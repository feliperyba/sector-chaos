import {
  MatchPhase,
  InputAction,
  ZONE,
  logger,
  type GameConfig,
  type InputActionData,
} from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import {
  MatchFlowService,
  EliminationService,
  MatchEndService,
  SuddenDeathService,
  ZoneService,
  SpawnService,
  SiegeService,
  MapSiegeService,
  SiegeWallManager,
  InMatchReconnectionManager,
} from '../../domain/services/index.ts';
import { GameSimulation, type QueuedInput, type SnapshotSink } from '../simulation/index.ts';
import type { BotSystem } from '../../ai/BotSystem.ts';
import type { ZoneFeed } from '../../ai/WorldSnapshotZone.ts';
import { JoinMatchCommand, LeaveMatchCommand, type JoinMatchInput } from '../commands/index.ts';
import { Position } from '../../domain/value-objects/index.ts';
import { tickPhaseTransitions, type PhaseContext } from './GameOrchestratorPhases.js';
import { processEliminationEvents } from './GameOrchestratorEliminations.ts';
import { MatchStateProjector } from './MatchStateProjector.ts';

/**
 * Bag of fully-constructed collaborator services handed to the
 * {@link GameOrchestrator} constructor by {@link createGameOrchestrator}.
 * Replaces the historical 2-phase placeholder shape (ctor built 13 dummy
 * services from a `[[]]` grid, then `initialize()` replaced 13 of 14 fields).
 * Field-for-field identical to the deleted `OrchestratorInitResult`.
 */
export interface OrchestratorServices {
  match: GameMatch;
  simulation: GameSimulation;
  joinCommand: JoinMatchCommand;
  leaveCommand: LeaveMatchCommand;
  matchFlow: MatchFlowService;
  eliminationService: EliminationService;
  suddenDeathService: SuddenDeathService;
  siegeService: SiegeService;
  siegeWallManager: SiegeWallManager;
  mapSiegeService: MapSiegeService;
  zoneService: ZoneService;
  spawnService: SpawnService;
  reconnectionManager: InMatchReconnectionManager;
}

export class GameOrchestrator {
  private simulation: GameSimulation;
  private match: GameMatch;
  private config: GameConfig;
  private phase: MatchPhase;
  private players: Map<string, { id: string; name: string; connected: boolean }>;
  private joinCommand: JoinMatchCommand;
  private leaveCommand: LeaveMatchCommand;
  private matchFlow: MatchFlowService;
  private eliminationService: EliminationService;
  private matchEndService: MatchEndService;
  private suddenDeathService: SuddenDeathService;
  private zoneService: ZoneService;
  private siegeService: SiegeService;
  private siegeWallManager: SiegeWallManager;
  private mapSiegeService: MapSiegeService;
  private spawnService: SpawnService;
  private reconnectionManager: InMatchReconnectionManager;
  private matchEndedEmitted: boolean = false;
  /**
   * Alive count at/below which the match ends. Read from
   * config.match.lastStandingThreshold at construction time; override at runtime
   * via setLastStandingThreshold(). `-1` disables the check entirely.
   */
  private lastStandingThreshold: number;
  /** Cached match-state projector (see MatchStateProjector). */
  private _stateProjector!: MatchStateProjector;
  /**
   * server-context-copy-elimination: reusable per-tick event buffer. Replaces
   * the former `[...simEvents, ...zoneEvents, ...siegeStartEvents,
   * ...siegeWallEvents, ...phaseResult.events]` spread merge (a fresh
   * combined array every tick). Cleared at the TOP of update() before
   * refilling — drain-before-refill guarantees no cross-tick retention:
   * every consumer of the returned array (GameRoomMessages.
   * handleSimulationTick's broadcast/grid/spectator loops + debugEventBus,
   * BotTestRoom/TestRoom ticks, the bot-benchmark harness, and test helpers)
   * iterates it synchronously within the same tick callback and stores
   * nothing, so each has a full interval before the next clear.
   */
  private readonly _tickEvents: GameEvent[] = [];

  /**
   * Atomic constructor. The {@link services} bag is built by
   * {@link createGameOrchestrator} from the real map; no placeholder state.
   * `matchId` is accepted for symmetry with the factory signature and for
   * diagnostic use, but the authoritative id lives on `services.match.matchId`.
   */
  constructor(matchId: string, config: GameConfig, services: OrchestratorServices) {
    this.config = config;
    this.lastStandingThreshold = config.match.lastStandingThreshold ?? 0;
    this.match = services.match;
    this.simulation = services.simulation;
    this.joinCommand = services.joinCommand;
    this.leaveCommand = services.leaveCommand;
    this.matchFlow = services.matchFlow;
    this.eliminationService = services.eliminationService;
    this.matchEndService = new MatchEndService();
    this.suddenDeathService = services.suddenDeathService;
    this.siegeService = services.siegeService;
    this.siegeWallManager = services.siegeWallManager;
    this.mapSiegeService = services.mapSiegeService;
    this.zoneService = services.zoneService;
    this.spawnService = services.spawnService;
    this.reconnectionManager = services.reconnectionManager;
    this.phase = MatchPhase.WAITING;
    this.players = new Map();
    this.matchEndedEmitted = false;
    void matchId;
  }

  /**
   * Runtime override for the alive-player count at/below which the match ends.
   * The initial value comes from config.match.lastStandingThreshold; this setter
   * allows changing it mid-match. Use `-1` to disable the check entirely.
   */
  setLastStandingThreshold(threshold: number): void {
    this.lastStandingThreshold = threshold;
  }

  start(): void {
    if (this.isRunning) return;

    const playerIds: string[] = [];
    for (const [id, player] of this.players) {
      if (player.connected) playerIds.push(id);
    }
    logger.info(
      `[Orchestrator] start() called with ${playerIds.length} connected players (total registered: ${this.players.size})`,
    );
    const spawnPositions = this.spawnService.assignSpawnPoints(playerIds);
    for (const playerId of playerIds) {
      const pos = spawnPositions.get(playerId);
      const player = this.match.getPlayer(playerId);
      if (pos && player) {
        player.movement.position = new Position(pos.x, pos.y);
      }
    }
    this.matchFlow.startMatch(playerIds, this.spawnService);
    this.phase = MatchPhase.COUNTDOWN;
    this.match.setPhase(MatchPhase.COUNTDOWN);
    this.simulation.start();
  }

  stop(): void {
    this.simulation.stop();
    this.mapSiegeService.stop();
    const state = this.matchFlow.getCurrentState();
    if (state.phase !== MatchPhase.FINISHED) {
      try {
        this.matchFlow.transitionTo(MatchPhase.FINISHED);
      } catch {
        this.matchFlow.forceFinish();
      }
    }
    this.phase = MatchPhase.FINISHED;
  }

  attachSnapshotSink(sink: SnapshotSink): void {
    this.simulation.attachSnapshotSink(sink);
  }

  /**
   * Forward runtime-service attachment to the underlying simulation. Mirrors
   * the seam exposed by GameSimulation.attachRuntimeServices (refactor #12) —
   * collapses the former setZoneService/setMatchFlow/setReconnectionManager
   * trio into one atomic handoff for services that arrive together.
   */
  attachRuntimeServices(services: {
    zoneService: ZoneService;
    matchFlow: MatchFlowService;
    reconnectionManager: InMatchReconnectionManager;
  }): void {
    this.simulation.attachRuntimeServices(services);
  }

  setBotSystem(botSystem: BotSystem): void {
    this.simulation.setBotSystem(botSystem);
  }
  getBotSystem(): BotSystem | null {
    return this.simulation.getBotSystem();
  }
  getReconnectionManager(): InMatchReconnectionManager {
    return this.reconnectionManager;
  }
  drainReconnectionEvents() {
    return this.simulation.drainReconnectionEvents();
  }
  getMatch() {
    return this.match;
  }
  getSimulation() {
    return this.simulation;
  }
  pause(): void {
    this.simulation.pause();
  }
  resume(): void {
    this.simulation.resume();
  }

  addPlayer(id: string, name: string): boolean {
    const result = this.joinCommand.execute({ playerId: id, playerName: name } as JoinMatchInput);
    if (!result.success) {
      logger.warn(`[Orchestrator] addPlayer(${id}) FAILED — match full?`);
      return false;
    }
    this.players.set(id, { id, name, connected: true });

    const player = this.match.getPlayer(id);
    const initialPos = player
      ? `(${player.movement.position.x.toFixed(0)}, ${player.movement.position.y.toFixed(0)})`
      : 'N/A';

    if (this.phase !== MatchPhase.WAITING && this.phase !== MatchPhase.FINISHED) {
      this.matchFlow.addLatePlayer(id);
      const spawnPositions = this.spawnService.assignSpawnPoints([id]);
      const pos = spawnPositions.get(id);
      if (pos && player) {
        player.movement.position = new Position(pos.x, pos.y);
        logger.info(
          `[Orchestrator] LATE addPlayer(${id}) phase=${MatchPhase[this.phase]} | initial=${initialPos} → override=(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`,
        );
      } else {
        logger.warn(
          `[Orchestrator] LATE addPlayer(${id}) phase=${MatchPhase[this.phase]} | assignSpawnPoints returned ${pos ? 'pos' : 'undefined'}, player=${player ? 'exists' : 'null'}`,
        );
      }
      if (
        (this.phase === MatchPhase.ACTIVE ||
          this.phase === MatchPhase.ZONE_SHRINKING ||
          this.phase === MatchPhase.FINAL_CLOSURE ||
          this.phase === MatchPhase.OVERTIME) &&
        player
      ) {
        player.revive(this.match.currentTick);
      }
    } else {
      logger.info(
        `[Orchestrator] addPlayer(${id}) phase=${MatchPhase[this.phase]} | pos=${initialPos} (no override)`,
      );
    }
    return true;
  }

  removePlayer(id: string): void {
    this.leaveCommand.execute(id);
    this.simulation.cleanupPlayer(id);
    this.spawnService.releaseAssignment(id);
    const player = this.players.get(id);
    if (player) {
      player.connected = false;
    }
  }

  getPlayer(id: string) {
    return this.match.getPlayer(id);
  }

  handleInput(
    playerId: string,
    action: InputAction,
    data: InputActionData,
    clientTick: number = 0,
  ): GameEvent[] {
    const input: QueuedInput = {
      playerId,
      action,
      data,
      clientTick,
      serverTick: this.match.currentTick,
      receivedAt: Date.now(),
    };
    this.simulation.processInput(input);
    return [];
  }

  update(deltaMs: number): GameEvent[] {
    // Drain-before-refill (see _tickEvents): clear the previous tick's events
    // BEFORE producing this tick's, so a caller still holding the previous
    // return value keeps valid data for the remainder of the interval.
    const allEvents = this._tickEvents;
    allEvents.length = 0;

    this.zoneService.update(deltaMs);
    const simEvents = this.simulation.update(deltaMs);
    const zoneEvents = this.zoneService.drainEvents();
    const zoneData = this.zoneService.getCurrentZone();

    let siegeStartEvents: GameEvent[] = [];
    let siegeWallEvents: GameEvent[] = [];
    if (zoneData.phase > 1) {
      siegeStartEvents = this.siegeService.checkSiegeStatus(
        { x: zoneData.centerX, y: zoneData.centerY },
        zoneData.currentRadius,
      );
      const isOvertime = this.zoneService.isOvertime();
      const siegeInterval = isOvertime
        ? ZONE.SIEGE_WALL_DROP_INTERVAL_OT
        : ZONE.SIEGE_WALL_DROP_INTERVAL;
      siegeWallEvents = this.mapSiegeService.update(
        Date.now(),
        siegeInterval,
        this.match.getGrid(),
        { x: zoneData.centerX, y: zoneData.centerY },
        zoneData.currentRadius,
        isOvertime,
      );
      if (siegeWallEvents.length > 0) {
        this.match.markGridDirty();
      }
    }

    processEliminationEvents(simEvents, this.match, this.eliminationService);

    const phaseCtx: PhaseContext = {
      match: this.match,
      matchFlow: this.matchFlow,
      eliminationService: this.eliminationService,
      matchEndService: this.matchEndService,
      suddenDeathService: this.suddenDeathService,
      zoneService: this.zoneService,
      matchEndedEmitted: this.matchEndedEmitted,
      lastStandingThreshold: this.lastStandingThreshold,
    };
    const phaseResult = tickPhaseTransitions(phaseCtx);
    this.phase = phaseResult.newPhase;
    this.matchEndedEmitted = phaseResult.matchEndedEmitted;

    // Push in the EXACT former spread-concatenation order:
    // simEvents → zoneEvents → siegeStartEvents → siegeWallEvents →
    // phaseResult.events. The buffer is copied element-wise (not aliased), so
    // reusing the simulation's own drained arrays downstream stays safe.
    for (let i = 0; i < simEvents.length; i++) allEvents.push(simEvents[i]!);
    for (let i = 0; i < zoneEvents.length; i++) allEvents.push(zoneEvents[i]!);
    for (let i = 0; i < siegeStartEvents.length; i++) allEvents.push(siegeStartEvents[i]!);
    for (let i = 0; i < siegeWallEvents.length; i++) allEvents.push(siegeWallEvents[i]!);
    for (let i = 0; i < phaseResult.events.length; i++) allEvents.push(phaseResult.events[i]!);

    // BOT STIMULUS TAP (bot-ai-v2 ticket 03, DEC-002): fan the FULLY
    // aggregated stream — the exact events the network mapper ships to
    // clients — out to hearing-range bots via the BotSystem's StimulusRouter.
    // Read-only over allEvents (never drains/mutates); zero new network
    // payloads (bots stay players on the input pipeline). Runs AFTER this
    // update's bot pass, so stimuli land in the queues with one tick of
    // latency — the same cadence as the bots' own submitted inputs. The
    // fallback tick stamps stimuli from wall-clock-free emitters (e.g.
    // ZoneWarning carries tick 0); everything else uses event.tick. No
    // wall-clock reads on this path (byte-identity contract holds).
    this.simulation.getBotSystem()?.ingestStimulusEvents(allEvents, this.match.currentTick);
    return allEvents;
  }

  getMatchState() {
    if (!this._stateProjector) {
      this._stateProjector = new MatchStateProjector({
        match: this.match,
        simulation: this.simulation,
        matchFlow: this.matchFlow,
        eliminationService: this.eliminationService,
        siegeService: this.siegeService,
        siegeWallManager: this.siegeWallManager,
        mapSiegeService: this.mapSiegeService,
        zoneService: this.zoneService,
      });
    }
    return this._stateProjector.project();
  }

  getPhase(): MatchPhase {
    return this.phase;
  }
  getPlayersAlive(): number {
    return this.match.alivePlayerCount;
  }
  getPlayerCount(): number {
    return this.players.size;
  }

  canStart(): boolean {
    let connectedCount = 0;
    for (const player of this.players.values()) {
      if (player.connected) connectedCount++;
    }
    return connectedCount >= this.config.match.minPlayers;
  }

  get isRunning() {
    return this.simulation.isRunning;
  }
  get currentTick() {
    return this.simulation.currentTick;
  }

  getPlayerGridPosition(playerId: string): { gridX: number; gridY: number } | null {
    const player = this.match.getPlayer(playerId);
    if (!player) return null;
    return this.match.worldToGrid(player.movement.position.x, player.movement.position.y);
  }

  getZoneData() {
    return this.zoneService.getCurrentZone();
  }

  /**
   * Zone read feed for the bot WorldSnapshot (perf-arc ticket 17): the same
   * per-match zoneService/siegeWallManager instances the wire projector reads,
   * exposed so bot construction can hand them to the snapshot sync — bots read
   * zone state per tick WITHOUT running a full state projection. Read-only
   * surface; both instances are created once per match (GameOrchestratorInit)
   * and never replaced.
   */
  getZoneFeed(): ZoneFeed {
    return { zoneService: this.zoneService, siegeWallManager: this.siegeWallManager };
  }
}

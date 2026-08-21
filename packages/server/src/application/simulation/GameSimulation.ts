import { PLAYER, SeededRNG, IdGenerator, NETWORK } from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { Player } from '../../domain/entities/Player.ts';
import type { IMovementService, MatchFlowService } from '../../domain/services/index.ts';
import type { ZoneService } from '../../domain/services/ZoneService.ts';
import { DeathResolutionService } from '../../domain/services/DeathResolutionService.ts';
import { LootService } from '../../domain/services/LootService.ts';
import {
  MovePlayerCommand,
  AttackCommand,
  PickupPowerUpCommand,
  PickupWeaponCommand,
  OpenChestCommand,
  TriggerTrapCommand,
  DashCommand,
} from '../commands/index.ts';
import { InputQueue, type QueuedInput } from './InputQueue.ts';
import { TickTimer } from './TickTimer.ts';
import { SimulationStats } from './SimulationStats.ts';
import { TickProfiler, type SimulationMetrics } from './TickProfiler.ts';
import { RateLimiter } from '../../validation/RateLimiter.ts';
import { PlayerAnimationSystem } from '../services/PlayerAnimationSystem.ts';
import { logger } from '@sector-battle/shared';
import { ShieldHandler } from '../../domain/handlers/ShieldHandler.ts';
import type { BotSystem } from '../../ai/BotSystem.ts';
import type {
  InMatchReconnectionManager,
  ReconnectionEvent,
} from '../../domain/services/ReconnectionManager.ts';
import {
  step3_ResolveMeleeRanged,
  step4_AdvanceProjectiles,
  step5_PropagateBarrels,
  step6_ProcessZone,
  step7_ProcessTraps,
  step8_ExpireTimers,
  step9_ResolveDeaths,
  type SimulationStepDeps,
} from './GameSimulationCombat.ts';
import type { LootHandlerContext } from './GameSimulationLoot.ts';
import {
  step1_ProcessInputs,
  type ActiveDash,
  type InputProcessContext,
} from './GameSimulationInput.ts';
import {
  checkTrapWalkOverSim,
  checkPowerUpWalkOverSim,
  rebuildTrapGridSim,
  step2_ResolveMovementSim,
  type WalkoverContext,
} from './GameSimulationWalkovers.ts';

const TICK_BUDGET_MS = 33;
const TICKS_PER_SECOND = 60;
const DASH_DURATION_TICKS = Math.round(PLAYER.DASH_DURATION * TICKS_PER_SECOND);

/**
 * Receives a notification every simulation tick after the snapshot step
 * (step11). The sink decides internally whether to actually serialize state
 * (e.g. the room's batched every-N-ticks syncState). Attached once at
 * room-create via {@link GameSimulation.attachSnapshotSink}; never detached.
 */
export interface SnapshotSink {
  onSnapshotTick(): void;
}

export class GameSimulation {
  getMetrics(): SimulationMetrics {
    return this.profiler.getMetrics();
  }

  private match: GameMatch;
  private inputQueue: InputQueue;
  private tickTimer: TickTimer;
  private readonly profiler = new TickProfiler();
  private running: boolean;
  private paused: boolean;
  private stats: SimulationStats;
  movementService: IMovementService;
  private moveCommand: MovePlayerCommand;
  attackCommand: AttackCommand;
  private pickupCommand: PickupPowerUpCommand;
  private pickupWeaponCommand: PickupWeaponCommand;
  private openChestCommand: OpenChestCommand;
  private triggerTrapCommand: TriggerTrapCommand;
  private dashCommand: DashCommand;
  private zoneService: ZoneService | null = null;
  private _lastProcessedInput = 0;
  private activeDashes: Map<string, ActiveDash> = new Map();
  private attackRateLimiter: RateLimiter;
  lootCtx!: LootHandlerContext;
  private snapshotSink: SnapshotSink | null = null;
  private matchFlow: MatchFlowService | null = null;
  private botSystem: BotSystem | null = null;
  private reconnectionManager: InMatchReconnectionManager | null = null;
  private pendingReconnectionEvents: ReconnectionEvent[] = [];
  shieldHandler!: ShieldHandler;
  private animationSystem: PlayerAnimationSystem;
  stepDeps!: SimulationStepDeps;

  private inputProcessCtx!: InputProcessContext;

  private trapCells: Map<number, string[]> = new Map();
  private trapCellPool: string[][] = [];
  private powerUpCells: Map<number, string[]> = new Map();
  private powerUpCellPool: string[][] = [];
  /** Last GameMatch.trapVersion the trap grid was rebuilt for (-1 forces first rebuild). */
  private _lastTrapVersion = -1;
  private walkoverCtx!: WalkoverContext;
  /**
   * server-alive-scratch-hoist: the ONE alive-player array per tick. Rebuilt at
   * the top of every {@linkcode step} (before step1) in players-Map insertion
   * order and shared by every per-tick alive scan site — step1 momentum coast,
   * step2 movement resolve, step6 zone processing, step8 timer expiry /
   * dash-end overlap / windup — plus the MovementService alive cache (via
   * MovePlayerCommand / step2). Replaces each site's former full-map
   * forEachAlivePlayer walk; the rebuild is the only per-tick full scan left.
   *
   * INVARIANT (do not weaken): the alive set is stable for the whole step —
   * damage only reduces HP and reports `killed`; the ALIVE status bit flips
   * exclusively in step9 (DeathResolutionService → dieWithTick/completeDeath)
   * and outside step() altogether (orchestrator revive on join/match-start,
   * leave's soft DEAD write). Steps 1-8 therefore can never observe an
   * aliveness change after the build, so iterating this array is equivalent to
   * each site's former fresh map scan (same members, same insertion order).
   * Valid only while the owning step() is on the stack; truncated and refilled
   * at the next step's top.
   */
  private readonly _alivePlayers: Player[] = [];

  constructor(match: GameMatch, movementService: IMovementService) {
    this.match = match;
    this.inputQueue = new InputQueue();
    this.tickTimer = new TickTimer();
    this.running = false;
    this.paused = false;
    this.stats = new SimulationStats();
    this.moveCommand = new MovePlayerCommand(match, movementService, this._alivePlayers);
    this.movementService = movementService;
    this.shieldHandler = new ShieldHandler();
    this.animationSystem = new PlayerAnimationSystem(match);
    this.attackCommand = new AttackCommand(match, this.shieldHandler);
    this.attackCommand.setAnimationSystem(this.animationSystem);
    this.pickupCommand = new PickupPowerUpCommand(match);
    this.pickupWeaponCommand = new PickupWeaponCommand(match);
    this.openChestCommand = new OpenChestCommand(match);
    this.triggerTrapCommand = new TriggerTrapCommand(match);
    this.dashCommand = new DashCommand(match);
    this.attackRateLimiter = new RateLimiter(10, 1000);
    const lootCtx = {
      match,
      lootService: new LootService(),
      lootRng: new SeededRNG(match.mapSeed || 12345),
      lootIdGen: new IdGenerator('loot'),
      powerUpIdGen: new IdGenerator('pu-sim'),
      processedDestructibles: new Set<string>(),
      lastOrphanSweepVersion: -1, // ticket 10 — forces the sweep's first run
    };
    this.lootCtx = lootCtx;
    this.walkoverCtx = {
      match,
      trapCells: this.trapCells,
      trapCellPool: this.trapCellPool,
      powerUpCells: this.powerUpCells,
      powerUpCellPool: this.powerUpCellPool,
      triggerTrapCommand: this.triggerTrapCommand,
      pickupCommand: this.pickupCommand,
      alivePlayers: this._alivePlayers,
    };
    this.stepDeps = {
      match,
      movementService,
      attackCommand: this.attackCommand,
      pickupCommand: this.pickupCommand,
      deathResolution: new DeathResolutionService(),
      shieldHandler: this.shieldHandler,
      lootCtx,
      alivePlayers: this._alivePlayers,
      checkTrapWalkOver: (playerId: string) => checkTrapWalkOverSim(this.walkoverCtx, playerId),
      checkPowerUpWalkOver: (playerId: string) =>
        checkPowerUpWalkOverSim(this.walkoverCtx, playerId),
      markPlayerDead: (id: string) => this.matchFlow?.markPlayerDead(id),
    };
    this.inputProcessCtx = {
      matchFlow: null,
      inputQueue: this.inputQueue,
      match,
      reconnectionManager: null,
      moveCommand: this.moveCommand,
      attackCommand: this.attackCommand,
      pickupWeaponCommand: this.pickupWeaponCommand,
      openChestCommand: this.openChestCommand,
      triggerTrapCommand: this.triggerTrapCommand,
      dashCommand: this.dashCommand,
      shieldHandler: this.shieldHandler,
      attackRateLimiter: this.attackRateLimiter,
      activeDashes: this.activeDashes,
      alivePlayers: this._alivePlayers,
      updateLastProcessedInput: (clientTick: number) => {
        if (clientTick > this._lastProcessedInput) {
          this._lastProcessedInput = clientTick;
        }
      },
      checkTrapWalkOver: (playerId: string) => checkTrapWalkOverSim(this.walkoverCtx, playerId),
      checkPowerUpWalkOver: (playerId: string) =>
        checkPowerUpWalkOverSim(this.walkoverCtx, playerId),
    };
  }

  /**
   * Attach the runtime services that arrive together at match-initialization
   * time (zone, match-flow, reconnection). Collapses the former
   * `setZoneService`/`setMatchFlow`/`setReconnectionManager` trio into a
   * single atomic handoff (refactor #12, Option B). `attachSnapshotSink` and
   * `setBotSystem` stay standalone — they arrive at different times.
   */
  attachRuntimeServices(services: {
    zoneService: ZoneService;
    matchFlow: MatchFlowService;
    reconnectionManager: InMatchReconnectionManager;
  }): void {
    this.zoneService = services.zoneService;
    this.matchFlow = services.matchFlow;
    this.inputProcessCtx.matchFlow = services.matchFlow;
    this.reconnectionManager = services.reconnectionManager;
    this.inputProcessCtx.reconnectionManager = services.reconnectionManager;
  }
  /**
   * Attach the {@link SnapshotSink} that fires every tick after the snapshot
   * step (step11). Attached once at room-create (see GameRoomLifecycle) and
   * never detached; the sink internally decides whether to serialize state
   * (e.g. the room's batched every-N-ticks syncState). Finishes the #12
   * attach-runtime pattern by naming the snapshot contract instead of a bare
   * `(() => void)` callback.
   */
  attachSnapshotSink(sink: SnapshotSink): void {
    this.snapshotSink = sink;
  }
  setBotSystem(botSystem: BotSystem): void {
    this.botSystem = botSystem;
  }
  getBotSystem(): BotSystem | null {
    return this.botSystem;
  }
  /**
   * The server-authoritative animation sim. Exposed so the wire mapper
   * (`StateMapper.mapDelta`) can project each player's animation phase onto
   * the schema directly from the sim's state (ADR-0014; see #10a), instead of
   * round-tripping it through `PlayerCombat` mirror fields.
   */
  getAnimationSystem(): PlayerAnimationSystem {
    return this.animationSystem;
  }

  drainReconnectionEvents(): ReconnectionEvent[] {
    const events = this.pendingReconnectionEvents;
    this.pendingReconnectionEvents = [];
    return events;
  }

  private rebuildTrapGrid(): void {
    rebuildTrapGridSim(this.walkoverCtx);
  }

  start(): void {
    this.running = true;
    this.paused = false;
  }
  stop(): void {
    this.running = false;
    this.paused = false;
    this.pickupCommand.clearAllEffects();
  }
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
  }
  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  processInput(input: QueuedInput): void {
    this.inputQueue.enqueue(input);
  }

  private step(): GameEvent[] {
    const tick = this.match.currentTick;

    // Traps are static once placed; only their cooldown/reveal state changes,
    // which doesn't move them. Rebuild the spatial grid solely when the trap
    // set changes (add/remove) — detected via the match's trapVersion counter.
    if (this._lastTrapVersion !== this.match.trapVersion) {
      this.rebuildTrapGrid();
      this._lastTrapVersion = this.match.trapVersion;
    }

    // server-alive-scratch-hoist: build the alive-player array ONCE per step,
    // before step1 — the single remaining full-map alive scan per tick. Every
    // per-tick site below (momentum coast, movement resolve, zone, timers,
    // dash-end overlap, windup, and the MovementService alive cache) iterates
    // this array instead of re-walking the players Map. Within-tick aliveness
    // invariant: see _alivePlayers — the set cannot change between here and
    // step8 because deaths only flip status in step9.
    const alive = this._alivePlayers;
    alive.length = 0;
    this.match.forEachAlivePlayer((p) => alive.push(p));

    this.profiler.time('inputs', () => this.step1_ProcessInputs(tick));
    this.profiler.time('movement', () => this.step2_ResolveMovement(tick));
    this.profiler.time('animSim', () => this.animationSystem.stepAll(tick));
    this.profiler.time('melee', () => step3_ResolveMeleeRanged(this.stepDeps, tick));
    this.profiler.time('projectiles', () => step4_AdvanceProjectiles(this.stepDeps, tick));
    this.profiler.time('barrels', () => step5_PropagateBarrels(this.stepDeps, tick));
    this.profiler.time('zone', () =>
      step6_ProcessZone(this.stepDeps, this.zoneService, tick, TICKS_PER_SECOND),
    );
    this.profiler.time('traps', () =>
      step7_ProcessTraps(
        this.stepDeps,
        (t: number) => this.triggerTrapCommand.tickFireAreas(t),
        tick,
      ),
    );
    this.profiler.time('timers', () =>
      step8_ExpireTimers(
        this.stepDeps,
        this.activeDashes,
        DASH_DURATION_TICKS,
        TICKS_PER_SECOND,
        tick,
      ),
    );
    this.profiler.time('deaths', () => step9_ResolveDeaths(this.stepDeps, this.activeDashes, tick));
    this.profiler.time('botAI', () => this.step10_BotAI(tick));

    this.profiler.time('snapshot', () => this.step11_Snapshot(tick));

    this.profiler.commitStepTimings();

    this.match.advanceTick();
    this.inputQueue.discardBefore(this.match.currentTick - NETWORK.INPUT_BUFFER_SIZE);
    return this.match.drainEvents();
  }

  private step1_ProcessInputs(tick: number): void {
    step1_ProcessInputs(this.inputProcessCtx, tick);
  }

  private step2_ResolveMovement(_tick: number): void {
    step2_ResolveMovementSim(this.walkoverCtx, this.movementService, _tick);
    // server-domain-spatial-hash: rebuild the domain broadphase index (ALL
    // players + active destructibles) ONCE per tick, after movement
    // resolution and before the combat steps (animSim/step3 melee sweeps,
    // step4 projectile scans, step5 barrels, step8 windup-completions) — the
    // same placement pattern as the power-up grid rebuild at the end of
    // step2. server-combat-spatial-queries (ticket 18): the five combat scan
    // sites (ranged arrow vs destructibles/players, thrown vs
    // destructibles/players, melee hurtbox gather) read this index via
    // domain/handlers/CombatSpatialQueries.ts — same hit-selection outcomes
    // as the former linear scans (seq-ordered candidates reproduce Map
    // iteration order). The index is a post-step2 SNAPSHOT — see
    // DomainSpatialIndex for the staleness contract (consumers re-verify
    // liveness + live positions per candidate).
    // Runs inside the 'movement' profiler label: the ADR-0025-pinned label
    // set must not grow.
    this.match.rebuildSpatialIndex();
  }

  private step10_BotAI(tick: number): void {
    if (!this.botSystem) return;
    const inputs = this.botSystem.tick(tick);
    for (const input of inputs) {
      input.serverTick = tick + 1;
      this.processInput(input);
    }
  }

  private step11_Snapshot(_tick: number): void {
    this.snapshotSink?.onSnapshotTick();
  }

  private processReconnectionEvents(events: ReconnectionEvent[]): void {
    for (const event of events) {
      if (event.type === 'PHASE2_ENTER') {
        const player = this.match.getPlayer(event.playerId);
        if (player && player.isActive) {
          player.connectionState = 'vulnerable';
          player.inputSuppressed = true;
        }
      }
    }
  }

  update(deltaMs: number): GameEvent[] {
    if (!this.running || this.paused) return [];
    const allEvents: GameEvent[] = [];
    const steps = this.tickTimer.consume(deltaMs);
    for (let i = 0; i < steps; i++) {
      const tickStart = performance.now();
      const tickEvents = this.step();
      allEvents.push(...tickEvents);
      const tickDuration = performance.now() - tickStart;
      this.stats.recordTick(tickDuration);
      this.profiler.recordTick(tickDuration, tickEvents.length);
      if (tickDuration > TICK_BUDGET_MS) {
        // The per-step timings live in the profiler. This is the one
        // GameSimulation → profiler read site: a read of lastTickSystemTimings
        // for the breakdown, keeping the profiler free of match/tick knowledge.
        const breakdown = Object.entries(this.profiler.getMetrics().lastTickSystemTimings)
          .map(([k, v]) => `${k}=${v.toFixed(1)}`)
          .join(' ');
        logger.warn(
          `[TICK-OVERRUN] tick ${this.match.currentTick} took ${tickDuration.toFixed(1)}ms [${breakdown}]`,
        );
      }
    }
    if (this.reconnectionManager) {
      const reconnectionEvents = this.reconnectionManager.tick(deltaMs);
      this.processReconnectionEvents(reconnectionEvents);
      this.pendingReconnectionEvents.push(...reconnectionEvents);
    }
    // if (steps > 0) {
    //   logger.debug(
    //     `update: ${steps} steps in ${totalDuration.toFixed(2)}ms, avg=${this.stats.avgTickTime.toFixed(2)}ms`,
    //   );
    // }
    return allEvents;
  }

  getStats(): { totalTicks: number; avgTickTime: number; maxTickTime: number } {
    return {
      totalTicks: this.stats.totalTicks,
      avgTickTime: this.stats.avgTickTime,
      maxTickTime: this.stats.maxTickTime,
    };
  }
  get currentTick(): number {
    return this.match.currentTick;
  }
  get lastProcessedInput(): number {
    return this._lastProcessedInput;
  }
  get isRunning(): boolean {
    return this.running;
  }
  get tickRate(): number {
    return 60;
  }

  cleanupPlayer(playerId: string): void {
    this.animationSystem.cleanupPlayer(playerId);
    this.activeDashes.delete(playerId);
    this.attackRateLimiter.reset(playerId);
    this.attackCommand.cleanupPlayer(playerId);
    this.shieldHandler.clearPlayer(playerId);
  }
}

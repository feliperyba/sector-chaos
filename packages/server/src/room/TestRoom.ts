import { Room, Client } from 'colyseus';
import { GameStateSchema } from '../infrastructure/schemas/index.ts';
import { GameOrchestrator } from '../application/services/GameOrchestrator.ts';
import { createGameOrchestrator } from '../application/services/GameOrchestratorInit.ts';
import { StateMapper, type MatchMeta } from '../infrastructure/mappers/StateMapper.ts';
import { EventMapper } from '../infrastructure/mappers/EventMapperHandlers.ts';
import {
  TileType,
  NETWORK,
  SeededRNG,
  rollWeaponTier,
  rollChestTier,
  type EnrichedMapData,
} from '@sector-battle/shared';
import type { MapResult } from '../domain/services/MapGenerator.ts';
import type { GameEvent } from '../domain/events/index.ts';
import { BotManager } from '../ai/BotManager.ts';
import { BotSystem } from '../ai/BotSystem.ts';
import { registerInputHandler } from './handlers/input.ts';
import { TmxParser } from '../infrastructure/parsers/TmxParser.ts';
import { logger } from '@sector-battle/shared';
import { debugEventBus } from '../infrastructure/DebugEventBus.ts';
import { registerSimulation, unregisterSimulation } from '../infrastructure/SimulationRegistry.ts';
import { resolve } from 'node:path';
import {
  type TestRoomOptions,
  type JoinOptions,
  TEST_CONFIG,
  buildSpawnPoints,
  findTilesOfType,
  createPathfinder,
} from './TestRoomLifecycle.ts';
import { registerTestRoomMessages, type TestRoomDeps } from './TestRoomMessages.ts';

const TICK_INTERVAL = NETWORK.TICK_INTERVAL;

export class TestRoom extends Room<{ state: GameStateSchema }> {
  maxClients = 1;
  patchRate = 60;

  private orchestrator!: GameOrchestrator;
  private matchMeta!: MatchMeta;
  private botManager!: BotManager;
  private debugMode = false;
  private mapGrid!: TileType[][];
  private enrichedData!: EnrichedMapData;
  private matchStarted = false;
  private debugFlags = { paused: false, stepOnce: false };

  private sendMapData(client: Client): void {
    const payload: Record<string, unknown> = {
      grid: this.enrichedData.grid,
      width: this.enrichedData.width,
      height: this.enrichedData.height,
      tileSize: this.enrichedData.tileSize,
      seed: this.enrichedData.seed,
      visualLayers: this.enrichedData.visualLayers,
      atlas: this.enrichedData.atlas,
    };
    client.send('mapData', payload);
  }

  onCreate(options: TestRoomOptions): void {
    const matchId = `test-${Date.now()}`;
    const config = { ...TEST_CONFIG };
    const difficulty = options.difficulty ?? 'normal';
    const mapPath = options.mapPath ?? resolve(process.cwd(), 'tiled/demo_map.tmx');

    this.setState(new GameStateSchema());
    this.debugMode = options.debug === true;

    const parser = new TmxParser();
    this.enrichedData = parser.parse(mapPath);

    config.map.arenaWidth = this.enrichedData.width;
    config.map.arenaHeight = this.enrichedData.height;
    config.map.sectorSize = this.enrichedData.width;

    const tierRng = new SeededRNG(this.enrichedData.seed);
    const mapResult: MapResult = {
      grid: this.enrichedData.grid,
      seed: this.enrichedData.seed,
      spawnPoints: buildSpawnPoints(this.enrichedData),
      chestPlacements: findTilesOfType(this.enrichedData.grid, TileType.CHEST).map((c) => ({
        ...c,
        tier: rollChestTier(tierRng),
      })),
      trapPlacements: this.enrichedData.entities.traps.map((t) => ({
        gridX: t.gridX,
        gridY: t.gridY,
        trapType: t.trapType,
      })),
      weaponSpawnPlacements: this.enrichedData.entities.weapons.map((w) => ({
        gridX: w.gridX,
        gridY: w.gridY,
        tier: w.tier ?? rollWeaponTier(tierRng),
        weaponType: w.weaponType,
      })),
    };

    this.mapGrid = this.enrichedData.grid;
    this.orchestrator = createGameOrchestrator(matchId, config, mapResult, this.enrichedData);
    registerSimulation(this.roomId, this.orchestrator.getSimulation());

    this.matchMeta = {
      matchId,
      mapSeed: this.enrichedData.seed,
      mapWidth: this.enrichedData.width,
      mapHeight: this.enrichedData.height,
    };

    this.setMetadata({ difficulty, mapPath });

    this.botManager = new BotManager();
    this.botManager.setDifficulty(difficulty);

    const pathfinder = createPathfinder(this.mapGrid, TEST_CONFIG.map.tileWidth);
    // Zone feed via WorldSnapshot sync (perf-arc ticket 17) — replaces the
    // retired getMatchState() closure (full wire projection per tick).
    const botSystem = new BotSystem(
      this.orchestrator.getMatch(),
      pathfinder,
      this.orchestrator.getZoneFeed(),
    );
    this.orchestrator.setBotSystem(botSystem);
    this.botManager.setBotSystem(botSystem);

    const botCount = Math.min(options.botCount ?? 4, config.match.maxPlayers - 1);
    this.botManager.spawnBots(this.orchestrator, 0, botCount, this.clock);

    registerInputHandler(this);

    registerTestRoomMessages(this, {
      orchestrator: this.orchestrator as unknown as TestRoomDeps['orchestrator'],
      sendMapData: this.sendMapData.bind(this),
      syncState: this.syncState.bind(this),
      broadcast: (channel: string, message: unknown) => {
        this.broadcast(channel, message);
      },
      enrichedData: this.enrichedData,
      debugFlags: this.debugFlags,
    });
  }

  onJoin(client: Client, options: JoinOptions): void {
    const name = options.name ?? 'Tester';
    this.orchestrator.addPlayer(client.sessionId, name);

    if (!this.matchStarted) {
      this.matchStarted = true;
      this.orchestrator.start();
      this.setSimulationInterval(this.onSimulationTick.bind(this), TICK_INTERVAL);
    }

    this.sendMapData(client);
    this.syncState();
  }

  onLeave(client: Client): void {
    this.orchestrator.removePlayer(client.sessionId);
    this.syncState();
  }

  async onDrop(client: Client): Promise<void> {
    try {
      await this.allowReconnection(client, 30);
      this.sendMapData(client);
      this.syncState();
    } catch {
      this.orchestrator.removePlayer(client.sessionId);
      this.syncState();
    }
  }

  onDispose(): void {
    unregisterSimulation(this.roomId);
    this.botManager.dispose();
    this.orchestrator.stop();
  }

  getOrchestrator(): GameOrchestrator {
    return this.orchestrator;
  }

  recordInputTime(_playerId: string): void {}

  private onSimulationTick(deltaTime: number): void {
    if (this.debugFlags.paused && !this.debugFlags.stepOnce) return;
    this.debugFlags.stepOnce = false;

    try {
      const events = this.orchestrator.update(deltaTime);
      this.syncState();
      this.broadcastEvents(events);
      if (process.env.NODE_ENV !== 'production') {
        debugEventBus.emitEvents(events);
      }

      if (this.debugMode) {
        const state = this.orchestrator.getMatchState();
        this.broadcast('debug:tick', {
          players: state.players.size,
        });
      }
    } catch (err) {
      logger.error('simulation tick error', err);
    }
  }

  private syncState(): void {
    const state = this.orchestrator.getMatchState();
    const animationSystem = this.orchestrator.getSimulation().getAnimationSystem();
    StateMapper.mapDelta(state, this.state, this.matchMeta, (playerId) =>
      animationSystem.getState(playerId),
    );
  }

  private broadcastEvents(events: GameEvent[]): void {
    const messages = EventMapper.broadcastEvents(events);
    for (const { channel, message } of messages) {
      this.broadcast(channel, message);
    }
  }
}

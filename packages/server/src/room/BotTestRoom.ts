import { Room, Client } from 'colyseus';
import { GameStateSchema } from '../infrastructure/schemas/index.ts';
import { GameOrchestrator } from '../application/services/GameOrchestrator.ts';
import { createGameOrchestrator } from '../application/services/GameOrchestratorInit.ts';
import { StateMapper, type MatchMeta } from '../infrastructure/mappers/StateMapper.ts';
import { EventMapper } from '../infrastructure/mappers/EventMapperHandlers.ts';
import {
  TileType,
  type GameConfig,
  PLAYER,
  COMBAT,
  ZONE,
  MATCH,
  GRID,
  NETWORK,
} from '@sector-battle/shared';
import { MapGenerator } from '../domain/services/MapGenerator.ts';
import type { GameEvent } from '../domain/events/index.ts';
import { BotManager } from '../ai/BotManager.ts';
import type { DifficultyLevel } from '../ai/BotManager.ts';
import { BotSystem } from '../ai/BotSystem.ts';
import { Pathfinder } from '../ai/navigation/Pathfinder.ts';
import { registerInputHandler } from './handlers/input.ts';
import { logger } from '@sector-battle/shared';
import { debugEventBus } from '../infrastructure/DebugEventBus.ts';
import { registerSimulation, unregisterSimulation } from '../infrastructure/SimulationRegistry.ts';

interface BotTestOptions {
  botCount: number;
  difficulty?: DifficultyLevel;
  mapId: string;
  debug?: boolean;
}

interface JoinOptions {
  name?: string;
}

const TPS = NETWORK.TICK_RATE;

const BOT_TEST_CONFIG: GameConfig = {
  player: {
    baseSpeed: PLAYER.BASE_SPEED,
    dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
    dashDuration: Math.round(PLAYER.DASH_DURATION * TPS),
    dashCooldown: Math.round(PLAYER.DASH_COOLDOWN * TPS),
    baseHealth: PLAYER.BASE_HEALTH,
    maxHealth: PLAYER.MAX_HEALTH,
    inventorySize: PLAYER.INVENTORY_SIZE,
    hitboxWidth: PLAYER.HITBOX_WIDTH,
    hitboxHeight: PLAYER.HITBOX_HEIGHT,
  },
  zone: {
    phases: ZONE.PHASES.map((p) => ({
      index: p.index,
      radiusRatio: p.radiusRatio,
      duration: p.duration,
      name: p.name,
    })),
    totalDuration: ZONE.TOTAL_DURATION,
    transitionDuration: ZONE.ZONE_TRANSITION_DURATION,
    tickInterval: ZONE.ZONE_TICK_INTERVAL,
    warningTime: ZONE.ZONE_WARNING_TIME,
  },
  match: {
    targetDuration: Math.round(MATCH.TARGET_DURATION * TPS),
    maxPlayers: MATCH.MAX_PLAYERS,
    minPlayers: MATCH.MIN_PLAYERS,
    countdownDuration: Math.round(MATCH.COUNTDOWN_DURATION * TPS),
    overtimeStart: MATCH.OVERTIME_START,
    lastStandingThreshold: -1,
  },
  map: {
    tileWidth: GRID.TILE_SIZE,
    tileHeight: GRID.TILE_SIZE,
    arenaWidth: GRID.ARENA_WIDTH,
    arenaHeight: GRID.ARENA_HEIGHT,
    sectorSize: GRID.SECTOR_GRID_SIZE,
    corridorWidth: GRID.CORRIDOR_WIDTH,
    destructibleDensity: 0.3,
    chestDensity: 0.05,
    exitCount: 3,
  },
  combat: {
    knockbackForce: COMBAT.KNOCKBACK_FORCE,
    knockbackDecay: COMBAT.KNOCKBACK_DECAY,
    throwRange: COMBAT.THROW_RANGE,
    bounceFactor: COMBAT.BOUNCE_FACTOR,
    maxBounces: COMBAT.MAX_BOUNCES,
    friendlyFire: COMBAT.FRIENDLY_FIRE,
  },
  network: {
    tickRate: NETWORK.TICK_RATE,
    patchRate: NETWORK.PATCH_RATE,
    maxLatency: NETWORK.MAX_LATENCY,
    inputBufferSize: NETWORK.INPUT_BUFFER_SIZE,
    snapshotInterval: NETWORK.SNAPSHOT_INTERVAL,
  },
};

const TICK_INTERVAL = NETWORK.TICK_INTERVAL;

export class BotTestRoom extends Room<{ state: GameStateSchema }> {
  maxClients = 1;
  patchRate = 50;

  private orchestrator!: GameOrchestrator;
  private matchMeta!: MatchMeta;
  private botManager!: BotManager;
  private debugMode = false;
  private mapGrid!: TileType[][];

  private sendMapData(client: Client): void {
    client.send('mapData', {
      grid: this.mapGrid,
      width: BOT_TEST_CONFIG.map.arenaWidth,
      height: BOT_TEST_CONFIG.map.arenaHeight,
      tileSize: BOT_TEST_CONFIG.map.tileWidth,
    });
  }

  onCreate(options: BotTestOptions): void {
    const matchId = `bottest-${Date.now()}`;
    const config = BOT_TEST_CONFIG;
    const difficulty = options.difficulty ?? 'normal';

    this.setState(new GameStateSchema());

    const seed = Date.now() & 0xffffffff;
    const mapResult = new MapGenerator().generate(seed, config.map);
    this.mapGrid = mapResult.grid;
    this.orchestrator = createGameOrchestrator(matchId, config, mapResult);
    registerSimulation(this.roomId, this.orchestrator.getSimulation());

    this.matchMeta = {
      matchId,
      mapSeed: seed,
      mapWidth: config.map.arenaWidth,
      mapHeight: config.map.arenaHeight,
    };

    this.debugMode = options.debug === true;

    this.setMetadata({
      difficulty,
      mapId: options.mapId,
    });

    this.botManager = new BotManager();
    this.botManager.setDifficulty(difficulty);

    const pathfinder = this.createPathfinder();
    // Zone feed via WorldSnapshot sync (perf-arc ticket 17) — replaces the
    // retired getMatchState() closure (full wire projection per tick).
    const botSystem = new BotSystem(
      this.orchestrator.getMatch(),
      pathfinder,
      this.orchestrator.getZoneFeed(),
    );
    this.orchestrator.setBotSystem(botSystem);
    this.botManager.setBotSystem(botSystem);

    const botCount = Math.min(options.botCount, config.match.maxPlayers - 1);
    this.botManager.spawnBots(this.orchestrator, 0, botCount, this.clock);

    this.orchestrator.start();

    registerInputHandler(this);

    this.onMessage('requestMapData', (client: Client) => {
      this.sendMapData(client);
    });

    this.setSimulationInterval(this.onSimulationTick.bind(this), TICK_INTERVAL);
  }

  onJoin(client: Client, options: JoinOptions): void {
    const name = options.name ?? 'Developer';
    this.orchestrator.addPlayer(client.sessionId, name);
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
    try {
      const events = this.orchestrator.update(deltaTime);
      this.syncState();
      this.broadcastEvents(events);
      if (process.env.NODE_ENV !== 'production') {
        debugEventBus.emitEvents(events);
      }

      if (this.debugMode) {
        this.broadcastBotDebug();
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

  private broadcastBotDebug(): void {
    this.broadcast('botDebug', { tick: this.orchestrator.currentTick });
  }

  private createPathfinder(): Pathfinder {
    const grid: boolean[][] = [];
    for (let y = 0; y < this.mapGrid.length; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < this.mapGrid[y]!.length; x++) {
        row.push(this.mapGrid[y]![x] === TileType.EMPTY || this.mapGrid[y]![x] === TileType.EXIT);
      }
      grid.push(row);
    }
    return new Pathfinder(grid, BOT_TEST_CONFIG.map.tileWidth, this.mapGrid);
  }
}

import type { Room, Client } from 'colyseus';
import { GameStateSchema } from '../infrastructure/schemas/index.ts';
import { GameOrchestrator } from '../application/services/GameOrchestrator.ts';
import { createGameOrchestrator } from '../application/services/GameOrchestratorInit.ts';
import { type MatchMeta } from '../infrastructure/mappers/StateMapper.ts';
import { Health } from '../domain/value-objects/Health.ts';
import {
  TileType,
  effectiveSectorTier,
  type GameConfig,
  type EnrichedMapData,
  PLAYER,
  MATCH,
  NETWORK,
  MatchPhase,
  NetworkChannel,
  SECTOR_GRID_SIZE,
  type InputMessage,
} from '@sector-battle/shared';
import { buildMapIdentityView } from '../ai/goal/GoalTypes.ts';
import { buildLightingReport } from '../infrastructure/map/LightingReportBuilder.js';
import { registerInputHandler } from './handlers/input.ts';
import { registerChatHandler } from './handlers/chat.ts';
import { BotManager } from '../ai/BotManager.ts';
import { BotSystem } from '../ai/BotSystem.ts';
import { Pathfinder } from '../ai/navigation/Pathfinder.ts';
import { logger } from '@sector-battle/shared';
import { registerSimulation, unregisterSimulation } from '../infrastructure/SimulationRegistry.ts';
import { buildGameMapResult, createPathfinder } from './GameRoomMapBuilder.ts';
import { buildMapIdentityManifest, type MapIdentityManifest } from './MapIdentityManifest.ts';
import { GameRoomOptionsSchema, DEFAULT_CONFIG, type GameRoomOptions } from './GameRoomConfig.ts';

/**
 * Interface used by lifecycle functions to interact with the GameRoom
 * without creating a circular dependency on the concrete class.
 */
export interface LifecycleRoom {
  roomId: string;
  setState(state: GameStateSchema): void;
  onMessage(type: string, callback: (client: Client, data: InputMessage) => void): void;
  setSimulationInterval(callback: (deltaTime: number) => void, interval: number): void;
  allowReconnection(client: Client, seconds: number): Promise<void>;
  broadcast(type: string, message: unknown): void;
  disconnect(): void;
  maxClients: number;
  patchRate: number;
  maxMessagesPerSecond: number;
  clock: Room['clock'];
  clients: Client[];
  orchestrator: GameOrchestrator;
  matchMeta: MatchMeta;
  gameConfig: GameConfig;
  botManager: BotManager;
  botFillTo: number;
  mapGrid: TileType[][];
  enrichedData: EnrichedMapData | null;
  /**
   * The frozen map-identity bundle (Named Districts program, ADR-0038) —
   * every identity stream the shared generation authors, in one value
   * object. See `MapIdentityManifest` for the per-stream docs and the
   * wire vs generation-only split.
   */
  mapManifest: MapIdentityManifest;
  pathfinder: Pathfinder;
  removedPlayers: Set<string>;
  spectatorFollowTargets: Map<string, string>;
  botTakenOver: Set<string>;
  lastChatTime: Map<string, number>;
  syncTickCounter: number;
  readonly syncEveryN: number;

  getOrchestrator(): GameOrchestrator;
  recordInputTime(playerId: string): void;
  syncState(): void;
  buildMapDataPayload(): Record<string, unknown>;
  onSimulationTick(deltaTime: number): void;
  matchStarted: boolean;
}

export function handleOnCreate(ctx: LifecycleRoom, options: GameRoomOptions): void {
  const parsed = GameRoomOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(`Invalid room options: ${parsed.error.message}`);
  }

  const matchId = options.matchId ?? `match-${Date.now()}`;
  const config = structuredClone(options.config ?? DEFAULT_CONFIG);

  // Single-player / low-bot test scenes (botFillTo < 2) should not auto-win
  // the instant the countdown ends. Force last-standing (1) so the match
  // ends when one player remains, rather than 0 which disables match-end.
  const effectiveBotFill = options.botFillTo ?? 4;
  if (effectiveBotFill < 2) {
    config.match.lastStandingThreshold = 1;
  }

  ctx.gameConfig = config;

  ctx.setState(new GameStateSchema());

  const seed = options.seed ?? Date.now() & 0xffffffff;
  const { mapResult, enrichedData } = buildGameMapResult(options, seed, config.map);
  ctx.enrichedData = enrichedData;
  // Lighting-hierarchy discipline report (map-redesign ticket 05 / DEC-005):
  // built AFTER the orchestrator hydrates the map entities so the report's
  // no-unbacked-lights audit (map-polish ticket 09) runs against the REAL
  // hydrated destructibles — the final placement list (post hue enforcement)
  // + the grid, with the effective tier lookup (base pyramid + per-match hot
  // upgrade) for the COLD-sector dark-pocket stats. Read by the benchmark
  // generation manifest (hue/value-band violations are logged there).
  // Map-polish ticket 10: the map's sector-border connections drive the
  // doorway sconce-pair audit (doorwaySconcePairs / doorwayAsymmetric) in the
  // same manifest section. Demo-TMX maps carry no `rawMapData` ⇒ the audit
  // stays 0/0.
  const baseTiers = mapResult.sectorTiers;
  const baseHot = mapResult.hotSector ?? { row: -1, col: -1 };
  ctx.gameConfig.map.arenaWidth = enrichedData.width;
  ctx.gameConfig.map.arenaHeight = enrichedData.height;

  ctx.mapGrid = mapResult.grid;
  ctx.orchestrator = createGameOrchestrator(
    matchId,
    config,
    mapResult,
    ctx.enrichedData ?? undefined,
  );
  registerSimulation(ctx.roomId, ctx.orchestrator.getSimulation());

  // Map-polish ticket 09: the audit cross-checks placements against the live
  // hydrated entity list (both directions — every non-exempt placement has
  // exactly one backing destructible, every 'light' entity has exactly one
  // backing placement). No ticks have run, so this is pure generation output.
  const hydratedDestructibles = [
    ...ctx.orchestrator.getMatch().getState().destructibles.values(),
  ].map((d) => ({ id: d.id, type: d.type, x: d.position.x, y: d.position.y }));
  const lightingReport = buildLightingReport(
    ctx.enrichedData?.entities.lightPlacements ?? [],
    ctx.enrichedData?.grid ?? [],
    ctx.enrichedData?.lightingEnforcements ?? [],
    baseTiers && baseTiers.length > 0
      ? (row: number, col: number) =>
          effectiveSectorTier({ tiers: baseTiers, hotSector: baseHot }, row, col)
      : undefined,
    mapResult.rawMapData?.connections ?? [],
    hydratedDestructibles,
  );

  // The ONE map-identity construction site: every identity stream the shared
  // generation authors (tiers/names/designation/landmarks/fortress/identity/
  // skeletons/audit/zone seed) plus the lighting report, frozen into a
  // single value object. `buildMapDataPayload` spreads the client-facing
  // subset; the benchmark generation manifest reads the audit fields. See
  // `MapIdentityManifest` for the per-stream wire vs generation-only split.
  ctx.mapManifest = buildMapIdentityManifest(mapResult, lightingReport);

  ctx.matchMeta = {
    matchId,
    mapSeed: seed,
    mapWidth: mapResult.grid[0]?.length ?? config.map.arenaWidth,
    mapHeight: mapResult.grid.length ?? config.map.arenaHeight,
  };
  ctx.botFillTo = Math.max(0, Math.min(options.botFillTo ?? 4, config.match.maxPlayers));

  ctx.botManager = new BotManager();
  ctx.botManager.setDifficulty(options.botDifficulty ?? 'normal');
  ctx.botManager.setAverageMmr(options.averageMmr);
  ctx.pathfinder = createPathfinder(ctx.mapGrid, ctx.gameConfig.map.tileWidth);

  // ZONE FEED (perf-arc ticket 17): the bot snapshot sync reads zone state
  // straight from the zoneService/siegeWallManager — the retired path was a
  // closure over orchestrator.getMatchState() (a full wire projection per
  // tick just to feed 2 zone fields).
  const botSystem = new BotSystem(
    ctx.orchestrator.getMatch(),
    ctx.pathfinder,
    ctx.orchestrator.getZoneFeed(),
  );
  // READ-ONLY map identity for the bot macro-goal generator (bot-ai-v2
  // ticket 07, DEC-008): effective sector tiers (base + per-match hot), POI
  // names and hero-landmark anchors, consumed as loot-goal flavor. The AI
  // never mutates map data — server-authoritative generation stays intact.
  // Tier-less maps (demo TMX: no sectorTiers) yield null → tier-blind AI.
  botSystem.setMapIdentity(
    buildMapIdentityView({
      cols: SECTOR_GRID_SIZE,
      rows: SECTOR_GRID_SIZE,
      mapWidth: (ctx.mapGrid[0]?.length ?? 0) * ctx.gameConfig.map.tileWidth,
      mapHeight: ctx.mapGrid.length * ctx.gameConfig.map.tileWidth,
      tilePixelSize: ctx.gameConfig.map.tileWidth,
      sectorTiers: mapResult.sectorTiers,
      hotSector: mapResult.hotSector,
      poiNames: mapResult.poiNames,
      landmarkTiles: mapResult.landmarks?.heroes,
    }),
  );
  ctx.orchestrator.setBotSystem(botSystem);
  ctx.botManager.setBotSystem(botSystem);

  ctx.botManager.spawnBots(ctx.orchestrator, 0, ctx.botFillTo, ctx.clock);

  ctx.orchestrator.attachSnapshotSink({
    onSnapshotTick: () => {
      ctx.syncTickCounter++;
      if (ctx.syncTickCounter >= ctx.syncEveryN) {
        ctx.syncTickCounter = 0;
        ctx.syncState();
      }
    },
  });

  registerInputHandler(ctx);
  registerChatHandler(ctx, ctx.lastChatTime);

  ctx.onMessage('requestMapData', (client: Client) => {
    client.send('mapData', ctx.buildMapDataPayload());
  });

  // Debug: set player health (for automated testing)
  ctx.onMessage('debug:setHealth', (client: Client, data: unknown) => {
    const payload = data as { health: number };
    const state = ctx.orchestrator.getMatchState();
    const player = state.players.get(client.sessionId);
    if (player) {
      player.health = new Health(
        Math.max(0, Math.min(payload.health, player.health.max)),
        player.health.max,
      );
      ctx.syncState();
      logger.info('debug:setHealth', { clientId: client.sessionId, health: payload.health });
    }
  });

  // Forward Colyseus's real-elapsed deltaTime (the callback's arg) into the
  // sim — see GameRoom.onSimulationTick for why this matters.
  ctx.setSimulationInterval((deltaTime) => ctx.onSimulationTick(deltaTime), NETWORK.TICK_INTERVAL);

  ctx.syncState();
}

export function handleOnAuth(_client: Client, options: { token?: string }): { authorized: true } {
  if (typeof options.token !== 'string' || options.token.length < 16)
    throw new Error('Invalid session token');
  return { authorized: true };
}

export function handleOnJoin(ctx: LifecycleRoom, client: Client, options: { name?: string }): void {
  ctx.removedPlayers.delete(client.sessionId);
  const playerId = client.sessionId;
  const reconnectionManager = ctx.orchestrator.getReconnectionManager();

  if (reconnectionManager.isTakenOver(playerId) || ctx.botTakenOver.has(playerId)) {
    const player = ctx.orchestrator.getPlayer(playerId);
    if (player && player.isActive) {
      client.send(NetworkChannel.RECONNECT_AS_SPECTATOR, {
        reason: 'bot_active',
        playerId,
        botPlayerId: playerId,
      });
    } else {
      client.send(NetworkChannel.RECONNECT_AS_SPECTATOR, {
        reason: 'bot_died',
        playerId,
      });
    }
    ctx.syncState();
    return;
  }

  const name = options.name ?? 'Player';
  ctx.orchestrator.addPlayer(client.sessionId, name);

  if (!ctx.orchestrator.isRunning && ctx.orchestrator.getPhase() !== MatchPhase.FINISHED) {
    ctx.orchestrator.start();
  }

  ctx.botManager.removeBotForRealPlayer(ctx.orchestrator);
  reconnectionManager.recordInput(client.sessionId);
  ctx.syncState();
}

export async function handleOnDrop(ctx: LifecycleRoom, client: Client): Promise<void> {
  logger.info(`client ${client.sessionId} dropped (onDrop)`);
  const player = ctx.orchestrator.getPlayer(client.sessionId);
  if (!player || !player.isActive) {
    logger.info(`client ${client.sessionId} not active, removing immediately`);
    if (!ctx.removedPlayers.has(client.sessionId)) {
      ctx.removedPlayers.add(client.sessionId);
      ctx.orchestrator.removePlayer(client.sessionId);
    }
    return;
  }

  player.connectionState = 'disconnected';
  player.connected = false;

  const reconnectionManager = ctx.orchestrator.getReconnectionManager();
  reconnectionManager.onDisconnect(client.sessionId);

  try {
    await ctx.allowReconnection(client, MATCH.DISCONNECT_PHASE1_DURATION);
    reconnectionManager.onReconnect(client.sessionId);
    player.connectionState = 'connected';
    player.connected = true;
    player.inputSuppressed = false;
    ctx.syncState();
    const state = ctx.orchestrator.getMatchState();
    const playerState = state.players.get(client.sessionId);
    if (playerState) {
      client.send(NetworkChannel.PLAYER_RESYNC, {
        sessionId: client.sessionId,
        x: playerState.movement.position.x,
        y: playerState.movement.position.y,
        health: playerState.health.current,
        maxHealth: playerState.health.max,
        status: playerState.statusEffects.status,
        activeSlot: playerState.inventory.activeSlot,
        inventorySize: PLAYER.INVENTORY_SIZE,
      });
    }
  } catch {
    // Phase 1 expired, Phase 2/3 handled by InMatchReconnectionManager.tick()
  }
}

export function handleOnLeave(ctx: LifecycleRoom, client: Client): void {
  logger.info(
    `client ${client.sessionId} left (onLeave), clients remaining: ${ctx.clients.length}`,
  );
  ctx.spectatorFollowTargets.delete(client.sessionId);
  ctx.botTakenOver.delete(client.sessionId);
  ctx.lastChatTime.delete(client.sessionId);
  ctx.orchestrator.getReconnectionManager().removePlayer(client.sessionId);
  if (!ctx.removedPlayers.has(client.sessionId)) {
    ctx.removedPlayers.add(client.sessionId);
    ctx.orchestrator.removePlayer(client.sessionId);
  }
  const realPlayerCount = ctx.clients.length;
  ctx.botManager.spawnBots(ctx.orchestrator, realPlayerCount, ctx.botFillTo, ctx.clock);
  ctx.syncState();

  const humanCount = ctx.clients.filter((c) => !ctx.botManager.hasBot(c.sessionId)).length;
  logger.info(`onLeave check: humanCount=${humanCount}, phase=${ctx.orchestrator.getPhase()}`);
  if (humanCount === 0) {
    logger.info(`disposing room - no humans remaining`);
    ctx.broadcast(NetworkChannel.MATCH_CANCELLED, { reason: 'all_players_disconnected' });
    ctx.botManager.dispose();
    ctx.clock.setTimeout(() => ctx.disconnect(), 2000);
  }
}

export function handleOnDispose(ctx: LifecycleRoom): void {
  logger.info(`[Room] onDispose (${ctx.roomId}) — cleaning up room state`);
  unregisterSimulation(ctx.roomId);
  ctx.botManager.dispose();
  ctx.orchestrator.stop();
  ctx.removedPlayers.clear();
  ctx.spectatorFollowTargets.clear();
  ctx.botTakenOver.clear();
  ctx.lastChatTime.clear();
  ctx.mapGrid = [];
}

import {
  ZONE,
  DamageType,
  SeededRNG,
  collectZoneBiasAnchors,
  deriveZoneSeed,
  type GameConfig,
  type EnrichedMapData,
  type TileVisual,
  emptyTileVisual,
  selectTileVisual,
} from '@sector-battle/shared';
import { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../domain/aggregates/createMatchServices.ts';
import {
  CollisionService,
  MovementService,
  MatchFlowService,
  EliminationService,
  SuddenDeathService,
  ZoneService,
  SpawnService,
  SiegeService,
  MapSiegeService,
  SiegeWallManager,
  InMatchReconnectionManager,
} from '../../domain/services/index.ts';
import type { MapResult } from '../../domain/services/MapGenerator.ts';
import { GameSimulation } from '../simulation/index.ts';
import { JoinMatchCommand, LeaveMatchCommand } from '../commands/index.ts';
import { GameOrchestrator, type OrchestratorServices } from './GameOrchestrator.ts';
import { MapEntityFactory } from './MapEntityFactory.ts';

/** Atomic factory for {@link GameOrchestrator}: builds the real match from `mapResult`. Setters stay post-construction (issue #13, Q2). */
export function createGameOrchestrator(
  matchId: string,
  config: GameConfig,
  mapResult: MapResult,
  enrichedData?: EnrichedMapData,
): GameOrchestrator {
  const services = createMatchServices(config);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(mapResult.seed || 12345);
  const match = new GameMatch(
    matchId,
    config,
    mapResult.grid,
    mapResult.spawnPoints,
    services,
    pools,
    lootRng,
  );

  if (enrichedData) {
    const mergedVisuals = buildMergedVisuals(enrichedData);
    match.setRangedColliderData({
      atlas: enrichedData.atlas,
      visuals: mergedVisuals,
      tileSize: enrichedData.tileSize,
    });
    // The match's own collision service (from createMatchServices) is a
    // separate instance from the movement service's. Wire enriched SAT
    // colliders to both so melee sweep (match.getCollisionService()) and
    // the blade Wall-clamp (movement service) share the same collider data.
    match.getCollisionService().setEnrichedGrid({
      grid: enrichedData.grid,
      visuals: mergedVisuals,
      atlas: enrichedData.atlas,
    });
  }

  const movementService = createMovementService(config, enrichedData);
  const collisionService = movementService.getCollisionService();
  collisionService.registerSiegeWallCollider();
  const simulation = new GameSimulation(match, movementService);
  const joinCommand = new JoinMatchCommand(match, config.match.maxPlayers);
  const leaveCommand = new LeaveMatchCommand(match);
  const matchFlow = new MatchFlowService();
  const eliminationService = new EliminationService();
  const suddenDeathService = new SuddenDeathService();

  const siegeConfig = {
    sectorGridSize: Math.ceil(config.map.arenaWidth / config.map.sectorSize),
    sectorTileSize: config.map.sectorSize,
    tilePixelSize: config.map.tileWidth,
  };
  const siegeService = new SiegeService(siegeConfig);
  // Sized to the live map grid (same dims expression MapSiegeService receives
  // below) — one flat allocation per match, no per-tick allocation.
  const siegeWallManager = new SiegeWallManager(
    mapResult.grid[0]?.length ?? config.map.arenaWidth,
    mapResult.grid.length ?? config.map.arenaHeight,
  );
  const mapSiegeService = new MapSiegeService(
    siegeWallManager,
    mapResult.grid[0]?.length ?? config.map.arenaWidth,
    mapResult.grid.length ?? config.map.arenaHeight,
    config.map.tileWidth,
    config.map.sectorSize,
  );
  // `currentTick` for siege crush damage is captured at construction time. The
  // match has not yet ticked, so this is `0` — byte-identical to the legacy
  // `initialize()` path which read `this.match.currentTick` (also 0) at the
  // same construction-time call site.
  const currentTick = 0;
  mapSiegeService.setEntityContext({
    getDestructibleAtTile: (gx: number, gy: number) => match.findDestructibleAtTile(gx, gy),
    destroyDestructible: (id: string) => {
      match.destroyDestructible(id);
    },
    getChestAtTile: (gx: number, gy: number) => match.findChestAtTile(gx, gy),
    removeChest: (id: string) => {
      match.removeChestById(id);
    },
    getWeaponPickupAtTile: (gx: number, gy: number) => match.findWeaponPickupAtTile(gx, gy),
    removeWeaponPickup: (id: string) => {
      match.removeWeaponPickupById(id);
    },
    getPowerUpAtTile: (gx: number, gy: number) => match.findPowerUpAtTile(gx, gy),
    removePowerUp: (id: string) => {
      match.removePowerUpById(id);
    },
    getTrapAtTile: (gx: number, gy: number) => match.findTrapAtTile(gx, gy),
    removeTrap: (id: string) => {
      match.removeTrapById(id);
    },
    crushPlayersOnTile: (gx: number, gy: number) => {
      for (const player of match.getPlayers()) {
        const grid = match.worldToGrid(player.movement.position.x, player.movement.position.y);
        if (grid.gridX !== gx || grid.gridY !== gy) continue;
        if (player.isActive) {
          const result = match.getDamagePipeline().processDamage(
            {
              sourceId: 'siege',
              damage: ZONE.SIEGE_CRUSH_DAMAGE,
              damageType: DamageType.SIEGE_CRUSH,
              targetIds: [player.id],
              sourcePosition: { x: player.movement.position.x, y: player.movement.position.y },
              currentTick,
              alivePlayerCount: match.getAlivePlayerCount(),
            },
            (id: string) => match.getPlayer(id),
          );
          for (const evt of result.events) {
            match.emitEvent(evt);
          }
        }
        if (player.isDying()) {
          player.completeDeath();
        }
      }
    },
    setSiegeWallCollider: (gx: number, gy: number) => {
      collisionService.setSiegeWallEnriched(gx, gy);
    },
  });

  const zoneService = new ZoneService();
  // Zone determinism (map-redesign ticket 09 / DEC-008.1, GDD §5.4): the zone
  // RNG derives from the FINAL map seed on an isolated XOR-salted,
  // avalanche-mixed stream (`deriveZoneSeed`) — NOT `Date.now()`. Wall clock
  // no longer influences zone GEOMETRY (phase timing still reads clocks per
  // the existing architecture). Same map seed ⇒ identical zone center
  // sequence.
  zoneService.initialize(
    {
      width: config.map.arenaWidth * config.map.tileWidth,
      height: config.map.arenaHeight * config.map.tileHeight,
    },
    deriveZoneSeed(mapResult.seed),
  );
  zoneService.configure({
    phases: config.zone.phases,
    transitionDuration: config.zone.transitionDuration,
    warningDuration: config.zone.warningTime,
  });
  zoneService.setGrid(mapResult.grid);
  // Landmark-biased endgame (ticket 09 / DEC-008.2): hero-POI + compound
  // anchors from the shared MapData — the final-phase center is drawn toward
  // structured ground (weighted-random, never forced). Empty on demo-TMX
  // maps (no landmark assignment) — the bias stays off there.
  if (mapResult.landmarks) {
    zoneService.setLandmarkBias(
      collectZoneBiasAnchors(
        { landmarks: mapResult.landmarks, fortress: mapResult.fortress ?? null },
        config.map.tileWidth,
      ),
    );
  }
  const reconnectionManager = new InMatchReconnectionManager();
  simulation.attachRuntimeServices({ zoneService, matchFlow, reconnectionManager });
  // The factory cannot know the snapshot callback at construction time (issue
  // #13, Q2 — it arrives after bot spawn via attachSnapshotSink, and 2 of 3
  // call sites never set it). Wire it post-construction.

  const spawnService = new SpawnService();
  spawnService.initialize(mapResult.spawnPoints);
  spawnService.setValidationContext({
    grid: mapResult.grid,
    tileWidth: config.map.tileWidth,
    tileHeight: config.map.tileHeight,
    hasSiegeWall: (gx: number, gy: number) => siegeWallManager.hasSiegeWall(gx, gy),
    destructiblePositions: () => {
      const positions: Array<{ gridX: number; gridY: number }> = [];
      for (const [, d] of match.getDestructibles()) {
        positions.push({
          gridX: Math.floor(d.position.x / config.map.tileWidth),
          gridY: Math.floor(d.position.y / config.map.tileHeight),
        });
      }
      return positions;
    },
  });

  new MapEntityFactory().populate(match, mapResult, config);

  const orchestratorServices: OrchestratorServices = {
    match,
    simulation,
    joinCommand,
    leaveCommand,
    matchFlow,
    eliminationService,
    suddenDeathService,
    siegeService,
    siegeWallManager,
    mapSiegeService,
    zoneService,
    spawnService,
    reconnectionManager,
  };
  return new GameOrchestrator(matchId, config, orchestratorServices);
}

export function createMovementService(
  config: GameConfig,
  enrichedData?: EnrichedMapData,
): MovementService {
  const collisionService = new CollisionService(config.map.tileWidth);
  if (enrichedData) {
    const mergedVisuals = buildMergedVisuals(enrichedData);
    collisionService.setEnrichedGrid({
      grid: enrichedData.grid,
      visuals: mergedVisuals,
      atlas: enrichedData.atlas,
    });
  }
  const maxSpeed = config.player.baseSpeed * config.player.dashSpeedMultiplier * 1.5;
  return new MovementService(collisionService, maxSpeed, config.map.tileWidth);
}

function buildMergedVisuals(data: EnrichedMapData): TileVisual[][] {
  const result: TileVisual[][] = [];
  for (let y = 0; y < data.height; y++) {
    const row: TileVisual[] = [];
    for (let x = 0; x < data.width; x++) {
      // selectTileVisual is the single shared predicate — the client's
      // findCellVisual calls the same function, so both sides always resolve a
      // tile to the same visual (last layer with spriteId>=0 wins).
      row.push(selectTileVisual(data.visualLayers, x, y) ?? emptyTileVisual());
    }
    result.push(row);
  }
  return result;
}

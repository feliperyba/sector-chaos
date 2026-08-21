import {
  TileType,
  IdGenerator,
  weaponRegistry,
  DURABILITY_BY_TIER,
  SeededRNG,
  NETWORK,
  type GameConfig,
  type ZoneState,
} from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import {
  Player,
  Explosion,
  Destructible,
  PowerUp,
  WeaponEntity,
  WeaponPickup,
  Chest,
} from '../entities/index.ts';
import { BarrelExplosionManager } from './BarrelExplosionManager.ts';
import type { DomainSpatialIndex } from './DomainSpatialIndex.ts';
import { ChestOpeningHandler } from '../handlers/ChestOpeningHandler.ts';
import type { GameEvent } from '../events/index.ts';
import type { DamagePipeline } from '../services/DamagePipeline.ts';
import type { LootService } from '../services/LootService.ts';
import type { ChestOpeningHandlerContext } from '../handlers/ChestOpeningHandler.ts';
import type { TileColliderData } from '@sector-battle/shared';
import { setTileAt as setTileAtFn } from './GameMatchGrid.ts';
import * as EntityOps from './GameMatchEntityOps.ts';
import { tileIndexRemoveAt, type TileEntityIndex } from './GameMatchTileIndex.ts';
import type { ICollisionService } from '../services/ICollisionService.ts';
import type { MatchServices } from './createMatchServices.ts';

export interface BarrelExplosionDeps {
  players: Map<string, Player>;
  explosions: Map<string, Explosion>;
  destructibles: Map<string, Destructible>;
  grid: TileType[][];
  config: GameConfig;
  idGenerator: IdGenerator;
  damagePipeline: DamagePipeline;
  lootService: LootService;
  lootRng: SeededRNG;
  getAlivePlayerCount: () => number;
  clearTileColliderVisual: (gx: number, gy: number) => void;
  markGridDirty: () => void;
  /** ticket 08 — bumps GameMatch.destructibleVersion (static-row sync gate). */
  onDestructiblesMutated: () => void;
  /** siege-tile-index (ticket 09) — see BarrelExplosionContext member. */
  onDestructibleMapDelete: (id: string, gx: number, gy: number) => void;
  addWeaponPickup: (id: string, weapon: WeaponEntity, pos: Position) => void;
  addPowerUp: (p: PowerUp) => void;
  currentTick: () => number;
  /** server-barrel-spatial-query: live read of the match's step2-rebuilt index. */
  getSpatialIndex: () => DomainSpatialIndex | null;
}

export function createBarrelExplosionManager(deps: BarrelExplosionDeps): BarrelExplosionManager {
  return new BarrelExplosionManager({
    players: deps.players,
    explosions: deps.explosions,
    destructibles: deps.destructibles,
    grid: deps.grid,
    config: deps.config,
    idGenerator: deps.idGenerator,
    damagePipeline: deps.damagePipeline,
    siegeWallManager: { hasSiegeWall: () => false },
    getAlivePlayerCount: deps.getAlivePlayerCount,
    getSpatialIndex: deps.getSpatialIndex,
    clearTileColliderVisual: deps.clearTileColliderVisual,
    markGridDirty: deps.markGridDirty,
    onDestructiblesMutated: deps.onDestructiblesMutated,
    onDestructibleMapDelete: deps.onDestructibleMapDelete,
    onDestructibleDestroyedByExplosion: (position, type) => {
      if (type !== 'crate') return null;
      const crateLoot = deps.lootService.rollCrateLoot(deps.lootRng);
      if (!crateLoot) return null;
      if (crateLoot.kind === 'weapon') {
        const pool = weaponRegistry.getSpawnableTypes();
        const weaponType = deps.lootRng.weightedPick(pool.map((w) => ({ item: w, weight: 1 })));
        const definition = weaponRegistry.getDefinition(weaponType);
        const ammo = DURABILITY_BY_TIER[crateLoot.tier];
        const cooldownTicks = Math.ceil(definition.baseStats.cooldown / NETWORK.TICK_INTERVAL);
        const weapon = new WeaponEntity(
          deps.idGenerator.next(),
          weaponType,
          crateLoot.tier,
          ammo,
          ammo,
          cooldownTicks,
        );
        deps.addWeaponPickup(weapon.id, weapon, new Position(position.x, position.y));
        return { weaponType, tier: crateLoot.tier };
      }
      const powerUp = PowerUp.create(
        deps.idGenerator.next(),
        crateLoot.powerUpType,
        new Position(position.x, position.y),
        deps.currentTick(),
      );
      deps.addPowerUp(powerUp);
      return null;
    },
  });
}

export function initZoneState(mapWidth: number, mapHeight: number): ZoneState {
  return {
    currentPhase: 0,
    centerX: mapWidth / 2,
    centerY: mapHeight / 2,
    targetCenterX: mapWidth / 2,
    targetCenterY: mapHeight / 2,
    isTransitioningCenter: false,
    currentRadius: Math.max(mapWidth, mapHeight),
    targetRadius: Math.max(mapWidth, mapHeight),
    shrinkSpeed: 0,
    damagePerTick: 0,
    nextShrinkTick: 0,
    phaseStartTime: 0,
    phaseEndTime: 0,
    nextPhasePreview: null,
  };
}

export interface ChestContextDeps {
  getPlayer: (id: string) => Player | undefined;
  getChests: () => import('../entities/Chest.ts').Chest[];
  getCurrentTick: () => number;
  emitEvent: (event: GameEvent) => void;
  setTileAt: (gx: number, gy: number, type: TileType) => void;
  worldToGrid: (wx: number, wy: number) => { gridX: number; gridY: number };
  addWeaponPickup: (id: string, weapon: WeaponEntity, pos: Position) => void;
  addPowerUp: (p: PowerUp) => void;
  removeChest: (id: string) => void;
  unregisterChestOpening: (playerId: string, chestId: string) => void;
  getTileAt: (gx: number, gy: number) => TileType;
  nextId: () => string;
  getTileWidth: () => number;
  lootService: LootService;
  lootRng: SeededRNG;
}

export function buildChestOpeningContext(deps: ChestContextDeps): ChestOpeningHandlerContext {
  return {
    getPlayer: deps.getPlayer,
    getChests: deps.getChests,
    getCurrentTick: deps.getCurrentTick,
    emitEvent: deps.emitEvent,
    setTileAt: deps.setTileAt,
    worldToGrid: deps.worldToGrid,
    addWeaponPickup: deps.addWeaponPickup,
    addPowerUp: deps.addPowerUp,
    removeChest: deps.removeChest,
    unregisterChestOpening: deps.unregisterChestOpening,
    getTileAt: deps.getTileAt,
    nextId: deps.nextId,
    getTileWidth: deps.getTileWidth,
    lootService: deps.lootService,
    lootRng: deps.lootRng,
  };
}

export interface MatchHandlerDeps {
  players: Map<string, Player>;
  explosions: Map<string, Explosion>;
  destructibles: Map<string, Destructible>;
  weaponPickups: Map<string, WeaponPickup>;
  grid: TileType[][];
  config: GameConfig;
  idGenerator: IdGenerator;
  services: MatchServices;
  lootRng: SeededRNG;
  colliderData: () => TileColliderData | null;
  collisionService: () => ICollisionService;
  getAlivePlayerCount: () => number;
  markGridDirty: () => void;
  /** ticket 10 — bumps GameMatch.orphanSweepVersion (orphan-sweep dirty gate). */
  bumpOrphanSweepVersion: () => void;
  /** ticket 08 — bumps GameMatch.destructibleVersion (static-row sync gate). */
  onDestructiblesMutated: () => void;
  /** siege-tile-index (ticket 09) — see BarrelExplosionContext member. */
  onDestructibleMapDelete: (id: string, gx: number, gy: number) => void;
  addWeaponPickup: (id: string, weapon: WeaponEntity, pos: Position) => void;
  addPowerUp: (p: PowerUp) => void;
  getPlayer: (id: string) => Player | undefined;
  getChests: () => Chest[];
  getCurrentTick: () => number;
  emitEvent: (event: GameEvent) => void;
  setTileAt: (gx: number, gy: number, type: TileType) => void;
  worldToGrid: (wx: number, wy: number) => { gridX: number; gridY: number };
  removeChest: (id: string) => void;
  unregisterChestOpening: (playerId: string, chestId: string) => void;
  getTileAt: (gx: number, gy: number) => TileType;
  nextId: () => string;
  getTileWidth: () => number;
  getSpatialIndex: () => DomainSpatialIndex | null;
}

export function initMatchHandlers(deps: MatchHandlerDeps): {
  barrelExplosionManager: BarrelExplosionManager;
  chestOpeningHandler: ChestOpeningHandler;
} {
  const barrelExplosionManager = createBarrelExplosionManager({
    players: deps.players,
    explosions: deps.explosions,
    destructibles: deps.destructibles,
    grid: deps.grid,
    config: deps.config,
    idGenerator: deps.idGenerator,
    damagePipeline: deps.services.damagePipeline,
    lootService: deps.services.lootService,
    lootRng: deps.lootRng,
    getAlivePlayerCount: deps.getAlivePlayerCount,
    // ticket 10 — the barrel-ray direct `grid[...] = EMPTY` writes route their
    // side effects through this wiring (its only callers, both immediately
    // after the write), so raise the orphan-sweep gate here.
    clearTileColliderVisual: (gx: number, gy: number) => {
      setTileAtFn(deps.grid, gx, gy, TileType.EMPTY, deps.colliderData(), deps.collisionService());
      deps.bumpOrphanSweepVersion();
    },
    markGridDirty: deps.markGridDirty,
    onDestructiblesMutated: deps.onDestructiblesMutated,
    onDestructibleMapDelete: deps.onDestructibleMapDelete,
    addWeaponPickup: deps.addWeaponPickup,
    addPowerUp: deps.addPowerUp,
    currentTick: () => deps.getCurrentTick(),
    getSpatialIndex: deps.getSpatialIndex,
  });

  const chestOpeningHandler = new ChestOpeningHandler(
    buildChestOpeningContext({
      getPlayer: deps.getPlayer,
      getChests: deps.getChests,
      getCurrentTick: deps.getCurrentTick,
      emitEvent: deps.emitEvent,
      setTileAt: deps.setTileAt,
      worldToGrid: deps.worldToGrid,
      addWeaponPickup: deps.addWeaponPickup,
      addPowerUp: deps.addPowerUp,
      removeChest: deps.removeChest,
      unregisterChestOpening: deps.unregisterChestOpening,
      getTileAt: deps.getTileAt,
      nextId: deps.nextId,
      getTileWidth: deps.getTileWidth,
      lootService: deps.services.lootService,
      lootRng: deps.lootRng,
    }),
  );

  return { barrelExplosionManager, chestOpeningHandler };
}

/**
 * Build the MatchHandlerDeps object from a GameMatch instance. Mechanical
 * extraction from the original GameMatch constructor — same field accesses
 * and callbacks, just relocated so the constructor stays compact.
 *
 * GameMatch exposes the fields this reads (players, explosions, destructibles,
 * weaponPickups, grid, config, idGenerator, lootRng, colliderData,
 * collisionService, spatialIndex) as public.
 */
export function buildMatchHandlerDeps(
  match: MatchHandlerDepsHost,
  services: MatchServices,
): MatchHandlerDeps {
  return {
    players: match.players,
    explosions: match.explosions,
    destructibles: match.destructibles,
    weaponPickups: match.weaponPickups,
    grid: match.grid,
    config: match.config,
    idGenerator: match.idGenerator,
    services,
    lootRng: match.lootRng,
    colliderData: () => match.colliderData,
    collisionService: () => match.collisionService,
    getAlivePlayerCount: () => match.getAlivePlayerCount(),
    markGridDirty: () => match.markGridDirty(),
    bumpOrphanSweepVersion: () => {
      match.orphanSweepVersion++;
    },
    onDestructiblesMutated: () => {
      match.destructibleVersion++;
    },
    // siege-tile-index (ticket 09) — keep the destructible bucket exact when
    // the barrel-chain direct map delete runs.
    onDestructibleMapDelete: (id, gx, gy) =>
      tileIndexRemoveAt(match.tileIndex.destructibles, gx, gy, id),
    addWeaponPickup: (id, w, p) => match.addWeaponPickup(id, w, p),
    addPowerUp: (p) => match.addPowerUp(p),
    getPlayer: (id) => match.getPlayer(id),
    getChests: () => match.getChests(),
    getCurrentTick: () => match.currentTick,
    emitEvent: (e) => match.emitEvent(e),
    setTileAt: (gx, gy, t) => match.setTileAt(gx, gy, t),
    worldToGrid: (wx, wy) => match.worldToGrid(wx, wy),
    removeChest: (id) => match.removeChest(id),
    unregisterChestOpening: (playerId, chestId) =>
      EntityOps.unregisterChestOpening(match.openingChestsByPlayer, playerId, chestId),
    getTileAt: (gx, gy) => match.getTileAt(gx, gy),
    nextId: () => match.idGenerator.next(),
    getTileWidth: () => match.config.map.tileWidth,
    getSpatialIndex: () => match.spatialIndex,
  };
}

/** Structural interface — GameMatch satisfies it. Lets the helper depend on a
 *  narrow shape rather than the whole GameMatch class. */
export interface MatchHandlerDepsHost {
  players: Map<string, Player>;
  explosions: Map<string, Explosion>;
  destructibles: Map<string, Destructible>;
  weaponPickups: Map<string, WeaponPickup>;
  grid: TileType[][];
  config: GameConfig;
  idGenerator: IdGenerator;
  lootRng: SeededRNG;
  colliderData: TileColliderData | null;
  collisionService: ICollisionService;
  getAlivePlayerCount(): number;
  markGridDirty(): void;
  /** ticket 08 — the static-row sync-gate counter bumped by onDestructiblesMutated. */
  destructibleVersion: number;
  /** ticket 10 — the orphan-sweep dirty-gate counter (see GameSimulationLoot). */
  orphanSweepVersion: number;
  /** siege-tile-index (ticket 09) — the per-match tile→ids index (see GameMatch). */
  tileIndex: TileEntityIndex;
  addWeaponPickup(id: string, weapon: WeaponEntity, pos: Position): void;
  addPowerUp(p: PowerUp): void;
  getPlayer(id: string): Player | undefined;
  getChests(): Chest[];
  currentTick: number;
  emitEvent(event: GameEvent): void;
  setTileAt(gx: number, gy: number, type: TileType): void;
  worldToGrid(wx: number, wy: number): { gridX: number; gridY: number };
  removeChest(id: string): void;
  /** server-chest-cancel-index: the per-match player→chest index (see GameMatch). */
  openingChestsByPlayer: EntityOps.ChestOpeningIndex;
  getTileAt(gx: number, gy: number): TileType;
  spatialIndex: DomainSpatialIndex | null;
}

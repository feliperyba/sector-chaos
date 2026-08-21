import { WeaponType, WeaponTier, type TileColliderData } from '@sector-battle/shared';
import type { Projectile } from '../entities/index.ts';
import type { Position } from '../value-objects/index.ts';
import type { GameEvent } from '../events/index.ts';
import type { GameMatch } from './GameMatch.ts';
import { ProjectileCollider } from '../handlers/ProjectileCollider.ts';
import { findTeleportDestination } from './TeleportService.ts';
import { tileIndexRemoveAt } from './GameMatchTileIndex.ts';
import { triggerBarrel as triggerBarrelFn, destroyDestructibleAction } from './GameMatchActions.ts';
import { updateExplosions as updateExplosionsHelper } from './GameMatchCleanup.ts';
import { updateProjectiles } from './GameMatchProjectileUpdater.ts';

/**
 * Projectile / explosion / teleport operations for GameMatch. Mechanical
 * extraction from the original GameMatch class — bodies verbatim.
 *
 * NOTE: GameMatch exposes `players`, `projectiles`, `projectileMeta`,
 * `destructibles`, `grid`, `throwHandler`, `rangedHandler`, `damagePipeline`,
 * `projectilePool`, `explosionPool`, `explosions`, `barrelExplosionManager`,
 * `traps`, `chests`, `weaponPickups`, `powerUps`, `mapWidth`, `mapHeight`,
 * `config`, `tick` as public so these helpers can read them.
 */

export function handleTeleportTrapAction(match: GameMatch, playerId: string): Position | null {
  return findTeleportDestination(
    {
      players: match.players,
      traps: match.traps,
      destructibles: match.destructibles,
      chests: match.chests,
      weaponPickups: match.weaponPickups,
      powerUps: match.powerUps,
      grid: match.grid,
      mapWidth: match.mapWidth,
      mapHeight: match.mapHeight,
      tileWidth: match.config.map.tileWidth,
      tileHeight: match.config.map.tileHeight,
    },
    playerId,
  );
}

export function triggerBarrelExplosionAction(
  match: GameMatch,
  gridX: number,
  gridY: number,
  _range: number,
  _damage: number,
  sourceOwnerId: string,
  currentTick: number,
): GameEvent[] {
  return triggerBarrelFn(match.barrelExplosionManager, gridX, gridY, sourceOwnerId, currentTick);
}

export function updateExplosionsAction(match: GameMatch): void {
  updateExplosionsHelper(match.explosions, match.explosionPool);
}

export function updateProjectilesAction(
  match: GameMatch,
  dt: number,
  onConvertToPickup?: (projectile: Projectile, position: { x: number; y: number }) => void,
  onBoomerangReturn?: (
    weaponType: WeaponType,
    durability: number,
    targetPlayerId: string,
    originalSlot: number,
    tier: WeaponTier,
  ) => void,
): GameEvent[] {
  // server-context-copy-elimination: the update context is built ONCE per
  // match and cached on `match.projectileUpdateCtx`; only the volatile fields
  // (`tick` + the two per-call callbacks) are refreshed. This replaces the
  // former per-tick path — a fresh 13-field source literal here plus a fresh
  // 16-field copy of it inside runProjectileUpdate (deleted) — with zero
  // steady-state allocation.
  //
  // Sharing one context instance across ticks is behavior-identical to the
  // per-tick copy because the copy was always SHALLOW:
  // - `updateProjectiles` never reassigns a `ctx.*` field (it only reads
  //   them); its mutations target map CONTENTS (`ctx.projectiles.get/set/delete`,
  //   `ctx.projectileMeta`) — the same Map objects the copy aliased anyway —
  //   plus the two scratch fields (`deadProjectiles`/`deadSet`), which are
  //   cleared at the top of every call and consumed synchronously within it,
  //   so no state crosses tick boundaries.
  // - Every stable field references a match-lifetime singleton: the maps are
  //   never reassigned, `grid` is mutated in place via `setTileAt` (its only
  //   assignment is the GameMatch constructor), handlers/pool/config are fixed
  //   at construction, and the two closures capture only `match`.
  let ctx = match.projectileUpdateCtx;
  if (!ctx) {
    ctx = {
      projectiles: match.projectiles,
      projectileMeta: match.projectileMeta,
      players: match.players,
      throwHandler: match.throwHandler,
      rangedHandler: match.rangedHandler,
      // server-projectile-collider-unify (ticket 20): the shared projectile
      // hit-test surface both flight models delegate to. Built once with
      // match-lifetime refs; the spatial index + tile-collider data are read
      // through live getters so no per-tick refresh is needed (the step2
      // rebuild and `setRangedColliderDataAction` land in `match.*` fields the
      // getters read at query time). Replaces the former grid / tileWidth /
      // destructibles / spatialIndex ctx bundles.
      projectileCollider: new ProjectileCollider({
        players: match.players,
        destructibles: match.destructibles,
        grid: match.grid,
        tileSize: match.config.map.tileWidth,
        getSpatialIndex: () => match.spatialIndex,
        getTileColliderData: () => match.colliderData,
      }),
      damagePipeline: match.damagePipeline,
      projectilePool: match.projectilePool,
      deadProjectiles: [],
      deadSet: new Set<string>(),
      getAlivePlayerCount: () => match.getAlivePlayerCount(),
      destroyDestructible: (id: string) => match.destroyDestructible(id),
      // ticket 08 — static-row sync gate (see ProjectileUpdateContext).
      onDestructiblesMutated: () => {
        match.destructibleVersion++;
      },
      tick: 0,
      onConvertToPickup: undefined,
      onBoomerangReturn: undefined,
    };
    match.projectileUpdateCtx = ctx;
  }
  ctx.tick = match.tick;
  ctx.onConvertToPickup = onConvertToPickup;
  ctx.onBoomerangReturn = onBoomerangReturn;
  return updateProjectiles(ctx, dt);
}

export function setRangedColliderDataAction(match: GameMatch, data: TileColliderData | null): void {
  // server-projectile-collider-unify (ticket 20): the collider reads this
  // field through its live getter — replaces the former
  // rangedHandler.setColliderData + throwHandler.setColliderData pair.
  match.colliderData = data;
}

export function destroyDestructibleForMatch(
  match: GameMatch,
  id: string,
  droppedLoot?: unknown,
): GameEvent[] {
  return destroyDestructibleAction(
    {
      destructibles: match.destructibles,
      worldToGrid: (wx, wy) => match.worldToGrid(wx, wy),
      setTileAt: (gx, gy, type) => match.setTileAt(gx, gy, type),
      barrelExplosionManager: match.barrelExplosionManager,
      tick: match.tick,
      eventCollector: match.eventCollector,
      // siege-tile-index (ticket 09) — keep the destructible bucket exact when
      // the direct map delete below runs.
      onDestructibleMapDelete: (removedId, gx, gy) =>
        tileIndexRemoveAt(match.tileIndex.destructibles, gx, gy, removedId),
    },
    id,
    droppedLoot,
  );
}

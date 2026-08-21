import type { Position } from '../value-objects/index.ts';
import {
  Player,
  Projectile,
  PowerUp,
  Trap,
  Chest,
  Destructible,
  Exit,
  Explosion,
  WeaponPickup,
  WeaponEntity,
} from '../entities/index.ts';
import type { Interactable } from '../types/Interactable.ts';
import type { TileEntityIndex } from './GameMatchTileIndex.ts';
import { bucketInsert, bucketRemove, tileKeyAt, tileKeyOf } from './GameMatchTileIndex.ts';

export interface EntityMaps {
  players: Map<string, Player>;
  projectiles: Map<string, Projectile>;
  powerUps: Map<string, PowerUp>;
  traps: Map<string, Trap>;
  chests: Map<string, Chest>;
  destructibles: Map<string, Destructible>;
  weaponPickups: Map<string, WeaponPickup>;
  exits: Map<string, Exit>;
  explosions: Map<string, Explosion>;
  projectileMeta: Map<
    string,
    { createdAtTick: number; distanceTraveled: number; embeddedTick: number }
  >;
  /** siege-tile-index (ticket 09) — tile→ids per static-position kind, backing
   *  the find*AtTile lookups. Maintained at every add/remove site of the five
   *  indexed kinds — see GameMatchTileIndex.ts for the site enumeration and
   *  the order-preservation contract. */
  tileIndex: TileEntityIndex;
}

/**
 * Build the per-match `EntityMaps` bundle from a GameMatch's public entity
 * maps — mechanical extraction from the GameMatch constructor (body
 * verbatim). Takes the bundle structurally (GameMatch satisfies `EntityMaps`)
 * to avoid a circular import onto the aggregate itself. ORDERING CONTRACT:
 * reads every member off the match, so the constructor must assign them all
 * (projectileMeta included) before calling this.
 */
export function createEntityMaps(match: EntityMaps): EntityMaps {
  return {
    players: match.players,
    projectiles: match.projectiles,
    powerUps: match.powerUps,
    traps: match.traps,
    chests: match.chests,
    destructibles: match.destructibles,
    weaponPickups: match.weaponPickups,
    exits: match.exits,
    explosions: match.explosions,
    projectileMeta: match.projectileMeta,
    tileIndex: match.tileIndex,
  };
}

/**
 * siege-tile-index (ticket 09): the find*AtTile family below reads the
 * per-tile buckets instead of scanning the whole entity map. Each lookup
 * re-applies the ORIGINAL linear-scan predicate (exact tile containment +
 * the same `isDestroyed`/`isActive` skips) to every bucket candidate in
 * bucket order, which mirrors entity-Map insertion order — same id returned,
 * same tie-break, O(occupants) instead of O(mapSize). See
 * GameMatchTileIndex.ts for the full contract.
 */
export function findDestructibleAtTile(maps: EntityMaps, gx: number, gy: number): string | null {
  const idx = maps.tileIndex;
  const bucket = idx.destructibles.get(tileKeyAt(gx, gy));
  if (!bucket) return null;
  const tw = idx.tileWidth;
  const th = idx.tileHeight;
  for (let i = 0; i < bucket.length; i++) {
    const id = bucket[i]!;
    const d = maps.destructibles.get(id);
    if (
      d &&
      !d.isDestroyed &&
      Math.floor(d.position.x / tw) === gx &&
      Math.floor(d.position.y / th) === gy
    ) {
      return id;
    }
  }
  return null;
}

export function findChestAtTile(maps: EntityMaps, gx: number, gy: number): string | null {
  const idx = maps.tileIndex;
  const bucket = idx.chests.get(tileKeyAt(gx, gy));
  if (!bucket) return null;
  const tw = idx.tileWidth;
  const th = idx.tileHeight;
  for (let i = 0; i < bucket.length; i++) {
    const id = bucket[i]!;
    const c = maps.chests.get(id);
    if (c && Math.floor(c.position.x / tw) === gx && Math.floor(c.position.y / th) === gy) {
      return id;
    }
  }
  return null;
}

export function findWeaponPickupAtTile(maps: EntityMaps, gx: number, gy: number): string | null {
  const idx = maps.tileIndex;
  const bucket = idx.weaponPickups.get(tileKeyAt(gx, gy));
  if (!bucket) return null;
  const tw = idx.tileWidth;
  const th = idx.tileHeight;
  for (let i = 0; i < bucket.length; i++) {
    const id = bucket[i]!;
    const wp = maps.weaponPickups.get(id);
    if (
      wp &&
      wp.isActive &&
      Math.floor(wp.position.x / tw) === gx &&
      Math.floor(wp.position.y / th) === gy
    ) {
      return id;
    }
  }
  return null;
}

export function findPowerUpAtTile(maps: EntityMaps, gx: number, gy: number): string | null {
  const idx = maps.tileIndex;
  const bucket = idx.powerUps.get(tileKeyAt(gx, gy));
  if (!bucket) return null;
  const tw = idx.tileWidth;
  const th = idx.tileHeight;
  for (let i = 0; i < bucket.length; i++) {
    const id = bucket[i]!;
    const pu = maps.powerUps.get(id);
    if (
      pu &&
      pu.isActive &&
      Math.floor(pu.position.x / tw) === gx &&
      Math.floor(pu.position.y / th) === gy
    ) {
      return id;
    }
  }
  return null;
}

export function findTrapAtTile(maps: EntityMaps, gx: number, gy: number): string | null {
  const idx = maps.tileIndex;
  const bucket = idx.traps.get(tileKeyAt(gx, gy));
  if (!bucket) return null;
  const tw = idx.tileWidth;
  const th = idx.tileHeight;
  for (let i = 0; i < bucket.length; i++) {
    const id = bucket[i]!;
    const t = maps.traps.get(id);
    if (t && Math.floor(t.position.x / tw) === gx && Math.floor(t.position.y / th) === gy) {
      return id;
    }
  }
  return null;
}

export function addWeaponPickup(
  maps: EntityMaps,
  id: string,
  weapon: WeaponEntity,
  position: Position,
  tick: number,
  textureKey?: string,
  rotation?: number,
  flipH?: boolean,
  flipV?: boolean,
): void {
  const pickup = WeaponPickup.create(
    id,
    weapon,
    position,
    tick,
    textureKey ?? '',
    rotation ?? 0,
    flipH ?? false,
    flipV ?? false,
  );
  maps.weaponPickups.set(id, pickup);
  bucketInsert(maps.tileIndex.weaponPickups, tileKeyOf(maps.tileIndex, position.x, position.y), id);
}

export function removeWeaponPickup(maps: EntityMaps, id: string): void {
  const wp = maps.weaponPickups.get(id);
  if (wp) {
    bucketRemove(
      maps.tileIndex.weaponPickups,
      tileKeyOf(maps.tileIndex, wp.position.x, wp.position.y),
      id,
    );
  }
  maps.weaponPickups.delete(id);
}

export function getWeaponPickupAt(
  maps: EntityMaps,
  x: number,
  y: number,
  range: number,
): WeaponPickup | undefined {
  const rangeSq = range * range;
  const candidates: Array<{ pickup: WeaponPickup; distSq: number }> = [];
  for (const [, pickup] of maps.weaponPickups) {
    if (!pickup.isActive) continue;
    const dx = pickup.position.x - x;
    const dy = pickup.position.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= rangeSq) {
      candidates.push({ pickup, distSq });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    if (a.distSq !== b.distSq) return a.distSq - b.distSq;
    return Player.tierPriority(b.pickup.weapon.tier) - Player.tierPriority(a.pickup.weapon.tier);
  });
  return candidates[0]!.pickup;
}

export function getInteractablesInRange(
  maps: EntityMaps,
  playerPos: Position,
  range: number,
): Interactable[] {
  const result: Interactable[] = [];
  for (const [, chest] of maps.chests) {
    if (chest.state !== 'closed') continue;
    if (chest.position.distanceTo(playerPos) <= range) {
      result.push({ id: chest.id, position: chest.position, type: 'chest' });
    }
  }
  for (const [, pickup] of maps.weaponPickups) {
    if (!pickup.isActive) continue;
    if (pickup.position.distanceTo(playerPos) <= range) {
      result.push({ id: pickup.id, position: pickup.position, type: 'weapon_pickup' });
    }
  }
  return result;
}

export function addProjectile(maps: EntityMaps, p: Projectile, tick: number): void {
  maps.projectiles.set(p.id, p);
  maps.projectileMeta.set(p.id, {
    createdAtTick: tick,
    distanceTraveled: 0,
    embeddedTick: 0,
  });
}

export function removeProjectile(
  maps: EntityMaps,
  id: string,
  projectilePool: { release(p: Projectile): void },
): void {
  const p = maps.projectiles.get(id);
  if (p) {
    if (p.bouncesRemaining >= 0) {
      const owner = maps.players.get(p.ownerId);
      if (owner) owner.combat.removeThrowInFlight(id);
    }
    projectilePool.release(p);
  }
  maps.projectiles.delete(id);
  maps.projectileMeta.delete(id);
}

export function addExplosion(maps: EntityMaps, e: Explosion): void {
  maps.explosions.set(e.id, e);
}

export function addPowerUp(maps: EntityMaps, p: PowerUp): void {
  maps.powerUps.set(p.id, p);
  bucketInsert(
    maps.tileIndex.powerUps,
    tileKeyOf(maps.tileIndex, p.position.x, p.position.y),
    p.id,
  );
}

export function addTrap(maps: EntityMaps, t: Trap): void {
  maps.traps.set(t.id, t);
  bucketInsert(maps.tileIndex.traps, tileKeyOf(maps.tileIndex, t.position.x, t.position.y), t.id);
}

/** Reusable spatial grid for trap-reveal proximity checks (cleared per call).
 *  Module-level to avoid per-tick allocation; checkTrapReveals is non-reentrant. */
const revealGrid = new Map<number, string[]>();
const revealBucketPool: string[][] = [];

export function checkTrapReveals(maps: EntityMaps, tileWidth: number): void {
  const revealRangePx = 2 * tileWidth;
  // Build a spatial grid of unrevealed traps, then iterate alive players and
  // query only the neighborhood around their cell — O(players × nearby traps)
  // instead of O(players × allTraps), with no per-call array allocation (grid
  // is reused). The cell size equals one tile; the reveal range is 2 tiles, so
  // a player can reveal a trap up to 2 cells away — the lookup must cover ±2
  // cells (a 5×5 neighborhood), not ±1 (3×3), or a trap 2 tiles away would be
  // missed (the original ±1 lookup only reached 1 tile = 128px, but the reveal
  // range is 256px, so traps at exactly 2 tiles were never found).
  const cellSize = tileWidth;
  const inv = 1 / cellSize;
  const cellReach = Math.ceil(revealRangePx / cellSize); // = 2 for the default range
  revealGrid.forEach((bucket) => {
    bucket.length = 0;
    revealBucketPool.push(bucket);
  });
  revealGrid.clear();

  for (const [trapId, trap] of maps.traps) {
    if (trap.isRevealed || trap.position == null) continue;
    const key =
      (Math.floor(trap.position.y * inv) * 100000 + Math.floor(trap.position.x * inv)) | 0;
    let bucket = revealGrid.get(key);
    if (!bucket) {
      bucket = revealBucketPool.pop() ?? [];
      revealGrid.set(key, bucket);
    }
    bucket.push(trapId);
  }

  for (const player of maps.players.values()) {
    if (!player.isActive) continue;
    const pos = player.movement.position;
    if (pos == null) continue;
    const cx = Math.floor(pos.x * inv);
    const cy = Math.floor(pos.y * inv);
    for (let dy = -cellReach; dy <= cellReach; dy++) {
      for (let dx = -cellReach; dx <= cellReach; dx++) {
        const bucket = revealGrid.get((cy + dy) * 100000 + (cx + dx));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const trap = maps.traps.get(bucket[i]!);
          if (!trap || trap.isRevealed || trap.position == null) continue;
          const ddx = Math.abs(pos.x - trap.position.x);
          const ddy = Math.abs(pos.y - trap.position.y);
          if (Math.max(ddx, ddy) <= revealRangePx) {
            trap.reveal();
          }
        }
      }
    }
  }
}

export function addChest(maps: EntityMaps, c: Chest): void {
  maps.chests.set(c.id, c);
  bucketInsert(maps.tileIndex.chests, tileKeyOf(maps.tileIndex, c.position.x, c.position.y), c.id);
}

/**
 * server-chest-cancel-index: player→chest-ids index backing
 * {@linkcode cancelChestOpeningForPlayer}. Entries are added at chest-open
 * START (`OpenChestCommand` success), and removed at CANCEL, COMPLETE
 * (`ChestOpeningHandler`), handler-initiated interrupts, and chest removal.
 * Entries are a conservative SUPERSET of the live 'opening' set (the entity's
 * internal move-interrupt path in `Chest.tickOpening` leaves a stale entry),
 * so the cancel lookup re-checks `state === 'opening'` before interrupting —
 * stale ids are skipped, never mis-interrupted.
 */
export type ChestOpeningIndex = Map<string, Set<string>>;

export function registerChestOpening(
  index: ChestOpeningIndex,
  playerId: string,
  chestId: string,
): void {
  let chestIds = index.get(playerId);
  if (!chestIds) {
    chestIds = new Set();
    index.set(playerId, chestIds);
  }
  chestIds.add(chestId);
}

export function unregisterChestOpening(
  index: ChestOpeningIndex,
  playerId: string,
  chestId: string,
): void {
  const chestIds = index.get(playerId);
  if (!chestIds) return;
  chestIds.delete(chestId);
  if (chestIds.size === 0) index.delete(playerId);
}

/**
 * O(1) replacement for the former full chest-map scan (ran per MOVE/ATTACK
 * input). Interrupts exactly the chests the scan would have: every indexed
 * chest for this player that is still 'opening' and attributed to them.
 */
export function cancelChestOpeningForPlayer(
  maps: EntityMaps,
  index: ChestOpeningIndex,
  playerId: string,
): void {
  const chestIds = index.get(playerId);
  if (!chestIds) return;
  for (const chestId of chestIds) {
    const chest = maps.chests.get(chestId);
    if (chest && chest.state === 'opening' && chest.openingPlayerId === playerId) chest.interrupt();
  }
  index.delete(playerId);
}

export function addDestructible(maps: EntityMaps, d: Destructible): void {
  maps.destructibles.set(d.id, d);
  bucketInsert(
    maps.tileIndex.destructibles,
    tileKeyOf(maps.tileIndex, d.position.x, d.position.y),
    d.id,
  );
}

export function addExit(maps: EntityMaps, e: Exit): void {
  maps.exits.set(e.id, e);
}

/** Drop a to-be-removed chest from the cancel index if it is mid-opening. */
function forgetChestOpening(maps: EntityMaps, index: ChestOpeningIndex, id: string): void {
  const chest = maps.chests.get(id);
  if (chest && chest.state === 'opening' && chest.openingPlayerId) {
    unregisterChestOpening(index, chest.openingPlayerId, id);
  }
}

function unindexFromTile(
  buckets: Map<number, string[]>,
  idx: TileEntityIndex,
  entity: { position: Position } | undefined,
  id: string,
): void {
  if (entity) bucketRemove(buckets, tileKeyOf(idx, entity.position.x, entity.position.y), id);
}

export function removeChestById(maps: EntityMaps, index: ChestOpeningIndex, id: string): void {
  forgetChestOpening(maps, index, id);
  unindexFromTile(maps.tileIndex.chests, maps.tileIndex, maps.chests.get(id), id);
  maps.chests.delete(id);
}

export function removeChest(maps: EntityMaps, index: ChestOpeningIndex, id: string): void {
  forgetChestOpening(maps, index, id);
  unindexFromTile(maps.tileIndex.chests, maps.tileIndex, maps.chests.get(id), id);
  maps.chests.delete(id);
}

export function removeWeaponPickupById(maps: EntityMaps, id: string): void {
  unindexFromTile(maps.tileIndex.weaponPickups, maps.tileIndex, maps.weaponPickups.get(id), id);
  maps.weaponPickups.delete(id);
}

export function removePowerUpById(maps: EntityMaps, id: string): void {
  unindexFromTile(maps.tileIndex.powerUps, maps.tileIndex, maps.powerUps.get(id), id);
  maps.powerUps.delete(id);
}

export function removeTrapById(maps: EntityMaps, id: string): void {
  unindexFromTile(maps.tileIndex.traps, maps.tileIndex, maps.traps.get(id), id);
  maps.traps.delete(id);
}

export function getDestructibles(maps: EntityMaps): Map<string, Destructible> {
  return maps.destructibles;
}

export function getChests(maps: EntityMaps): Chest[] {
  const r: Chest[] = [];
  for (const [, chest] of maps.chests) r.push(chest);
  return r;
}

export function getActiveTraps(maps: EntityMaps): Trap[] {
  return Array.from(maps.traps.values());
}

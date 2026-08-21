/**
 * GameMatchTileIndex.ts — tile-keyed entity index for the five static-position
 * entity kinds (siege-tile-index, perf-arc-neo ticket 09).
 *
 * Replaces the five full-map linear scans behind the siege wall-drop path
 * (`destroyEntitiesOnTile` → `find*AtTile`) — each dropped tile now costs
 * O(occupants of that tile) instead of five O(mapSize) sweeps
 * (02-server-cpu-investigation, finding F1).
 *
 * ORDER-PRESERVATION CONTRACT (gameplay-visible tie-break):
 * The old scans returned the FIRST match in entity-Map iteration order (JS Map
 * insertion order). Buckets are `string[]` lists maintained append-on-add /
 * first-match-remove-on-remove, so a bucket lists its live members in exactly
 * the entity-Map's insertion order (deleting a Map key never reorders the
 * survivors, and the bucket remove preserves the survivors' relative order
 * the same way). The find* lookups re-apply the ORIGINAL per-entity predicate
 * (tile containment + `isDestroyed`/`isActive` flags) to every candidate, so
 * the first candidate that passes is the first Map-order member that passes —
 * identical id, identical selection, identical order.
 *
 * STALE-ENTRY SAFETY (defense in depth): every lookup validates candidates
 * against the live entity Map (`maps.<kind>.get(id)`), so an id that left the
 * Map without an indexed remove can never be returned. Both such sites
 * (`destroyDestructibleAction`, `BarrelExplosionManager` chain deletes) are
 * also hooked for eager removal via `tileIndexRemoveAt` — the validation is a
 * safety net, not the mechanism.
 *
 * POSITION IMMUTABILITY: all five kinds set `position` only in their
 * constructors (readonly on WeaponPickup; never reassigned elsewhere), so an
 * entity's tile never changes after insert and no re-keying is needed.
 *
 * ADD/REMOVE SITE ENUMERATION (every mutation path of the five maps):
 *   indexed adds  — EntityOps addWeaponPickup/addPowerUp/addTrap/addChest/
 *                   addDestructible + hydrateMatchEntities direct sets
 *   indexed removes — EntityOps removeWeaponPickup(+ById)/removePowerUpById/
 *                   removeTrapById/removeChest(+ById)
 *   hooked removes — destroyDestructibleAction + BarrelExplosionManager
 *                   (direct `destructibles.delete`, see above)
 */
export interface TileEntityIndex {
  /** tileKey → entity ids at that tile, in entity-Map insertion order. */
  readonly destructibles: Map<number, string[]>;
  readonly chests: Map<number, string[]>;
  readonly weaponPickups: Map<number, string[]>;
  readonly powerUps: Map<number, string[]>;
  readonly traps: Map<number, string[]>;
  readonly tileWidth: number;
  readonly tileHeight: number;
}

export function createTileEntityIndex(tileWidth: number, tileHeight: number): TileEntityIndex {
  return {
    destructibles: new Map(),
    chests: new Map(),
    weaponPickups: new Map(),
    powerUps: new Map(),
    traps: new Map(),
    tileWidth,
    tileHeight,
  };
}

/** Tile-key stride — gx is always < stride (grid columns are far below 1e5);
 *  same multiplier precedent as checkTrapReveals' reveal grid. */
const TILE_KEY_STRIDE = 100000;

/** Key from integer grid coords (lookup side — the find* seam). */
export function tileKeyAt(gx: number, gy: number): number {
  return gy * TILE_KEY_STRIDE + gx;
}

/** Key from a world position — the exact `worldToGrid` floor math, unrolled
 *  to avoid the `{gridX, gridY}` allocation per indexed add. */
export function tileKeyOf(idx: TileEntityIndex, x: number, y: number): number {
  return Math.floor(y / idx.tileHeight) * TILE_KEY_STRIDE + Math.floor(x / idx.tileWidth);
}

/**
 * Append an id to its tile bucket. Skips when already present: a re-`set` of
 * an existing Map key keeps its ORIGINAL iteration position (it does not move
 * to the end), and the bucket must mirror that — the id stays where it is.
 */
export function bucketInsert(buckets: Map<number, string[]>, key: number, id: string): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = [];
    buckets.set(key, bucket);
  }
  if (bucket.includes(id)) return;
  bucket.push(id);
}

/**
 * Remove an id from its tile bucket (first occurrence; ids are unique per
 * kind, so there is at most one). Drops the bucket when it empties. No-op on
 * a missing id — a lookup that cannot resolve the entity's tile (already
 * deleted from the map) has nothing stale left to clean.
 */
export function bucketRemove(buckets: Map<number, string[]>, key: number, id: string): void {
  const bucket = buckets.get(key);
  if (!bucket) return;
  const i = bucket.indexOf(id);
  if (i >= 0) bucket.splice(i, 1);
  if (bucket.length === 0) buckets.delete(key);
}

/** Convenience for the direct-delete hooks, which know the integer tile. */
export function tileIndexRemoveAt(
  buckets: Map<number, string[]>,
  gx: number,
  gy: number,
  id: string,
): void {
  bucketRemove(buckets, tileKeyAt(gx, gy), id);
}

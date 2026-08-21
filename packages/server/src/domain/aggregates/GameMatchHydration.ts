import { MapEntityHydrator, type HydrationResult } from '../services/MapEntityHydrator.ts';
import type { MapResult } from '../services/MapGenerator.ts';
import type { EntityMaps } from './GameMatchEntityOps.ts';
import { bucketInsert, tileKeyOf } from './GameMatchTileIndex.ts';

/**
 * Hydrate map entities (chests, destructibles, traps, weapon pickups) from
 * a MapResult into the match's entity maps. Mechanical extraction from
 * GameMatch.ts — body verbatim, plus the siege-tile-index (ticket 09) insert
 * alongside each direct map set (this is one of the enumerated add sites).
 */
export function hydrateMatchEntities(
  maps: EntityMaps,
  mapResult: MapResult,
  tileWidth: number,
  mapSeed: number,
): HydrationResult {
  const hydrator = new MapEntityHydrator(mapResult, tileWidth, undefined, mapSeed);
  const { chests, destructibles, traps, weaponPickups } = hydrator.hydrate(mapResult);
  const idx = maps.tileIndex;
  for (const c of chests) {
    maps.chests.set(c.id, c);
    bucketInsert(idx.chests, tileKeyOf(idx, c.position.x, c.position.y), c.id);
  }
  for (const d of destructibles) {
    maps.destructibles.set(d.id, d);
    bucketInsert(idx.destructibles, tileKeyOf(idx, d.position.x, d.position.y), d.id);
  }
  for (const t of traps) {
    maps.traps.set(t.id, t);
    bucketInsert(idx.traps, tileKeyOf(idx, t.position.x, t.position.y), t.id);
  }
  for (const wp of weaponPickups) {
    maps.weaponPickups.set(wp.id, wp);
    bucketInsert(idx.weaponPickups, tileKeyOf(idx, wp.position.x, wp.position.y), wp.id);
  }
  return hydrator.computeResult(chests, destructibles, traps, weaponPickups);
}

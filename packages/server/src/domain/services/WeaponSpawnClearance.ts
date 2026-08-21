/**
 * WeaponSpawnClearance — placement-time axial-cover clearance for ground
 * weapon pickups.
 *
 * Why this exists: weapon pickups hydrate at TILE CENTERS, and the generator's
 * loot placer freely picks walkable tiles that sit flush against walls/crates
 * (the "nook" pattern). Projectiles (arrows AND thrown weapons — the same
 * shared `ProjectileTileCollision`/destructible-scan paths) then die against
 * that cover at the shared tile boundary — up to ~72px past the weapon center
 * — which lands INSIDE the weapon's rendered sprite (weapons render at
 * WEAPON_RENDER_SCALE 1.3 ≈ 166px on a 128px tile). To any player that reads
 * exactly as "the projectile hit the ground weapon".
 *
 * The fix: after map generation (both demo-TMX and procedural paths converge
 * in `buildGameMapResult`), nudge any weapon placement whose tile or 4 axial
 * neighbors touch solid grid onto the nearest tile with clear axial
 * neighborhood. Axial clearance is sufficient at every approach angle: with
 * the nearest axial cover ≥2 tiles away, projectile death points (tile
 * colliders at the cover face, or the destructible entity scan at ≤80px from
 * cover centers) always fall ≥100px from the weapon center — outside its
 * sprite footprint.
 *
 * Determinism: pure function of `mapResult` (fixed ring-scan order), so the
 * same seed always produces the same nudged placements. Mutates
 * `weaponSpawnPlacements` in place; nothing else on MapResult is touched
 * (MapData golden fixtures are upstream and unaffected).
 */
import { TileType } from '@sector-battle/shared';
import type { MapResult } from './MapGenerator.ts';

/** Max ring radius (in tiles) searched for a clear alternative position. */
const MAX_SEARCH_RADIUS = 8;

function isWalkable(tile: TileType | undefined): boolean {
  return tile === TileType.EMPTY || tile === TileType.EXIT;
}

/** A tile's 4 axial neighbors must be walkable (out-of-bounds = blocked). */
function hasAxialClearance(grid: TileType[][], x: number, y: number): boolean {
  if (!isWalkable(grid[y]?.[x])) return false;
  return (
    isWalkable(grid[y - 1]?.[x]) &&
    isWalkable(grid[y + 1]?.[x]) &&
    isWalkable(grid[y]?.[x - 1]) &&
    isWalkable(grid[y]?.[x + 1])
  );
}

/**
 * Nudge weapon placements off axial cover. `claimTiles` (extra `"x,y"` keys
 * to avoid, e.g. already-nudged weapons) lets callers prevent stacking.
 */
export function applyWeaponSpawnClearance(mapResult: MapResult): void {
  const grid = mapResult.grid;
  if (grid.length === 0) return;

  const claimed = new Set<string>();
  const claim = (x: number, y: number) => claimed.add(`${x},${y}`);
  const isClaimed = (x: number, y: number) => claimed.has(`${x},${y}`);

  for (const list of [
    mapResult.destructiblePlacements ?? [],
    mapResult.chestPlacements ?? [],
    mapResult.trapPlacements ?? [],
    mapResult.powerupPlacements ?? [],
  ]) {
    for (const p of list) claim(p.gridX, p.gridY);
  }

  for (const wp of mapResult.weaponSpawnPlacements) {
    const original = { x: wp.gridX, y: wp.gridY };
    let target = original;

    if (!hasAxialClearance(grid, original.x, original.y) || isClaimed(original.x, original.y)) {
      search: for (let r = 1; r <= MAX_SEARCH_RADIUS; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dy) !== r && Math.abs(dx) !== r) continue; // ring cells only
            const x = original.x + dx;
            const y = original.y + dy;
            if (hasAxialClearance(grid, x, y) && !isClaimed(x, y)) {
              target = { x, y };
              break search;
            }
          }
        }
      }
    }

    wp.gridX = target.x;
    wp.gridY = target.y;
    claim(target.x, target.y);
  }
}

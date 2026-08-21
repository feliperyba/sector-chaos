/**
 * TileCollisionQuery.ts — Shared zero-allocation tile overlap query.
 *
 * Single source of truth for the epsilon + iteration bounds used by both the
 * server `CollisionService` and client `ClientCollisionService`. Extracted so
 * that a fix to the epsilon or loop logic propagates to both sides at once —
 * any divergence here causes prediction/reconciliation failures.
 */

/** Epsilon offset to avoid the edge-case where an entity boundary exactly aligns with a tile boundary. */
const TILE_EDGE_EPSILON = 0.001;

/**
 * Calls `callback(gridX, gridY)` for every tile overlapping the given AABB.
 *
 * Zero-allocation: no arrays or objects are created. Iteration order is
 * top-to-bottom (rows), left-to-right (columns) within each row — identical to
 * the legacy `getOverlappingTiles` implementations on both sides.
 *
 * @param x        - AABB top-left X (world space)
 * @param y        - AABB top-left Y (world space)
 * @param width    - AABB width
 * @param height   - AABB height
 * @param tileSize - Tile size in pixels
 * @param callback - Invoked once per overlapping tile with (gridX, gridY)
 */
export function forEachOverlappingTile(
  x: number,
  y: number,
  width: number,
  height: number,
  tileSize: number,
  callback: (gridX: number, gridY: number) => void,
): void {
  const left = Math.floor(x / tileSize);
  const right = Math.floor((x + width - TILE_EDGE_EPSILON) / tileSize);
  const top = Math.floor(y / tileSize);
  const bottom = Math.floor((y + height - TILE_EDGE_EPSILON) / tileSize);
  for (let gy = top; gy <= bottom; gy++) {
    for (let gx = left; gx <= right; gx++) {
      callback(gx, gy);
    }
  }
}

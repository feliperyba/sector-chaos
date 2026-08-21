import { TileType } from '../enums/TileType.js';
import { AABBCollision, type AABB } from '../math/AABBCollision.js';
import type { MTV } from '../math/Vec2.js';
import { forEachOverlappingTile } from './TileCollisionQuery.js';

/**
 * Pooled AABB scratch for the overlapping tile (`resolvePlayerSeparation`'s
 * module-pool pattern). The former per-tile `{ x: gx*tileSize, ... }` literals
 * were allocation-only — `AABBCollision.getMTVInto` reads the four fields and
 * retains nothing — so in-place pooled mutation is numeric-identical. Written
 * on every consulted tile → the module is NOT reentrant; both call contexts
 * (server sim tick, client prediction/replay) are synchronous single-threaded
 * and never nest these calls.
 */
const tileScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };
/**
 * Pooled AABB scratch for the two-axis test boxes. One scratch serves both the
 * X test (`{...entity, x: resolvedX}`) and the Y test (`{...entity, x:
 * resolvedX, y: resolvedY}`) — all four fields are fully rewritten between the
 * two `getMTVInto` reads, so the second test never observes stale fields.
 */
const testScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Tile-blocked predicate for the simple (non-enriched) resolver: out-of-bounds
 * is SOLID, EMPTY/EXIT are walkable, everything else is solid.
 *
 * Verbatim body of the server `CollisionService.isTileBlocked`
 * (CollisionService.ts) and the former client
 * `ClientCollisionService.isTileBlocked` — the two originals were
 * behaviorally identical for every well-formed grid (the only textual
 * difference, `grid[0]?.length ?? 0` vs `grid[0]!.length`, is unobservable
 * whenever row 0 exists, which every produced grid guarantees). Exported so
 * parity tests can pin the predicate itself, not just the resolved positions.
 */
export function isSimpleTileBlocked(grid: TileType[][], gridX: number, gridY: number): boolean {
  if (gridY < 0 || gridY >= grid.length) return true;
  if (gridX < 0 || gridX >= grid[0]!.length) return true;
  const tile = grid[gridY]![gridX]!;
  return tile !== TileType.EMPTY && tile !== TileType.EXIT;
}

/**
 * Resolve an entity AABB against a plain tile grid using per-tile two-axis MTV
 * (the "simple" / non-enriched resolution). This is the SINGLE shared body of
 * the formerly duplicated loops:
 *
 * - server `CollisionService.resolveSimple` (CollisionService.ts) — the
 *   non-enriched branch of `resolveTileCollision`; the server keeps its
 *   try/catch + logged fallback AROUND this call and keeps its outer
 *   dispatcher (`resolveTileCollision`, ADR-0035 divergent surface) unchanged;
 * - client `ClientCollisionService.resolveCollision` fallback branch — taken
 *   when no enriched atlas visual exists (`hasEnriched === false`). Deleted as
 *   a duplicate by the ticket-43 re-triage (option b): the client now
 *   delegates here instead of re-implementing the loop.
 *
 * NOTE the deliberate asymmetry with {@link resolveTileCollisionEnriched}'s
 * no-visual fallback: THAT resolver SKIPS out-of-grid tiles
 * (`grid[gy]?.[gx] === undefined → return`, resolveTileCollision.ts), while
 * this one treats out-of-grid tiles as SOLID full-tile AABBs (via
 * {@link isSimpleTileBlocked}). This is the 31%-divergence surface documented
 * in the ticket-43 re-triage: the two fallbacks are NOT interchangeable, and
 * this helper exists precisely so the client's non-atlas branch keeps the
 * server's OOB=solid semantics without a duplicated loop. Do not "fix" either
 * side to match the other — pick the resolver that matches the required
 * semantics instead.
 *
 * Bit-exactness contract vs both former loops: identical float expressions in
 * identical evaluation order (the pooled scratches hold exactly the values the
 * per-iteration literals held; `getMTVInto` reads only the field values).
 * Proven empirically by the parity sweeps in
 * `client-v3 .../collision/__tests__/simple-fallback-parity.test.ts` and
 * `server tests/domain/services/CollisionServiceSimpleParity.test.ts` against
 * verbatim replicas of both original loops, including out-of-bounds boundary
 * cases.
 *
 * Pure calculator (ADR-0035 §5.4): allocates nothing (module-pooled AABB
 * scratch + caller-owned MTV/out receptacles), reads no state beyond its
 * arguments, no `Math.random`. Server-authoritative: the server calls this
 * inside its authoritative loop and keeps ownership of the result; the client
 * calls it inside prediction/replay only. The caller owns everything around
 * the call (map-bounds clamping, player separation, corner↔center conversion).
 *
 * NOT reentrant (module-pooled scratch); synchronous single-threaded use only.
 *
 * @param entity    Entity AABB (top-left world coords). Read-only — never mutated.
 * @param grid      Tile grid indexed [gridY][gridX]. Must be a well-formed 2D
 *                  array (row 0 exists whenever grid.length > 0); a null/empty
 *                  grid throws, exactly like both former loops did (callers
 *                  that need a safe fallback wrap in try/catch — the server
 *                  keeps its own).
 * @param tileSize  Tile size in pixels.
 * @param mtvScratch Caller-owned MTV receptacle, reused per consulted tile
 *                  (same per-instance-scratch contract as both originals).
 * @param out       Caller-owned receptacle for the resolved top-left position
 *                  (mutated in place; returns nothing).
 */
export function resolveSimpleTileCollision(
  entity: AABB,
  grid: TileType[][],
  tileSize: number,
  mtvScratch: MTV,
  out: { x: number; y: number },
): void {
  let resolvedX = entity.x;
  let resolvedY = entity.y;

  forEachOverlappingTile(
    entity.x,
    entity.y,
    entity.width,
    entity.height,
    tileSize,
    (tileX, tileY) => {
      if (!isSimpleTileBlocked(grid, tileX, tileY)) return;

      // The former per-tile literal `{ x: tileX*tileSize, y: tileY*tileSize,
      // width: tileSize, height: tileSize }`.
      tileScratch.x = tileX * tileSize;
      tileScratch.y = tileY * tileSize;
      tileScratch.width = tileSize;
      tileScratch.height = tileSize;

      // X axis first, from the ORIGINAL entity.y (the former
      // `{ ...entity, x: resolvedX }` spread did not override y).
      testScratch.x = resolvedX;
      testScratch.y = entity.y;
      testScratch.width = entity.width;
      testScratch.height = entity.height;
      if (
        AABBCollision.getMTVInto(testScratch, tileScratch, mtvScratch) &&
        Math.abs(mtvScratch.x) > Math.abs(mtvScratch.y)
      ) {
        resolvedX += mtvScratch.x > 0 ? mtvScratch.depth : -mtvScratch.depth;
      }

      // Y axis second, from the UPDATED resolvedX and the running resolvedY
      // (the former `{ ...entity, x: resolvedX, y: resolvedY }` spread).
      testScratch.x = resolvedX;
      testScratch.y = resolvedY;
      testScratch.width = entity.width;
      testScratch.height = entity.height;
      if (
        AABBCollision.getMTVInto(testScratch, tileScratch, mtvScratch) &&
        Math.abs(mtvScratch.y) >= Math.abs(mtvScratch.x)
      ) {
        resolvedY += mtvScratch.y > 0 ? mtvScratch.depth : -mtvScratch.depth;
      }
    },
  );

  out.x = resolvedX;
  out.y = resolvedY;
}

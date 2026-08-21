import { TileType } from '../enums/TileType.js';
import type { MTV } from '../math/Vec2.js';
import { AABBCollision, type AABB } from '../math/AABBCollision.js';
import { ColliderCollision } from '../math/ColliderCollision.js';
import { forEachOverlappingTile } from './TileCollisionQuery.js';
import type { CollisionGridProvider } from './CollisionGridProvider.js';

/**
 * Pooled AABB scratches (`resolveSimpleTileCollision`'s module-pool pattern,
 * perf ticket 11). The former per-tile literals — the fallback tile box, the
 * two-axis test boxes, and the collider-branch entity box — were
 * allocation-only: every callee (`AABBCollision.getMTVInto`,
 * `ColliderCollision.resolveEntityTileCollidersPolygonsInto`) reads the four
 * fields and retains nothing, and all four fields are fully rewritten between
 * reads, so in-place pooled mutation is numeric-identical (identical float
 * expressions in identical order). Written on every consulted tile → the
 * module is NOT reentrant; both call contexts (server sim tick, client
 * prediction/replay) are synchronous single-threaded and never nest these
 * calls.
 */
const tileScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };
/**
 * One scratch serves both the X test (the former `{ ...entity, x: resolvedX }`
 * spread) and the Y test (the former `{ ...entity, x: resolvedX, y:
 * resolvedY }` spread) — all four fields are fully rewritten between the two
 * `getMTVInto` reads, so the second test never observes stale fields.
 */
const testScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };
/** Entity box for the collider (SAT) branch — the former per-tile literal. */
const entityScratch: AABB = { x: 0, y: 0, width: 0, height: 0 };
/** Caller-visible MTV for the collider branch (the former fresh MTV return). */
const colliderMtvScratch: MTV = { x: 0, y: 0, depth: 0 };

/**
 * Resolve an entity AABB against the enriched tile grid using a single shared
 * algorithm for both server and client.
 *
 * Per overlapping tile:
 *  - skip EMPTY / EXIT / out-of-range grid tiles;
 *  - if the tile has no enriched visual (or spriteId < 0) → full-tile AABB
 *    fallback (two-axis MTV);
 *  - otherwise resolve against the visual's cached world-space collider polygons
 *    (built lazily on first contact) via SAT.
 *
 * Zero-allocation (perf ticket 11): the resolved position is written into the
 * caller-owned `out` receptacle (`resolveSimpleTileCollision`'s contract) and
 * the per-tile boxes/MTV come from the module pool above. The caller owns any
 * post-processing (e.g. the client's map-bounds clamp + center offset). The
 * `mtvScratch` is reused for the AABB-fallback MTV — pass a per-instance
 * scratch to avoid allocation. NOT reentrant (module-pooled scratch);
 * synchronous single-threaded use only.
 */
export function resolveTileCollisionEnriched(
  entity: AABB,
  grid: TileType[][],
  provider: CollisionGridProvider,
  mtvScratch: MTV,
  out: { x: number; y: number },
): void {
  const tileSize = provider.getTileSize();
  let resolvedX = entity.x;
  let resolvedY = entity.y;

  forEachOverlappingTile(entity.x, entity.y, entity.width, entity.height, tileSize, (gx, gy) => {
    const visual = provider.getVisual(gx, gy);
    const gridTile = grid[gy]?.[gx];
    if (gridTile === undefined || gridTile === TileType.EMPTY || gridTile === TileType.EXIT) return;

    if (!visual || visual.spriteId < 0) {
      // AABB fallback — no artist-authored collider for this tile. The former
      // per-tile literals, field-for-field (see the pool docs above).
      tileScratch.x = gx * tileSize;
      tileScratch.y = gy * tileSize;
      tileScratch.width = tileSize;
      tileScratch.height = tileSize;
      const mtv = mtvScratch;

      // X axis first, from the ORIGINAL entity.y (the former
      // `{ ...entity, x: resolvedX }` spread did not override y).
      testScratch.x = resolvedX;
      testScratch.y = entity.y;
      testScratch.width = entity.width;
      testScratch.height = entity.height;
      if (
        AABBCollision.getMTVInto(testScratch, tileScratch, mtv) &&
        Math.abs(mtv.x) > Math.abs(mtv.y)
      ) {
        resolvedX += mtv.x > 0 ? mtv.depth : -mtv.depth;
      }

      // Y axis second, from the UPDATED resolvedX and the running resolvedY
      // (the former `{ ...entity, x: resolvedX, y: resolvedY }` spread).
      testScratch.x = resolvedX;
      testScratch.y = resolvedY;
      testScratch.width = entity.width;
      testScratch.height = entity.height;
      if (
        AABBCollision.getMTVInto(testScratch, tileScratch, mtv) &&
        Math.abs(mtv.y) >= Math.abs(mtv.x)
      ) {
        resolvedY += mtv.y > 0 ? mtv.depth : -mtv.depth;
      }
      return;
    }

    const sprite = provider.getSprite(visual.spriteId);
    if (!sprite || sprite.colliders.length === 0) return;
    if (sprite.tileType === TileType.EMPTY) return;

    // Lazily cache the world-space collider polygons (static geometry).
    if (!visual.cachedWorldPolygons) {
      visual.cachedWorldPolygons = ColliderCollision.buildWorldPolygons(
        sprite.colliders,
        gx,
        gy,
        tileSize,
        visual.rotation,
        visual.flipH,
        visual.flipV,
      );
    }
    entityScratch.x = resolvedX;
    entityScratch.y = resolvedY;
    entityScratch.width = entity.width;
    entityScratch.height = entity.height;
    const mtv = colliderMtvScratch;
    if (
      ColliderCollision.resolveEntityTileCollidersPolygonsInto(
        entityScratch,
        visual.cachedWorldPolygons,
        mtv,
      )
    ) {
      if (Math.abs(mtv.x) >= Math.abs(mtv.y)) {
        resolvedX += mtv.x * mtv.depth;
      } else {
        resolvedY += mtv.y * mtv.depth;
      }
    }
  });

  out.x = resolvedX;
  out.y = resolvedY;
}

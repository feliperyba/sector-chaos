import { TileType } from '../enums/TileType.js';
import type { AABB } from '../math/AABBCollision.js';
import type { MTV } from '../math/Vec2.js';
import { AABBCollision } from '../math/AABBCollision.js';
import { ColliderCollision } from '../math/ColliderCollision.js';
import type { TileColliderData } from '../map/tiledTypes.js';

export interface ProjectileTileCollisionResult {
  collided: boolean;
  mtv: MTV | null;
  tileType: TileType;
  gridX: number;
  gridY: number;
}

/**
 * Module-level scratch result for `checkInto`. Callers MUST consume the fields
 * immediately after a `checkInto` returns true — the next `checkInto`/`check`
 * call overwrites this object. Never retain a reference across calls.
 */
export const projectileTileCollisionScratch: ProjectileTileCollisionResult = {
  collided: false,
  mtv: null,
  tileType: TileType.EMPTY,
  gridX: -1,
  gridY: -1,
};

/** Reusable MTV written into by the collider path + the final winning MTV. */
const scratchResultMTV: MTV = { x: 0, y: 0, depth: 0 };
/** Temp MTV written into by `AABBCollision.getMTVInto` (AABB fallback path). */
const tempMTV: MTV = { x: 0, y: 0, depth: 0 };

export class ProjectileTileCollision {
  /**
   * Zero-allocation collision check. Writes the winning hit (minimum MTV depth)
   * into the module-level {@link projectileTileCollisionScratch} and returns
   * whether a collision occurred. Callers read the scratch fields immediately.
   */
  static checkInto(
    entity: AABB,
    grid: TileType[][],
    tileSize: number,
    colliderData: TileColliderData | null,
  ): boolean {
    const left = Math.floor(entity.x / tileSize);
    const right = Math.floor((entity.x + entity.width - 0.001) / tileSize);
    const top = Math.floor(entity.y / tileSize);
    const bottom = Math.floor((entity.y + entity.height - 0.001) / tileSize);

    const result = projectileTileCollisionScratch;
    let bestDepth = Infinity;
    let found = false;

    for (let gy = top; gy <= bottom; gy++) {
      for (let gx = left; gx <= right; gx++) {
        if (gy < 0 || gy >= grid.length || gx < 0 || gx >= grid[gy]!.length) continue;

        const tileType = grid[gy]![gx]!;

        if (tileType === TileType.EMPTY || tileType === TileType.EXIT) continue;

        // Path 1: collider-data path. When a tile has a registered sprite
        // with one or more colliders, resolve against those colliders
        // (rotated/flipped as configured). If the sprite has zero colliders,
        // the tile is intentionally passable — the AABB fallback is skipped
        // to preserve the "zero colliders = passable" contract.
        if (colliderData !== null) {
          const visual = colliderData.visuals[gy]?.[gx];

          if (visual && visual.spriteId >= 0) {
            const sprite = colliderData.atlas.sprites[visual.spriteId];

            if (sprite && sprite.colliders.length > 0) {
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
              const mtv = ColliderCollision.resolveEntityTileCollidersPolygons(
                entity,
                visual.cachedWorldPolygons,
              );

              if (mtv && mtv.depth < bestDepth) {
                bestDepth = mtv.depth;
                scratchResultMTV.x = mtv.x;
                scratchResultMTV.y = mtv.y;
                scratchResultMTV.depth = mtv.depth;
                result.tileType = tileType;
                result.gridX = gx;
                result.gridY = gy;
                found = true;
              }
            }
            continue;
          }
        }

        // Path 2: AABB fallback. Used when there is no collider data at all
        // (e.g. tests / authoring mode without an atlas) OR when a tile has
        // no per-tile visual entry. Treats any non-EMPTY/non-EXIT tile as a
        // full-tile AABB — this is what blocks projectiles against CHEST,
        // DESTRUCTIBLE_BARREL, DESTRUCTIBLE_CRATE, etc. when no sprite
        // collider is defined.
        const tileAABB: AABB = {
          x: gx * tileSize,
          y: gy * tileSize,
          width: tileSize,
          height: tileSize,
        };
        if (AABBCollision.getMTVInto(entity, tileAABB, tempMTV) && tempMTV.depth < bestDepth) {
          bestDepth = tempMTV.depth;
          scratchResultMTV.x = tempMTV.x;
          scratchResultMTV.y = tempMTV.y;
          scratchResultMTV.depth = tempMTV.depth;
          result.tileType = tileType;
          result.gridX = gx;
          result.gridY = gy;
          found = true;
        }
      }
    }

    result.collided = found;
    result.mtv = found ? scratchResultMTV : null;
    return found;
  }

  /**
   * Allocating collision check (returns a fresh result object). Delegates to
   * {@link checkInto} and snapshots the scratch so callers/tests can retain the
   * result. Prefer {@link checkInto} on hot paths.
   */
  static check(
    entity: AABB,
    grid: TileType[][],
    tileSize: number,
    colliderData: TileColliderData | null,
  ): ProjectileTileCollisionResult {
    if (ProjectileTileCollision.checkInto(entity, grid, tileSize, colliderData)) {
      const s = projectileTileCollisionScratch;
      const mtv = s.mtv;
      return {
        collided: true,
        mtv: mtv ? { x: mtv.x, y: mtv.y, depth: mtv.depth } : null,
        tileType: s.tileType,
        gridX: s.gridX,
        gridY: s.gridY,
      };
    }
    return { collided: false, mtv: null, tileType: TileType.EMPTY, gridX: -1, gridY: -1 };
  }
}

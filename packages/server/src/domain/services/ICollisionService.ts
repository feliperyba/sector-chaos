import type { AABB, TileVisual, TileSpriteAtlas, TileType } from '@sector-battle/shared';

export interface ResolvedPosition {
  x: number;
  y: number;
}

export interface EnrichedCollisionGrid {
  grid: TileType[][];
  visuals: TileVisual[][];
  atlas: TileSpriteAtlas;
}

export interface ICollisionService {
  resolveTileCollision(entity: AABB, grid: TileType[][]): ResolvedPosition;
  setEnrichedGrid(data: EnrichedCollisionGrid): void;
  clearEnrichedVisual(gridX: number, gridY: number): void;
  isTileBlocked(gridX: number, gridY: number, grid: TileType[][]): boolean;
  /**
   * Point solidity query (hands/blade containment). Uses the enriched SAT
   * collider metadata when available — a point inside a blocked tile but
   * outside its sprite's colliders is FREE. Falls back to the full-tile grid
   * check only when no metadata exists for the cell.
   */
  isPointBlocked(x: number, y: number, grid: TileType[][]): boolean;
  /**
   * SAT test: does the blade segment (expanded by `expand` on all sides)
   * overlap any enriched collider polygon at the given grid cell? Used by
   * melee sweep — the blade is wall-clamped outside the tile, so a
   * point-in-polygon test can never fire; we need segment-vs-polygon
   * overlap instead. Returns false when no enriched data exists.
   */
  segmentIntersectsTileCollider(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    expand: number,
    gridX: number,
    gridY: number,
  ): boolean;
  /**
   * World-space centroid (vertex average) of the merged collider polygon at the
   * given grid cell, or null when no enriched collider exists for that tile.
   * Used by the bot AI to aim attacks at the REAL shape of an off-center
   * destructible/wall collider instead of tile-center — the SAT hit system
   * tests the same transformed polygon, so aiming at its centroid aligns the
   * bot's swing with the server's contact test.
   */
  getColliderCentroid(gridX: number, gridY: number): { x: number; y: number } | null;
  /**
   * Appends a full-tile siege-wall sprite (INDESTRUCTIBLE_WALL, rect collider
   * covering the whole tile) to the enriched atlas. Must be called once after
   * setEnrichedGrid, before any siege wall drops. No-op when no enriched grid.
   */
  registerSiegeWallCollider(): void;
  /**
   * Overwrites the enriched visual at (gridX, gridY) to point at the siege-wall
   * sprite registered by registerSiegeWallCollider. This ensures the enriched
   * collision path (resolveEnriched + isPointBlocked) treats the tile as a
   * full-tile solid block instead of falling through to the old sprite's
   * (possibly empty) colliders.
   */
  setSiegeWallEnriched(gridX: number, gridY: number): void;
}

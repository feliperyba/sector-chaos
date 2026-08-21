import type { TileVisual, TileSpriteDef } from '../map/tiledTypes.js';

/**
 * Read-only access to a tile's enriched collision data (visual + sprite atlas),
 * abstracting how the server (`EnrichedCollisionGrid`) and client
 * (`MapRenderer` atlas + visual layers) store it. Used by the shared
 * {@link resolveTileCollisionEnriched} so both sides run ONE resolution
 * algorithm — eliminating the structural divergence risk where a server-side
 * epsilon/order fix wouldn't reach the client (and break prediction).
 */
export interface CollisionGridProvider {
  /** Visual entry for the tile at (gx, gy), or null/undefined if none. */
  getVisual(gx: number, gy: number): TileVisual | null | undefined;
  /** Sprite definition by atlas sprite id, or null/undefined if none. */
  getSprite(spriteId: number): TileSpriteDef | null | undefined;
  /** Tile size in pixels. */
  getTileSize(): number;
}

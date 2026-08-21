import { TileType } from '../../enums/TileType.js';
import type { SectorData } from '../types.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';

/** Composite map dimension (4 sectors × 20 tiles = 80). */
const GRID_SIZE = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;

/**
 * Read a tile from the composite sector grid via global coordinates.
 * Returns -1 for out-of-bounds (never a valid TileType) so callers can treat
 * the result as "non-empty" at the map edge without special-casing.
 */
export function getTile(sectors: SectorData[][], gr: number, gc: number): number {
  const sr = Math.floor(gr / SECTOR_TILE_SIZE);
  const sc = Math.floor(gc / SECTOR_TILE_SIZE);
  const lr = gr % SECTOR_TILE_SIZE;
  const lc = gc % SECTOR_TILE_SIZE;
  return sectors[sr]?.[sc]?.tiles?.[lr]?.[lc] ?? -1;
}

/** Write a tile to the composite sector grid via global coordinates (no-op OOB). */
export function setTile(sectors: SectorData[][], gr: number, gc: number, value: number): void {
  const sr = Math.floor(gr / SECTOR_TILE_SIZE);
  const sc = Math.floor(gc / SECTOR_TILE_SIZE);
  const lr = gr % SECTOR_TILE_SIZE;
  const lc = gc % SECTOR_TILE_SIZE;
  const sector = sectors[sr]?.[sc];
  if (!sector?.tiles?.[lr]) return;
  sector.tiles[lr]![lc] = value;
}

/** True for tiles strictly inside the outer perimeter ring (rows/cols 1..78). */
export function isInteriorGlobal(gr: number, gc: number): boolean {
  return gr >= 1 && gr <= GRID_SIZE - 2 && gc >= 1 && gc <= GRID_SIZE - 2;
}

/** Cover tiles: breakable structures a player can destroy for loot/positioning. */
const COVER_TYPES = new Set<number>([
  TileType.DESTRUCTIBLE_WALL,
  TileType.DESTRUCTIBLE_CRATE,
  TileType.DESTRUCTIBLE_BARREL,
]);

/** Cover = crates, barrels, destructible walls. */
export function isCover(tileType: number): boolean {
  return COVER_TYPES.has(tileType);
}

/** Wall = indestructible or destructible wall (blocks sight/movement). */
export function isWall(tileType: number): boolean {
  return tileType === TileType.INDESTRUCTIBLE_WALL || tileType === TileType.DESTRUCTIBLE_WALL;
}

/** Structure = anything non-EMPTY (walls, cover, chests, exits, doors, …). */
export function isStructure(tileType: number): boolean {
  return tileType !== TileType.EMPTY;
}

export { GRID_SIZE };

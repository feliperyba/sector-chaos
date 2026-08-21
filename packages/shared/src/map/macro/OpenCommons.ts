import { TileType } from '../../enums/TileType.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import type { OpenCommonsInfo } from './MacroTypes.js';

/** Map edge index that must never be touched (outer perimeter wall). */
const PERIMETER_LAST = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE - 1; // 79

/**
 * Candidate adjacent outer-sector pairs. Each pair shares either an E-W
 * (left/right) or N-S (top/bottom) border. We never include any pair that
 * touches the center 2×2 — the merged arena lives entirely in one corner of
 * the outer ring so the center landmark and highway keep their priority.
 *
 * The list is intentionally exhaustive: every outer-ring corner sector
 * contributes both its horizontal and vertical adjacency. Picking from this
 * list uniformly gives each corner an equal chance of being "opened up".
 */
interface CandidatePair {
  a: { row: number; col: number };
  b: { row: number; col: number };
  type: 'EW' | 'NS';
}

const CANDIDATE_PAIRS: readonly CandidatePair[] = [
  // Top-left corner cluster
  { a: { row: 0, col: 0 }, b: { row: 0, col: 1 }, type: 'EW' },
  { a: { row: 0, col: 0 }, b: { row: 1, col: 0 }, type: 'NS' },
  // Top-right corner cluster
  { a: { row: 0, col: 2 }, b: { row: 0, col: 3 }, type: 'EW' },
  { a: { row: 0, col: 3 }, b: { row: 1, col: 3 }, type: 'NS' },
  // Bottom-left corner cluster
  { a: { row: 3, col: 0 }, b: { row: 3, col: 1 }, type: 'EW' },
  { a: { row: 2, col: 0 }, b: { row: 3, col: 0 }, type: 'NS' },
  // Bottom-right corner cluster
  { a: { row: 3, col: 2 }, b: { row: 3, col: 3 }, type: 'EW' },
  { a: { row: 2, col: 3 }, b: { row: 3, col: 3 }, type: 'NS' },
];

/**
 * Clear a single tile to EMPTY via global coordinates. Outer perimeter tiles
 * are silently skipped. Each cleared coord is recorded in `carvedTiles`.
 */
function clearTileToEmpty(
  sectors: SectorData[][],
  gr: number,
  gc: number,
  carvedTiles: Set<string>,
): void {
  if (gr <= 0 || gr >= PERIMETER_LAST || gc <= 0 || gc >= PERIMETER_LAST) return;
  const sr = Math.floor(gr / SECTOR_TILE_SIZE);
  const sc = Math.floor(gc / SECTOR_TILE_SIZE);
  const lr = gr % SECTOR_TILE_SIZE;
  const lc = gc % SECTOR_TILE_SIZE;
  const tileRow = sectors[sr]?.[sc]?.tiles?.[lr];
  if (!tileRow) return;
  tileRow[lc] = TileType.EMPTY;
  carvedTiles.add(`${gr},${gc}`);
}

/**
 * Merge one pair of adjacent outer-ring sectors by clearing their shared
 * border to EMPTY.
 *
 * Selection / algorithm:
 *
 *   1. Pick one of the 8 candidate pairs uniformly at random. Each pair is
 *      made of two outer-ring sectors that share either an E-W or N-S edge
 *      and never include a center 2×2 sector.
 *   2. Clear every shared-border tile to EMPTY. Adjacent sectors each have
 *      their own border wall ring; the seam between them is therefore a
 *      2-tile-wide barrier (A's outer ring + B's outer ring). We clear BOTH
 *      columns/rows so the two arenas fully merge into one open space:
 *        • E-W pair: clear A's rightmost local column (global col
 *          `leftCol*20+19`) and B's leftmost local column (global col
 *          `rightCol*20`), for every local row in the shared sector row.
 *        • N-S pair: clear A's bottom local row and B's top local row,
 *          for every local column in the shared sector column.
 *   3. Every cleared coord is recorded in `carvedTiles`. Outer perimeter
 *      tiles (rows/cols 0 or PERIMETER_LAST) are silently skipped — the
 *      candidate pairs never have a shared border on the outer perimeter
 *      (their shared edge is always an interior sector seam), so this guard
 *      is a belt-and-braces safety check.
 *
 * The skeletons, cover patterns, and corridors inside each sector are
 * preserved — only the dividing border wall is removed, producing a
 * double-wide arena in one corner of the map.
 *
 * @param sectors - the 2D sector grid (mutated in place)
 * @param rng - isolated RNG stream (caller must XOR the seed)
 * @returns commons metadata including the chosen pair and all cleared coords
 */
export function placeOpenCommons(sectors: SectorData[][], rng: SeededRNG): OpenCommonsInfo {
  const pick = CANDIDATE_PAIRS[rng.nextInt(0, CANDIDATE_PAIRS.length - 1)]!;
  const { a: sectorA, b: sectorB, type } = pick;

  const carvedTiles = new Set<string>();

  if (type === 'EW') {
    // E-W pair: sectors share a vertical seam. leftCol is the lower sector
    // column index (sector A is to its left); rightCol = leftCol + 1.
    const leftCol = Math.min(sectorA.col, sectorB.col);
    const rightCol = Math.max(sectorA.col, sectorB.col);
    const leftSeamGlobalCol = leftCol * SECTOR_TILE_SIZE + (SECTOR_TILE_SIZE - 1);
    const rightSeamGlobalCol = rightCol * SECTOR_TILE_SIZE;
    const topRow = sectorA.row * SECTOR_TILE_SIZE;

    for (let lr = 0; lr < SECTOR_TILE_SIZE; lr++) {
      const gr = topRow + lr;
      clearTileToEmpty(sectors, gr, leftSeamGlobalCol, carvedTiles);
      clearTileToEmpty(sectors, gr, rightSeamGlobalCol, carvedTiles);
    }
  } else {
    // N-S pair: sectors share a horizontal seam. topRow is the lower sector
    // row index (sector A is above); bottomRow = topRow + 1.
    const topRow = Math.min(sectorA.row, sectorB.row);
    const bottomRow = Math.max(sectorA.row, sectorB.row);
    const topSeamGlobalRow = topRow * SECTOR_TILE_SIZE + (SECTOR_TILE_SIZE - 1);
    const bottomSeamGlobalRow = bottomRow * SECTOR_TILE_SIZE;
    const leftCol = sectorA.col * SECTOR_TILE_SIZE;

    for (let lc = 0; lc < SECTOR_TILE_SIZE; lc++) {
      const gc = leftCol + lc;
      clearTileToEmpty(sectors, topSeamGlobalRow, gc, carvedTiles);
      clearTileToEmpty(sectors, bottomSeamGlobalRow, gc, carvedTiles);
    }
  }

  return { sectorA, sectorB, carvedTiles };
}

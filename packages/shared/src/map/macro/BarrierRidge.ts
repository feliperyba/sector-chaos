import { TileType } from '../../enums/TileType.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import type { BarrierRidgeInfo } from './MacroTypes.js';

/** Map edge index that must never be touched (outer perimeter wall). */
const PERIMETER_LAST = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE - 1; // 79

/** Inclusive range of how many 3-tile-wide gaps to cut through the ridge. */
const GAP_COUNT_MIN = 2;
const GAP_COUNT_MAX = 3;

/** Width (in tiles) of each gap punched through the ridge line. */
const GAP_WIDTH = 3;

/**
 * Center-band sector coords: the inner 2×2 ((1,1)/(1,2)/(2,1)/(2,2)) is
 * off-limits for ridge tiles. Detected by checking `sr === 1 || sr === 2`
 * AND `sc === 1 || sc === 2`.
 */
function isCenterSector(sr: number, sc: number): boolean {
  return (sr === 1 || sr === 2) && (sc === 1 || sc === 2);
}

/**
 * Ridge path candidate. Each path traces a diagonal from a point near one
 * corner of the map toward the center, but stops at a point that stays
 * inside an OUTER-ring sector. The 8 paths pair each of the 4 corners with
 * a "steep" (more vertical) or "shallow" (more horizontal) variant so the
 * ridge may pass through either of the two outer sectors adjacent to the
 * corner sector — never through a center 2×2 sector.
 *
 * Coordinates are global tile indices.
 */
interface RidgePath {
  startR: number;
  startC: number;
  endR: number;
  endC: number;
}

const RIDGE_PATHS: readonly RidgePath[] = [
  // 0 — NW corner, steep (down-right into sector (1,0))
  { startR: 5, startC: 5, endR: 35, endC: 18 },
  // 1 — NW corner, shallow (down-right into sector (0,1))
  { startR: 5, startC: 5, endR: 18, endC: 35 },
  // 2 — NE corner, steep (down-left into sector (1,3))
  { startR: 5, startC: 74, endR: 35, endC: 61 },
  // 3 — NE corner, shallow (down-left into sector (0,2))
  { startR: 5, startC: 74, endR: 18, endC: 44 },
  // 4 — SW corner, steep (up-right into sector (2,0))
  { startR: 74, startC: 5, endR: 44, endC: 18 },
  // 5 — SW corner, shallow (up-right into sector (3,1))
  { startR: 74, startC: 5, endR: 61, endC: 35 },
  // 6 — SE corner, steep (up-left into sector (2,3))
  { startR: 74, startC: 74, endR: 44, endC: 61 },
  // 7 — SE corner, shallow (up-left into sector (3,2))
  { startR: 74, startC: 74, endR: 61, endC: 44 },
];

/**
 * Bresenham integer line algorithm. Returns the ordered list of
 * `{row, col}` points from `(r0,c0)` to `(r1,c1)` inclusive.
 */
function bresenhamLine(
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): Array<{ row: number; col: number }> {
  const points: Array<{ row: number; col: number }> = [];
  let dr = Math.abs(r1 - r0);
  let dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dr - dc;
  let r = r0;
  let c = c0;

  // Safety cap (a line over an 80×80 grid never exceeds ~160 steps).
  let guard = 4 * SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
  while (guard-- > 0) {
    points.push({ row: r, col: c });
    if (r === r1 && c === c1) break;
    const e2 = 2 * err;
    if (e2 > -dc) {
      err -= dc;
      r += sr;
    }
    if (e2 < dr) {
      err += dr;
      c += sc;
    }
  }
  return points;
}

/**
 * Write a wall tile to the sector grid via global coordinates. Returns `true`
 * if the tile was actually written (i.e., the target cell existed).
 */
function setWallAt(sectors: SectorData[][], gr: number, gc: number): boolean {
  if (gr <= 0 || gr >= PERIMETER_LAST || gc <= 0 || gc >= PERIMETER_LAST) return false;
  const sr = Math.floor(gr / SECTOR_TILE_SIZE);
  const sc = Math.floor(gc / SECTOR_TILE_SIZE);
  const lr = gr % SECTOR_TILE_SIZE;
  const lc = gc % SECTOR_TILE_SIZE;
  const tileRow = sectors[sr]?.[sc]?.tiles?.[lr];
  if (!tileRow) return false;
  tileRow[lc] = TileType.INDESTRUCTIBLE_WALL;
  return true;
}

/**
 * Place a 1-tile-thick INDESTRUCTIBLE_WALL ridge running diagonally through
 * 2 outer-ring sectors of one map quadrant.
 *
 * Selection / algorithm:
 *
 *   1. One of 8 paths is selected at random (4 corners × {steep, shallow}).
 *      Each path starts near a corner and ends inside an outer-ring sector
 *      so the diagonal never enters the center 2×2.
 *   2. Bresenham traces the line. For each tile we skip (do NOT write) when
 *      the tile is on the outer perimeter, is in a center 2×2 sector, or is
 *      already claimed by a higher-priority feature (highway / compound).
 *      "Highway wins" and "compound win" rules from ADR 0028 are honoured —
 *      skipped tiles are NOT recorded in `carvedTiles`.
 *   3. 2–3 gaps (each 3 consecutive placed tiles wide) are cut through the
 *      ridge. Gap positions are picked from the placed-tile index list so a
 *      gap always lands on actual ridge wall, never on a skipped tile.
 *
 * @param sectors - the 2D sector grid (mutated in place)
 * @param rng - isolated RNG stream (caller must XOR the seed)
 * @param highwayTiles - coords the highway already wrote; never overwritten
 * @param compoundTiles - coords the compound already wrote; never overwritten
 * @returns ridge metadata including all wall-tile coords and gap positions
 */
export function placeBarrierRidge(
  sectors: SectorData[][],
  rng: SeededRNG,
  highwayTiles: Set<string>,
  compoundTiles: Set<string>,
): BarrierRidgeInfo {
  const pathIdx = rng.nextInt(0, RIDGE_PATHS.length - 1);
  const path = RIDGE_PATHS[pathIdx]!;

  // 1. Trace the diagonal and place walls where allowed.
  const linePoints = bresenhamLine(path.startR, path.startC, path.endR, path.endC);
  const placedIndices: number[] = [];
  const carvedTiles = new Set<string>();

  for (let i = 0; i < linePoints.length; i++) {
    const { row: gr, col: gc } = linePoints[i]!;
    const key = `${gr},${gc}`;

    // Outer perimeter is untouchable.
    if (gr <= 0 || gr >= PERIMETER_LAST || gc <= 0 || gc >= PERIMETER_LAST) continue;

    // Never place inside the center 2x2 sectors.
    const sr = Math.floor(gr / SECTOR_TILE_SIZE);
    const sc = Math.floor(gc / SECTOR_TILE_SIZE);
    if (isCenterSector(sr, sc)) continue;

    // Highway wins on overlap — creates a natural break in the ridge.
    if (highwayTiles.has(key)) continue;
    // Compound wins on overlap — preserves the landmark footprint.
    if (compoundTiles.has(key)) continue;

    if (setWallAt(sectors, gr, gc)) {
      carvedTiles.add(key);
      placedIndices.push(i);
    }
  }

  // 2. Cut 2–3 gaps through the ridge at distinct placed-tile positions.
  const gapPositions: Array<{ row: number; col: number }> = [];
  if (placedIndices.length >= GAP_WIDTH) {
    const gapCount = rng.nextInt(GAP_COUNT_MIN, GAP_COUNT_MAX);
    const gapStarts = new Set<number>();
    let attempts = 0;
    while (gapStarts.size < gapCount && attempts < 16) {
      attempts++;
      // Pick a placed-tile index, then widen to a full GAP_WIDTH window that
      // fits inside the placedIndices list. Center the gap on the pick.
      const centerPick = placedIndices[rng.nextInt(0, placedIndices.length - 1)]!;
      // Find where centerPick sits in placedIndices so we can choose a window
      // of GAP_WIDTH consecutive placed tiles around it.
      const centerSlot = placedIndices.indexOf(centerPick);
      // Window is [centerSlot - half, centerSlot - half + GAP_WIDTH - 1]
      const half = Math.floor(GAP_WIDTH / 2);
      let startSlot = centerSlot - half;
      if (startSlot < 0) startSlot = 0;
      if (startSlot + GAP_WIDTH > placedIndices.length) {
        startSlot = placedIndices.length - GAP_WIDTH;
      }
      // Avoid re-cutting an already-cleared window (compare by starting line
      // index so we don't cut overlapping windows).
      const startLineIdx = placedIndices[startSlot]!;
      if (gapStarts.has(startLineIdx)) continue;
      gapStarts.add(startLineIdx);

      // Clear GAP_WIDTH consecutive placed tiles to EMPTY, removing them
      // from carvedTiles so they are no longer treated as wall.
      const firstPoint = linePoints[startLineIdx]!;
      gapPositions.push({ row: firstPoint.row, col: firstPoint.col });
      for (let g = 0; g < GAP_WIDTH; g++) {
        const lineIdx = placedIndices[startSlot + g]!;
        const pt = linePoints[lineIdx]!;
        const ptKey = `${pt.row},${pt.col}`;
        // Clear the tile (it's known to be interior — placedIndices only
        // contains tiles that passed the perimeter/center checks).
        const srr = Math.floor(pt.row / SECTOR_TILE_SIZE);
        const scc = Math.floor(pt.col / SECTOR_TILE_SIZE);
        const lrr = pt.row % SECTOR_TILE_SIZE;
        const lcc = pt.col % SECTOR_TILE_SIZE;
        const tileRow = sectors[srr]?.[scc]?.tiles?.[lrr];
        if (tileRow) tileRow[lcc] = TileType.EMPTY;
        carvedTiles.delete(ptKey);
      }
    }
  }

  return { carvedTiles, gapPositions };
}

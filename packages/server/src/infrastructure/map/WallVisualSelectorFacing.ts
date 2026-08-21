/**
 * WallVisualSelectorFacing — cardinal-topology helpers + the one-open
 * facing mode (map-polish ticket 13; extracted from `WallVisualSelector`
 * at ticket 20 for the 500-line gate).
 *
 * `oneOpenFaceMode` is the run/thick-aware replacement for the historical
 * positional `%20` sector-border heuristic (deleted in ticket 13): the
 * facing mode for a 1-open-cardinal tile is derived purely from the grid
 * and the neighbour masks.
 *
 * Determinism contract (ADR 0035): pure functions of the grid/masks — no
 * RNG, no wall-clock, no positional inputs.
 */

import { TileType } from '@sector-battle/shared';
import { WALL_MASK_BITS, type OneOpenFaceMode } from './WallMaskClassifier.js';
import { isWallLikeTile } from './WallOrientationDetector.js';

export type Dir = 'N' | 'E' | 'S' | 'W';

export const DIR_OFFSETS: Record<Dir, [number, number]> = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};

export const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export const DIRS: Dir[] = ['N', 'E', 'S', 'W'];

export function openCardinalsOf(mask: number): Dir[] {
  return DIRS.filter((d) => (mask & WALL_MASK_BITS[d]) === 0);
}

/** In-grid wall-likeness of the neighbour one step in `dir` (off-map = false). */
export function inGridWallNeighbour(
  grid: TileType[][],
  row: number,
  col: number,
  dir: Dir,
): boolean {
  const [dr, dc] = DIR_OFFSETS[dir];
  const r = row + dr;
  const c = col + dc;
  if (r < 0 || r >= grid.length) return false;
  const rowCells = grid[r]!;
  if (c < 0 || c >= rowCells.length) return false;
  return isWallLikeTile(rowCells[c]!);
}

/** How many of the tile's four cardinal neighbours lie outside the grid. */
export function offMapCardinalCount(grid: TileType[][], row: number, col: number): number {
  let count = 0;
  for (const dir of DIRS) {
    const [dr, dc] = DIR_OFFSETS[dir];
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= grid.length || c < 0 || c >= grid[r]!.length) count++;
  }
  return count;
}

/**
 * Facing mode for a 1-open-cardinal cell (map-polish ticket 13 run/thick-aware
 * rules; ticket 27 RENDER-TRUTH correction — pixel-verified against the demo
 * `tiled/demo_map.tmx` border ring through the real client transform chain).
 *
 * The render-truth convention (ticket 27, from the demo authoring + the
 * owner-approved ticket-23 corners): THE SOLID BAR PRESENTS TOWARD THE FLOOR.
 * The demo border ring puts the band on the floor side on ALL four sides
 * (top row rot180, bottom rot0, left col rot90, right col rot270 — the lone
 * open cardinal), and the corner elbows/blobs sit on the floor quadrant.
 *
 * - `'open'`    — face the open cardinal (the floor side). Used for EVERY
 *                 INDESTRUCTIBLE 1-open cell (world-edge ring, sector-ring
 *                 seams, wall-mass edges, abutments): a backed indestructible
 *                 1-open cell is ALWAYS `wall_fill`-covered (`selectWallFill`:
 *                 1-open + in-grid wall behind), so the fill closes the seam
 *                 behind the bar and the repair pass skips the cell — the
 *                 floor-facing bar is continuity-free by construction. The
 *                 historical `'partner'` meeting-at-the-seam put both bars
 *                 INTO the wall mass — the owner's "side walls on the inner
 *                 side of the tile" complaint — and the historical `'run'`
 *                 axis rule drew the bar into the mass whenever the floor
 *                 pocket sat on the axis rule's default side.
 * - `'partner'` — face the opposite of the open cardinal, i.e. toward the
 *                 wall behind. Chosen ONLY when the pair can NEVER be filled:
 *                 a DESTRUCTIBLE wall behind a DESTRUCTIBLE tile (a destroyed
 *                 wall must not leave baked fill behind, so the strips
 *                 meeting on the shared seam are the pair's only connective
 *                 representation).
 * - `'run'`     — face along the wall-run axis (E+W walled → face N, else
 *                 face E) so a strip stays on ONE side through an
 *                 abutment/junction tile. DESTRUCTIBLE-only (an
 *                 indestructible wall behind a destructible tile): the tile
 *                 can never be filled, so run consistency is the only thing
 *                 keeping unfillable destructible clusters connected — the
 *                 axis compromise is load-bearing there (53-seed sweep:
 *                 facing the floor pocket instead breaks the pinned D5
 *                 T-stem residual bound 31 → 43).
 */
export function oneOpenFaceMode(
  grid: TileType[][],
  orientations: (number | null)[][],
  row: number,
  col: number,
  open: Dir,
  tile: TileType,
): OneOpenFaceMode {
  const back = OPPOSITE[open];
  if (!inGridWallNeighbour(grid, row, col, back)) return 'open';
  const [dr, dc] = DIR_OFFSETS[back];
  if (tile === TileType.DESTRUCTIBLE_WALL) {
    // A destructible wall behind can never be filled, so this strip must
    // carry the connection into it (the only never-fillable pair class).
    // An indestructible wall behind is fill-bridged (`junctionFill`) — this
    // destructible tile keeps its run facing so the strip never flips side
    // mid-run (see `'run'` above: unfillable ⇒ the axis compromise is
    // load-bearing).
    return grid[row + dr]![col + dc] === TileType.DESTRUCTIBLE_WALL ? 'partner' : 'run';
  }
  // INDESTRUCTIBLE with an in-grid wall behind: ALWAYS fill-covered (the
  // 2-thick-pair-face rule), so the bar presents toward the floor and the
  // fill carries the seam — mutual-pair and mass-edge alike (ticket 27).
  // (`orientations` stays in the signature: the mode API is grid+masks in,
  // mode out — callers and tests pass the parallel mask grid.)
  return 'open';
}

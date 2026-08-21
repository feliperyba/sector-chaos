import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';

/**
 * Reusable geometric cover-placement primitives. Each function mutates a 20×20
 * tile grid in place, placing breakable cover (`tileType`) only on EMPTY
 * interior cells (never on the border ring and never overwriting an existing
 * tile). Every function is a pure function of its RNG stream, so identical seeds
 * reproduce the layout exactly. See ADR 0027 / Wave 1 cover overhaul.
 *
 * Map-polish ticket 28: the per-cell RNG scatter fill family (`latticeFill` /
 * `edgeTrace` / `staggeredRows` / `diagonalPairs` / `concentricArcs`) was
 * DELETED — those passes rolled independent per-cell skip/density dice and
 * sprinkled singles/dominoes between the authored structures (the owner's
 * "random positions" complaint). Interior composition is now authored skeleton
 * structure + the deterministic PrefabPlacementPass. The two surviving
 * primitives are DETERMINISTIC-AUTHORED geometry (fixed angles/step and a
 * fixed cardinal frame — no per-cell scatter dice beyond the authored
 * open-side/skirt choices).
 */

/** Sector side length these primitives assume. */
const SIZE = 20;
/** First interior index (just inside the border ring). */
const LO = 1;
/** Last interior index (just inside the border ring). */
const HI = SIZE - 2;

/** Cardinal neighbour offsets [row delta, col delta]. */
const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * Whether a coordinate is a paintable interior cell (inside the border ring).
 *
 * @param r - the row to test
 * @param c - the column to test
 * @returns `true` if the cell lies strictly inside the border ring
 */
function isInterior(r: number, c: number): boolean {
  return r >= LO && r <= HI && c >= LO && c <= HI;
}

/**
 * Write `t` to an interior EMPTY cell, leaving the border ring and existing
 * tiles untouched.
 *
 * @param tiles - the grid being modified
 * @param r - the target row
 * @param c - the target column
 * @param t - the tile type to write
 */
function placeIfEmpty(tiles: Uint8Array[], r: number, c: number, t: TileType): void {
  if (isInterior(r, c) && tiles[r]![c] === TileType.EMPTY) tiles[r]![c] = t;
}

/**
 * RADIAL SPOKES — place cover radiating from a center point at fixed angles.
 * For each angle the function walks outward, placing `tileType` every `step`
 * tiles, stopping when it leaves the interior or meets a non-EMPTY cell. Spokes
 * read as sightlines/fire-lanes converging on (or emanating from) the center.
 * Deterministic authored geometry (no per-cell dice — the RNG parameter is
 * reserved for future jitter and currently unused).
 *
 * @param tiles - the grid being modified (mutated in place)
 * @param rng - the per-sector RNG stream (reserved for future jitter; currently unused)
 * @param params - centerR, centerC, angles (radians), step, maxLength, tileType
 */
export function radialSpokes(
  tiles: Uint8Array[],
  rng: SeededRNG,
  params: {
    centerR: number;
    centerC: number;
    angles: number[];
    step: number;
    maxLength?: number;
    tileType: TileType;
  },
): void {
  const { centerR, centerC, angles, tileType } = params;
  const step = params.step ?? 2;
  const maxLength = params.maxLength ?? 8;
  void rng;
  if (step < 1) return;
  for (const angle of angles) {
    const dr = Math.sin(angle);
    const dc = Math.cos(angle);
    for (let d = step; d <= maxLength; d += step) {
      const r = Math.round(centerR + dr * d);
      const c = Math.round(centerC + dc * d);
      if (!isInterior(r, c) || tiles[r]![c] !== TileType.EMPTY) break;
      tiles[r]![c] = tileType;
    }
  }
}

/**
 * CACHE FRAME — frame a center cell with breakable cover on `4 - openSides`
 * cardinal sides, leaving `openSides` sides open (chosen at random). Produces a
 * U, L, or crescent shape that reads as a deliberate cache/ambush pocket around
 * the center tile. Authored framing (the RNG draws only the open-side choice).
 *
 * @param tiles - the grid being modified (mutated in place)
 * @param rng - the per-sector RNG stream (chooses which sides stay open)
 * @param params - centerR, centerC, openSides (0-4), tileType
 */
export function cacheFrame(
  tiles: Uint8Array[],
  rng: SeededRNG,
  params: {
    centerR: number;
    centerC: number;
    openSides: number;
    tileType: TileType;
  },
): void {
  const { centerR, centerC, openSides, tileType } = params;
  const sides = rng.shuffle([...CARDINALS]);
  const open = Math.max(0, Math.min(4, openSides));
  const openKeys = new Set(sides.slice(0, open).map(([dr, dc]) => `${dr},${dc}`));
  for (const [dr, dc] of CARDINALS) {
    if (openKeys.has(`${dr},${dc}`)) continue;
    placeIfEmpty(tiles, centerR + dr, centerC + dc, tileType);
  }
}

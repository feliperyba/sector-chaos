import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';

/**
 * Shared carve primitives for the Maze skeleton builders (T6). These are the
 * pure, RNG-driven grid operations the four Maze sub-variants compose into their
 * distinct shapes (see {@link file mazeSkeletons.ts}): a solid-fill grid, EMPTY
 * carving (cells / rects / mixed-width corridors), a connectivity guarantee, a
 * loop-carving pass, a perimeter-erosion "open to a target ratio" pass (the perf
 * floor), breakable-wall placement, a randomized-DFS lattice, and artery
 * thickening. Splitting them out keeps each Maze file under the length budget and
 * keeps {@link file mazeSkeletons.ts} a readable catalogue of the four shapes.
 *
 * The maze starts as solid INDESTRUCTIBLE_WALL and corridors are carved out of
 * it, so the border ring (row/col 0 and 19) is indestructible for free. Every
 * function is a pure function of the grid + its {@link SeededRNG}, so the same
 * seed reproduces output byte-identically.
 */

/** The 20×20 sector side length these primitives assume. */
export const SIZE = 20;
/** First interior index (just inside the border ring). */
export const LO = 1;
/** Last interior index (just inside the border ring). */
export const HI = SIZE - 2;
/** Total interior cells (18×18). */
export const INTERIOR_CELLS = (HI - LO + 1) * (HI - LO + 1);

/** Cardinal offsets. */
export const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * Allocate a 20×20 grid filled with INDESTRUCTIBLE_WALL (the maze starts solid
 * and corridors are carved out of it). The border ring is therefore already
 * indestructible.
 *
 * @returns a freshly solid 20×20 tile grid
 */
export function solidGrid(): Uint8Array[] {
  const tiles: Uint8Array[] = [];
  for (let row = 0; row < SIZE; row++) {
    tiles[row] = new Uint8Array(SIZE);
    tiles[row]!.fill(TileType.INDESTRUCTIBLE_WALL);
  }
  return tiles;
}

/** Whether a coordinate is a carvable interior cell (inside the border ring). */
export function isInterior(r: number, c: number): boolean {
  return r >= LO && r <= HI && c >= LO && c <= HI;
}

/** Carve a single interior cell to EMPTY (no-op on the border ring). */
export function carve(tiles: Uint8Array[], r: number, c: number): void {
  if (isInterior(r, c)) tiles[r]![c] = TileType.EMPTY;
}

/**
 * Carve a filled rectangle of EMPTY cells (clamped to the interior). Used for
 * chambers and wide junctions — the open pockets that host spawns and loot.
 *
 * @param tiles - the grid being built
 * @param r0 - top row
 * @param c0 - left column
 * @param r1 - bottom row (inclusive)
 * @param c1 - right column (inclusive)
 */
export function carveRect(
  tiles: Uint8Array[],
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): void {
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
      carve(tiles, r, c);
    }
  }
}

/**
 * Carve a straight EMPTY corridor of a given width between two cells along one
 * axis at a time (an L-shaped run). Width grows toward higher indices so a
 * 2-wide hall reads as a thick artery. Pure geometry — used by every builder for
 * the mixed-width arteries.
 *
 * @param tiles - the grid being built
 * @param r0 - start row
 * @param c0 - start column
 * @param r1 - end row
 * @param c1 - end column
 * @param width - corridor width (1 = branch, 2 = artery)
 */
export function carveCorridor(
  tiles: Uint8Array[],
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  width: number,
): void {
  const w = Math.max(1, width);
  // Horizontal leg at r0, then vertical leg at c1.
  const cStart = Math.min(c0, c1);
  const cEnd = Math.max(c0, c1);
  for (let c = cStart; c <= cEnd; c++) {
    for (let dw = 0; dw < w; dw++) carve(tiles, r0 + dw, c);
  }
  const rStart = Math.min(r0, r1);
  const rEnd = Math.max(r0, r1);
  for (let r = rStart; r <= rEnd; r++) {
    for (let dw = 0; dw < w; dw++) carve(tiles, r, c1 + dw);
  }
}

/**
 * Loop-carving pass: knock out a seeded fraction of INDESTRUCTIBLE_WALL tiles
 * that separate two EMPTY cells (turning them EMPTY), so dead-ends become rare
 * and the maze gains alternate routes. Operates only on walls flanked by EMPTY
 * on an axis, so it never breaches the border or opens a sealed pocket randomly.
 *
 * @param tiles - the grid being built (mutated)
 * @param rng - the per-sector RNG stream
 * @param fraction - fraction of eligible separator walls to remove
 */
export function carveLoops(tiles: Uint8Array[], rng: SeededRNG, fraction: number): void {
  const candidates = collectSeparators(tiles);
  const shuffled = rng.shuffle(candidates);
  const count = Math.floor(shuffled.length * fraction);
  for (let i = 0; i < count; i++) {
    const idx = shuffled[i]!;
    tiles[(idx / SIZE) | 0]![idx % SIZE] = TileType.EMPTY;
  }
}

/** Collect INDESTRUCTIBLE_WALL cells flanked by EMPTY on at least one axis. */
function collectSeparators(tiles: Uint8Array[]): number[] {
  const candidates: number[] = [];
  for (let r = LO; r <= HI; r++) {
    for (let c = LO; c <= HI; c++) {
      if (tiles[r]![c] !== TileType.INDESTRUCTIBLE_WALL) continue;
      const horiz = tiles[r]![c - 1] === TileType.EMPTY && tiles[r]![c + 1] === TileType.EMPTY;
      const vert = tiles[r - 1]![c] === TileType.EMPTY && tiles[r + 1]![c] === TileType.EMPTY;
      if (horiz || vert) candidates.push(r * SIZE + c);
    }
  }
  return candidates;
}

/** Count EMPTY interior cells. */
function countEmpty(tiles: Uint8Array[]): number {
  let n = 0;
  for (let r = LO; r <= HI; r++)
    for (let c = LO; c <= HI; c++) if (tiles[r]![c] === TileType.EMPTY) n++;
  return n;
}

/**
 * Open the maze up to a minimum EMPTY ratio. This is the PERF FLOOR: it
 * guarantees the new maze ends up LIGHTER than the old mirrored maze (which
 * averaged ~30% indestructible / ~70% EMPTY with 36% of its EMPTY in 1-wide
 * corridors) — more EMPTY means fewer indestructible walls and, with arteries
 * already thickened, fewer 1-wide runs for 63-bot LOS / pathfinding (ADR 0024).
 * Phase 1 carves loops between corridors (keeps a maze read); Phase 2 erodes the
 * perimeter of any remaining sealed wall blocks so the EMPTY region grows into
 * the solid field. Bounded so it always terminates.
 *
 * @param tiles - the grid being built (mutated)
 * @param rng - the per-sector RNG stream
 * @param targetEmptyRatio - the EMPTY fraction of the interior to reach
 */
export function openToTarget(tiles: Uint8Array[], rng: SeededRNG, targetEmptyRatio: number): void {
  const target = Math.floor(INTERIOR_CELLS * targetEmptyRatio);
  // Phase 1: loop-carving (knock out separators between corridors).
  for (let pass = 0; pass < 12 && countEmpty(tiles) < target; pass++) {
    const before = countEmpty(tiles);
    carveLoops(tiles, rng, 0.5);
    if (countEmpty(tiles) === before) break;
  }
  // Phase 2: perimeter erosion when loop-carving stalls. Walls fully buried in
  // other walls survive longest, so structure thins evenly rather than vanishing.
  for (let pass = 0; pass < INTERIOR_CELLS && countEmpty(tiles) < target; pass++) {
    const perimeter: number[] = [];
    for (let r = LO; r <= HI; r++) {
      for (let c = LO; c <= HI; c++) {
        if (tiles[r]![c] !== TileType.INDESTRUCTIBLE_WALL) continue;
        let touchesEmpty = false;
        for (const [dr, dc] of CARDINALS) {
          if (tiles[r + dr]![c + dc] === TileType.EMPTY) {
            touchesEmpty = true;
            break;
          }
        }
        if (touchesEmpty) perimeter.push(r * SIZE + c);
      }
    }
    if (perimeter.length === 0) break;
    const shuffled = rng.shuffle(perimeter);
    const need = target - countEmpty(tiles);
    const take = Math.max(1, Math.min(need, Math.ceil(shuffled.length * 0.4)));
    for (let i = 0; i < take; i++) {
      const idx = shuffled[i]!;
      tiles[(idx / SIZE) | 0]![idx % SIZE] = TileType.EMPTY;
    }
  }
}

/**
 * Convert a seeded fraction of the INDESTRUCTIBLE_WALL separator walls (walls
 * flanked by EMPTY on an axis) into DESTRUCTIBLE_WALL `wall_secret` gates. Unlike
 * {@link placeBreakableShortcuts} this is bulk conversion (for the Breakable
 * Warren, where smashing is the PRIMARY flanking mechanic, and to thin the
 * inter-chamber / inter-ring walls of the other variants) — it also lowers the
 * indestructible-wall count, since breakable walls do not count toward the perf
 * cap.
 *
 * @param tiles - the grid being built (mutated)
 * @param rng - the per-sector RNG stream
 * @param fraction - fraction of eligible separator walls to make breakable
 * @returns the number of walls converted
 */
export function convertSeparatorsToBreakable(
  tiles: Uint8Array[],
  rng: SeededRNG,
  fraction: number,
): number {
  const candidates = collectSeparators(tiles);
  const shuffled = rng.shuffle(candidates);
  const count = Math.floor(shuffled.length * fraction);
  for (let i = 0; i < count; i++) {
    const idx = shuffled[i]!;
    tiles[(idx / SIZE) | 0]![idx % SIZE] = TileType.DESTRUCTIBLE_WALL;
  }
  return count;
}

/**
 * Breakable-shortcut pass: convert a seeded subset of INDESTRUCTIBLE_WALL tiles
 * into DESTRUCTIBLE_WALL (`wall_secret`) where smashing the wall would open a
 * MEANINGFUL new route, not just any wall. Primary candidates are one-tile gates
 * whose opposite sides are BOTH EMPTY (smashing joins two separated corridors);
 * the fallback is any wall touching ≥2 EMPTY cells (opens a new face into a
 * corridor/chamber), which guarantees placement even when no perfect gate exists.
 *
 * @param tiles - the grid being built (mutated)
 * @param rng - the per-sector RNG stream
 * @param target - desired number of breakable shortcuts
 * @returns the number of shortcuts actually placed
 */
export function placeBreakableShortcuts(
  tiles: Uint8Array[],
  rng: SeededRNG,
  target: number,
): number {
  const gates: number[] = [];
  const faces: number[] = [];
  for (let r = LO; r <= HI; r++) {
    for (let c = LO; c <= HI; c++) {
      if (tiles[r]![c] !== TileType.INDESTRUCTIBLE_WALL) continue;
      const horizGate = tiles[r]![c - 1] === TileType.EMPTY && tiles[r]![c + 1] === TileType.EMPTY;
      const vertGate = tiles[r - 1]![c] === TileType.EMPTY && tiles[r + 1]![c] === TileType.EMPTY;
      if (horizGate || vertGate) {
        gates.push(r * SIZE + c);
        continue;
      }
      let emptyNeighbours = 0;
      for (const [dr, dc] of CARDINALS)
        if (tiles[r + dr]![c + dc] === TileType.EMPTY) emptyNeighbours++;
      if (emptyNeighbours >= 2) faces.push(r * SIZE + c);
    }
  }
  const ordered = [...rng.shuffle(gates), ...rng.shuffle(faces)];
  let placed = 0;
  for (let i = 0; i < ordered.length && placed < target; i++) {
    const idx = ordered[i]!;
    tiles[(idx / SIZE) | 0]![idx % SIZE] = TileType.DESTRUCTIBLE_WALL;
    placed++;
  }
  return placed;
}

/**
 * Spaced randomized-DFS lattice carve. Carves 1-wide passages between cells on
 * the odd-interior lattice from a non-central start (asymmetric), producing a
 * connected spanning maze. Cells live at lattice coords; passages knock out the
 * wall between adjacent cells.
 *
 * @param tiles - the grid being built (mutated)
 * @param rng - the per-sector RNG stream
 * @param startR - lattice start row (odd interior)
 * @param startC - lattice start column (odd interior)
 */
export function carveDfsLattice(
  tiles: Uint8Array[],
  rng: SeededRNG,
  startR: number,
  startC: number,
): void {
  const visited = new Set<number>();
  const stack: [number, number][] = [[startR, startC]];
  visited.add(startR * SIZE + startC);
  carve(tiles, startR, startC);
  const steps: ReadonlyArray<readonly [number, number]> = [
    [-2, 0],
    [2, 0],
    [0, -2],
    [0, 2],
  ];
  while (stack.length > 0) {
    const [cr, cc] = stack[stack.length - 1]!;
    const options: [number, number][] = [];
    for (const [dr, dc] of steps) {
      const nr = cr + dr;
      const nc = cc + dc;
      if (isInterior(nr, nc) && !visited.has(nr * SIZE + nc)) options.push([nr, nc]);
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const [nr, nc] = options[rng.nextInt(0, options.length - 1)]!;
    carve(tiles, (cr + nr) / 2, (cc + nc) / 2);
    carve(tiles, nr, nc);
    visited.add(nr * SIZE + nc);
    stack.push([nr, nc]);
  }
}

/**
 * Thicken a seeded fraction of EMPTY corridor cells into 2-wide arteries by
 * carving the cell below/right of selected EMPTY cells. This is what makes the
 * maze MIXED-WIDTH (2-wide arteries among the 1-wide DFS branches) — fairer for
 * the 96px melee hitbox and cheaper for LOS than all-width-1.
 *
 * @param tiles - the grid being built (mutated)
 * @param rng - the per-sector RNG stream
 * @param fraction - fraction of EMPTY cells to seed an artery from
 */
export function thickenArteries(tiles: Uint8Array[], rng: SeededRNG, fraction: number): void {
  const empties: number[] = [];
  for (let r = LO; r <= HI; r++) {
    for (let c = LO; c <= HI; c++) {
      if (tiles[r]![c] === TileType.EMPTY) empties.push(r * SIZE + c);
    }
  }
  const shuffled = rng.shuffle(empties);
  const count = Math.floor(shuffled.length * fraction);
  for (let i = 0; i < count; i++) {
    const idx = shuffled[i]!;
    const r = (idx / SIZE) | 0;
    const c = idx % SIZE;
    // Widen along whichever neighbour keeps the artery readable; both clamp to
    // interior, so border safety is preserved.
    if (rng.nextInt(0, 1) === 0) carve(tiles, r + 1, c);
    else carve(tiles, r, c + 1);
  }
}

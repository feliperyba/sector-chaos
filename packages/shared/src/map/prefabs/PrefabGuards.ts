/**
 * Pure grid guards backing the prefab placement pass (map-polish ticket 25).
 * Extracted beside `PrefabPlacementPass` for the 500-line gate — every
 * function here is a pure function of its grid arguments (zero RNG, ADR
 * 0035), mirroring the validator flood gate's exact semantics.
 */

import { TileType } from '../../enums/TileType.js';
import { SECTOR_TILE_SIZE } from '../constants.js';

/**
 * Whether a stamp CREATED a 1-wide slot: an EMPTY cell in the stamp's ±1
 * neighbourhood now squeezed between non-EMPTY tiles on BOTH horizontal or
 * BOTH vertical cardinals, where at least one of the two blockers is a cell
 * THIS stamp wrote. (Pre-existing slots — maze corridors, gate jaws — are
 * the skeletons' authored geometry and stay untouched; a stamp may not add
 * the second jaw.) A stamp-created slot is the single-tile-pluggable gap the
 * later keep/entity passes can close (sealing the pocket behind it) — the
 * documented ticket-24 seed-55 late-closer class; refusing to create slots
 * keeps every prefab-adjacent gap ≥2 wide by construction.
 */
export function stampPinchesSlot(
  composite: Uint8Array[],
  written: ReadonlyArray<readonly [number, number]>,
  sRow: number,
  sCol: number,
): boolean {
  const height = composite.length;
  const width = composite[0]!.length;
  /** Slot-blocker provenance: written by this stamp / pre-existing / open. */
  type Block = 'written' | 'pre' | 'open';
  const writtenKeys = new Set(
    written.map(([r, c]) => `${sRow * SECTOR_TILE_SIZE + r},${sCol * SECTOR_TILE_SIZE + c}`),
  );
  const blocked = (r: number, c: number): Block => {
    if (r < 0 || r >= height || c < 0 || c >= width) return 'pre'; // off-grid = wall
    if (composite[r]![c] === TileType.EMPTY) return 'open';
    return writtenKeys.has(`${r},${c}`) ? 'written' : 'pre';
  };
  const slotCreatedByStamp = (r: number, c: number): boolean => {
    const pairs: Array<readonly [Block, Block]> = [
      [blocked(r, c - 1), blocked(r, c + 1)],
      [blocked(r - 1, c), blocked(r + 1, c)],
    ];
    for (const [a, b] of pairs) {
      if (a === 'open' || b === 'open') continue;
      // Both blockers solid: a slot — created by this stamp iff it wrote one.
      if (a === 'written' || b === 'written') return true;
    }
    return false;
  };
  const checked = new Set<string>();
  for (const [wr, wc] of written) {
    const gr = sRow * SECTOR_TILE_SIZE + wr;
    const gc = sCol * SECTOR_TILE_SIZE + wc;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = gr + dr;
        const c = gc + dc;
        const key = `${r},${c}`;
        if (checked.has(key)) continue;
        checked.add(key);
        if (r < 0 || r >= height || c < 0 || c >= width) continue;
        if (composite[r]![c] !== TileType.EMPTY) continue;
        if (slotCreatedByStamp(r, c)) return true;
      }
    }
  }
  return false;
}

/**
 * Label the composite grid's EMPTY cells into 4-connected components (flat
 * row-major label array; -1 = non-EMPTY). Matches the validator flood-fill
 * gate's `isEmptyTile` + cardinal BFS semantics exactly.
 */
export function labelEmptyComponents(grid: Uint8Array[]): Int32Array {
  const height = grid.length;
  const width = grid[0]!.length;
  const labels = new Int32Array(height * width).fill(-1);
  let nextLabel = 0;
  const queue: number[] = [];
  for (let start = 0; start < height * width; start++) {
    if (labels[start]! !== -1) continue;
    if (grid[(start / width) | 0]![start % width] !== TileType.EMPTY) continue;
    labels[start] = nextLabel;
    queue.push(start);
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++]!;
      const r = (idx / width) | 0;
      const c = idx % width;
      for (const [nr, nc] of [
        [r + 1, c],
        [r - 1, c],
        [r, c + 1],
        [r, c - 1],
      ] as const) {
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
        const nIdx = nr * width + nc;
        if (labels[nIdx]! !== -1 || grid[nr]![nc] !== TileType.EMPTY) continue;
        labels[nIdx] = nextLabel;
        queue.push(nIdx);
      }
    }
    nextLabel++;
    queue.length = 0;
  }
  return labels;
}

/**
 * The longest contiguous stretch of `cells` satisfying `ok` (ties → the first),
 * or null when no stretch reaches 2 tiles — the conflict-clip rule (a clipped
 * run degrades to its clean ≥2-tile remainder, never a stub). Pure: `ok` is a
 * caller-supplied predicate over the candidate cells only.
 */
export function longestStretch(
  cells: ReadonlyArray<readonly [number, number]>,
  ok: (r: number, c: number) => boolean,
): Array<[number, number]> | null {
  let best: Array<[number, number]> = [];
  let current: Array<[number, number]> = [];
  for (const [r, c] of cells) {
    if (ok(r, c)) {
      current.push([r, c]);
    } else {
      if (current.length > best.length) best = current;
      current = [];
    }
  }
  if (current.length > best.length) best = current;
  return best.length >= 2 ? best : null;
}

/**
 * Whether a stamp split an open region: some pre-stamp component's
 * still-EMPTY cells now carry more than one post-stamp component label.
 * (Stamps only REMOVE EMPTY cells, so post-components refine pre-components —
 * one pre-label mapping to two post-labels is exactly a split.)
 */
export function stampSplitsOpenRegions(
  preLabels: Int32Array,
  postLabels: Int32Array,
  grid: Uint8Array[],
): boolean {
  const width = grid[0]!.length;
  const postOfPre = new Map<number, number>();
  for (let idx = 0; idx < preLabels.length; idx++) {
    const pre = preLabels[idx]!;
    if (pre < 0) continue;
    if (grid[(idx / width) | 0]![idx % width] !== TileType.EMPTY) continue; // became cover
    const post = postLabels[idx]!;
    const seen = postOfPre.get(pre);
    if (seen === undefined) postOfPre.set(pre, post);
    else if (seen !== post) return true;
  }
  return false;
}

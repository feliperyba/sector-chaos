import { TileType } from '../../enums/TileType.js';
import { SIZE, LO, HI, CARDINALS, isInterior, carveCorridor } from './mazeCarve.js';

/**
 * EMPTY-connectivity guarantee for the Maze skeleton builders (T6). After the
 * builders carve their corridors, chambers, and lattices, the open region can
 * still be split into disconnected pockets. These primitives flood-label the
 * EMPTY components and bridge every stray pocket back into the main region so the
 * T1 connectivity gate sees a single EMPTY region (loops are real EMPTY
 * corridors, not breakable-only links). Split out of {@link file mazeCarve.ts} to
 * keep each Maze file under the length budget; depends one-directionally on the
 * carve primitives (SIZE/LO/HI/CARDINALS/isInterior/carveCorridor).
 *
 * Every function is a pure function of the grid + the carve geometry, so the same
 * seed reproduces output byte-identically.
 */

/**
 * Flood the EMPTY region from the largest open cell and carve a one-tile bridge
 * from every disconnected EMPTY pocket back toward the main region, until the
 * whole EMPTY region is a single connected component. DESTRUCTIBLE walls block
 * the EMPTY flood, so this guarantees the T1 connectivity gate sees one EMPTY
 * region (loops are real EMPTY corridors, not breakable-only links). Runs a
 * bounded number of passes; each pass connects at least one pocket.
 *
 * @param tiles - the grid being built (mutated)
 */
export function connectEmptyRegion(tiles: Uint8Array[]): void {
  for (let pass = 0; pass < SIZE * SIZE; pass++) {
    const comp = labelComponents(tiles);
    if (comp.count <= 1) return;
    bridgeSmallestPocket(tiles, comp);
  }
}

interface Components {
  /** Per-cell component id, -1 for non-EMPTY cells. */
  ids: Int16Array;
  /** Number of distinct EMPTY components. */
  count: number;
  /** Component id of the largest EMPTY component. */
  largest: number;
}

/** Label connected EMPTY components (4-connected) across the interior. */
function labelComponents(tiles: Uint8Array[]): Components {
  const ids = new Int16Array(SIZE * SIZE).fill(-1);
  let count = 0;
  let largest = -1;
  let largestSize = -1;
  for (let r = LO; r <= HI; r++) {
    for (let c = LO; c <= HI; c++) {
      if (tiles[r]![c] !== TileType.EMPTY || ids[r * SIZE + c] !== -1) continue;
      const id = count++;
      let size = 0;
      const stack: number[] = [r * SIZE + c];
      ids[r * SIZE + c] = id;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        size++;
        const cr = (idx / SIZE) | 0;
        const cc = idx % SIZE;
        for (const [dr, dc] of CARDINALS) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (!isInterior(nr, nc)) continue;
          const nIdx = nr * SIZE + nc;
          if (tiles[nr]![nc] === TileType.EMPTY && ids[nIdx] === -1) {
            ids[nIdx] = id;
            stack.push(nIdx);
          }
        }
      }
      if (size > largestSize) {
        largestSize = size;
        largest = id;
      }
    }
  }
  return { ids, count, largest };
}

/**
 * Find a non-largest EMPTY pocket and carve a straight one-tile bridge from one
 * of its cells toward the nearest cell of the largest component, turning the
 * intervening INDESTRUCTIBLE_WALL run EMPTY.
 *
 * @param tiles - the grid being built (mutated)
 * @param comp - the current component labelling
 */
function bridgeSmallestPocket(tiles: Uint8Array[], comp: Components): void {
  // Pick any cell of a non-largest component as the bridge source.
  let src = -1;
  for (let r = LO; r <= HI && src === -1; r++) {
    for (let c = LO; c <= HI; c++) {
      const id = comp.ids[r * SIZE + c]!;
      if (id !== -1 && id !== comp.largest) {
        src = r * SIZE + c;
        break;
      }
    }
  }
  if (src === -1) return;
  const sr = (src / SIZE) | 0;
  const sc = src % SIZE;
  // Nearest largest-component cell (Manhattan), then carve an L toward it.
  let best = -1;
  let bestDist = Infinity;
  for (let r = LO; r <= HI; r++) {
    for (let c = LO; c <= HI; c++) {
      if (comp.ids[r * SIZE + c] !== comp.largest) continue;
      const d = Math.abs(r - sr) + Math.abs(c - sc);
      if (d < bestDist) {
        bestDist = d;
        best = r * SIZE + c;
      }
    }
  }
  if (best === -1) return;
  carveCorridor(tiles, sr, sc, (best / SIZE) | 0, best % SIZE, 1);
}

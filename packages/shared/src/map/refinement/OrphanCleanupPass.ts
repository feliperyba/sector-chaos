import { TileType } from '../../enums/TileType.js';
import type { SectorData } from '../types.js';
import { getTile, setTile, isCover, GRID_SIZE } from './GridAccess.js';

const CARDINALS: readonly (readonly [number, number])[] = [
  [-1, 0] as const,
  [1, 0] as const,
  [0, -1] as const,
  [0, 1] as const,
];

/**
 * Orphan Cleanup — a cover tile (DESTRUCTIBLE_CRATE, DESTRUCTIBLE_BARREL,
 * DESTRUCTIBLE_WALL) whose 4 cardinal neighbours are ALL EMPTY is "orphaned":
 * it has lost all structural context and reads as random clutter. These are
 * cleared to EMPTY.
 *
 * Two-phase (collect against the ORIGINAL state, then apply) prevents the
 * cascade where removing one orphan would make its neighbour look orphaned
 * too. Purely deterministic — no RNG.
 *
 * Never touches CHEST (3), EXIT (4), INDESTRUCTIBLE_WALL (1) — only cover
 * types. Never touches the outer perimeter.
 *
 * @param sectors - the 2D sector grid (mutated in place)
 * @returns the number of orphan tiles removed
 */
export function orphanCleanup(sectors: SectorData[][]): number {
  // Phase 1: collect orphans evaluated against the original tile state.
  const orphans: Array<[number, number]> = [];

  for (let r = 1; r <= GRID_SIZE - 2; r++) {
    for (let c = 1; c <= GRID_SIZE - 2; c++) {
      const tile = getTile(sectors, r, c);
      if (!isCover(tile)) continue;

      let allNeighborsEmpty = true;
      for (const [dr, dc] of CARDINALS) {
        if (getTile(sectors, r + dr, c + dc) !== TileType.EMPTY) {
          allNeighborsEmpty = false;
          break;
        }
      }
      if (allNeighborsEmpty) orphans.push([r, c]);
    }
  }

  // Phase 2: apply all clears.
  for (const [r, c] of orphans) {
    setTile(sectors, r, c, TileType.EMPTY);
  }

  return orphans.length;
}

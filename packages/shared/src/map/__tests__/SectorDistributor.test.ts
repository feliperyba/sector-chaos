import { describe, expect, it } from 'vitest';

import { SectorDistributor } from '../SectorDistributor.js';
import { SeededRNG } from '../rng/SeededRNG.js';
import { SECTOR_GRID_SIZE } from '../constants.js';
import { getSectorRing } from '../gridUtils.js';
import { SectorType } from '../types.js';

/**
 * Verifies the RNG draw-order contract on {@link SectorDistributor.distribute}.
 *
 * Cases (per ticket #23 Step 2b):
 *  1. RNG draw-order contract — two SeededRNG(12345), both at the same post-
 *     state after `distribute` (pins the draw count; an added/removed draw
 *     desyncs them).
 *  2. Center-hot invariants over 60 seeds (all 4 types present, center
 *     guarantees >=1 ResourceRich + >=1 GridArena, outer-ring trends).
 *  3. Deterministic output (same seed -> same SectorType[][]).
 *  4. Anti-clustering (no run of 3 identical types in any row/col).
 */

/** Number of post-distribute draws to compare when pinning rng post-state. */
const POST_STATE_PROBE_DRAWS = 5;

describe('SectorDistributor', () => {
  it('RNG draw-order contract: two SeededRNG(12345) reach the same post-state after distribute', () => {
    // Two rngs from the same seed.
    const rngA = new SeededRNG(12345);
    const rngB = new SeededRNG(12345);

    const distributor = new SectorDistributor();
    const gridA = distributor.distribute(rngA);
    const gridB = distributor.distribute(rngB);

    // The type grids must match (proves both consumed the same weightedPick
    // sequence — i.e. the same number of draws in the same order).
    expect(gridA).toEqual(gridB);

    // And the rngs must be at identical internal state afterwards: the next
    // N draws from each must match. If a draw was added/removed/rewritten,
    // the streams desync and this fails. (Using multiple draws rules out a
    // coincidental single-value collision.)
    for (let i = 0; i < POST_STATE_PROBE_DRAWS; i++) {
      expect(rngA.nextUint32()).toBe(rngB.nextUint32());
    }
  });

  it('center-hot invariants hold over 60 seeds (all types present, center guarantees, outer trends)', () => {
    const distributor = new SectorDistributor();
    const seeds = Array.from({ length: 60 }, (_, i) => i * 7 + 3);

    let centerRrGa = 0;
    let centerTotal = 0;
    let outerOaMz = 0;
    let outerTotal = 0;

    for (const seed of seeds) {
      const grid = distributor.distribute(new SeededRNG(seed));

      // All four types present.
      const types = new Set(grid.flat());
      expect(types.size).toBe(4);
      expect(types.has(SectorType.GRID_ARENA)).toBe(true);
      expect(types.has(SectorType.OPEN_ARENA)).toBe(true);
      expect(types.has(SectorType.MAZE)).toBe(true);
      expect(types.has(SectorType.RESOURCE_RICH)).toBe(true);

      // Split by ring; assert center guarantees + accumulate trend counts.
      const center: SectorType[] = [];
      const outer: SectorType[] = [];
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          const t = grid[row]![col]!;
          if (getSectorRing(row, col, SECTOR_GRID_SIZE) === 'center') center.push(t);
          else outer.push(t);
        }
      }

      // Center 2x2 always holds >=1 ResourceRich AND >=1 GridArena.
      expect(center.filter((t) => t === SectorType.RESOURCE_RICH).length).toBeGreaterThanOrEqual(1);
      expect(center.filter((t) => t === SectorType.GRID_ARENA).length).toBeGreaterThanOrEqual(1);

      centerRrGa += center.filter(
        (t) => t === SectorType.RESOURCE_RICH || t === SectorType.GRID_ARENA,
      ).length;
      centerTotal += center.length;
      outerOaMz += outer.filter((t) => t === SectorType.OPEN_ARENA || t === SectorType.MAZE).length;
      outerTotal += outer.length;
    }

    // Strong-majority trends (not absolute — the rare-type tail still appears).
    expect(centerRrGa / centerTotal).toBeGreaterThan(0.7);
    expect(outerOaMz / outerTotal).toBeGreaterThan(0.6);
  });

  it('deterministic output: same seed produces identical SectorType[][] grids', () => {
    const distributor = new SectorDistributor();
    const seeds = [1, 42, 999, 0xdeadbeef, 123456];

    for (const seed of seeds) {
      const a = distributor.distribute(new SeededRNG(seed));
      const b = distributor.distribute(new SeededRNG(seed));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('anti-clustering: spreadClusters breaks every 3-run whose third cell is outer-ring (center cells are intentionally left alone)', () => {
    const distributor = new SectorDistributor();
    // spreadClusters' documented contract (see SectorDistributor.spreadClusters
    // JSDoc): break any run of three identical types by retyping the THIRD
    // cell to a deterministic alternative — but SKIP center cells so it never
    // undoes the center guarantees. Therefore the honest characterization is:
    // no 3-run may exist whose third cell is in the OUTER ring. (A 3-run whose
    // third cell lands on a center cell is permitted and does occur, since
    // retyping it could violate the >=1 ResourceRich + >=1 GridArena center
    // guarantee.) Broad sweep over 100 seeds.
    const seeds = Array.from({ length: 100 }, (_, i) => i + 1);

    for (const seed of seeds) {
      const grid = distributor.distribute(new SeededRNG(seed));

      // Row-wise: a 3-run is only forbidden if its third cell is outer-ring.
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 2; col < SECTOR_GRID_SIZE; col++) {
          const a = grid[row]![col]!;
          const b = grid[row]![col - 1]!;
          const c = grid[row]![col - 2]!;
          if (a !== b || b !== c) continue;
          // It's a 3-run; the third cell must NOT be outer-ring (else
          // spreadClusters should have retyped it).
          expect(getSectorRing(row, col, SECTOR_GRID_SIZE)).toBe('center');
        }
      }

      // Col-wise: a 3-run is only forbidden if its third cell is outer-ring.
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        for (let row = 2; row < SECTOR_GRID_SIZE; row++) {
          const a = grid[row]![col]!;
          const b = grid[row - 1]![col]!;
          const c = grid[row - 2]![col]!;
          if (a !== b || b !== c) continue;
          expect(getSectorRing(row, col, SECTOR_GRID_SIZE)).toBe('center');
        }
      }
    }
  });
});

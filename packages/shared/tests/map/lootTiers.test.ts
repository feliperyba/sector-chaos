import { describe, it, expect } from 'vitest';
import {
  assignSectorTiers,
  countTiers,
  effectiveSectorTier,
  TIER_TARGETS,
} from '../../src/map/lootTiers.js';
import { getSectorRing } from '../../src/map/gridUtils.js';
import { SECTOR_GRID_SIZE } from '../../src/map/constants.js';
import { SectorLootTier } from '../../src/map/types.js';

/**
 * Loot-tier pyramid + per-match hot sector (map-redesign ticket 02 / DEC-003).
 *
 * The quick-form seed-sweep spot-check required by the ticket: >=20 seeds,
 * tier ratios within ±1 sector of the pyramid targets, hot sector differs
 * between consecutive seeds.
 */
const SWEEP_SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7);

function centerCoords(): Array<{ row: number; col: number }> {
  return [
    { row: 1, col: 1 },
    { row: 1, col: 2 },
    { row: 2, col: 1 },
    { row: 2, col: 2 },
  ];
}

function sectorKey(s: { row: number; col: number }): string {
  return `${s.row},${s.col}`;
}

describe('assignSectorTiers — pyramid structure (per seed)', () => {
  it('grid is 4x4 and only contains valid tiers', () => {
    for (const seed of SWEEP_SEEDS) {
      const { tiers } = assignSectorTiers(seed);
      expect(tiers).toHaveLength(SECTOR_GRID_SIZE);
      for (const row of tiers) {
        expect(row).toHaveLength(SECTOR_GRID_SIZE);
        for (const tier of row) {
          expect(['HOT', 'WARM', 'COLD']).toContain(tier);
        }
      }
    }
  });

  it('HOT count within 2-3 and within ±1 of the target', () => {
    for (const seed of SWEEP_SEEDS) {
      const counts = countTiers(assignSectorTiers(seed).tiers);
      expect(counts.hot).toBeGreaterThanOrEqual(TIER_TARGETS.hotMin);
      expect(counts.hot).toBeLessThanOrEqual(TIER_TARGETS.hotMax);
      expect(Math.abs(counts.hot - TIER_TARGETS.hotMax)).toBeLessThanOrEqual(1);
    }
  });

  it('WARM count within ±1 of target (~8)', () => {
    for (const seed of SWEEP_SEEDS) {
      const counts = countTiers(assignSectorTiers(seed).tiers);
      expect(Math.abs(counts.warm - TIER_TARGETS.warm)).toBeLessThanOrEqual(1);
    }
  });

  it('COLD count within ±1 of target (~5)', () => {
    for (const seed of SWEEP_SEEDS) {
      const counts = countTiers(assignSectorTiers(seed).tiers);
      expect(Math.abs(counts.cold - TIER_TARGETS.cold)).toBeLessThanOrEqual(1);
    }
  });

  it('center cluster guaranteed: center 2x2 always holds >=1 base HOT', () => {
    for (const seed of SWEEP_SEEDS) {
      const { tiers } = assignSectorTiers(seed);
      const centerHot = centerCoords().filter(
        ({ row, col }) => tiers[row]![col] === SectorLootTier.HOT,
      );
      expect(centerHot.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('COLD sectors are only on the outer ring', () => {
    for (const seed of SWEEP_SEEDS) {
      const { tiers } = assignSectorTiers(seed);
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          if (tiers[row]![col] !== SectorLootTier.COLD) continue;
          expect(getSectorRing(row, col, SECTOR_GRID_SIZE)).toBe('outer');
        }
      }
    }
  });

  it('HOT sectors form one contiguous cluster (every HOT touches another HOT)', () => {
    for (const seed of SWEEP_SEEDS) {
      const { tiers } = assignSectorTiers(seed);
      const hot = new Set<string>();
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          if (tiers[row]![col] === SectorLootTier.HOT) hot.add(`${row},${col}`);
        }
      }
      expect(hot.size).toBeGreaterThanOrEqual(2);
      // With 2-3 HOT sectors and >=1 in the tight 2x2 center + the outer pick
      // edge-adjacent to a center HOT, every HOT sector must have >=1 HOT
      // 4-neighbour (a cluster, never isolated singles).
      for (const key of hot) {
        const [row, col] = key.split(',').map(Number) as [number, number];
        const neighbors = [
          [row - 1, col],
          [row + 1, col],
          [row, col - 1],
          [row, col + 1],
        ].map(([r, c]) => `${r},${c}`);
        expect(neighbors.some((n) => hot.has(n))).toBe(true);
      }
    }
  });
});

describe('assignSectorTiers — per-match hot sector', () => {
  it('hot sector is a non-central (outer) WARM sector in the base pyramid', () => {
    for (const seed of SWEEP_SEEDS) {
      const { tiers, hotSector } = assignSectorTiers(seed);
      expect(getSectorRing(hotSector.row, hotSector.col, SECTOR_GRID_SIZE)).toBe('outer');
      expect(tiers[hotSector.row]![hotSector.col]).toBe(SectorLootTier.WARM);
    }
  });

  it('effectiveSectorTier upgrades the hot sector to HOT, others unchanged', () => {
    const assignment = assignSectorTiers(42);
    const { tiers, hotSector } = assignment;
    expect(effectiveSectorTier(assignment, hotSector.row, hotSector.col)).toBe(SectorLootTier.HOT);
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        if (row === hotSector.row && col === hotSector.col) continue;
        expect(effectiveSectorTier(assignment, row, col)).toBe(tiers[row]![col]);
      }
    }
  });

  it('hot sector differs between consecutive seeds (rotation, DEC-009 >=60%)', () => {
    let changed = 0;
    let pairs = 0;
    for (let i = 0; i < SWEEP_SEEDS.length - 1; i++) {
      const a = assignSectorTiers(SWEEP_SEEDS[i]!).hotSector;
      const b = assignSectorTiers(SWEEP_SEEDS[i + 1]!).hotSector;
      pairs++;
      if (sectorKey(a) !== sectorKey(b)) changed++;
    }
    expect(pairs).toBeGreaterThanOrEqual(20);
    // DEC-009 hot-sector rotation gate: >=60% of consecutive seed pairs must
    // rotate the hot sector (6 outer-WARM candidates -> ~1/6 collision rate).
    expect(changed / pairs).toBeGreaterThanOrEqual(0.6);
  });
});

describe('assignSectorTiers — determinism (ADR 0035)', () => {
  it('same seed produces a deep-equal assignment', () => {
    for (const seed of SWEEP_SEEDS) {
      expect(assignSectorTiers(seed)).toEqual(assignSectorTiers(seed));
    }
  });

  it('tier pass draws are isolated from the generation RNG stream', () => {
    // The tier pass must not consume from the shared generation stream: for a
    // given map seed, generating the full map twice (which re-runs the tier
    // pass) yields byte-identical MapData including sector tiles — covered by
    // the MapGenerator determinism + golden tests. Here we assert the cheaper
    // property directly: the assignment is a pure function of the seed alone
    // (no hidden state), so two fresh calls agree on every coordinate.
    const a = assignSectorTiers(7);
    const b = assignSectorTiers(7);
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        expect(a.tiers[row]![col]).toBe(b.tiers[row]![col]);
      }
    }
    expect(a.hotSector).toEqual(b.hotSector);
  });
});

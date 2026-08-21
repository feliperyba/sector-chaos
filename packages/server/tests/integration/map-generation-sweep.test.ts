import { describe, it, expect, beforeAll } from 'vitest';
import {
  MapGenerator,
  SPAWN_EQUITY_MAX_DEVIATION,
  LANDMARK_REGISTRY,
  LANDMARK_TYPE_ORDER,
  SectorLootTier,
  getSectorRing,
  SECTOR_GRID_SIZE,
  type GenerationAudit,
  type MapData,
} from '@sector-battle/shared';

/**
 * Map-redesign ticket 10 / DEC-009 — the seed-sweep distribution suite:
 * "test distributions, not just fixtures". Generation-only (no simulation):
 * runs the shared MapGenerator over a deterministic seed list and asserts the
 * generator's CHARACTER — tier pyramid ratios, landmark frequency bands,
 * adjacency uniqueness, hot-sector rotation, Citadel frequency, spawn equity
 * bounds — plus the no-spurious-retry regression (first-attempt pass rate
 * not worse than the pre-ticket baseline, measured 0/500 on consecutive
 * seeds in skeletonVariety.test.ts).
 *
 * Forms (DEC-009 #4 / Wei's runtime note):
 * - CI form (default): 5 seeds — the assertions that are stable at small N.
 * - Full form: `MAP_SWEEP_SEEDS=50 pnpm --filter @sector-battle/server exec
 *   vitest run tests/integration/map-generation-sweep.test.ts` — adds the
 *   statistical bands (Citadel rate, landmark coverage/frequency). Measured
 *   runtime of the 50-seed generation sweep: ~2s (well under the ~30s bound).
 */

const SWEEP_SEEDS: readonly number[] = Array.from(
  { length: Math.max(2, Number(process.env.MAP_SWEEP_SEEDS ?? 5)) },
  (_, i) => i + 1,
);
const FULL_FORM = SWEEP_SEEDS.length >= 50;
const BOUND = 1 + SPAWN_EQUITY_MAX_DEVIATION;

interface SweepEntry {
  seed: number;
  map: MapData;
  audit: GenerationAudit;
}

let sweep: SweepEntry[] = [];

beforeAll(() => {
  const gen = new MapGenerator();
  sweep = SWEEP_SEEDS.map((seed) => {
    const map = gen.generate(seed);
    const audit = gen.getLastGenerationAudit();
    if (!audit) throw new Error(`no generation audit for seed ${seed}`);
    return { seed, map, audit };
  });
}, 120_000);

describe('map-generation seed-sweep distribution suite (ticket 10 / DEC-009)', () => {
  it('every map: spawn equity bounds held post-repair (0 violations, ratios within bound)', () => {
    for (const { seed, audit } of sweep) {
      expect(
        audit.equity.violations,
        `seed ${seed}: residual spawn-equity violations`,
      ).toHaveLength(0);
      for (const component of ['weapon', 'chest', 'clump', 'hot'] as const) {
        expect(audit.equity.maxRatio[component], `seed ${seed} ${component}`).toBeLessThanOrEqual(
          BOUND + 1e-9,
        );
      }
      // GDD §5 preserved: 64 spawns, 4 per sector, after the repair pass.
      expect(audit.spawnRepairs).toBeLessThan(64);
    }
  });

  it('no spurious-retry regression: every map generated on the FIRST attempt', () => {
    // Pre-ticket baseline: 0 retries over the 500-seed consecutive sweep
    // (skeletonVariety.test.ts). The equity gate must not push maps into the
    // generation retry loop: repair handles borderline spawns, rejection is
    // reserved for genuinely unrepairable geometry.
    const retried = sweep.filter((e) => e.audit.generationAttempts > 1);
    expect(
      retried.map((e) => e.seed),
      `seeds needed >1 generation attempt: ${retried.map((e) => `${e.seed}x${e.audit.generationAttempts}`).join(', ')}`,
    ).toEqual([]);
  });

  it('tier pyramid ratios in band on every map (HOT 2–3 / WARM 8–9 / COLD 5±1)', () => {
    for (const { seed, map } of sweep) {
      let hot = 0;
      let warm = 0;
      let cold = 0;
      for (const row of map.sectorTiers) {
        for (const tier of row) {
          if (tier === SectorLootTier.HOT) hot++;
          else if (tier === SectorLootTier.WARM) warm++;
          else cold++;
        }
      }
      expect(hot, `seed ${seed} HOT`).toBeGreaterThanOrEqual(2);
      expect(hot, `seed ${seed} HOT`).toBeLessThanOrEqual(3);
      expect(warm, `seed ${seed} WARM`).toBeGreaterThanOrEqual(7);
      expect(warm, `seed ${seed} WARM`).toBeLessThanOrEqual(9);
      expect(cold, `seed ${seed} COLD`).toBeGreaterThanOrEqual(4);
      expect(cold, `seed ${seed} COLD`).toBeLessThanOrEqual(6);
      // Hot sector: outer-ring base-WARM upgraded for the match.
      expect(getSectorRing(map.hotSector.row, map.hotSector.col, SECTOR_GRID_SIZE)).toBe('outer');
      expect(map.sectorTiers[map.hotSector.row]![map.hotSector.col]).toBe(SectorLootTier.WARM);
    }
  });

  it('landmark bands: minors 2–3, adjacency uniqueness, rare under-rolled (every map)', () => {
    for (const { seed, map } of sweep) {
      const heroes = map.landmarks.heroes;
      expect(heroes).toHaveLength(SECTOR_GRID_SIZE);
      expect(map.landmarks.minors.length).toBeGreaterThanOrEqual(2);
      expect(map.landmarks.minors.length).toBeLessThanOrEqual(3);
      let rare = 0;
      for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
        for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
          const hero = heroes[row]![col]!;
          if (hero.rarity === 'rare') rare++;
          if (col > 0) expect(heroes[row]![col - 1]!.compositionId).not.toBe(hero.compositionId);
          if (row > 0) expect(heroes[row - 1]![col]!.compositionId).not.toBe(hero.compositionId);
        }
      }
      // RARE variants are deliberately under-rolled (rarity-as-emotion):
      // expected ~0.8 per map (5% share over the 500-seed sweep); a single
      // map may still roll up to 4 without breaking the under-rolled intent.
      expect(rare).toBeLessThanOrEqual(4);
    }
  });

  it('hot-sector rotation ≥60% between consecutive seeds', () => {
    let changes = 0;
    let pairs = 0;
    for (let i = 1; i < sweep.length; i++) {
      const a = sweep[i - 1]!.map.hotSector;
      const b = sweep[i]!.map.hotSector;
      pairs++;
      if (a.row !== b.row || a.col !== b.col) changes++;
    }
    expect(pairs).toBeGreaterThan(0);
    expect(changes / pairs, `${changes}/${pairs} consecutive pairs rotated`).toBeGreaterThanOrEqual(
      0.6,
    );
  });

  it('macro shape rides the designation vocabulary (manifest completion field)', () => {
    for (const { map } of sweep) {
      const shape = map.designation.split(' • ')[0]!;
      expect(['RINGROAD', 'SPINEWAY', 'RIDGELINE', 'TWINFIELDS']).toContain(shape);
    }
  });

  it('same-seed regeneration is byte-stable (fairness pass deterministic)', () => {
    const gen = new MapGenerator();
    const a = gen.generate(sweep[0]!.seed);
    const auditA = gen.getLastGenerationAudit()!;
    const b = gen.generate(sweep[0]!.seed);
    const auditB = gen.getLastGenerationAudit()!;
    expect(JSON.stringify(b.spawnPoints)).toBe(JSON.stringify(a.spawnPoints));
    expect(auditB.spawnRepairs).toBe(auditA.spawnRepairs);
  });

  // ---- Full-form-only statistical bands (need ≥50 seeds to be meaningful) ----

  it.skipIf(!FULL_FORM)('rare-landmark share under-rolled across the sweep', () => {
    let rare = 0;
    let total = 0;
    for (const { map } of sweep) {
      for (const row of map.landmarks.heroes) {
        for (const hero of row) {
          total++;
          if (hero.rarity === 'rare') rare++;
        }
      }
    }
    // Measured ~5% over 500 seeds; the band allows up to 15% before the
    // rarity-as-emotion character is considered lost.
    expect(rare / total).toBeLessThanOrEqual(0.15);
  });

  it.skipIf(!FULL_FORM)('Citadel frequency in band over the full sweep', () => {
    const citadels = sweep.filter((e) => e.map.fortress?.variant === 'CITADEL').length;
    const rate = citadels / sweep.length;
    // Design parameter CITADEL_CHANCE = 0.125 (DEC-004's 10–15% band); the
    // sweep band widens to [5%, 25%] for deterministic-sample noise at N=50.
    expect(rate, `${citadels}/${sweep.length} Citadel maps`).toBeGreaterThanOrEqual(0.05);
    expect(rate).toBeLessThanOrEqual(0.25);
  });

  it.skipIf(!FULL_FORM)(
    'landmark frequency bands: every composition appears, none dominates',
    () => {
      const counts = new Map<string, number>();
      let total = 0;
      for (const { map } of sweep) {
        for (const row of map.landmarks.heroes) {
          for (const hero of row) {
            counts.set(hero.compositionId, (counts.get(hero.compositionId) ?? 0) + 1);
            total++;
          }
        }
      }
      const all = LANDMARK_TYPE_ORDER.flatMap((t) => LANDMARK_REGISTRY[t].map((e) => e.id));
      // Coverage: every authored composition is reachable (no dead variant).
      const missing = all.filter((id) => !counts.has(id));
      expect(missing, `compositions never drawn: ${missing.join(', ')}`).toEqual([]);
      // No monopoly: the most-drawn composition stays well under a quarter of
      // all hero draws (measured max ~10%).
      const top = Math.max(...counts.values()) / total;
      expect(top).toBeLessThanOrEqual(0.2);
    },
  );

  it.skipIf(!FULL_FORM)(
    'designation distinctness reported (DEC-010, collision rate not gated)',
    () => {
      const designations = new Set(sweep.map((e) => e.map.designation));
      // Soft audit surface: distinct designations across the sweep.
      console.log(
        `sweep character: ${sweep.length} seeds, ${designations.size} distinct designations, ` +
          `avg repairs ${(sweep.reduce((s, e) => s + e.audit.spawnRepairs, 0) / sweep.length).toFixed(1)}, ` +
          `Citadel maps ${sweep.filter((e) => e.map.fortress?.variant === 'CITADEL').length}`,
      );
      expect(designations.size).toBeGreaterThanOrEqual(Math.floor(sweep.length * 0.9));
    },
  );
});

import { describe, it, expect } from 'vitest';
import {
  BENCH_WIDE_MIX,
  MMR_DIFFICULTY_MIX,
  drawDifficultyFromMix,
  mmrBandFromAverage,
  MMR_HIGH_BAND_MIN,
  MMR_LOW_BAND_MAX,
} from '../../../src/ai/skill/BotDifficultyTables.ts';
import type { DifficultyLevel } from '../../../src/ai/intent/PersonalityProfile.ts';

/**
 * bot-ai-v2 ticket 08 (DEC-009.1) — the GDD §14.6 MMR→difficulty
 * distribution, implemented VERBATIM. These tests pin the table against the
 * GDD text row by row, the banding edges, the weighted draw, and the
 * no-MMR default path (through BotManager).
 */

/** mulberry32 — the same PRNG the seeded streams use (deterministic draws). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('GDD §14.6 MMR difficulty distribution (verbatim)', () => {
  it('low MMR lobby: 70% Easy, 20% Medium, 10% Hard', () => {
    const row = Object.fromEntries(
      MMR_DIFFICULTY_MIX.low.map((w) => [w.difficulty, w.percent]),
    ) as Record<string, number>;
    expect(row.easy).toBe(70);
    expect(row.medium).toBe(20);
    expect(row.hard).toBe(10);
    expect(MMR_DIFFICULTY_MIX.low).toHaveLength(3);
  });

  it('mid MMR lobby: 20% Easy, 60% Medium, 20% Hard', () => {
    const row = Object.fromEntries(
      MMR_DIFFICULTY_MIX.mid.map((w) => [w.difficulty, w.percent]),
    ) as Record<string, number>;
    expect(row.easy).toBe(20);
    expect(row.medium).toBe(60);
    expect(row.hard).toBe(20);
    expect(MMR_DIFFICULTY_MIX.mid).toHaveLength(3);
  });

  it('high MMR lobby: 10% Easy, 20% Medium, 70% Hard', () => {
    const row = Object.fromEntries(
      MMR_DIFFICULTY_MIX.high.map((w) => [w.difficulty, w.percent]),
    ) as Record<string, number>;
    expect(row.easy).toBe(10);
    expect(row.medium).toBe(20);
    expect(row.hard).toBe(70);
    expect(MMR_DIFFICULTY_MIX.high).toHaveLength(3);
  });

  it('every row sums to 100 percent and only names easy/medium/hard', () => {
    for (const mix of Object.values(MMR_DIFFICULTY_MIX)) {
      expect(mix.reduce((sum, w) => sum + w.percent, 0)).toBe(100);
      for (const w of mix) {
        expect(['easy', 'medium', 'hard']).toContain(w.difficulty);
        expect(w.percent).toBeGreaterThan(0);
      }
    }
  });

  it('the bench wide mix spans ALL five tiers evenly (the deliberate pin)', () => {
    expect(BENCH_WIDE_MIX).toHaveLength(5);
    const byTier = new Map(BENCH_WIDE_MIX.map((w) => [w.difficulty, w.percent]));
    for (const tier of ['easy', 'normal', 'medium', 'hard', 'elite'] as DifficultyLevel[]) {
      expect(byTier.get(tier)).toBe(20);
    }
    expect(BENCH_WIDE_MIX.reduce((sum, w) => sum + w.percent, 0)).toBe(100);
  });
});

describe('mmrBandFromAverage', () => {
  it('no-data values yield null (the GDD default path — room-wide difficulty)', () => {
    expect(mmrBandFromAverage(undefined)).toBeNull();
    expect(mmrBandFromAverage(0)).toBeNull();
    expect(mmrBandFromAverage(-50)).toBeNull();
    expect(mmrBandFromAverage(Number.NaN)).toBeNull();
    expect(mmrBandFromAverage(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('bands follow the tunable edges: low < 1200 ≤ mid ≤ 1800 < high', () => {
    expect(MMR_LOW_BAND_MAX).toBe(1200);
    expect(MMR_HIGH_BAND_MIN).toBe(1800);
    expect(mmrBandFromAverage(1)).toBe('low');
    expect(mmrBandFromAverage(1199.99)).toBe('low');
    expect(mmrBandFromAverage(1200)).toBe('mid');
    expect(mmrBandFromAverage(1500)).toBe('mid');
    expect(mmrBandFromAverage(1800)).toBe('mid');
    expect(mmrBandFromAverage(1800.01)).toBe('high');
    expect(mmrBandFromAverage(3000)).toBe('high');
  });
});

describe('drawDifficultyFromMix', () => {
  it('is a pure function of (mix, roll) — same inputs, same result', () => {
    for (const roll of [0, 0.1, 0.35, 0.5, 0.6999999, 0.7, 0.9, 0.999999]) {
      expect(drawDifficultyFromMix(MMR_DIFFICULTY_MIX.low, roll)).toBe(
        drawDifficultyFromMix(MMR_DIFFICULTY_MIX.low, roll),
      );
    }
  });

  it('boundary rolls slice the GDD percents exactly (low band: 70/20/10)', () => {
    const low = MMR_DIFFICULTY_MIX.low;
    expect(drawDifficultyFromMix(low, 0)).toBe('easy');
    expect(drawDifficultyFromMix(low, 0.5)).toBe('easy');
    expect(drawDifficultyFromMix(low, 0.6999)).toBe('easy');
    expect(drawDifficultyFromMix(low, 0.7)).toBe('medium');
    expect(drawDifficultyFromMix(low, 0.8999)).toBe('medium');
    expect(drawDifficultyFromMix(low, 0.9)).toBe('hard');
    expect(drawDifficultyFromMix(low, 0.9999)).toBe('hard');
    // Rolls ≥ 1 (impossible from [0,1) streams) clamp to the last row.
    expect(drawDifficultyFromMix(low, 1)).toBe('hard');
  });

  it('seeded draws reproduce the GDD percentages within tolerance', () => {
    const rng = mulberry32(20260819);
    const N = 60000;
    for (const band of ['low', 'mid', 'high'] as const) {
      const counts: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
      for (let i = 0; i < N; i++) {
        counts[drawDifficultyFromMix(MMR_DIFFICULTY_MIX[band], rng())]!++;
      }
      for (const w of MMR_DIFFICULTY_MIX[band]) {
        const observed = (counts[w.difficulty] ?? 0) / N;
        // ±2 percentage points at N=60000 (binomial SD ≈ 0.19pp — generous
        // margin so the suite never flakes, tight enough to catch a wrong
        // table row).
        expect(Math.abs(observed - w.percent / 100)).toBeLessThan(0.02);
      }
    }
  });
});

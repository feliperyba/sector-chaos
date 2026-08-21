import { describe, it, expect } from 'vitest';
import { BotRNG, hashToSeed } from '../../../src/ai/BotContext.ts';
import {
  REACTION_LATENCY_BY_DIFFICULTY,
  REACTION_LATENCY_MAX_TICKS,
} from '../../../src/ai/reactor/ReactorConfig.ts';
import {
  drawReactionLatencyMs,
  drawReactionLatencyTicks,
} from '../../../src/ai/reactor/ReactorLatency.ts';
import type { DifficultyLevel } from '../../../src/ai/intent/PersonalityProfile.ts';

/**
 * Ex-Gaussian reaction-latency distribution (DEC-007, bot-ai-v2 ticket 04).
 *
 * The GDD §14.2 difficulty table's reaction times (Easy 600 / Medium 300 /
 * Hard 100 ms) are consumed as the distribution MEANS — every assertion here
 * is made against the TABLE value, not an invented threshold. All draws go
 * through BotRNG streams (determinism), so every expectation is exact for a
 * fixed seed: the statistical tolerances are set far wider than the sampling
 * error of the fixed draw count (documented per test), so a same-seed run can
 * never flake.
 */

const N = 24_000;

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}

describe('drawReactionLatencyMs distribution shape', () => {
  // Sample-mean standard error at N=24000: easy ≈1.2ms, medium ≈0.6ms, hard
  // ≈0.2ms — the ±8% band below is 40–190× the sampling error. No flake.
  it.each([
    ['easy', 600],
    ['normal', 300],
    ['medium', 300],
    ['hard', 100],
    ['elite', 100],
  ] as const)('%s: sample mean ≈ the GDD table mean (%dms)', (difficulty, meanMs) => {
    const rng = new BotRNG(hashToSeed(`latency-${difficulty}`));
    const params = REACTION_LATENCY_BY_DIFFICULTY[difficulty as DifficultyLevel];
    let sum = 0;
    for (let i = 0; i < N; i++) sum += drawReactionLatencyMs(rng, params);
    const sampleMean = sum / N;
    expect(sampleMean).toBeGreaterThan(meanMs * 0.92);
    expect(sampleMean).toBeLessThan(meanMs * 1.08);
  });

  it('is right-skewed: mean > median (the ex-Gaussian tail), per difficulty', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const rng = new BotRNG(hashToSeed(`skew-${difficulty}`));
      const params = REACTION_LATENCY_BY_DIFFICULTY[difficulty];
      const draws: number[] = [];
      for (let i = 0; i < N; i++) draws.push(drawReactionLatencyMs(rng, params));
      const sorted = [...draws].sort((a, b) => a - b);
      const mean = draws.reduce((a, b) => a + b, 0) / N;
      const median = quantile(sorted, 0.5);
      // E[X] > median for every ex-Gaussian, but the gap is NOT τ·ln2 — the
      // Gaussian body (σ ≥ τ·1.5 here) dominates and shrinks it. Measured at
      // these fixed seeds: easy ≈ 6.7ms, medium ≈ 3.5ms, hard ≈ 1.5ms. The
      // +1ms margin clears all three with headroom, and the seeded draws are
      // byte-deterministic, so the bound can never flake.
      expect(mean).toBeGreaterThan(median + 1);
    }
  });

  it('percentiles are strictly ordered (p10 < p50 < p90) — spread, not a spike', () => {
    const rng = new BotRNG(hashToSeed('percentiles-medium'));
    const params = REACTION_LATENCY_BY_DIFFICULTY.medium;
    const draws: number[] = [];
    for (let i = 0; i < N; i++) draws.push(drawReactionLatencyMs(rng, params));
    const sorted = [...draws].sort((a, b) => a - b);
    const p10 = quantile(sorted, 0.1);
    const p50 = quantile(sorted, 0.5);
    const p90 = quantile(sorted, 0.9);
    expect(p10).toBeLessThan(p50);
    expect(p50).toBeLessThan(p90);
    // Non-degenerate width: the 10–90 band spans a meaningful fraction of
    // the mean (ex-Gaussian body σ=75ms for medium ⇒ band ≈ 2.56σ ≈ 190ms).
    expect(p90 - p10).toBeGreaterThan(100);
  });
});

describe('drawReactionLatencyTicks', () => {
  it('is bounded: every draw in [0, REACTION_LATENCY_MAX_TICKS]', () => {
    const rng = new BotRNG(hashToSeed('ticks-bounded'));
    const params = REACTION_LATENCY_BY_DIFFICULTY.easy; // widest tail
    for (let i = 0; i < N; i++) {
      const t = drawReactionLatencyTicks(rng, params);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(REACTION_LATENCY_MAX_TICKS);
      expect(Number.isInteger(t)).toBe(true);
    }
  });

  it('is deterministic: same seed → identical draw sequence', () => {
    const a = new BotRNG(hashToSeed('det-latency'));
    const b = new BotRNG(hashToSeed('det-latency'));
    const params = REACTION_LATENCY_BY_DIFFICULTY.medium;
    for (let i = 0; i < 100; i++) {
      expect(drawReactionLatencyTicks(a, params)).toBe(drawReactionLatencyTicks(b, params));
    }
  });

  it('GROUP STAGGER: two bots (different seeds) draw different latencies — same stimulus, different reaction ticks', () => {
    const botA = new BotRNG(hashToSeed('bot-alpha'));
    const botB = new BotRNG(hashToSeed('bot-bravo'));
    const params = REACTION_LATENCY_BY_DIFFICULTY.hard;
    const drawsA: number[] = [];
    const drawsB: number[] = [];
    for (let i = 0; i < 64; i++) {
      drawsA.push(drawReactionLatencyTicks(botA, params));
      drawsB.push(drawReactionLatencyTicks(botB, params));
    }
    // The sequences differ (two independent per-bot streams reacting to the
    // same stimulus never land on identical tick schedules). P(colliding on
    // all 64 draws) is astronomically small for ~11-wide integer draws.
    expect(drawsA).not.toEqual(drawsB);
    // And across the pair, the combined set of reaction offsets spans more
    // than one tick — the visible stagger the bench histogram reads.
    const distinct = new Set<number>([...drawsA, ...drawsB]);
    expect(distinct.size).toBeGreaterThan(1);
  });
});

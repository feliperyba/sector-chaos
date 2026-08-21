import { describe, it, expect } from 'vitest';
import { BotRNG } from '../../../src/ai/BotContext.ts';
import { detectionConfidence, foveationNoiseScale } from '../../../src/ai/belief/BeliefMath.ts';
import { FOVEATION_DETECTION_RANGE } from '../../../src/ai/belief/BeliefConfig.ts';
import { reactionCapFor } from '../../../src/ai/skill/CombatCapTables.ts';
import { drawReactionLatencyTicks } from '../../../src/ai/reactor/ReactorLatency.ts';
import type { DifficultyLevel } from '../../../src/ai/intent/PersonalityProfile.ts';

/**
 * bot-ai-v2 ticket 08 (DEC-009.5) — DETECTION RANGES END-TO-END per
 * difficulty: ticket 05 restored the GDD §14.2 ranges (Easy 192 / Medium 320
 * / Hard 512 px) as belief CONFIDENCE modifiers; this suite verifies the
 * per-difficulty COMPOSITION the harness measures ("an easy bot notices a
 * distant enemy later than a hard bot — measurable sight→react delta"):
 *
 *   sight  = detectionConfidence(dist, tier) — beyond the tier's range the
 *            sighting is a faded, noisier belief (a LATER effective notice);
 *   react  = drawReactionLatencyTicks — the ex-Gaussian μ per tier (the
 *            GDD §14.2 reaction times as distribution means).
 *
 * The benchmark surface for this gate is the harness's per-difficulty
 * seenToAttack + reactionLatency cuts (pinned live by the wide-mix roster in
 * bot-ai-fullgame.test.ts); the directional thresholds vs baseline are the
 * orchestrator's full-bench sweep. What MUST hold at every distance is the
 * ORDERING — pinned here end-to-end with deterministic draws.
 */

const MS_PER_TICK = 1000 / 60;

/** Empirical mean latency (ticks) over N paired draws (same seed per tier →
 *  deterministic; paired seeds make the comparison exact, not statistical). */
function meanLatencyTicks(tier: DifficultyLevel, n: number, seed: number): number {
  const rng = new BotRNG(seed);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += drawReactionLatencyTicks(rng, reactionCapFor(tier));
  return sum / n;
}

describe('GDD §14.2 detection ranges (restored by ticket 05, consumed here)', () => {
  it('the table is verbatim: Easy 192 / Medium 320 / Hard 512 px', () => {
    expect(FOVEATION_DETECTION_RANGE.easy).toBe(192);
    expect(FOVEATION_DETECTION_RANGE.medium).toBe(320);
    expect(FOVEATION_DETECTION_RANGE.hard).toBe(512);
  });

  it('a distant enemy is a FADED belief for easy and a FULL sighting for hard', () => {
    // 400px: inside hard's 512 range, OUTSIDE easy's 192 and medium's 320.
    expect(detectionConfidence(400, 'easy')).toBeLessThan(1);
    expect(detectionConfidence(400, 'medium')).toBeLessThan(1);
    expect(detectionConfidence(400, 'hard')).toBe(1);
    // And the fade is ordered with the tier everywhere beyond easy's range.
    for (let dist = 193; dist < 1000; dist += 37) {
      expect(detectionConfidence(dist, 'easy')).toBeLessThanOrEqual(
        detectionConfidence(dist, 'medium'),
      );
      expect(detectionConfidence(dist, 'medium')).toBeLessThanOrEqual(
        detectionConfidence(dist, 'hard'),
      );
    }
    // Inside EVERY tier's range (≤192) all see full confidence.
    for (const tier of ['easy', 'normal', 'medium', 'hard', 'elite'] as const) {
      expect(detectionConfidence(150, tier)).toBe(1);
    }
  });

  it('the same distant sighting is NOISIER for easy than hard (foggy memory)', () => {
    // Facing the target (angle 0) at 400px: easy's believed position carries
    // more positional noise than hard's — the "notices it worse" half of the
    // delta, compounding over the fight.
    expect(foveationNoiseScale(0, 400, 'easy')).toBeGreaterThan(
      foveationNoiseScale(0, 400, 'hard'),
    );
    for (const angle of [0, Math.PI / 3, Math.PI / 2, Math.PI]) {
      expect(foveationNoiseScale(angle, 400, 'easy')).toBeGreaterThanOrEqual(
        foveationNoiseScale(angle, 400, 'hard'),
      );
    }
  });
});

describe('sight→react delta per difficulty (the composed end-to-end ordering)', () => {
  it('reaction μ: easy 600ms / medium 300ms / hard 100ms — the GDD §14.2 means', () => {
    expect(reactionCapFor('easy').meanMs).toBe(600);
    expect(reactionCapFor('medium').meanMs).toBe(300);
    expect(reactionCapFor('hard').meanMs).toBe(100);
  });

  it('deterministic ex-Gaussian draws: easy reacts visibly LATER than hard (paired seeds)', () => {
    // 2000 paired draws per tier: the empirical means sit near the GDD
    // distribution means (±8 ticks — generous vs the tail's variance so the
    // suite never flakes, tight enough to keep the tiers separated by more
    // than half the easy-hard μ gap).
    const easyMean = meanLatencyTicks('easy', 2000, 20260819);
    const hardMean = meanLatencyTicks('hard', 2000, 20260819);
    expect(easyMean).toBeGreaterThan(36 - 8); // 600ms ≈ 36 ticks
    expect(easyMean).toBeLessThan(36 + 8);
    expect(hardMean).toBeGreaterThan(6 - 4); // 100ms ≈ 6 ticks
    expect(hardMean).toBeLessThan(6 + 4);
    // THE measurable sight→react delta: ~half a second of separation.
    expect(easyMean - hardMean).toBeGreaterThan(15);
  });

  it('composed: at every combat-relevant distance, easy reacts later than hard', () => {
    // "Notices later": beyond easy's 192px range the sighting is faded
    // (detectionConfidence < 1) while hard's is full up to 512px; the react
    // μ adds a monotone delay on top. The composed earliest-response tick
    // (sight-confidence gate + latency mean in ticks) is ordered at EVERY
    // distance in the perception band.
    for (let dist = 200; dist < 1000; dist += 40) {
      const easySight = detectionConfidence(dist, 'easy');
      const hardSight = detectionConfidence(dist, 'hard');
      // Confidence ordering (the sight half)…
      expect(easySight).toBeLessThanOrEqual(hardSight);
      // …and the react half is strictly ordered regardless of distance.
      const easyReact = reactionCapFor('easy').meanMs / MS_PER_TICK;
      const hardReact = reactionCapFor('hard').meanMs / MS_PER_TICK;
      expect(easyReact).toBeGreaterThan(hardReact);
    }
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import {
  AIM_CONVERGENCE_BY_DIFFICULTY,
  FIRE_DISCIPLINE_BY_DIFFICULTY,
  accuracyCapFor,
  engagementSpreadMultiplier,
  fireDisciplineFor,
  reactionCapFor,
  type AccuracyCap,
  type FireDisciplineCap,
} from '../../../src/ai/skill/CombatCapTables.ts';
import { SKILL_BY_DIFFICULTY } from '../../../src/ai/intent/PersonalityProfile.ts';
import {
  REACTION_LATENCY_BY_DIFFICULTY,
  type ReactionLatencyParams,
} from '../../../src/ai/reactor/ReactorConfig.ts';
import type { DifficultyLevel } from '../../../src/ai/intent/PersonalityProfile.ts';

/**
 * bot-ai-v2 ticket 08 (DEC-009.4) — the THREE INDEPENDENT combat caps:
 * accuracy (aim-error + convergence), reaction (ex-Gaussian μ), fire
 * discipline (sustain-fire-range band + first-shot delay). The PUBG lesson:
 * each cap is its own lever — tuning one curve must NEVER move the others.
 * These suites pin that independence by MUTATING one table at a time and
 * asserting the other two accessors return byte-identical values, plus the
 * per-tier GDD orderings.
 */

const TIERS = ['easy', 'normal', 'medium', 'hard', 'elite'] as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const snapshots = {
  accuracy: {} as Record<DifficultyLevel, AccuracyCap>,
  reaction: {} as Record<DifficultyLevel, ReactionLatencyParams>,
  fire: {} as Record<DifficultyLevel, FireDisciplineCap>,
};
for (const tier of TIERS) {
  snapshots.accuracy[tier] = { ...accuracyCapFor(tier) };
  snapshots.reaction[tier] = { ...reactionCapFor(tier) };
  snapshots.fire[tier] = { ...fireDisciplineFor(tier) };
}

/** Mutate one table's row for the duration of a check, then restore. */
function withMutation<T>(apply: () => void, restore: () => void, check: () => T): T {
  apply();
  try {
    return check();
  } finally {
    restore();
  }
}

describe('cap 1 — accuracy (aim-error multiplier + convergence ramp)', () => {
  it('reads BOTH halves: the skill knob row and the convergence row', () => {
    for (const tier of TIERS) {
      const cap = accuracyCapFor(tier);
      expect(cap.aimErrorMultiplier).toBe(SKILL_BY_DIFFICULTY[tier].aimErrorMultiplier);
      expect(cap.convergenceTicks).toBe(AIM_CONVERGENCE_BY_DIFFICULTY[tier].convergenceTicks);
      expect(cap.openingSpreadMultiplier).toBe(
        AIM_CONVERGENCE_BY_DIFFICULTY[tier].openingSpreadMultiplier,
      );
    }
  });

  it('engagementSpreadMultiplier: opens at the tier multiplier, decays linearly to 1, never below', () => {
    for (const tier of TIERS) {
      const cap = accuracyCapFor(tier);
      const mul = (t: number) => engagementSpreadMultiplier(cap, t);
      expect(mul(0)).toBeCloseTo(cap.openingSpreadMultiplier, 9);
      // Monotone non-increasing over the ramp, exactly 1 at/after the end.
      let prev = mul(0);
      for (let t = 1; t <= cap.convergenceTicks; t++) {
        const v = mul(t);
        expect(v).toBeLessThanOrEqual(prev + 1e-12);
        expect(v).toBeGreaterThanOrEqual(1);
        prev = v;
      }
      expect(mul(cap.convergenceTicks)).toBeCloseTo(1, 9);
      expect(mul(cap.convergenceTicks * 10)).toBe(1);
    }
    // Defensive shape: a no-ramp cap is identically 1.
    expect(
      engagementSpreadMultiplier(
        { convergenceTicks: 0, openingSpreadMultiplier: 1.5, aimErrorMultiplier: 1 },
        5,
      ),
    ).toBe(1);
    expect(
      engagementSpreadMultiplier(
        { convergenceTicks: 40, openingSpreadMultiplier: 1, aimErrorMultiplier: 1 },
        5,
      ),
    ).toBe(1);
  });

  it('per-tier ordering: easy opens widest and converges slowest; elite snaps', () => {
    expect(AIM_CONVERGENCE_BY_DIFFICULTY.easy.convergenceTicks).toBeGreaterThan(
      AIM_CONVERGENCE_BY_DIFFICULTY.medium.convergenceTicks,
    );
    expect(AIM_CONVERGENCE_BY_DIFFICULTY.medium.convergenceTicks).toBeGreaterThan(
      AIM_CONVERGENCE_BY_DIFFICULTY.hard.convergenceTicks,
    );
    expect(SKILL_BY_DIFFICULTY.easy.aimErrorMultiplier).toBeGreaterThan(
      SKILL_BY_DIFFICULTY.medium.aimErrorMultiplier,
    );
    expect(SKILL_BY_DIFFICULTY.medium.aimErrorMultiplier).toBeGreaterThan(
      SKILL_BY_DIFFICULTY.hard.aimErrorMultiplier,
    );
  });
});

describe('cap 2 — reaction (GDD §14.2 ex-Gaussian means, verbatim)', () => {
  it('the GDD §14.2 table: Easy 600ms / Medium 300ms / Hard 100ms as distribution means', () => {
    expect(reactionCapFor('easy').meanMs).toBe(600);
    expect(reactionCapFor('medium').meanMs).toBe(300);
    expect(reactionCapFor('hard').meanMs).toBe(100);
    // 'normal' shares Medium's row, 'elite' shares Hard's (collapsed skill
    // rows — documented in ReactorConfig).
    expect(reactionCapFor('normal').meanMs).toBe(300);
    expect(reactionCapFor('elite').meanMs).toBe(100);
  });
});

describe('cap 3 — fire discipline (sustain-fire-range band + first-shot delay)', () => {
  it('per-tier ordering: easy holds fire until deep in the band and hesitates; hard commits at the edge', () => {
    const f = FIRE_DISCIPLINE_BY_DIFFICULTY;
    expect(f.easy.sustainFireRangeFactor).toBeLessThan(f.medium.sustainFireRangeFactor);
    expect(f.medium.sustainFireRangeFactor).toBeLessThan(f.hard.sustainFireRangeFactor);
    expect(f.easy.firstShotDelayTicks).toBeGreaterThan(f.medium.firstShotDelayTicks);
    expect(f.medium.firstShotDelayTicks).toBeGreaterThan(f.hard.firstShotDelayTicks);
    // Bands are sane fractions of the weapon win band (0 < factor ≤ 1).
    for (const tier of TIERS) {
      expect(f[tier].sustainFireRangeFactor).toBeGreaterThan(0);
      expect(f[tier].sustainFireRangeFactor).toBeLessThanOrEqual(1);
      expect(f[tier].firstShotDelayTicks).toBeGreaterThanOrEqual(0);
    }
  });

  it('the applied band: easy full-commit range is visibly shorter than hard (same weapon)', () => {
    // ATTACK_RANGE_MARGIN (0.88) × factor — the executeEngage consumption.
    const MARGIN = 0.88;
    const weaponRange = 320; // Spear-class
    const easyBand =
      weaponRange * MARGIN * FIRE_DISCIPLINE_BY_DIFFICULTY.easy.sustainFireRangeFactor;
    const hardBand =
      weaponRange * MARGIN * FIRE_DISCIPLINE_BY_DIFFICULTY.hard.sustainFireRangeFactor;
    expect(easyBand).toBeLessThan(hardBand - 40); // a visible gap, not a rounding whisper
    // And the first-shot delay gate arithmetic (BotCombatEngage reads it as
    // `tick - losHeldSinceTick >= firstShotDelayTicks`).
    const losAcquiredAt = 1000;
    const easyReady = 1000 + FIRE_DISCIPLINE_BY_DIFFICULTY.easy.firstShotDelayTicks;
    const hardReady = 1000 + FIRE_DISCIPLINE_BY_DIFFICULTY.hard.firstShotDelayTicks;
    expect(easyReady).toBeGreaterThan(hardReady + 10); // 18t vs 3t — the human hesitation beat
    expect(losAcquiredAt + 0).toBeLessThan(easyReady);
  });
});

describe('INDEPENDENCE — adjusting one cap never moves the others', () => {
  afterEach(() => {
    // Belt-and-braces: withMutation restored everything, but a failed
    // assertion inside `check` could leave a mutation behind if restore itself
    // threw — re-pin every accessor against the snapshots taken at load.
    for (const tier of TIERS) {
      expect(accuracyCapFor(tier)).toEqual(snapshots.accuracy[tier]);
      expect(reactionCapFor(tier)).toEqual(snapshots.reaction[tier]);
      expect(fireDisciplineFor(tier)).toEqual(snapshots.fire[tier]);
    }
  });

  it('mutating FIRE DISCIPLINE leaves accuracy and reaction untouched', () => {
    const result = withMutation(
      () => {
        (FIRE_DISCIPLINE_BY_DIFFICULTY as Mutable<typeof FIRE_DISCIPLINE_BY_DIFFICULTY>).medium = {
          sustainFireRangeFactor: 0.11,
          firstShotDelayTicks: 55,
        };
      },
      () => {
        (FIRE_DISCIPLINE_BY_DIFFICULTY as Mutable<typeof FIRE_DISCIPLINE_BY_DIFFICULTY>).medium =
          snapshots.fire.medium;
      },
      () => ({
        fireChanged:
          fireDisciplineFor('medium').sustainFireRangeFactor === 0.11 &&
          fireDisciplineFor('medium').firstShotDelayTicks === 55,
        accuracySame: accuracyCapFor('medium'),
        reactionSame: reactionCapFor('medium'),
      }),
    );
    expect(result.fireChanged).toBe(true); // the mutation took effect…
    expect(result.accuracySame).toEqual(snapshots.accuracy.medium); // …and moved NOTHING else
    expect(result.reactionSame).toEqual(snapshots.reaction.medium);
  });

  it('mutating ACCURACY (knob + convergence) leaves reaction and fire untouched', () => {
    const originalKnob = SKILL_BY_DIFFICULTY.medium;
    const originalConv = AIM_CONVERGENCE_BY_DIFFICULTY.medium;
    const result = withMutation(
      () => {
        (SKILL_BY_DIFFICULTY as Mutable<typeof SKILL_BY_DIFFICULTY>).medium = {
          ...originalKnob,
          aimErrorMultiplier: 2.5,
        };
        (AIM_CONVERGENCE_BY_DIFFICULTY as Mutable<typeof AIM_CONVERGENCE_BY_DIFFICULTY>).medium = {
          convergenceTicks: 7,
          openingSpreadMultiplier: 3.3,
        };
      },
      () => {
        (SKILL_BY_DIFFICULTY as Mutable<typeof SKILL_BY_DIFFICULTY>).medium = originalKnob;
        (AIM_CONVERGENCE_BY_DIFFICULTY as Mutable<typeof AIM_CONVERGENCE_BY_DIFFICULTY>).medium =
          originalConv;
      },
      () => ({
        accuracyChanged:
          accuracyCapFor('medium').aimErrorMultiplier === 2.5 &&
          accuracyCapFor('medium').convergenceTicks === 7 &&
          accuracyCapFor('medium').openingSpreadMultiplier === 3.3,
        reactionSame: reactionCapFor('medium'),
        fireSame: fireDisciplineFor('medium'),
      }),
    );
    expect(result.accuracyChanged).toBe(true);
    expect(result.reactionSame).toEqual(snapshots.reaction.medium);
    expect(result.fireSame).toEqual(snapshots.fire.medium);
  });

  it('mutating REACTION leaves accuracy and fire untouched', () => {
    const table = REACTION_LATENCY_BY_DIFFICULTY as Mutable<
      Record<DifficultyLevel, ReactionLatencyParams>
    >;
    const original = table.hard;
    const result = withMutation(
      () => {
        table.hard = { meanMs: 900, sigmaMs: 10, tauMs: 5 };
      },
      () => {
        table.hard = original;
      },
      () => ({
        reactionChanged: reactionCapFor('hard').meanMs === 900,
        accuracySame: accuracyCapFor('hard'),
        fireSame: fireDisciplineFor('hard'),
      }),
    );
    expect(result.reactionChanged).toBe(true);
    expect(result.accuracySame).toEqual(snapshots.accuracy.hard);
    expect(result.fireSame).toEqual(snapshots.fire.hard);
  });

  it('the three access surfaces are DISJOINT data by construction (identity)', () => {
    // Each accessor is a pure read of exactly its own table rows — the
    // identity checks make accidental cross-reads (e.g. fireDisciplineFor
    // accidentally deriving from the skill knobs) impossible to hide.
    for (const tier of TIERS) {
      expect(reactionCapFor(tier)).toBe(REACTION_LATENCY_BY_DIFFICULTY[tier]);
      expect(fireDisciplineFor(tier)).toBe(FIRE_DISCIPLINE_BY_DIFFICULTY[tier]);
      expect(accuracyCapFor(tier).aimErrorMultiplier).toBe(
        SKILL_BY_DIFFICULTY[tier].aimErrorMultiplier,
      );
    }
  });
});

/**
 * The THREE INDEPENDENT combat caps — bot-ai-v2 ticket 08 (DEC-009.4).
 *
 * PUBG's hotfix lesson (BRP §1.2): bot nerfs must be INDEPENDENT levers.
 * This module is the single access surface for the three caps, each backed
 * by its OWN data table so tuning one curve never moves the others:
 *
 *   1. ACCURACY  — aim-error multiplier (SKILL_BY_DIFFICULTY, the long-lived
 *                  knob) + the NEW engagement convergence ramp (DEC-007.2:
 *                  aim error starts high on acquisition and decays over the
 *                  first ticks of an engagement — multi-adjustment aiming).
 *   2. REACTION  — the ex-Gaussian latency parameters (ticket 04's
 *                  REACTION_LATENCY_BY_DIFFICULTY, GDD §14.2 means consumed
 *                  as distribution means). Re-exported read-only here so the
 *                  three accessors live side by side.
 *   3. FIRE DISCIPLINE — NEW: sustain-fire-range (full fire commitment only
 *                  inside the weapon's win band) + first-shot delay after
 *                  LOS acquire.
 *
 * INDEPENDENCE (the unit-tested property): each accessor reads EXACTLY ONE
 * cap's tables — accuracyCapFor never touches the reaction/fire tables,
 * reactionCapFor never touches accuracy/fire, fireDisciplineFor never
 * touches accuracy/reaction. The independence suite mutates one table and
 * asserts the other two accessors return byte-identical values.
 *
 * NO artificial win cap anywhere (DEC-009 rejected alternative): within its
 * caps every tier plays to win.
 */

import type { DifficultyLevel } from '../intent/PersonalityProfile.ts';
import { SKILL_BY_DIFFICULTY } from '../intent/PersonalityProfile.ts';
import {
  REACTION_LATENCY_BY_DIFFICULTY,
  type ReactionLatencyParams,
} from '../reactor/ReactorConfig.ts';

// ---------------------------------------------------------------------------
// Cap 1 — ACCURACY (aim-error + convergence)
// ---------------------------------------------------------------------------

/** The convergence half of the accuracy cap (the multiplier half already
 *  lives in SKILL_BY_DIFFICULTY.aimErrorMultiplier — re-read, not copied). */
export interface AccuracyConvergence {
  /** Ticks from engagement start over which the opening spread decays to
   *  the weapon's baseline precision (DEC-007.2's "~30-45 ticks", tier-
   *  scaled: easy converges over 1.5 s, elite snaps in a third of that). */
  readonly convergenceTicks: number;
  /** Opening spread multiplier at engagement start (decays linearly to 1). */
  readonly openingSpreadMultiplier: number;
}

/** Convergence ramp per difficulty — SEPARATE data from the reaction and
 *  fire tables (independence by construction). */
export const AIM_CONVERGENCE_BY_DIFFICULTY: Record<DifficultyLevel, AccuracyConvergence> = {
  easy: { convergenceTicks: 90, openingSpreadMultiplier: 2.4 },
  normal: { convergenceTicks: 60, openingSpreadMultiplier: 2.0 },
  medium: { convergenceTicks: 45, openingSpreadMultiplier: 1.6 },
  hard: { convergenceTicks: 25, openingSpreadMultiplier: 1.3 },
  elite: { convergenceTicks: 18, openingSpreadMultiplier: 1.15 },
};

/** The full accuracy cap view (both halves). */
export interface AccuracyCap extends AccuracyConvergence {
  readonly aimErrorMultiplier: number;
}

/** Accuracy cap for a difficulty: reads SKILL_BY_DIFFICULTY (multiplier) +
 * AIM_CONVERGENCE_BY_DIFFICULTY (ramp). Touches NO other cap's table. */
export function accuracyCapFor(difficulty: DifficultyLevel): AccuracyCap {
  const knob = SKILL_BY_DIFFICULTY[difficulty];
  const conv = AIM_CONVERGENCE_BY_DIFFICULTY[difficulty];
  return {
    aimErrorMultiplier: knob.aimErrorMultiplier,
    convergenceTicks: conv.convergenceTicks,
    openingSpreadMultiplier: conv.openingSpreadMultiplier,
  };
}

/**
 * The engagement spread multiplier: 1 + (opening − 1) × max(0, 1 − t/T) —
 * the opening shot sprays `opening`× wider, decaying linearly to baseline
 * at `convergenceTicks` since the engagement began. Pure function; the
 * caller passes `ticksSinceEngagementStart` (BotContext.engageStartTick).
 */
export function engagementSpreadMultiplier(cap: AccuracyCap, ticksSinceStart: number): number {
  if (cap.convergenceTicks <= 0 || cap.openingSpreadMultiplier <= 1) return 1;
  const remaining = Math.max(0, 1 - ticksSinceStart / cap.convergenceTicks);
  return 1 + (cap.openingSpreadMultiplier - 1) * remaining;
}

// ---------------------------------------------------------------------------
// Cap 2 — REACTION (ex-Gaussian latency; the table lives in ReactorConfig
// since ticket 04 — surfaced here for the three-accessor surface + tests)
// ---------------------------------------------------------------------------

/**
 * Reaction cap for a difficulty — the GDD §14.2 reaction times (Easy 600 /
 * Medium 300 / Hard 100 ms) as ex-Gaussian distribution means. Reads ONLY
 * REACTION_LATENCY_BY_DIFFICULTY.
 */
export function reactionCapFor(difficulty: DifficultyLevel): ReactionLatencyParams {
  return REACTION_LATENCY_BY_DIFFICULTY[difficulty];
}

// ---------------------------------------------------------------------------
// Cap 3 — FIRE DISCIPLINE (NEW data)
// ---------------------------------------------------------------------------

/** The fire-discipline cap. */
export interface FireDisciplineCap {
  /**
   * Sustain-fire-range factor: the weapon's effective win band
   * (range × ATTACK_RANGE_MARGIN) scales by this — full fire commitment
   * only INSIDE the band. Easy tiers hold fire until well inside (they
   * close before committing); hard tiers commit at the band edge.
   */
  readonly sustainFireRangeFactor: number;
  /**
   * First-shot delay in ticks after LOS acquire on a target: the reacquire-
   * aim beat before committing the first attack (easy bots visibly hesitate
   * on contact; hard bots snap). 0 = fire the instant the band opens.
   */
  readonly firstShotDelayTicks: number;
}

/** Fire-discipline per difficulty — SEPARATE data from the accuracy and
 *  reaction tables (independence by construction). */
export const FIRE_DISCIPLINE_BY_DIFFICULTY: Record<DifficultyLevel, FireDisciplineCap> = {
  easy: { sustainFireRangeFactor: 0.62, firstShotDelayTicks: 18 },
  normal: { sustainFireRangeFactor: 0.7, firstShotDelayTicks: 12 },
  medium: { sustainFireRangeFactor: 0.78, firstShotDelayTicks: 7 },
  hard: { sustainFireRangeFactor: 0.86, firstShotDelayTicks: 3 },
  elite: { sustainFireRangeFactor: 0.9, firstShotDelayTicks: 1 },
};

/** Fire-discipline cap for a difficulty. Reads ONLY
 *  FIRE_DISCIPLINE_BY_DIFFICULTY. */
export function fireDisciplineFor(difficulty: DifficultyLevel): FireDisciplineCap {
  return FIRE_DISCIPLINE_BY_DIFFICULTY[difficulty];
}

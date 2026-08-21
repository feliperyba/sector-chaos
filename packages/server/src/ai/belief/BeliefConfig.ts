/**
 * Believed-state tuning data — bot-ai-v2 ticket 05 (DEC-003).
 *
 * ALL belief tuning lives in these tables, never in algorithm code: the GDD
 * §14.2 per-difficulty detection ranges (192/320/512 px) and the §14.3
 * LOS-halving rule as CONFIDENCE-MODIFIER data (never hard vision walls — a
 * top-down game's players see 360°; cone-blindness was explicitly rejected
 * in DEC-003's Alternatives Considered), foveation noise scales, decay
 * half-lives, convergence ramps, damage-estimate spread, and the
 * search-failure window. Designers rebalance the belief model by editing
 * numbers here.
 */

import type { DifficultyLevel } from '../intent/PersonalityProfile.ts';
import { GOAL_SUSPEND_TICKS } from '../BotSystemConstants.ts';

/**
 * GDD §14.2 detection ranges (px) per difficulty — Easy 192 / Medium 320 /
 * Hard 512. `normal`/`elite` interpolate the GDD table (320 / 512).
 *
 * NOT a hard wall: an enemy beyond this range is still perceived (full
 * ground truth stays in ctx.enemies); the range is the point up to which a
 * SEEN belief carries FULL confidence. Beyond it, confidence fades linearly
 * toward BELIEF_PERIPHERAL_CONFIDENCE_FLOOR at the perception edge
 * (BeliefMath.detectionConfidence) — a distant enemy is a foggy memory, not
 * an invisible one.
 */
export const FOVEATION_DETECTION_RANGE: Readonly<Record<DifficultyLevel, number>> = {
  easy: 192,
  normal: 320,
  medium: 320,
  hard: 512,
  elite: 512,
};

/**
 * GDD §14.3 LOS-halving as a confidence multiplier: "targets without LOS
 * have detection range reduced to 50%" becomes `confidence × 0.5` for
 * wall-blocked sightings (BeliefMath.losConfidenceFactor). Again a modifier,
 * not a wall — the enemy is perceived through the wall but remembered as a
 * half-trusted position.
 */
export const LOS_HALVING_FACTOR = 0.5;

/** Perception range (px) — matches BotPerception's PERCEPTION_RANGE; the
 *  confidence fade reaches this floor at the scan's hard edge. */
export const BELIEF_PERCEPTION_RANGE = 1000;

/** Confidence floor for a SEEN belief at the perception edge (the "foggy
 *  peripheral memory" level). Between the detection range and the edge,
 *  confidence fades linearly from 1.0 down to this. */
export const BELIEF_PERIPHERAL_CONFIDENCE_FLOOR = 0.4;

/**
 * Foveation-lite position-noise scales (px), pre-difficulty-multiplier.
 * Noise grows with angle-from-facing (full detail in the facing sector —
 * coarse, position-noised periphery) and with distance beyond the
 * difficulty's detection range:
 *   scale = (facingTerm(angle) + distantTerm(dist, difficulty))
 *           × FOVEATION_NOISE_MULTIPLIER[difficulty]
 * where facingTerm ramps 0 at ≤ FRONT_ARC to FOVEATION_PERIPHERY_NOISE_PX at
 * directly behind, and distantTerm ramps 0 inside the detection range to
 * FOVEATION_DISTANT_NOISE_PX at the perception edge.
 */
export const FOVEATION_FRONT_ARC_RAD = Math.PI / 3; // 60° half-angle — the facing sector
export const FOVEATION_FRONT_NOISE_PX = 10; // small jitter even in the facing sector
export const FOVEATION_PERIPHERY_NOISE_PX = 120; // directly-behind sighting noise
export const FOVEATION_DISTANT_NOISE_PX = 160; // extra noise at the perception edge

/**
 * Per-difficulty noise multiplier (mirrors SKILL_BY_DIFFICULTY's
 * aimErrorMultiplier shape): skilled bots perceive more precisely, so their
 * believed positions sit closer to truth (faster effective convergence).
 */
export const FOVEATION_NOISE_MULTIPLIER: Readonly<Record<DifficultyLevel, number>> = {
  easy: 1.6,
  normal: 1.2,
  medium: 1.0,
  hard: 0.7,
  elite: 0.45,
};

/**
 * Convergence ramp per sighting scan (DEC-003 Dissent resolution: beliefs
 * converge to truth on re-acquisition, and SKILLED difficulties close the
 * gap faster). After a sighting whose sample confidence is `sample`, the
 * stored confidence moves toward it by this fraction per scan:
 *   next = prev + (sample - prev) × RAMP
 * Hard/elite snap to the sample in one scan; easy ramps over ~3 scans.
 */
export const CONVERGENCE_RAMP_PER_SCAN: Readonly<Record<DifficultyLevel, number>> = {
  easy: 0.35,
  normal: 0.55,
  medium: 0.7,
  hard: 0.9,
  elite: 1.0,
};

/**
 * Confidence decay half-life (ticks) per difficulty: how long until an
 * unrefreshed belief's confidence halves. Skilled bots also REMEMBER longer
 * (a Hard bot's 1.0-confidence seen belief stays above the pursuit
 * threshold for ~460 ticks ≈ the legacy 8s LAST_ENEMY_MEMORY_TICKS window;
 * an Easy bot's fades in ~120 ticks).
 */
export const CONFIDENCE_HALF_LIFE_TICKS: Readonly<Record<DifficultyLevel, number>> = {
  easy: 60,
  normal: 100,
  medium: 140,
  hard: 200,
  elite: 240,
};

/** Initial confidence of a HEARD belief (an attack stimulus seat — the bot
 *  knows a shot came from there, but only roughly where the shooter is). */
export const HEARD_CONFIDENCE = 0.35;
/** Initial confidence of a DAMAGE belief (direction + spread estimate). */
export const DAMAGE_CONFIDENCE = 0.25;
/** Damage with NO knockback direction (sourceless flinch): the lowest
 *  trusted belief — "someone hit me from nearby". */
export const DAMAGE_NO_DIRECTION_CONFIDENCE = 0.15;

/** A belief whose decayed confidence falls below this is expired: deleted
 *  from the store (and an open pursuit on it closes as 'dropped'). */
export const BELIEF_MIN_CONFIDENCE = 0.05;
/** Absolute age cap (ticks) on any belief regardless of confidence. */
export const BELIEF_MAX_AGE_TICKS = 480;

/** Minimum confidence for an out-of-scan belief to be WORTH INVESTIGATING
 *  (the pursuit gate in BeliefUpdate.pursueBelievedEnemy). */
export const PURSUIT_MIN_CONFIDENCE = 0.2;

/**
 * SEARCH-FAILURE WINDOW (DEC-003, Halo 2 memory): after this many ticks
 * investigating a believed position without re-acquiring the enemy, the
 * belief drops and a short family cooldown applies (the goal-suspension
 * mechanism extended from goals to targets — see
 * BeliefUpdate.enforceSearchFailure). ~90 ticks = 1.5s.
 */
export const SEARCH_FAILURE_TICKS = 90;

/**
 * The family cooldown applied on search-failure: the SAME duration class
 * the goal-suspension mechanism uses (GOAL_SUSPEND_TICKS = 240 / 4s) — the
 * extension reuses selector.suspend() rather than inventing a parallel
 * mechanism. Declared as a named reference, not a copy, so the two stay in
 * lockstep if the goal window is ever retuned.
 */
export const TARGET_SEARCH_SUSPEND_TICKS = GOAL_SUSPEND_TICKS;

/**
 * Damage-direction estimation (NEVER the attacker's true coordinates):
 * the attacker is estimated at victim + direction × guessed-distance, where
 * the direction is the (negated, server-authoritative) knockback vector and
 * BOTH the angular spread and the distance guess are drawn from the per-bot
 * BotRNG. A human's "shot came from over there" — direction with error.
 */
export const DAMAGE_EST_SPREAD_RAD = 0.5; // ± ~28.6° angular error
export const DAMAGE_EST_MIN_DIST_PX = 220;
export const DAMAGE_EST_MAX_DIST_PX = 700;

/**
 * Dead-reckoning cap (px): between updates an out-of-scan belief's position
 * extrapolates by lastVelocity × dt, but never more than this far from its
 * last update point (a sprinting enemy's old velocity is a weak predictor).
 */
export const DEAD_RECKON_MAX_PX = 240;

/**
 * Target-lock freshness gate (AUDIT §10c.6 / DEC-003 Dissent): selectTarget
 * honors a lock only while the bot's belief about the target was refreshed
 * within this many ticks. 6 ticks = two perception scan cycles — the exact
 * staleness window the audit flagged ("3-tick-old lists drive locks").
 */
export const LOCK_FRESHNESS_TICKS = 6;

/**
 * Archetype signature-movement DATA — bot-ai-v2 ticket 08 (DEC-009.2).
 *
 * THE PROBLEM THIS SOLVES: archetype expression existed only as intent score
 * multipliers — invisible to a spectator (AUDIT §6, §10d). Titanfall's lesson
 * (BRP §1.7): movement class IS identity.
 *
 * THE FIX: per-archetype MOVEMENT PARAMETER PROFILES (speed variance, turn
 * smoothness, stop frequency, approach-curve shape) consumed by the movement/
 * approach paths (BotNavigation + the engage executor) — NO new intents. The
 * five DEC-009 signature behaviors:
 *   - AGGRESSOR: beeline + weave (sinusoidal S-curve approach, snappy turns)
 *   - DUELIST:   spacing discipline + dash-punish (tight spacing-margin hold,
 *                 extended punish reach — consumed by BotCombatEngage)
 *   - SURVIVOR:  zone-edge preference + hotspot avoidance (steering blends in
 *                 BotNavigation, active on patrol-family states)
 *   - SCAVENGER: loiter-at-loot (stop windows near loot anchors, dawdly speed)
 *   - TRAPPER:   pre-positioning near chests/barrels/destructible seams (stop
 *                 windows near feature anchors, curved approaches)
 *
 * ALL movement-signature tuning lives in this table, never in algorithm code
 * (SPEC user story 35). The per-bot draw (weave direction, stop cadence,
 * speed-wobble interval) is BotRNG-seeded in BotMovementSignature.ts.
 */

import { PersonalityArchetype } from '../intent/PersonalityProfile.ts';

/** The shape of the approach curve applied on top of the pathfinder heading.
 *  - 'direct': no lateral offset (DUELIST's crisp committed lines)
 *  - 'weave':  sinusoidal S-curve (AGGRESSOR's beeline+weave)
 *  - 'arc':    constant-sign lateral bias per segment (curved approach)
 *  - 'drift':  gentle random lateral jitter (SCAVENGER's loiter-y walk) */
export type ApproachCurve = 'direct' | 'weave' | 'arc' | 'drift';

/** Per-archetype movement signature parameters (pure data). */
export interface MovementProfile {
  /** 0..1 — micro-pause cadence ("operation noise", DEC-007.4): higher =
   *  more frequent 1-tick speed dips, giving per-bot SPEED VARIANCE. */
  readonly speedVariance: number;
  /** 0..1 — turn smoothing: 1 = instant turns, lower = lazier blended turns
   *  (the emitted angle eases toward the intended heading). */
  readonly turnSmoothing: number;
  /** 0..1 — anchor-loiter arm probability per cadence check (STOP FREQUENCY).
   *  Zero for archetypes without an anchor-loiter behavior. */
  readonly stopFrequency: number;
  /** Base loiter window length (ticks) once armed. */
  readonly stopDurationTicks: number;
  /** Lateral approach-curve shape (see ApproachCurve). */
  readonly approachCurve: ApproachCurve;
  /** Peak lateral heading offset (radians) for weave/arc/drift curves. */
  readonly approachCurveAmplitudeRad: number;
  /** ENGAGE spacing-margin scale (1 = table default; <1 = tighter hold) —
   *  DUELIST's spacing discipline. 0 disables the scaling. */
  readonly spacingMarginScale: number;
  /** Multiplier on the dash-punish trigger band in ENGAGE — DUELIST punishes
   *  whiffs from further out. */
  readonly dashPunishReach: number;
  /** 0..1 — mid-game zone-ring hold blend weight (SURVIVOR's zone-edge
   *  preference; applied only on patrol-family movement, never on loot runs
   *  or zone flees). */
  readonly zoneEdgePreference: number;
  /** 0..1 — steer-away blend weight from a fresh shared fight hotspot
   *  (SURVIVOR/SCAVENGER's hotspot avoidance). */
  readonly hotspotAvoidWeight: number;
  /** SCAVENGER anchor predicate: loiter when loot is nearby. */
  readonly loiterAtLoot: boolean;
  /** TRAPPER anchor predicate: hold near chests/barrels (pre-positioning). */
  readonly prePositionNearFeatures: boolean;
}

/**
 * THE per-archetype table (DEC-009.2). Values are tuned so each signature is
 * VISIBLE at top-down zoom: the weave amplitude (~0.2 rad ≈ ±12°) deflects a
 * 400px approach by ~80px; loiter windows (~0.5s) read as deliberate pauses.
 */
export const MOVEMENT_PROFILES: Record<PersonalityArchetype, MovementProfile> = {
  // Beeline + weave: presses straight at the target with a committed S-curve,
  // snappy turns, steady sprint (little speed noise).
  [PersonalityArchetype.AGGRESSOR]: {
    speedVariance: 0.15,
    turnSmoothing: 0.85,
    stopFrequency: 0,
    stopDurationTicks: 0,
    approachCurve: 'weave',
    approachCurveAmplitudeRad: 0.22,
    spacingMarginScale: 1.5,
    dashPunishReach: 1.0,
    zoneEdgePreference: 0,
    hotspotAvoidWeight: 0,
    loiterAtLoot: false,
    prePositionNearFeatures: false,
  },
  // Spacing discipline + dash-punish: crisp direct lines, tight spacing-band
  // hold, punish reach extended — the fencer's movement.
  [PersonalityArchetype.DUELIST]: {
    speedVariance: 0.08,
    turnSmoothing: 0.95,
    stopFrequency: 0,
    stopDurationTicks: 0,
    approachCurve: 'direct',
    approachCurveAmplitudeRad: 0,
    spacingMarginScale: 0.5,
    dashPunishReach: 1.3,
    zoneEdgePreference: 0.1,
    hotspotAvoidWeight: 0.15,
    loiterAtLoot: false,
    prePositionNearFeatures: false,
  },
  // Zone-edge preference + hotspot avoidance: smooth arcing turns, drifts to
  // the safe ring on patrol, gives heard fights a wide berth.
  [PersonalityArchetype.SURVIVOR]: {
    speedVariance: 0.3,
    turnSmoothing: 0.6,
    stopFrequency: 0.15,
    stopDurationTicks: 16,
    approachCurve: 'arc',
    approachCurveAmplitudeRad: 0.12,
    spacingMarginScale: 1.1,
    dashPunishReach: 0.7,
    zoneEdgePreference: 0.5,
    hotspotAvoidWeight: 0.55,
    loiterAtLoot: false,
    prePositionNearFeatures: false,
  },
  // Loiter-at-loot: dawdly drifting walk, the most speed noise, pauses at
  // loot anchors to pick through them.
  [PersonalityArchetype.SCAVENGER]: {
    speedVariance: 0.45,
    turnSmoothing: 0.55,
    stopFrequency: 0.5,
    stopDurationTicks: 24,
    approachCurve: 'drift',
    approachCurveAmplitudeRad: 0.15,
    spacingMarginScale: 1.2,
    dashPunishReach: 0.6,
    zoneEdgePreference: 0.2,
    hotspotAvoidWeight: 0.35,
    loiterAtLoot: true,
    prePositionNearFeatures: false,
  },
  // Pre-positioning near chests/barrels/seams: curved approaches, holds near
  // feature anchors (waiting for someone to walk into the trap zone).
  [PersonalityArchetype.TRAPPER]: {
    speedVariance: 0.2,
    turnSmoothing: 0.7,
    stopFrequency: 0.35,
    stopDurationTicks: 30,
    approachCurve: 'arc',
    approachCurveAmplitudeRad: 0.18,
    spacingMarginScale: 1.0,
    dashPunishReach: 0.85,
    zoneEdgePreference: 0.15,
    hotspotAvoidWeight: 0.1,
    loiterAtLoot: false,
    prePositionNearFeatures: true,
  },
};

/** Fallback for contexts without a signature (defensive — every registered
 *  bot gets one; unit-test ctx literals may not). Neutral: no curve, no
 *  stops, instant turns, no blends — behavior identical to pre-signature. */
export const NEUTRAL_MOVEMENT_PROFILE: MovementProfile = {
  speedVariance: 0,
  turnSmoothing: 1,
  stopFrequency: 0,
  stopDurationTicks: 0,
  approachCurve: 'direct',
  approachCurveAmplitudeRad: 0,
  spacingMarginScale: 1,
  dashPunishReach: 1,
  zoneEdgePreference: 0,
  hotspotAvoidWeight: 0,
  loiterAtLoot: false,
  prePositionNearFeatures: false,
};

/** Stop/loiter cadence: anchor-loiter arm checks happen every ~50-80 ticks
 *  (jittered per bot via BotRNG), so stops are occasional pauses, not
 *  stutter. Tuning data for the signature state machine. */
export const STOP_CHECK_BASE_TICKS = 50;
export const STOP_CHECK_JITTER_TICKS = 30;

/** Micro-pause (speed variance) interval bounds in ticks BEFORE the variance
 *  scaling: interval = MIN + (1 - speedVariance) × RANGE ± per-bot jitter.
 *  Higher variance → shorter intervals → more speed dips. */
export const SPEED_WOBBLE_MIN_TICKS = 40;
export const SPEED_WOBBLE_RANGE_TICKS = 220;

/** Speed-dip length (ticks). One tick of zero-direction MOVE decelerates the
 *  bot by ~107 px/s (DECELERATION/60); the re-acceleration tail gives the
 *  per-bot speed trace its variance without ever reading as a stall. */
export const SPEED_WOBBLE_DURATION_TICKS = 1;

/** Fight-hotspot avoidance reach (px): a hotspot older than the fight-memory
 *  window or farther than this does not deflect patrol movement. */
export const HOTSPOT_AVOID_RANGE_PX = 900;

/** Zone-edge preference: the blend is active while the bot sits deeper than
 *  this fraction of the zone radius and pushes it outward toward the ring. */
export const ZONE_EDGE_INNER_FRACTION = 0.55;

/** ANCHOR PROXIMITY for loiter arming (px) — the ranges at which a bot's scan
 *  view counts "loot nearby" / "chest nearby" / "barrel nearby" for the
 *  signature stop machine (SCAVENGER loiters at loot, TRAPPER pre-positions
 *  at chests/barrels). Consumed by BotNavigation's navigateTo view. */
export const LOOT_ANCHOR_RANGE_PX = 320;
export const FEATURE_ANCHOR_RANGE_PX = 420;
export const BARREL_ANCHOR_RANGE_PX = 380;

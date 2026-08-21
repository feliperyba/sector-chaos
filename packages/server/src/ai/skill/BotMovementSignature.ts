/**
 * Movement-signature state machine — bot-ai-v2 ticket 08 (DEC-009.2).
 *
 * The per-bot carrier + appliers of {@linkcode MOVEMENT_PROFILES}: turn
 * smoothing, approach-curve shaping, anchor-loiter stops, micro-pause speed
 * variance, hotspot avoidance, and zone-edge preference. Consumed by the
 * movement/approach paths (BotNavigation.navigateTo / validatedMoveToward and
 * the ENGAGE executor) — no new intents anywhere.
 *
 * ORDER OF APPLICATION (load-bearing, per call site in BotNavigation):
 *   separation/danger blends → hotspot avoidance → zone-edge preference →
 *   signature shaping (curve + smoothing) → validateFinalAngle.
 * The signature runs BEFORE the wall validation so no emitted angle may point
 * into a wall (the DEC-005.1 invariant covers the shaped angle too).
 *
 * Determinism: every draw routes through the per-bot BotRNG (the same stream
 * the rest of the AI uses); no wall-clock reads. A null signature (unit-test
 * ctx literals, pre-register contexts) is NEUTRAL — every applier returns the
 * input unchanged and no stop is ever emitted.
 */

import { normalizeAngle } from '@sector-battle/shared';
import type { QueuedInput } from '../../application/simulation/InputQueue.ts';
import type { BotRNG } from '../BotContext.ts';
import { BotState } from '../BotContextTypes.ts';
import { makeStopInput } from '../BotInput.ts';
import {
  HOTSPOT_AVOID_RANGE_PX,
  SPEED_WOBBLE_DURATION_TICKS,
  SPEED_WOBBLE_MIN_TICKS,
  SPEED_WOBBLE_RANGE_TICKS,
  STOP_CHECK_BASE_TICKS,
  STOP_CHECK_JITTER_TICKS,
  ZONE_EDGE_INNER_FRACTION,
  type MovementProfile,
} from './MovementProfileTables.ts';

/** Per-bot movement-signature state (created at registerBot, lives on
 *  BotContext.movement). Mutated only by the appliers below. */
export interface MovementSignatureState {
  readonly profile: MovementProfile;
  /** The bot's own deterministic RNG (shared stream — same-seed identity). */
  readonly rng: BotRNG;
  /** Last emitted (shaped) angle — the turn-smoothing anchor. */
  lastAngle: number | null;
  /** Advancing phase of the 'weave' curve (radians). */
  weavePhase: number;
  /** Current lateral sign of the 'arc' curve (±1). */
  arcDir: number;
  /** Ticks left on the current 'arc' segment before re-rolling the sign. */
  arcSegmentTicksLeft: number;
  /** Current 'drift' lateral offset (eased toward a fresh target). */
  driftOffset: number;
  /** 'drift' target offset the easing approaches. */
  driftTarget: number;
  /** Tick until which the bot is inside an anchor-loiter stop (-1 = none). */
  stopUntilTick: number;
  /** Next anchor-loiter arm-check tick. */
  nextStopCheckTick: number;
  /** Next micro-pause (speed variance) tick. */
  speedWobbleNextTick: number;
  /** Per-bot micro-pause interval (ticks) drawn at creation. */
  speedWobbleEvery: number;
}

/** Weave phase advance per shaped emission (radians/tick): ~0.09 gives one
 *  full S every ~70 ticks (1.2 s) — visible at top-down zoom, not jittery. */
const WEAVE_PHASE_ADVANCE = 0.09;
/** Arc segment length bounds (ticks) before the curve sign re-rolls. */
const ARC_SEGMENT_MIN_TICKS = 40;
const ARC_SEGMENT_MAX_TICKS = 90;
/** Drift easing rate toward the fresh target (fraction per tick). */
const DRIFT_EASE = 0.12;
/** Turn-smoothing floor: never blend below this fraction or a 0-smoothing
 *  profile would freeze the heading entirely. */
const TURN_SMOOTHING_FLOOR = 0.15;
/** Fight-memory freshness bound for hotspot avoidance (ticks) — matches the
 *  hotspot's own memory window class (HOTSPOT_MEMORY_TICKS = 20 s). */
const HOTSPOT_FRESH_TICKS = 1200;
/** Max hotspot-avoidance / zone-edge blend weights (keeps both readable
 *  nudges, never overrides the goal heading). */
const HOTSPOT_BLEND_CAP = 0.3;
const ZONE_EDGE_BLEND_CAP = 0.35;

/** The patrol-family states where signature steering/stops are allowed. Never
 *  in combat (ENGAGE/RETREAT), mid-breach (DEMOLITION) or survival flee. */
const SIGNATURE_SAFE_STATES: ReadonlySet<BotState> = new Set([
  BotState.WANDER,
  BotState.HUNT,
  BotState.LOOT,
  BotState.SEEK_WEAPON,
]);

/** Build a bot's movement signature (per-bot draws from its own RNG):
 *  arc segment length/direction, drift target, first stop-check cadence, and
 *  the FIXED micro-pause interval scaled by the archetype's speedVariance. */
export function createMovementSignature(
  rng: BotRNG,
  profile: MovementProfile,
): MovementSignatureState {
  const speedWobbleEvery =
    SPEED_WOBBLE_MIN_TICKS +
    Math.round((1 - profile.speedVariance) * SPEED_WOBBLE_RANGE_TICKS) +
    rng.int(0, 60);
  return {
    profile,
    rng,
    lastAngle: null,
    weavePhase: rng.next() * Math.PI * 2,
    arcDir: rng.next() < 0.5 ? -1 : 1,
    arcSegmentTicksLeft:
      ARC_SEGMENT_MIN_TICKS +
      Math.floor(rng.next() * (ARC_SEGMENT_MAX_TICKS - ARC_SEGMENT_MIN_TICKS)),
    driftOffset: 0,
    driftTarget: 0,
    stopUntilTick: -1,
    nextStopCheckTick: STOP_CHECK_BASE_TICKS + rng.int(0, STOP_CHECK_JITTER_TICKS),
    // First micro-pause comes after a FULL cadence (not at tick 0 — a bot
    // that just spawned doesn't stutter its first step).
    speedWobbleNextTick: speedWobbleEvery,
    speedWobbleEvery,
  };
}

/** Shortest-arc signed delta from `from` to `to` in (-π, π]. */
function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/** Vector blend of two angles: result = from + delta(from→to) × weight. */
function blendAngles(from: number, to: number, weight: number): number {
  return normalizeAngle(from + angleDelta(from, to) * weight);
}

/**
 * Signature shaping of one movement emission: approach-curve lateral offset
 * (weave / arc / drift), then turn smoothing toward the shaped heading.
 * Mutates the signature state (phase advance, segment countdown, easing);
 * returns the shaped angle. Null signature → angle unchanged (neutral).
 */
export function applyMovementShaping(
  sig: MovementSignatureState | null,
  tick: number,
  angle: number,
): number {
  if (!sig) return angle;
  const p = sig.profile;
  let a = angle;
  switch (p.approachCurve) {
    case 'weave':
      a += Math.sin(sig.weavePhase) * p.approachCurveAmplitudeRad;
      sig.weavePhase += WEAVE_PHASE_ADVANCE;
      break;
    case 'arc':
      a += sig.arcDir * p.approachCurveAmplitudeRad;
      sig.arcSegmentTicksLeft--;
      if (sig.arcSegmentTicksLeft <= 0) {
        sig.arcDir = -sig.arcDir;
        sig.arcSegmentTicksLeft =
          ARC_SEGMENT_MIN_TICKS + sig.rng.int(0, ARC_SEGMENT_MAX_TICKS - ARC_SEGMENT_MIN_TICKS);
      }
      break;
    case 'drift':
      if (sig.rng.next() < 0.05) {
        sig.driftTarget = (sig.rng.next() - 0.5) * 2 * p.approachCurveAmplitudeRad;
      }
      sig.driftOffset += (sig.driftTarget - sig.driftOffset) * DRIFT_EASE;
      a += sig.driftOffset;
      break;
    default:
      break;
  }
  if (sig.lastAngle !== null && p.turnSmoothing < 1) {
    const s = Math.max(p.turnSmoothing, TURN_SMOOTHING_FLOOR);
    a = sig.lastAngle! + angleDelta(sig.lastAngle!, a) * s;
  }
  sig.lastAngle = normalizeAngle(a);
  void tick; // shaping is emission-count-driven, not tick-driven
  return sig.lastAngle;
}

/** Minimal structural view the stop machine needs (unit-test friendly). */
export interface SignatureStopView {
  tick: number;
  playerId: string;
  state: BotState;
  /** Any perceived item (weapon/powerup/chest) — SCAVENGER loot anchors. */
  hasLootNearby: boolean;
  /** Chest in scan — TRAPPER feature anchors. */
  hasChestNearby: boolean;
  /** Barrel danger in scan — TRAPPER seam anchors. */
  hasBarrelNearby: boolean;
  /** Aim held while stopped (face the anchor/enemy — never an AFK freeze). */
  aimAngle: number;
}

/**
 * The stop/speed-variance emission: returns a STOP input for this tick when
 * the signature owns it (an active loiter window, or a due micro-pause),
 * else null. Arms loiter windows only in safe states near the archetype's
 * anchor (SCAVENGER: loot; TRAPPER: chest/barrel); micro-pauses are
 * class-independent but never fire in combat/flee states. Null signature or
 * stopFrequency-0/speedVariance-0 profiles never stop (neutral).
 */
export function signatureStopInput(
  sig: MovementSignatureState | null,
  view: SignatureStopView,
): QueuedInput | null {
  if (!sig) return null;
  const p = sig.profile;
  const safe = SIGNATURE_SAFE_STATES.has(view.state);

  // Active loiter window — hold (this is the visible pause).
  if (sig.stopUntilTick > view.tick) {
    return makeStopInput(view.playerId, view.aimAngle, view.tick);
  }
  if (sig.stopUntilTick >= 0 && sig.stopUntilTick <= view.tick) {
    sig.stopUntilTick = -1; // window just ended — resume
  }

  if (safe) {
    // Anchor-loiter cadence check.
    if (view.tick >= sig.nextStopCheckTick) {
      sig.nextStopCheckTick =
        view.tick + STOP_CHECK_BASE_TICKS + sig.rng.int(0, STOP_CHECK_JITTER_TICKS);
      if (p.stopFrequency > 0 && sig.rng.next() < p.stopFrequency) {
        const anchorOk =
          (p.loiterAtLoot && view.hasLootNearby) ||
          (p.prePositionNearFeatures && (view.hasChestNearby || view.hasBarrelNearby));
        if (anchorOk) {
          sig.stopUntilTick = view.tick + p.stopDurationTicks + sig.rng.int(0, 12);
          return makeStopInput(view.playerId, view.aimAngle, view.tick);
        }
      }
    }
    // Micro-pause (speed variance): a SPEED_WOBBLE_DURATION_TICKS-long dip
    // on the bot's fixed cadence — the emission covers the duration and the
    // next due time is offset past it, so normal movement resumes (with the
    // decel/re-accel tail giving the speed trace its variance).
    if (p.speedVariance > 0 && view.tick >= sig.speedWobbleNextTick) {
      sig.speedWobbleNextTick =
        view.tick + SPEED_WOBBLE_DURATION_TICKS + sig.speedWobbleEvery + sig.rng.int(0, 30);
      return makeStopInput(view.playerId, view.aimAngle, view.tick);
    }
  }
  return null;
}

/** Minimal structural view for the hotspot-avoidance blend. */
export interface HotspotAvoidView {
  tick: number;
  state: BotState;
  x: number;
  y: number;
  /** Shared fight-memory seat (BotContext.fightMemory* — see runPerception). */
  fightMemoryX: number;
  fightMemoryY: number;
  fightMemoryTick: number;
}

/**
 * SURVIVOR/SCAVENGER hotspot avoidance: when a fresh shared fight memory sits
 * within {@linkcode HOTSPOT_AVOID_RANGE_PX}, blend the heading AWAY from it
 * (weight = archetype × proximity, capped — a readable wide berth, never a
 * flee). Patrol-family states only; null signature → unchanged.
 */
export function applyHotspotAvoidance(
  sig: MovementSignatureState | null,
  view: HotspotAvoidView,
  angle: number,
): number {
  if (!sig || sig.profile.hotspotAvoidWeight <= 0) return angle;
  if (!SIGNATURE_SAFE_STATES.has(view.state)) return angle;
  if (view.tick - view.fightMemoryTick > HOTSPOT_FRESH_TICKS) return angle;
  const dx = view.x - view.fightMemoryX;
  const dy = view.y - view.fightMemoryY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1 || dist > HOTSPOT_AVOID_RANGE_PX) return angle;
  const w = Math.min(
    HOTSPOT_BLEND_CAP,
    sig.profile.hotspotAvoidWeight * (1 - dist / HOTSPOT_AVOID_RANGE_PX) * 0.3,
  );
  if (w <= 0) return angle;
  const away = Math.atan2(dy, dx);
  return blendAngles(angle, away, w);
}

/** Minimal structural view for the zone-edge preference blend. */
export interface ZoneEdgeView {
  state: BotState;
  x: number;
  y: number;
  zoneCenterX: number;
  zoneCenterY: number;
  zoneRadius: number;
}

/**
 * SURVIVOR zone-edge preference: while patrolling DEEP inside the zone
 * (inside {@linkcode ZONE_EDGE_INNER_FRACTION} × radius), blend the heading
 * outward toward the ring — the visible "works the edge, skips the middle"
 * habit. Never applies to loot runs or zone flees (state-gated), and the
 * endgame edge/center positioning stays owned by the macro-goal layer
 * (GoalTables.endgameEdgeBias — this is the mid-game movement surface).
 */
export function applyZoneEdgePreference(
  sig: MovementSignatureState | null,
  view: ZoneEdgeView,
  angle: number,
): number {
  if (!sig || sig.profile.zoneEdgePreference <= 0) return angle;
  if (view.state !== BotState.WANDER && view.state !== BotState.HUNT) return angle;
  if (view.zoneRadius <= 0) return angle;
  const dx = view.x - view.zoneCenterX;
  const dy = view.y - view.zoneCenterY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const frac = dist / view.zoneRadius;
  if (frac >= ZONE_EDGE_INNER_FRACTION) return angle;
  const outward = Math.atan2(dy, dx);
  const w = Math.min(
    ZONE_EDGE_BLEND_CAP,
    sig.profile.zoneEdgePreference *
      ((ZONE_EDGE_INNER_FRACTION - frac) / ZONE_EDGE_INNER_FRACTION) *
      0.35,
  );
  if (w <= 0) return angle;
  return blendAngles(angle, outward, w);
}

/**
 * Believed-state math — bot-ai-v2 ticket 05 (DEC-003).
 *
 * THE PURE SEAM of the belief layer: confidence decay, the GDD §14.2/§14.3
 * confidence-modifier tables, foveation noise, convergence, damage-origin
 * estimation, and dead-reckoning — all pure functions of their arguments
 * (the ONLY stochastic draws come from the caller-supplied per-bot BotRNG;
 * no clock reads, no ctx mutation). Unit-tested in isolation without a room.
 */

import type { BotRNG } from '../BotContext.ts';
import type { DifficultyLevel } from '../intent/PersonalityProfile.ts';
import {
  BELIEF_MAX_AGE_TICKS,
  BELIEF_MIN_CONFIDENCE,
  BELIEF_PERCEPTION_RANGE,
  BELIEF_PERIPHERAL_CONFIDENCE_FLOOR,
  CONVERGENCE_RAMP_PER_SCAN,
  DAMAGE_EST_MAX_DIST_PX,
  DAMAGE_EST_MIN_DIST_PX,
  DAMAGE_EST_SPREAD_RAD,
  DEAD_RECKON_MAX_PX,
  FOVEATION_DETECTION_RANGE,
  FOVEATION_DISTANT_NOISE_PX,
  FOVEATION_FRONT_ARC_RAD,
  FOVEATION_FRONT_NOISE_PX,
  FOVEATION_NOISE_MULTIPLIER,
  FOVEATION_PERIPHERY_NOISE_PX,
  CONFIDENCE_HALF_LIFE_TICKS,
  LOS_HALVING_FACTOR,
} from './BeliefConfig.ts';

/** Wrap an angle difference into [-π, π]. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** |angle between the bot's facing and the direction to a point|, in [0, π]. */
export function angleFromFacingAbs(
  facingAngle: number,
  toX: number,
  toY: number,
  fromX: number,
  fromY: number,
): number {
  const target = Math.atan2(toY - fromY, toX - fromX);
  return Math.abs(angleDelta(facingAngle, target));
}

/**
 * Exponential confidence decay: `confidence × 0.5^(dt / halfLife)`. A belief
 * untouched for one half-life is half as trusted; the half-life itself is
 * per-difficulty (CONFIDENCE_HALF_LIFE_TICKS). Pure; dt < 0 returns the
 * input unchanged (defensive — cannot occur: belief ticks are monotonic).
 */
export function decayConfidence(
  confidence: number,
  dtTicks: number,
  difficulty: DifficultyLevel,
): number {
  if (dtTicks <= 0) return confidence;
  const halfLife = CONFIDENCE_HALF_LIFE_TICKS[difficulty];
  return confidence * Math.pow(0.5, dtTicks / halfLife);
}

/**
 * GDD §14.2 detection range as a CONFIDENCE MODIFIER (never a wall): full
 * 1.0 confidence at/below the difficulty's detection range, fading linearly
 * to BELIEF_PERIPHERAL_CONFIDENCE_FLOOR at the perception edge. Beyond the
 * edge the floor persists (the caller only writes beliefs for scanned
 * enemies, so `dist > BELIEF_PERCEPTION_RANGE` cannot occur in production;
 * the clamp keeps the function total and monotone).
 */
export function detectionConfidence(dist: number, difficulty: DifficultyLevel): number {
  const range = FOVEATION_DETECTION_RANGE[difficulty];
  if (dist <= range) return 1;
  const t = Math.min(1, (dist - range) / (BELIEF_PERCEPTION_RANGE - range));
  return 1 + (BELIEF_PERIPHERAL_CONFIDENCE_FLOOR - 1) * t;
}

/**
 * GDD §14.3 LOS-halving as a confidence multiplier: a sighting without
 * line-of-sight (enemy behind a wall) is remembered at half confidence.
 */
export function losConfidenceFactor(hasLOS: boolean): number {
  return hasLOS ? 1 : LOS_HALVING_FACTOR;
}

/**
 * Foveation-lite position-noise scale (px) for one sighting: grows with
 * angle-from-facing (facing sector ≈ precise, directly-behind ≈ coarse) and
 * with distance beyond the difficulty's detection range, scaled by the
 * per-difficulty noise multiplier. Pure — the RNG application is separate
 * ({@link applyFoveationNoise}) so bounds are testable without draws.
 */
export function foveationNoiseScale(
  angleFromFacing: number,
  dist: number,
  difficulty: DifficultyLevel,
): number {
  // Facing term: 0 ramp over the front arc → FOVEATION_PERIPHERY_NOISE_PX at
  // directly behind (π). Below the front arc a small base jitter remains
  // (FOVEATION_FRONT_NOISE_PX) — no perception is pixel-perfect.
  const a = Math.min(Math.PI, Math.max(0, angleFromFacing));
  let facingTerm: number;
  if (a <= FOVEATION_FRONT_ARC_RAD) {
    facingTerm = FOVEATION_FRONT_NOISE_PX * (a / FOVEATION_FRONT_ARC_RAD);
  } else {
    const t = (a - FOVEATION_FRONT_ARC_RAD) / (Math.PI - FOVEATION_FRONT_ARC_RAD);
    facingTerm =
      FOVEATION_FRONT_NOISE_PX + (FOVEATION_PERIPHERY_NOISE_PX - FOVEATION_FRONT_NOISE_PX) * t;
  }
  // Distant term: 0 inside the detection range → FOVEATION_DISTANT_NOISE_PX
  // at the perception edge.
  const range = FOVEATION_DETECTION_RANGE[difficulty];
  let distantTerm = 0;
  if (dist > range) {
    const t = Math.min(1, (dist - range) / (BELIEF_PERCEPTION_RANGE - range));
    distantTerm = FOVEATION_DISTANT_NOISE_PX * t;
  }
  return (facingTerm + distantTerm) * FOVEATION_NOISE_MULTIPLIER[difficulty];
}

/**
 * Apply per-bot-RNG foveation noise to a believed position. Each axis draws
 * uniformly in [-scale, +scale] — a bounded box around the true sighting
 * (|dx| ≤ scale and |dy| ≤ scale are hard bounds, unit-tested). Determinism:
 * exactly TWO rng.next() draws per call, in x-then-y order.
 */
export function applyFoveationNoise(
  rng: BotRNG,
  x: number,
  y: number,
  angleFromFacing: number,
  dist: number,
  difficulty: DifficultyLevel,
): { x: number; y: number } {
  const scale = foveationNoiseScale(angleFromFacing, dist, difficulty);
  const dx = (rng.next() * 2 - 1) * scale;
  const dy = (rng.next() * 2 - 1) * scale;
  return { x: x + dx, y: y + dy };
}

/**
 * Convergence toward truth on re-acquisition (DEC-003 Dissent): the stored
 * confidence moves toward the fresh sample confidence by the per-difficulty
 * ramp. Hard/elite converge in one scan; easy ramps over ~3. Pure.
 */
export function nextSeenConfidence(
  prevConfidence: number,
  sampleConfidence: number,
  difficulty: DifficultyLevel,
): number {
  const ramp = CONVERGENCE_RAMP_PER_SCAN[difficulty];
  const next = prevConfidence + (sampleConfidence - prevConfidence) * ramp;
  return Math.min(1, Math.max(0, next));
}

/**
 * DAMAGE-DIRECTION ESTIMATION (the DEC-003 core): estimate the attacker's
 * position from the victim's position + the damage direction (the negated
 * server-authoritative knockback vector, pointing from victim TOWARD the
 * attacker), with BOTH an angular spread and a guessed distance drawn from
 * the per-bot BotRNG. The true attacker coordinates are NEVER inputs —
 * bounded error by construction (the estimate can be wrong; it cannot be
 * omniscient).
 *
 * Zero direction (damage with no knockback): the estimate collapses to the
 * victim's own position ("someone hit me from nearby") — the caller stores
 * it with DAMAGE_NO_DIRECTION_CONFIDENCE.
 * Determinism: exactly ONE angle-range draw + ONE distance-range draw when
 * a direction exists, zero draws otherwise.
 */
export function estimateDamageOrigin(
  rng: BotRNG,
  victimX: number,
  victimY: number,
  dirX: number,
  dirY: number,
): { x: number; y: number } {
  const len = Math.sqrt(dirX * dirX + dirY * dirY);
  if (len < 1e-6) return { x: victimX, y: victimY };
  const baseAngle = Math.atan2(dirY / len, dirX / len);
  const angle = baseAngle + rng.range(-DAMAGE_EST_SPREAD_RAD, DAMAGE_EST_SPREAD_RAD);
  const dist = rng.range(DAMAGE_EST_MIN_DIST_PX, DAMAGE_EST_MAX_DIST_PX);
  return { x: victimX + Math.cos(angle) * dist, y: victimY + Math.sin(angle) * dist };
}

/**
 * Geometric ERROR BOUND for damage estimates (the bounded-error assertion's
 * denominator): the EXACT maximum distance an estimate can sit from the true
 * attacker, given the true attacker distance — pure law-of-cosines over the
 * worst angular spread and both distance-range endpoints. Used ONLY by tests
 * and telemetry sanity; the AI never sees the true distance.
 *
 * error² = T² + D² − 2·T·D·cos(δ) with D ∈ [dmin, dmax], |δ| ≤ spread. The
 * expression is convex in D, so the max is at an endpoint; it grows as
 * cos(δ) shrinks, so the worst δ is the full spread.
 */
export function damageEstimateErrorBound(trueDist: number): number {
  const c = Math.cos(DAMAGE_EST_SPREAD_RAD);
  const e2 = (d: number): number => trueDist * trueDist + d * d - 2 * trueDist * d * c;
  return Math.sqrt(Math.max(e2(DAMAGE_EST_MIN_DIST_PX), e2(DAMAGE_EST_MAX_DIST_PX)));
}

/**
 * Dead-reckoning: extrapolate a believed position by its last velocity ×
 * elapsed ticks, capped at DEAD_RECKON_MAX_PX from the last update point
 * (the believed world is a memory, not a simulator). Pure.
 */
export function deadReckon(
  beliefX: number,
  beliefY: number,
  vx: number,
  vy: number,
  beliefTick: number,
  nowTick: number,
): { x: number; y: number } {
  const dt = Math.max(0, nowTick - beliefTick);
  if (dt === 0) return { x: beliefX, y: beliefY };
  let dx = vx * dt;
  let dy = vy * dt;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > DEAD_RECKON_MAX_PX) {
    const k = DEAD_RECKON_MAX_PX / len;
    dx *= k;
    dy *= k;
  }
  return { x: beliefX + dx, y: beliefY + dy };
}

/** Belief expiry predicate: confidence floor OR absolute age cap. */
export function isBeliefExpired(confidence: number, beliefTick: number, nowTick: number): boolean {
  return confidence < BELIEF_MIN_CONFIDENCE || nowTick - beliefTick > BELIEF_MAX_AGE_TICKS;
}

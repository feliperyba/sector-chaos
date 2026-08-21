/**
 * solveBladeLength.ts — Computes the hitbox blade length for a weapon so the
 * tip's APEX radius during the strike equals the weapon's gameplay range.
 *
 * This pins balance parity: the swept-segment hitbox can reach exactly as far
 * as the legacy instant arc/line hitbox did, regardless of how the strike
 * keyframes are authored. Runs once at module init — deterministic.
 */
import type { MotionKeyframe } from './types.js';
import type { EasingName } from '../AnimEasing.js';
import { interpolateKeyframes } from '../AnimEasing.js';
import {
  solveWeaponPosition,
  computeWeaponSegment,
  type WeaponPositionStrategy,
} from '../WeaponPose.js';

const SAMPLES = 96;

/** Max |tip| over the strike, body at origin, facing +X, attackBlend = 1. */
export function maxTipRadius(
  keyframes: readonly MotionKeyframe[],
  easing: EasingName,
  strategy: WeaponPositionStrategy,
  handOffset: number,
  bladeLength: number,
): number {
  let max = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const hands = interpolateKeyframes(keyframes, i / SAMPLES, easing);
    const input = {
      leftHand: hands.left,
      rightHand: hands.right,
      bodyX: 0,
      bodyY: 0,
      angle: 0,
      handOffset,
      rotOffset: 0,
      strategy,
      attackBlend: 1,
    };
    const pos = solveWeaponPosition(input);
    const seg = computeWeaponSegment(pos, input, bladeLength);
    const r = Math.sqrt(seg.tip.x * seg.tip.x + seg.tip.y * seg.tip.y);
    if (r > max) max = r;
  }
  return max;
}

/**
 * Strike-extension scaling ramps in over the first part of the strike so the
 * scaled path still starts at the windup-end pose (no pose pop at the phase
 * boundary); the apex region (progress ≥ RAMP_END) is fully scaled.
 */
const RAMP_END = 0.2;

/** Scale strike keyframes' hand positions radially by k, ramped by progress. */
export function scaleStrikeKeyframes(
  keyframes: readonly MotionKeyframe[],
  k: number,
): MotionKeyframe[] {
  return keyframes.map((f) => {
    const w = Math.min(1, f.progress / RAMP_END);
    const s = 1 + (k - 1) * w;
    return {
      ...f,
      left: { x: f.left.x * s, y: f.left.y * s },
      right: { x: f.right.x * s, y: f.right.y * s },
    };
  });
}

/**
 * Solve the radial hand-extension factor k so the strike's apex tip radius
 * equals `range` for a FIXED (sprite-true) bladeLength. This is the inverse
 * of solveBladeLength: the weapon art never scales — the reach comes from the
 * hands thrusting/swinging further. Monotonic in k → bisection.
 *
 * `minExtension` floors k so the hands never swing less than this fraction of
 * their authored keyframes. When the blade alone already reaches `range` (long
 * weapons after art scaling), the solver would otherwise shrink the hand arc
 * toward zero — the swing collapses to "in front of the face". Default 1.0
 * keeps the full authored swing; the blade simply extends the tip, and the
 * sweep handler's broad-phase still caps damage at `range`.
 */
export function solveStrikeExtension(
  keyframes: readonly MotionKeyframe[],
  easing: EasingName,
  strategy: WeaponPositionStrategy,
  handOffset: number,
  bladeLength: number,
  range: number,
  minExtension: number = 1.0,
): number {
  const radiusAt = (k: number) =>
    maxTipRadius(scaleStrikeKeyframes(keyframes, k), easing, strategy, handOffset, bladeLength);
  let lo = 0.1;
  let hi = 8;
  // If even the minimum extension already reaches range, don't shrink the
  // hands further — clamp to the floor so the swing stays full.
  if (radiusAt(minExtension) >= range) return minExtension;
  if (radiusAt(lo) >= range) return lo;
  if (radiusAt(hi) <= range) return hi;
  // Search only above the floor.
  lo = Math.max(lo, minExtension);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (radiusAt(mid) < range) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Solve bladeLength so maxTipRadius == range. Monotonic in bladeLength for
 * outward-pointing strikes → bisection. Returns 0 if even a zero-length
 * blade already reaches past `range` (degenerate spec — caught by tests).
 * Used only for sprite-less strategies (fists) — weapons with art use the
 * fixed sprite blade + solveStrikeExtension instead.
 */
export function solveBladeLength(
  keyframes: readonly MotionKeyframe[],
  easing: EasingName,
  strategy: WeaponPositionStrategy,
  handOffset: number,
  range: number,
): number {
  if (maxTipRadius(keyframes, easing, strategy, handOffset, 0) >= range) return 0;
  let lo = 0;
  let hi = range; // blade can never need to exceed full range
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (maxTipRadius(keyframes, easing, strategy, handOffset, mid) < range) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

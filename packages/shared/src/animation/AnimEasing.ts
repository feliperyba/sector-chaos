/**
 * AnimEasing.ts — Easing functions and keyframe interpolation.
 *
 * Moved from client-v3 (was packages/client-v3/src/rendering/AnimationEasing.ts).
 * Pure functions — no state, no side effects. Extended with per-segment easing:
 * a keyframe may carry its own `easing`, applied to the segment FROM that
 * keyframe TO the next one (falls back to the phase-level easing).
 */
import type { Vec2 } from '../math/Vec2.js';

export type EasingName =
  | 'easeInQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeOutExpo'
  | 'easeOutBack'
  | 'easeOutElastic'
  | 'easeOutBounce'
  | 'easeInOutCubic'
  | 'easeInOutSine'
  | 'linear';

export const EASING_FNS: Record<EasingName, (t: number) => number> = {
  easeInQuad: (t) => t * t,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  easeOutBounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  linear: (t) => t,
};

/** Minimal keyframe contract the interpolator needs. */
export interface InterpKeyframe {
  progress: number;
  left: Vec2;
  right: Vec2;
  /** Optional per-segment easing: applies from THIS keyframe to the next. */
  easing?: EasingName;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function cloneVec(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function interpolateKeyframes(
  keyframes: readonly InterpKeyframe[],
  progress: number,
  easing: EasingName,
): { left: Vec2; right: Vec2 } {
  const out = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  interpolateKeyframesInto(out, keyframes, progress, easing);
  return out;
}

/**
 * Zero-allocation variant: writes into `out.left`/`out.right` in place.
 * Caller must read the values before the next call (shared memory).
 */
export function interpolateKeyframesInto(
  out: { left: Vec2; right: Vec2 },
  keyframes: readonly InterpKeyframe[],
  progress: number,
  easing: EasingName,
): void {
  const p = Math.max(0, Math.min(1, progress));
  const last = keyframes.length - 1;
  const first = keyframes[0]!;
  const lastKf = keyframes[last]!;

  if (p <= first.progress) {
    out.left.x = first.left.x;
    out.left.y = first.left.y;
    out.right.x = first.right.x;
    out.right.y = first.right.y;
    return;
  }
  if (p >= lastKf.progress) {
    out.left.x = lastKf.left.x;
    out.left.y = lastKf.left.y;
    out.right.x = lastKf.right.x;
    out.right.y = lastKf.right.y;
    return;
  }

  for (let i = 0; i < last; i++) {
    const lower = keyframes[i]!;
    const upper = keyframes[i + 1]!;
    if (p >= lower.progress && p <= upper.progress) {
      const range = upper.progress - lower.progress;
      const localT = range > 0 ? (p - lower.progress) / range : 0;
      const easedT = EASING_FNS[lower.easing ?? easing](localT);
      out.left.x = lerp(lower.left.x, upper.left.x, easedT);
      out.left.y = lerp(lower.left.y, upper.left.y, easedT);
      out.right.x = lerp(lower.right.x, upper.right.x, easedT);
      out.right.y = lerp(lower.right.y, upper.right.y, easedT);
      return;
    }
  }

  out.left.x = lastKf.left.x;
  out.left.y = lastKf.left.y;
  out.right.x = lastKf.right.x;
  out.right.y = lastKf.right.y;
}

/**
 * Interpolate a scalar keyframe channel (e.g. body lean) along the same
 * progress/easing rules as the positional channels.
 */
export function interpolateScalar(
  points: readonly { progress: number; value: number; easing?: EasingName }[],
  progress: number,
  easing: EasingName,
): number {
  if (points.length === 0) return 0;
  const p = Math.max(0, Math.min(1, progress));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (p <= first.progress) return first.value;
  if (p >= last.progress) return last.value;
  for (let i = 0; i < points.length - 1; i++) {
    const lower = points[i]!;
    const upper = points[i + 1]!;
    if (p >= lower.progress && p <= upper.progress) {
      const range = upper.progress - lower.progress;
      const localT = range > 0 ? (p - lower.progress) / range : 0;
      const easedT = EASING_FNS[lower.easing ?? easing](localT);
      return lerp(lower.value, upper.value, easedT);
    }
  }
  return last.value;
}

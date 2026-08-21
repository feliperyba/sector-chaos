/** Normalizes angle to [-PI, PI] range. Returns 0 for non-finite input. */
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const TWO_PI = Math.PI * 2;
  const normalized = ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  // Map -PI to PI to keep the closed interval [-PI, PI].
  return normalized === -Math.PI ? Math.PI : normalized;
}

/** Normalizes angle to [0, 2*PI) range. Returns 0 for non-finite input. */
export function normalizeAnglePositive(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const TWO_PI = Math.PI * 2;
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/** Shortest angular delta between two angles. */
export function shortestAngleDelta(from: number, to: number): number {
  const delta = to - from;
  const TWO_PI = Math.PI * 2;
  const normalized = ((((delta + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  // Map -PI to PI to keep the closed interval [-PI, PI].
  return normalized === -Math.PI ? Math.PI : normalized;
}

/**
 * Absolute shortest angular difference between two angles, in [0, PI].
 *
 * Companion of {@link shortestAngleDelta} with the same argument order
 * (`to - from`), and the shared-math counterpart of the bot-AI `angleDiff`.
 * Built on {@link normalizeAngle} (NOT a re-implementation of the wrapping):
 * for finite inputs the result is exactly
 * `Math.abs(shortestAngleDelta(from, to))`, and non-finite inputs degrade to
 * `Math.abs(normalizeAngle(...)) === 0` instead of propagating NaN.
 */
export function absAngleDelta(from: number, to: number): number {
  return Math.abs(normalizeAngle(to - from));
}

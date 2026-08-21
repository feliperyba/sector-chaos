/**
 * Pure, zero-allocation 2D geometry primitives.
 *
 * Flat scalar namespace (NOT a `Vec2` class) matching the shared style of
 * `applyAccelerationInto`: scalar in / scalar out, or scratch-out into a
 * caller-owned receptacle. No object allocation, no `Math.random`, no side
 * effects — safe for the server-authoritative sim and client prediction
 * alike (float determinism, ADR-0035).
 *
 * These are the canonical targets for migrating the duplicated inline math
 * (bot-AI local helpers in `BotInput.ts`, client `Math.atan2` aim/dash sites,
 * `Math.sqrt` normalization in the prediction path). This module lands the
 * shared foundation only — no production callers are migrated here.
 */

/**
 * Angle in radians from point `(fromX, fromY)` to point `(toX, toY)`,
 * in the `Math.atan2` range [-PI, PI]. Screen/world convention: +Y is down.
 *
 * Same formula as the bot-AI `angleTo` (`BotInput.ts`) and the client inline
 * aim/dash `Math.atan2` sites: `atan2(dy, dx)`.
 *
 * Coincident points return `atan2(0, 0)` which is `0` (i.e. facing +X) —
 * that is the ECMAScript-specified result, preserved verbatim.
 */
export function angleTo(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(toY - fromY, toX - fromX);
}

/**
 * Euclidean distance between points `(ax, ay)` and `(bx, by)`.
 *
 * Same formula as the bot-AI `distance` (`BotInput.ts`) and the inline
 * `Math.sqrt(dx ** 2 + dy ** 2)` call sites: `sqrt` of sum of squares.
 */
export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

/**
 * Squared Euclidean distance between points `(ax, ay)` and `(bx, by)`.
 *
 * For comparison-only hot paths (threshold checks) where the `sqrt` can be
 * skipped entirely; pair with squared thresholds. Exactly
 * `distance(ax, ay, bx, by) ** 2` without the root.
 */
export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  return (bx - ax) ** 2 + (by - ay) ** 2;
}

/**
 * Writes the unit vector of `(x, y)` into the caller-owned scratch `out`.
 * Zero-allocation variant: mutates `out.x`/`out.y` in place, returns nothing.
 *
 * CHOSEN ZERO-LENGTH BEHAVIOR (documented, deliberately not NaN):
 * unless `(x, y)` has a positive FINITE length, the result is the zero
 * vector `(0, 0)`. That covers zero-length input AND any non-finite
 * component (NaN or Infinity — an Infinity component would otherwise make
 * `Infinity / Infinity = NaN`). This helper therefore NEVER writes NaN into
 * the scratch. For finite input it matches the prediction-path convention
 * `len > 0 ? dir / len : 0` (`PredictionService.ts`, `Reconciler.ts`).
 * Callers that want a different zero-direction default (e.g. dash fallback
 * `(1, 0)`) branch at their call site before invoking this helper.
 *
 * @param out - Receptacle for the unit vector (mutated in place)
 * @param x   - Vector X component
 * @param y   - Vector Y component
 */
export function normalizeInto(out: { x: number; y: number }, x: number, y: number): void {
  const len = Math.sqrt(x * x + y * y);
  // `len > 0` is false for 0 and NaN; the isFinite check rejects an Infinity
  // component (len = Infinity) that would otherwise divide out to NaN.
  if (!(len > 0) || !Number.isFinite(len)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  out.x = x / len;
  out.y = y / len;
}

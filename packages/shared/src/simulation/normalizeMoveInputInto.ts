/**
 * Normalize a raw 2D movement/dash input vector to a unit direction (ticket 15
 * / research C3 row 2 + row 10). This is the ONE leaf behind the four former
 * hand copies of input normalization — server `MovementService.validateAndMove`,
 * shared `simulatePhysicsStepInto` (input + dash-direction), client
 * `PredictionService.step` (input + dash-direction capture) and
 * `Reconciler.reconcile` (frame direction + dash direction) — so client
 * prediction and server simulation normalize with identical arithmetic by
 * construction.
 *
 * FLOAT-ORDER CONTRACT: the magnitude is computed as
 * `Math.sqrt(dx * dx + dy * dy)` EXACTLY — NOT `Math.hypot`. `Math.hypot` is
 * implementation-approximate and demonstrably NOT bit-identical to the sqrt
 * form (e.g. hypot(0.7071067811865475, 0.7071067811865475) = 1 while the sqrt
 * form yields 0.9999999999999999), so the sqrt form — the arithmetic the
 * server's validateAndMove always used — is the canonical one. Pinned by the
 * verbatim-oracle battery in `__tests__/normalizeMoveInputInto.test.ts`.
 *
 * Zero-allocation: writes the unit direction into the caller-owned `out`
 * receptacle. Returns the magnitude so callers preserve their exact `len > 0`
 * discriminators — dash-direction fallbacks differ per call site
 * (`(1,0)` after normalize on the physics paths; `facingAngle` BEFORE
 * normalize in the server DashCommand) and stay call-site-owned by design.
 * Returning the length is load-bearing for edge inputs: e.g. `(1e200, 1e200)`
 * squares to Infinity, so `len > 0` is true while `out` degenerates to (0,0) —
 * only the returned length reproduces the former `len > 0` branch faithfully.
 *
 * `(0,0)` is a valid input and normalizes to `(0,0)` — downstream that means
 * "no direction", which triggers deceleration in `applyAccelerationInto`.
 */
export function normalizeMoveInputInto(
  out: { x: number; y: number },
  dx: number,
  dy: number,
): number {
  const len = Math.sqrt(dx * dx + dy * dy);
  out.x = len > 0 ? dx / len : 0;
  out.y = len > 0 ? dy / len : 0;
  return len;
}

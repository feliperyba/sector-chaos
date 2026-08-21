import { PLAYER_PHYSICS_CONFIG } from './playerPhysicsConfig.js';
import type { PhysicsConfig } from './PhysicsTypes.js';

/**
 * The stagger speed multiply (ticket 15 / research C3 row 3) — the ONE leaf
 * behind both former hand-rolled staggers:
 *
 *   server `MovementService.validateAndMove`:
 *     `staggerPenalty = isStaggered ? STAGGER_MOVE_SPEED_PENALTY : 1`
 *     `effectiveMaxSpeed = speed.value * staggerPenalty`
 *   shared `simulatePhysicsStepInto`:
 *     `effectiveSpeed *= config.staggerMoveSpeedPenalty` when staggered
 *
 * BIT-IDENTICAL to BOTH former forms in every case:
 *   - staggered: `speed * penalty` — the SAME multiply expression in the SAME
 *     order both sides computed (`STAGGER_MOVE_SPEED_PENALTY` is 0.75, which
 *     is not a power of two, so the multiply itself can round — identity holds
 *     because it is literally the same operation, not because it is exact).
 *   - not staggered: the branch returns `speed` unchanged, while the former
 *     server form computed `speed * 1` — and `x * 1 === x` exactly for every
 *     IEEE-754 double (including -0/NaN/Infinity).
 *
 * The client step applies this to its walk OR dash accel target (NET-21
 * Approach B: the dash target is `baseSpeed * dashSpeedMultiplier`), so the
 * "walk" in the name is the not-dashing scalar; callers compose the target and
 * pass it in. Pinned by the verbatim-oracle battery in
 * `__tests__/effectiveWalkSpeed.test.ts`.
 */
export function effectiveWalkSpeed(
  speed: number,
  isStaggered: boolean,
  config: PhysicsConfig = PLAYER_PHYSICS_CONFIG,
): number {
  return isStaggered ? speed * config.staggerMoveSpeedPenalty : speed;
}

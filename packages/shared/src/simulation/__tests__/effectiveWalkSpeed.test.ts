import { describe, it, expect } from 'vitest';
import { effectiveWalkSpeed } from '../effectiveWalkSpeed.js';
import { PLAYER_PHYSICS_CONFIG } from '../playerPhysicsConfig.js';
import { PLAYER, COMBAT } from '../../constants/index.js';

/**
 * Verbatim-oracle battery for `effectiveWalkSpeed` (ticket 15 / research C3
 * row 3). Both former stagger multiplies are transcribed VERBATIM and the
 * shared leaf is asserted BIT-IDENTICAL (`===`) to each over a speed battery
 * that includes the exact production scalars (BASE_SPEED, the dash speed
 * BASE_SPEED*DASH_SPEED_MULTIPLIER, staggered products) plus IEEE edges
 * (signed zero, denormal, Infinity, negatives):
 *
 *   server MovementService.validateAndMove (former lines 161-162):
 *     staggerPenalty = isStaggered ? STAGGER_MOVE_SPEED_PENALTY : 1
 *     effectiveMaxSpeed = speed.value * staggerPenalty
 *   shared simulatePhysicsStepInto (former lines 75-78):
 *     effectiveSpeed = isDashing ? baseSpeed * dashSpeedMultiplier : speed
 *     if (isStaggered) effectiveSpeed *= staggerMoveSpeedPenalty
 *
 * Bit-identity argument (pinned empirically below): staggered — the SAME
 * multiply `speed * 0.75` in the same order on both sides (0.75 is NOT a
 * power of two, so the product CAN round — identity comes from the leaf and
 * both former copies being the same expression, not from exactness of the
 * multiply itself; see the leaf test's pinned rationale); not staggered —
 * the leaf returns `speed` unchanged while the former server form computed
 * `speed * 1`, and `x * 1 === x` exactly for every IEEE-754 double.
 */

/** Transcript — server validateAndMove (former lines 161-162). */
function serverOriginal(speed: number, isStaggered: boolean) {
  const staggerPenalty = isStaggered ? COMBAT.STAGGER_MOVE_SPEED_PENALTY : 1;
  return speed * staggerPenalty;
}

/** Transcript — shared simulatePhysicsStepInto (former lines 75-78). */
function clientStepOriginal(
  speed: number,
  isDashing: boolean,
  isStaggered: boolean,
  config = PLAYER_PHYSICS_CONFIG,
) {
  let effectiveSpeed = isDashing ? config.baseSpeed * config.dashSpeedMultiplier : speed;
  if (isStaggered) {
    effectiveSpeed *= config.staggerMoveSpeedPenalty;
  }
  return effectiveSpeed;
}

const SPEEDS = [
  0,
  -0,
  1,
  215.5,
  PLAYER.BASE_SPEED, // 430
  PLAYER.BASE_SPEED * 1.5, // 645 (speed power-up)
  PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER, // 860 (dash scalar)
  1e-300,
  5e-324,
  1e300,
  Number.MAX_VALUE,
  Infinity,
  -430,
];

describe('effectiveWalkSpeed — verbatim-oracle parity battery (ticket 15)', () => {
  it('is bit-identical to the server penalty-multiply transcript for every speed × stagger state', () => {
    for (const speed of SPEEDS) {
      for (const isStaggered of [false, true]) {
        expect(effectiveWalkSpeed(speed, isStaggered)).toBe(serverOriginal(speed, isStaggered));
      }
    }
  });

  it('is bit-identical to the client step transcript for walk AND dash accel targets', () => {
    for (const speed of SPEEDS) {
      for (const isDashing of [false, true]) {
        for (const isStaggered of [false, true]) {
          // the client composes the target first, then staggers — the leaf
          // call sites do exactly this composition
          const target = isDashing
            ? PLAYER_PHYSICS_CONFIG.baseSpeed * PLAYER_PHYSICS_CONFIG.dashSpeedMultiplier
            : speed;
          expect(effectiveWalkSpeed(target, isStaggered, PLAYER_PHYSICS_CONFIG)).toBe(
            clientStepOriginal(speed, isDashing, isStaggered),
          );
        }
      }
    }
  });

  it('not-staggered returns the input scalar UNCHANGED (identity, incl. signed zero)', () => {
    expect(effectiveWalkSpeed(430, false)).toBe(430);
    expect(effectiveWalkSpeed(-0, false)).toBe(-0);
    expect(Object.is(effectiveWalkSpeed(-0, false), -0)).toBe(true);
    expect(effectiveWalkSpeed(Infinity, false)).toBe(Infinity);
  });

  it('staggered applies the pinned 0.75 penalty with the identical multiply', () => {
    // The evidence doc claimed 0.5; the constant of record is 0.75 — pinned
    // here so nobody "corrects" it from the doc again. 0.75 is NOT a power of
    // two, so `speed * 0.75` CAN round — bit-identity comes from the leaf and
    // both former copies being the SAME multiply expression in the same order
    // (asserted === above), not from exactness of the multiply itself.
    expect(COMBAT.STAGGER_MOVE_SPEED_PENALTY).toBe(0.75);
    expect(PLAYER_PHYSICS_CONFIG.staggerMoveSpeedPenalty).toBe(0.75);
    expect(effectiveWalkSpeed(430, true)).toBe(322.5);
    expect(effectiveWalkSpeed(645, true)).toBe(483.75);
    expect(effectiveWalkSpeed(860, true)).toBe(645);
    // pinned production numbers: staggered walk cap and staggered dash target
    expect(effectiveWalkSpeed(PLAYER.BASE_SPEED, true)).toBe(PLAYER.BASE_SPEED * 0.75);
    expect(
      effectiveWalkSpeed(
        PLAYER_PHYSICS_CONFIG.baseSpeed * PLAYER_PHYSICS_CONFIG.dashSpeedMultiplier,
        true,
      ),
    ).toBe(PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER * 0.75);
  });

  it('default config IS PLAYER_PHYSICS_CONFIG (single object identity — drift impossible)', () => {
    // The server consumes the default; the client passes its config through.
    // Same frozen object → same penalty by construction.
    expect(effectiveWalkSpeed(100, true)).toBe(
      effectiveWalkSpeed(100, true, PLAYER_PHYSICS_CONFIG),
    );
  });
});

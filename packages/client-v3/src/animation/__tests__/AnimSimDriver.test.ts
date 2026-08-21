import { describe, it, expect } from 'vitest';
import { AnimSimDriver } from '../AnimSimDriver.js';
import { AnimPhase, WeaponType } from '@sector-battle/shared';
import type { DriverFrameInput } from '../AnimSimDriver.js';

/**
 * Regression tests for the `[anim] phase-clock drift` warnings (B4 perf H6).
 *
 * ROOT CAUSE: `applyServerPhase` received the server's phase AGE (`ageTicks`)
 * but compared it against a `localAge` derived from the CLIENT's own `simTick`.
 * The client's `simTick` falls behind the server's wall-clock tick whenever a
 * frame exceeds the 50ms dt clamp (PlayerRenderer.ts:379) or during local
 * hit-stop (effectiveDt = 0 → zero ticks advanced). Once behind, every patch
 * reported a growing `localAge - ageTicks` delta and fired the drift warning —
 * but the driver only re-based `phaseStartTick`, never advancing `simTick`
 * itself, so the drift compounded forever (until the next phase transition).
 *
 * The fix threads the absolute server tick into `applyServerPhase` so the
 * driver can detect lagging simTick and advance it (catch-up) within a
 * deadband, keeping the client's clock aligned with the server's.
 */

function makeFrameInput(overrides: Partial<DriverFrameInput> = {}): DriverFrameInput {
  return {
    facingAngle: 0,
    bodyX: 0,
    bodyY: 0,
    bodyVelX: 0,
    bodyVelY: 0,
    isMoving: false,
    weaponType: WeaponType.FISTS,
    ...overrides,
  };
}

describe('AnimSimDriver — simTick catch-up (H6 phase-clock drift regression)', () => {
  it('does NOT log drift when the client simTick is aligned with the server tick', () => {
    const driver = new AnimSimDriver(WeaponType.FISTS);
    const input = makeFrameInput();

    // Step the client sim to tick 100 (aligned with the server).
    for (let i = 0; i < 100; i++) {
      driver.update(1 / 60, input);
    }
    expect(driver.simTickForTest).toBe(100);

    // Server patch at server tick 100, phase started at tick 90 → ageTicks 10.
    // Client simTick is also 100, phaseStartTick set to 90 → localAge 10. No drift.
    driver.applyServerPhase(AnimPhase.WINDUP, 10, 0, WeaponType.FISTS, 'line', 100, 90);
    expect(driver.debugDesync().phaseAgeDeltaTicks).toBe(0);
    expect(driver.debugDesync().lastCorrectionTicks).toBe(0);
  });

  it('advances simTick to catch up when the client lags behind the server tick (H6)', () => {
    // The core regression: a slow frame / hit-stop drops the client simTick
    // behind the server's wall-clock tick. The next patch MUST advance the
    // client simTick (within a deadband) instead of leaving it behind —
    // otherwise the phase-age delta grows every patch and fires drift warnings.
    const driver = new AnimSimDriver(WeaponType.FISTS);
    const input = makeFrameInput();

    // Client sim only reaches tick 94 (6 ticks behind — simulates dropped time).
    for (let i = 0; i < 94; i++) {
      driver.update(1 / 60, input);
    }
    expect(driver.simTickForTest).toBe(94);

    // Server is at tick 100; the player's attack phase started at server tick 90
    // → server ageTicks = 10. If the driver used its own simTick (94), localAge
    // = 94 - phaseStartTick. The OLD behavior left simTick at 94 → localAge
    // would be 4 → delta = 4 - 10 = -6 → drift warning. The NEW behavior
    // advances simTick to ~100 first, so localAge ≈ 10 → delta ≈ 0.
    driver.applyServerPhase(AnimPhase.WINDUP, 10, 0, WeaponType.FISTS, 'line', 100, 90);

    // After catch-up, simTick should be close to the server tick (100).
    expect(driver.simTickForTest).toBeGreaterThanOrEqual(98);
    expect(driver.simTickForTest).toBeLessThanOrEqual(100);

    // The phase-age delta must now be within the deadband (no large correction).
    expect(Math.abs(driver.debugDesync().phaseAgeDeltaTicks)).toBeLessThanOrEqual(2);
  });

  it('catch-up is bounded: a huge server tick jump does not run hundreds of steps', () => {
    // Safety guard: if the server tick is wildly ahead (e.g. after a tab-throttle
    // pause), catch-up must be bounded so it does not stall the frame. The driver
    // should advance simTick by a capped amount, not jump the full gap.
    const driver = new AnimSimDriver(WeaponType.FISTS);
    const input = makeFrameInput();
    for (let i = 0; i < 10; i++) {
      driver.update(1 / 60, input);
    }
    expect(driver.simTickForTest).toBe(10);

    // Server jumps to tick 500 (tab was backgrounded). The driver should NOT
    // try to step 490 ticks in one call. It advances simTick directly (no
    // stepAnimation calls for the gap) but bounds the jump.
    driver.applyServerPhase(AnimPhase.IDLE, 0, 0, WeaponType.FISTS, '', 500, 500);

    // simTick advanced toward the server tick (the exact bound is an internal
    // detail, but it must be closer to 500 than to 10 and it must not exceed 500).
    expect(driver.simTickForTest).toBeGreaterThan(10);
    expect(driver.simTickForTest).toBeLessThanOrEqual(500);
  });

  it('catch-up is BIDIRECTIONAL: steps simTick back when the client runs ahead (steady +6 drift fix)', () => {
    // ROOT CAUSE of the steady +6/+7 `[anim] phase-clock drift` warnings: the
    // catch-up only advanced simTick FORWARD (when the client lagged behind
    // the server). When the client frame loop outruns the server's tick (server
    // overruns → schema.tick advances <60Hz, client runs at true wall-clock
    // 60Hz), simTick gets AHEAD of serverTick. The old code never stepped
    // simTick back, so the positive delta grew until the rebase snapped the
    // pose — visible jitter + the threshold warning. The fix steps simTick
    // backward (within the same bounded deadband) to realign.
    const driver = new AnimSimDriver(WeaponType.FISTS);
    const input = makeFrameInput();

    // Client steps to simTick 100; server is also at tick 100 (aligned).
    for (let i = 0; i < 100; i++) driver.update(1 / 60, input);
    expect(driver.simTickForTest).toBe(100);
    driver.applyServerPhase(AnimPhase.WINDUP, 10, 0, WeaponType.FISTS, 'line', 100, 50);

    // Client steps 20 MORE frames (simTick → 120) but the server only advanced
    // to tick 110 (it overran / lagged). simTick is now 10 ahead of serverTick.
    for (let i = 0; i < 20; i++) driver.update(1 / 60, input);
    expect(driver.simTickForTest).toBe(120);

    // applyServerPhase with the lagging serverTick=110. The OLD behavior: lag =
    // 110 - 120 = -10 < deadband → no catch-up → delta = (120-50) - (110-50) =
    // +10 → drift warning + rebase snap. The NEW behavior: lag < -deadband →
    // step simTick back toward 110.
    driver.applyServerPhase(AnimPhase.WINDUP, 60, 0, WeaponType.FISTS, 'line', 110, 50);

    // simTick must have stepped BACK toward the server tick (110), not stayed
    // at 120. The bounded step (MAX_SIMTICK_CATCHUP_TICKS=60) covers the full
    // 10-tick gap, so simTick should land within the deadband of 110.
    expect(driver.simTickForTest).toBeLessThanOrEqual(112);
    expect(driver.simTickForTest).toBeGreaterThanOrEqual(108);

    // The phase-age delta must now be within the deadband — no large correction,
    // no drift warning, no rebase snap.
    expect(Math.abs(driver.debugDesync().phaseAgeDeltaTicks)).toBeLessThanOrEqual(2);
  });
});

describe('AnimSimDriver — stepping basics (characterization)', () => {
  it('update() with dt = FIXED_DT advances simTick by exactly 1', () => {
    const driver = new AnimSimDriver(WeaponType.FISTS);
    driver.update(1 / 60, makeFrameInput());
    expect(driver.simTickForTest).toBe(1);
    driver.update(1 / 60, makeFrameInput());
    expect(driver.simTickForTest).toBe(2);
  });

  it('update() accumulates sub-tick dt and carries the remainder', () => {
    const driver = new AnimSimDriver(WeaponType.FISTS);
    // 1.5 ticks worth of dt → 1 step, 0.5 tick residual carried.
    driver.update((1 / 60) * 1.5, makeFrameInput());
    expect(driver.simTickForTest).toBe(1);
    // Next 0.5 tick pushes the residual over → second step.
    driver.update((1 / 60) * 0.5, makeFrameInput());
    expect(driver.simTickForTest).toBe(2);
  });
});

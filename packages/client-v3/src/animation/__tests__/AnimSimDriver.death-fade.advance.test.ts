/**
 * Diagnostic probe — does the REAL AnimSimDriver's death fade actually complete?
 *
 * The Bug 2 arms-linger probe (PlayerRendererUpdate.arms-linger.diag.test.ts)
 * used a STUB driver whose deathProgress advanced manually. That proved the
 * RENDERER hides arms when deathProgress reaches 1 — but never tested whether
 * the REAL driver reaches deathProgress=1 after triggerDeath. If the DYING
 * phase auto-transitions to IDLE before phaseProgress hits 1, deathProgress
 * (gated on phase===DYING) snaps back to 0, the DYING block stops running, and
 * the corpse's body + arms never get setVisible(false) — they linger at whatever
 * alpha the fade reached. This probe drives the real driver to find out.
 */
import { describe, it, expect } from 'vitest';
import { AnimPhase } from '@sector-battle/shared';
import { AnimSimDriver } from '../AnimSimDriver.js';
import { AnimationState } from '../../types.js';

const FRAME_INPUT = {
  facingAngle: 0,
  bodyX: 0,
  bodyY: 0,
  bodyVelX: 0,
  bodyVelY: 0,
  isMoving: false,
  weaponType: 0,
  isWorldBlocked: undefined,
} as never;

describe('REAL AnimSimDriver — death fade completion (Bug 2)', () => {
  it('triggerDeath puts the driver into DYING', () => {
    const driver = new AnimSimDriver(0);
    for (let i = 0; i < 5; i++) driver.update(1 / 60, FRAME_INPUT);
    driver.triggerDeath();
    expect(driver.phase).toBe(AnimPhase.DYING);
    expect(driver.animState).toBe(AnimationState.DYING);
  });

  it('deathProgress reaches 1.0 after enough ticks (fade completes)', () => {
    const driver = new AnimSimDriver(0);
    for (let i = 0; i < 5; i++) driver.update(1 / 60, FRAME_INPUT);
    driver.triggerDeath();
    const samples: number[] = [];
    // Step well past any reasonable DYING_TICKS duration.
    for (let i = 0; i < 90; i++) {
      driver.update(1 / 60, FRAME_INPUT);
      samples.push(driver.deathProgress);
    }
    // eslint-disable-next-line no-console
    console.log('[death-fade] deathProgress series:', samples.map((p) => p.toFixed(3)).join(' '));
    expect(driver.deathProgress).toBe(1);
  });

  it('the DYING phase is terminal (does NOT auto-transition to IDLE before t=1)', () => {
    // If the phase left DYING, deathProgress would snap to 0 (it's gated on
    // phase===DYING). So a final deathProgress of 1 also implies the phase is
    // still DYING. Assert both explicitly.
    const driver = new AnimSimDriver(0);
    for (let i = 0; i < 5; i++) driver.update(1 / 60, FRAME_INPUT);
    driver.triggerDeath();
    for (let i = 0; i < 90; i++) driver.update(1 / 60, FRAME_INPUT);
    expect(driver.phase).toBe(AnimPhase.DYING);
    expect(driver.deathProgress).toBe(1);
  });

  it('sample() returns a pose while DYING (so the renderer DYING block runs)', () => {
    const driver = new AnimSimDriver(0);
    for (let i = 0; i < 5; i++) driver.update(1 / 60, FRAME_INPUT);
    driver.triggerDeath();
    driver.update(1 / 60, FRAME_INPUT);
    const pose = driver.sample();
    expect(pose).not.toBeNull();
  });
});

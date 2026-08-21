import { describe, it, expect } from 'vitest';
import { applyAccelerationInto } from '../applyAcceleration.js';
import { PLAYER } from '../../constants/player.js';

const BASE_SPEED = PLAYER.BASE_SPEED; // 430
const ACCEL = PLAYER.ACCELERATION; // 4800
const DECEL = PLAYER.DECELERATION; // 6400

const out = { vx: 0, vy: 0 };

describe('applyAccelerationInto', () => {
  it('zero input with zero velocity → stays zero', () => {
    applyAccelerationInto(out, 0, 0, 0, 0, BASE_SPEED, ACCEL, DECEL, 1 / 60);
    expect(out.vx).toBe(0);
    expect(out.vy).toBe(0);
  });

  it('zero input with velocity → decelerates toward zero', () => {
    applyAccelerationInto(out, 200, 0, 0, 0, BASE_SPEED, ACCEL, DECEL, 1 / 60);
    expect(out.vx).toBeGreaterThan(0);
    expect(out.vx).toBeLessThan(200);
    expect(out.vy).toBe(0);
  });

  it('input with zero velocity → accelerates toward maxSpeed in input direction', () => {
    applyAccelerationInto(out, 0, 0, 1, 0, BASE_SPEED, ACCEL, DECEL, 1 / 60);
    expect(out.vx).toBeGreaterThan(0);
    expect(out.vy).toBe(0);
    // After one frame at ACCEL, should be ACCEL/60
    expect(out.vx).toBeCloseTo(ACCEL / 60, 1);
  });

  it('input at 45 degrees → velocity vector points 45 degrees, magnitude approaches maxSpeed', () => {
    applyAccelerationInto(out, 0, 0, 1, 1, BASE_SPEED, ACCEL, DECEL, 1 / 60);
    expect(out.vx).toBeGreaterThan(0);
    expect(out.vy).toBeGreaterThan(0);
    // Both components should be equal (45 degrees)
    expect(out.vx).toBeCloseTo(out.vy, 5);
  });

  it('reaching maxSpeed → clamped, does not exceed', () => {
    // Simulate many frames until velocity settles
    let vx = 0;
    let vy = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 300; i++) {
      applyAccelerationInto(out, vx, vy, 1, 0, BASE_SPEED, ACCEL, DECEL, dt);
      vx = out.vx;
      vy = out.vy;
    }
    expect(vx).toBeCloseTo(BASE_SPEED, 0);
    expect(vy).toBe(0);
    expect(Math.abs(vx)).toBeLessThanOrEqual(BASE_SPEED + 0.5);
  });

  it('direction change → velocity curves toward new direction (not instant snap)', () => {
    // Moving right at max speed, then switch to left input
    applyAccelerationInto(out, BASE_SPEED, 0, -1, 0, BASE_SPEED, ACCEL, DECEL, 1 / 60);
    // Should NOT instantly reverse — still positive but reduced
    expect(out.vx).toBeGreaterThan(0);
    expect(out.vx).toBeLessThan(BASE_SPEED);
    expect(out.vy).toBe(0);
  });

  it('small dt → small velocity change (frame-rate independent)', () => {
    const tinyDt = 1 / 1000;
    applyAccelerationInto(out, 0, 0, 1, 0, BASE_SPEED, ACCEL, DECEL, tinyDt);
    const vx1 = out.vx;
    applyAccelerationInto(out, 0, 0, 1, 0, BASE_SPEED, ACCEL, DECEL, 1 / 60);
    const vx2 = out.vx;
    // Smaller dt produces smaller velocity change
    expect(Math.abs(vx1)).toBeLessThan(Math.abs(vx2));
    expect(vx1).toBeCloseTo(ACCEL * tinyDt, 5);
  });

  it('dash values (higher maxSpeed) work correctly with same function', () => {
    const dashSpeed = BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER; // 650
    let vx = 0;
    let vy = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 300; i++) {
      applyAccelerationInto(out, vx, vy, 1, 0, dashSpeed, ACCEL, DECEL, dt);
      vx = out.vx;
      vy = out.vy;
    }
    expect(vx).toBeCloseTo(dashSpeed, 0);
    expect(vy).toBe(0);
  });
});

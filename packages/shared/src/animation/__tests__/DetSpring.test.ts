import { describe, it, expect } from 'vitest';
import {
  createSpringState,
  createSpringState1D,
  stepSpring,
  stepSpring1D,
  stepAngleSpring,
  applyImpulse,
  snapSpring,
  constrainAlongAxis,
} from '../DetSpring.js';

describe('DetSpring', () => {
  it('converges to target', () => {
    const s = createSpringState(0, 0);
    for (let i = 0; i < 120; i++) stepSpring(s, 100, 0, 30, 1.0);
    expect(s.x).toBeCloseTo(100, 0);
    expect(Math.abs(s.x - 100)).toBeLessThan(0.5);
    expect(s.y).toBeCloseTo(0, 2);
  });

  it('overshoots with underdamped', () => {
    const s = createSpringState(0, 0);
    let overshot = false;
    for (let i = 0; i < 120; i++) {
      stepSpring(s, 100, 0, 20, 0.3);
      if (s.x > 100) overshot = true;
    }
    expect(overshot).toBe(true);
  });

  it('no overshoot when critically damped', () => {
    const s = createSpringState(0, 0);
    for (let i = 0; i < 120; i++) {
      stepSpring(s, 100, 0, 30, 1.0);
      expect(s.x).toBeLessThanOrEqual(100 + 1e-10);
    }
  });

  it('snapSpring resets position and zeroes velocity', () => {
    const s = createSpringState(0, 0);
    for (let i = 0; i < 10; i++) stepSpring(s, 100, 0, 30, 1.0);
    const posBefore = s.x;
    expect(posBefore).toBeGreaterThan(10);
    snapSpring(s, 0, 0);
    expect(s.vx).toBe(0);
    stepSpring(s, 100, 0, 30, 1.0);
    expect(s.x).toBeLessThan(posBefore);
    expect(s.x).toBeGreaterThan(0);
  });

  it('applyImpulse kicks velocity', () => {
    const s = createSpringState(0, 0);
    applyImpulse(s, 50, -20);
    expect(s.vx).toBe(50);
    expect(s.vy).toBe(-20);
    stepSpring(s, 0, 0, 30, 1.0);
    expect(s.x).toBeGreaterThan(0);
    expect(s.y).toBeLessThan(0);
  });

  it('is deterministic — identical runs produce bit-identical state', () => {
    const run = () => {
      const s = createSpringState(3.7, -2.1);
      applyImpulse(s, 41.5, 13.25);
      for (let i = 0; i < 600; i++) {
        stepSpring(s, Math.sin(i * 0.1) * 60, Math.cos(i * 0.07) * 40, 180 + (i % 7), 0.65);
        if (i % 50 === 0) applyImpulse(s, -8, 5);
      }
      return s;
    };
    const a = run();
    const b = run();
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.vx).toBe(b.vx);
    expect(a.vy).toBe(b.vy);
  });

  it('survives serialization round-trip mid-run', () => {
    const s = createSpringState(0, 0);
    for (let i = 0; i < 30; i++) stepSpring(s, 100, 50, 200, 0.7);
    const restored = JSON.parse(JSON.stringify(s)) as typeof s;
    for (let i = 0; i < 30; i++) {
      stepSpring(s, 100, 50, 200, 0.7);
      stepSpring(restored, 100, 50, 200, 0.7);
    }
    expect(restored.x).toBe(s.x);
    expect(restored.y).toBe(s.y);
    expect(restored.vx).toBe(s.vx);
    expect(restored.vy).toBe(s.vy);
  });

  it('constrainAlongAxis clamps position and absorbs outward velocity', () => {
    const s = createSpringState(20, 0);
    s.vx = 100;
    const engaged = constrainAlongAxis(s, 1, 0, 10, 0, 0);
    expect(engaged).toBe(true);
    expect(s.x).toBe(10);
    expect(s.vx).toBeLessThanOrEqual(0);
    const notEngaged = constrainAlongAxis(s, 1, 0, 10, 0, 0);
    expect(notEngaged).toBe(false);
  });

  it('scalar spring converges', () => {
    const s = createSpringState1D(0);
    for (let i = 0; i < 120; i++) stepSpring1D(s, 1.5, 30, 1.0);
    expect(s.value).toBeCloseTo(1.5, 1);
  });

  it('angle spring takes the shortest path across the ±π seam', () => {
    const s = createSpringState1D(3.0); // near +π
    for (let i = 0; i < 120; i++) stepAngleSpring(s, -3.0, 30, 1.0); // near -π
    // Shortest path crosses the seam: value should END beyond +π territory
    // (≈ +3.28 ≡ −3.0), never swinging back through 0.
    expect(Math.abs(Math.atan2(Math.sin(s.value - -3.0), Math.cos(s.value - -3.0)))).toBeLessThan(
      0.05,
    );
    expect(s.value).toBeGreaterThan(3.0); // went up across the seam, not down through 0
  });
});

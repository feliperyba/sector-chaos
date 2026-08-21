import { describe, it, expect } from 'vitest';

describe('fixed timestep accumulator', () => {
  const FIXED_DT = 1 / 60;

  it('produces 2 steps for 34ms delta', () => {
    const delta = 34; // ms — exceeds 2 × FIXED_DT (≈33.33ms)
    let accumulator = 0;
    let steps = 0;
    accumulator += delta / 1000;
    while (accumulator >= FIXED_DT) {
      steps++;
      accumulator -= FIXED_DT;
    }
    expect(steps).toBe(2);
    expect(accumulator).toBeLessThan(FIXED_DT);
  });

  it('caps at 2 ticks worth for large delta', () => {
    const delta = 100; // ms — way too much
    let accumulator = 0;
    accumulator += delta / 1000;
    const cap = FIXED_DT * 2;
    if (accumulator > cap) accumulator = cap;
    let steps = 0;
    while (accumulator >= FIXED_DT) {
      steps++;
      accumulator -= FIXED_DT;
    }
    expect(steps).toBe(2);
  });

  it('produces 1 step for 17ms delta', () => {
    const delta = 17; // ms — exceeds FIXED_DT (≈16.67ms)
    let accumulator = 0;
    let steps = 0;
    accumulator += delta / 1000;
    while (accumulator >= FIXED_DT) {
      steps++;
      accumulator -= FIXED_DT;
    }
    expect(steps).toBe(1);
  });

  it('accumulates leftover time', () => {
    let accumulator = 0;
    // Frame 1: 17ms
    accumulator += 17 / 1000;
    let steps = 0;
    while (accumulator >= FIXED_DT) {
      steps++;
      accumulator -= FIXED_DT;
    }
    expect(steps).toBe(1);
    expect(accumulator).toBeGreaterThan(0); // leftover ~0.33ms
    // Frame 2: 17ms again
    accumulator += 17 / 1000;
    steps = 0;
    while (accumulator >= FIXED_DT) {
      steps++;
      accumulator -= FIXED_DT;
    }
    // Leftover + 17ms should still be 1 step (not 2)
    expect(steps).toBe(1);
  });
});

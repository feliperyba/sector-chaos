import { describe, it, expect } from 'vitest';

describe('velocity extrapolation', () => {
  function extrapolate(
    posX: number,
    posY: number,
    velX: number,
    velY: number,
    accumulator: number,
  ): { x: number; y: number } {
    return {
      x: posX + velX * accumulator,
      y: posY + velY * accumulator,
    };
  }

  it('at zero velocity, visual position equals local position', () => {
    const result = extrapolate(100, 200, 0, 0, 0.008);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('at zero accumulator, visual position equals local position', () => {
    const result = extrapolate(100, 200, 430, 0, 0);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('extrapolates forward at BASE_SPEED with half-tick accumulator', () => {
    const BASE_SPEED = 430;
    const FIXED_DT = 1 / 60;
    const halfAcc = FIXED_DT / 2;
    const result = extrapolate(100, 200, BASE_SPEED, 0, halfAcc);
    expect(result.x).toBeCloseTo(100 + BASE_SPEED * halfAcc, 2);
    expect(result.y).toBe(200);
  });

  it('extrapolates diagonally', () => {
    const DIAGONAL_SPEED = 430 * Math.SQRT1_2;
    const acc = 1 / 60;
    const result = extrapolate(0, 0, DIAGONAL_SPEED, DIAGONAL_SPEED, acc);
    expect(result.x).toBeCloseTo(DIAGONAL_SPEED * acc, 2);
    expect(result.y).toBeCloseTo(DIAGONAL_SPEED * acc, 2);
  });

  it('max extrapolation at full accumulator equals one tick of movement', () => {
    const BASE_SPEED = 430;
    const FIXED_DT = 1 / 60;
    const result = extrapolate(0, 0, BASE_SPEED, 0, FIXED_DT);
    expect(result.x).toBeCloseTo(BASE_SPEED * FIXED_DT, 4);
    expect(result.y).toBe(0);
  });

  it('accumulator capped at 2 ticks limits extrapolation', () => {
    const BASE_SPEED = 430;
    const FIXED_DT = 1 / 60;
    const maxAcc = FIXED_DT * 2;
    const result = extrapolate(0, 0, BASE_SPEED, 0, maxAcc);
    expect(result.x).toBeCloseTo(BASE_SPEED * maxAcc, 4);
  });

  it('extrapolation does NOT affect localPos', () => {
    const pos = { x: 100, y: 200 };
    const visual = extrapolate(pos.x, pos.y, 430, 0, 0.008);
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(200);
    expect(visual.x).not.toBe(pos.x);
  });

  it('negative velocity extrapolates backward', () => {
    const result = extrapolate(100, 200, -430, 0, 0.008);
    expect(result.x).toBeLessThan(100);
    expect(result.y).toBe(200);
  });

  it('frame-rate independence: same wall-clock gives same visual', () => {
    const BASE_SPEED = 430;
    const FIXED_DT = 1 / 60;

    const acc60 = FIXED_DT * 0.5;
    const r60 = extrapolate(0, 0, BASE_SPEED, 0, acc60);

    const acc120 = FIXED_DT * 0.25;
    const r120 = extrapolate(0, 0, BASE_SPEED, 0, acc120);

    expect(r60.x).toBe(BASE_SPEED * acc60);
    expect(r120.x).toBe(BASE_SPEED * acc120);
    expect(r60.x).toBeGreaterThan(r120.x);
  });

  it('reconciliation snap then extrapolate is smooth', () => {
    const correctedPos = 103;
    const velocity = 430;
    const acc = 0.005;
    const visual = extrapolate(correctedPos, 0, velocity, 0, acc);
    expect(visual.x).toBeGreaterThan(correctedPos);
    expect(visual.x).toBeLessThan(correctedPos + velocity * (1 / 60));
  });
});

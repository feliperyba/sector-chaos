import { describe, it, expect } from 'vitest';
import { normalizeAngle, shortestAngleDelta, absAngleDelta } from '../ArcCalculation.js';

describe('normalizeAngle', () => {
  it('normalizes positive angle to [-π, π]', () => {
    // ±π are the same angle; modular arithmetic maps odd multiples to +π.
    expect(Math.abs(normalizeAngle(3 * Math.PI))).toBeCloseTo(Math.PI);
  });

  it('normalizes negative angle to [-π, π]', () => {
    expect(Math.abs(normalizeAngle(-3 * Math.PI))).toBeCloseTo(Math.PI);
  });

  it('normalizes full rotation (2π) to ~0', () => {
    expect(normalizeAngle(2 * Math.PI)).toBeCloseTo(0);
  });

  it('leaves already-normalized angle unchanged', () => {
    expect(normalizeAngle(0.5)).toBeCloseTo(0.5);
  });
});

describe('shortestAngleDelta', () => {
  it('returns positive delta for clockwise', () => {
    expect(shortestAngleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });

  it('returns negative delta for counter-clockwise', () => {
    expect(shortestAngleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });

  it('returns zero for same angle', () => {
    expect(shortestAngleDelta(1.5, 1.5)).toBeCloseTo(0);
  });

  it('returns shortest path across -π/π boundary', () => {
    expect(shortestAngleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });
});

describe('absAngleDelta', () => {
  it('returns 0 for identical angles', () => {
    expect(absAngleDelta(1.5, 1.5)).toBeCloseTo(0);
    expect(absAngleDelta(-2, -2)).toBeCloseTo(0);
  });

  it('returns the absolute quarter-turn regardless of direction', () => {
    expect(absAngleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(absAngleDelta(0, -Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });

  it('wraps at the ±π boundary: half-turn is PI from either side', () => {
    // +PI and -PI are the same angle; both are exactly PI away from 0.
    expect(absAngleDelta(0, Math.PI)).toBeCloseTo(Math.PI);
    expect(absAngleDelta(0, -Math.PI)).toBeCloseTo(Math.PI);
  });

  it('takes the short way across the wrap point', () => {
    // PI-0.1 vs -PI+0.1 are 0.2 apart, NOT 2PI-0.2.
    expect(absAngleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
    expect(absAngleDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(0.2);
  });

  it('folds full rotations into the same delta', () => {
    expect(absAngleDelta(0, 2 * Math.PI + 0.5)).toBeCloseTo(0.5);
    expect(absAngleDelta(0, -4 * Math.PI - 0.5)).toBeCloseTo(0.5);
    expect(absAngleDelta(2 * Math.PI, 0)).toBeCloseTo(0);
  });

  it('is symmetric in its arguments', () => {
    for (const [a, b] of [
      [0.3, 1.9],
      [-2.8, 2.8],
      [Math.PI, 0],
    ] as const) {
      expect(absAngleDelta(a, b)).toBeCloseTo(absAngleDelta(b, a));
    }
  });

  it('is always within [0, PI]', () => {
    const step = Math.PI / 9;
    for (let i = -18; i <= 18; i++) {
      for (let j = -18; j <= 18; j++) {
        const d = absAngleDelta(i * step, j * step);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.PI);
      }
    }
  });

  it('degrades non-finite input to 0 via normalizeAngle (no NaN)', () => {
    expect(absAngleDelta(NaN, 1)).toBe(0);
    expect(absAngleDelta(1, Infinity)).toBe(0);
  });
});

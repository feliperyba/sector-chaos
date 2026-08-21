import { normalizeAngle, shortestAngleDelta } from '../../src/math/ArcCalculation.js';

describe('normalizeAngle', () => {
  it('leaves angles already in [-π,π] unchanged', () => {
    expect(normalizeAngle(0)).toBeCloseTo(0);
    // ±π are the same angle; modular arithmetic normalizes to +π.
    expect(Math.abs(normalizeAngle(Math.PI))).toBeCloseTo(Math.PI);
    expect(Math.abs(normalizeAngle(-Math.PI))).toBeCloseTo(Math.PI);
    expect(normalizeAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });

  it('wraps 3π to ≈π', () => {
    expect(Math.abs(normalizeAngle(3 * Math.PI))).toBeCloseTo(Math.PI);
  });

  it('wraps -3π to ≈-π', () => {
    expect(Math.abs(normalizeAngle(-3 * Math.PI))).toBeCloseTo(Math.PI);
  });

  it('wraps 2π to 0', () => {
    expect(normalizeAngle(2 * Math.PI)).toBeCloseTo(0);
  });
});

describe('shortestAngleDelta', () => {
  it('returns 0 for same angle', () => {
    expect(shortestAngleDelta(1.5, 1.5)).toBeCloseTo(0);
  });

  it('returns π/2 for π/2 difference', () => {
    expect(shortestAngleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
  });

  it('returns -π/2 for -π/2 difference', () => {
    expect(shortestAngleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });

  it('wraps around (from π to -π is small)', () => {
    expect(Math.abs(shortestAngleDelta(Math.PI * 0.99, -Math.PI * 0.99))).toBeCloseTo(
      0.02 * Math.PI,
      1,
    );
  });

  it('returns negative delta for counter-clockwise', () => {
    expect(shortestAngleDelta(Math.PI / 4, 0)).toBeCloseTo(-Math.PI / 4);
  });
});

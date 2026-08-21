import { Interpolation } from '../../src/math/Interpolation.js';

describe('Interpolation.lerp', () => {
  it('returns start at t=0 and end at t=1', () => {
    expect(Interpolation.lerp(0, 100, 0)).toBeCloseTo(0);
    expect(Interpolation.lerp(0, 100, 0.5)).toBeCloseTo(50);
    expect(Interpolation.lerp(0, 100, 1)).toBeCloseTo(100);
  });

  it('handles negative range', () => {
    expect(Interpolation.lerp(-10, 10, 0.5)).toBeCloseTo(0);
  });
});

describe('Interpolation.clamp', () => {
  it('clamps value within range', () => {
    expect(Interpolation.clamp(5, 0, 10)).toBe(5);
    expect(Interpolation.clamp(-5, 0, 10)).toBe(0);
    expect(Interpolation.clamp(15, 0, 10)).toBe(10);
  });
});

describe('Interpolation.distance', () => {
  it('returns distance between two points', () => {
    expect(Interpolation.distance(0, 0, 3, 4)).toBeCloseTo(5);
  });
});

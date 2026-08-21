import { describe, it, expect } from 'vitest';
import { angleTo, distance, distanceSq, normalizeInto } from '../geometry.js';
import { shortestAngleDelta, absAngleDelta } from '../ArcCalculation.js';

describe('angleTo', () => {
  it('returns 0 for +X axis (east)', () => {
    expect(angleTo(0, 0, 100, 0)).toBeCloseTo(0);
  });

  it('returns +PI/2 for +Y axis (south — screen convention, +Y is down)', () => {
    expect(angleTo(0, 0, 0, 100)).toBeCloseTo(Math.PI / 2);
  });

  it('returns +PI for -X axis (west)', () => {
    expect(angleTo(0, 0, -100, 0)).toBeCloseTo(Math.PI);
  });

  it('returns -PI/2 for -Y axis (north)', () => {
    expect(angleTo(0, 0, 0, -100)).toBeCloseTo(-Math.PI / 2);
  });

  it('covers all four quadrants via diagonals', () => {
    // Q1 (+x,+y): atan2(1,1) = +PI/4
    expect(angleTo(0, 0, 1, 1)).toBeCloseTo(Math.PI / 4);
    // Q2 (-x,+y): atan2(1,-1) = +3PI/4
    expect(angleTo(0, 0, -1, 1)).toBeCloseTo((3 * Math.PI) / 4);
    // Q3 (-x,-y): atan2(-1,-1) = -3PI/4
    expect(angleTo(0, 0, -1, -1)).toBeCloseTo((-3 * Math.PI) / 4);
    // Q4 (+x,-y): atan2(-1,1) = -PI/4
    expect(angleTo(0, 0, 1, -1)).toBeCloseTo(-Math.PI / 4);
  });

  it('is direction-aware: reversed endpoints are PI apart', () => {
    const forward = angleTo(10, 10, 30, 40);
    const backward = angleTo(30, 40, 10, 10);
    expect(Math.abs(forward - backward)).toBeCloseTo(Math.PI);
  });

  it('is translation-invariant (same offset applied to both points)', () => {
    expect(angleTo(1000, -2000, 1010, -2000)).toBeCloseTo(angleTo(0, 0, 10, 0));
  });

  it('returns 0 for coincident points (atan2(0,0) === 0 per spec)', () => {
    expect(angleTo(5, 5, 5, 5)).toBe(0);
  });

  it('matches the raw atan2 formula used at every duplicated call site', () => {
    // Characterization: BotInput.ts / GameScene.ts / InputOrchestrator.ts all
    // inline Math.atan2(dy, dx) of the delta.
    const fromX = 123.5;
    const fromY = -67.25;
    const toX = -40.75;
    const toY = 310.125;
    expect(angleTo(fromX, fromY, toX, toY)).toBe(Math.atan2(toY - fromY, toX - fromX));
  });
});

describe('distance', () => {
  it('returns 0 for zero distance (same point)', () => {
    expect(distance(5, 5, 5, 5)).toBe(0);
  });

  it('axis-aligned: pure horizontal', () => {
    expect(distance(0, 0, 3, 0)).toBeCloseTo(3);
    expect(distance(-3, 0, 0, 0)).toBeCloseTo(3);
  });

  it('axis-aligned: pure vertical', () => {
    expect(distance(0, 0, 0, 4)).toBeCloseTo(4);
    expect(distance(0, 4, 0, 0)).toBeCloseTo(4);
  });

  it('all four quadrants via 3-4-5 right triangles', () => {
    expect(distance(0, 0, 3, 4)).toBeCloseTo(5);
    expect(distance(0, 0, -3, 4)).toBeCloseTo(5);
    expect(distance(0, 0, -3, -4)).toBeCloseTo(5);
    expect(distance(0, 0, 3, -4)).toBeCloseTo(5);
  });

  it('is symmetric', () => {
    expect(distance(1, 2, -30, 44)).toBe(distance(-30, 44, 1, 2));
  });

  it('matches the bot-AI sqrt(dx^2+dy^2) formula', () => {
    // Characterization: BotInput.ts distance = Math.sqrt((bx-ax)**2 + (by-ay)**2).
    const ax = 12.5;
    const ay = -340.75;
    const bx = 999.25;
    const by = 0.5;
    expect(distance(ax, ay, bx, by)).toBe(Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2));
  });
});

describe('distanceSq', () => {
  it('returns 0 for zero distance', () => {
    expect(distanceSq(7, -2, 7, -2)).toBe(0);
  });

  it('axis-aligned cases', () => {
    expect(distanceSq(0, 0, 3, 0)).toBeCloseTo(9);
    expect(distanceSq(0, 0, 0, -4)).toBeCloseTo(16);
  });

  it('is exactly the sum of squared deltas (no sqrt)', () => {
    expect(distanceSq(1, 1, 4, 5)).toBe(3 * 3 + 4 * 4);
  });

  it('equals distance^2 across quadrants', () => {
    for (const [bx, by] of [
      [3, 4],
      [-3, 4],
      [-3, -4],
      [3, -4],
      [0, 0],
    ] as const) {
      expect(distanceSq(0, 0, bx, by)).toBeCloseTo(distance(0, 0, bx, by) ** 2);
    }
  });

  it('supports squared-threshold comparison (radius 64)', () => {
    // Usage pattern for comparison-only hot paths: compare squares, skip sqrt.
    const r = 64;
    const rSq = r * r;
    expect(distanceSq(0, 0, 63.9, 0) < rSq).toBe(true);
    expect(distanceSq(0, 0, 64.1, 0) < rSq).toBe(false);
  });
});

describe('normalizeInto', () => {
  const scratch = { x: -999, y: -999 };

  it('writes unit vectors for the four axis directions', () => {
    normalizeInto(scratch, 5, 0);
    expect(scratch.x).toBeCloseTo(1);
    expect(scratch.y).toBeCloseTo(0);

    normalizeInto(scratch, 0, -2.5);
    expect(scratch.x).toBeCloseTo(0);
    expect(scratch.y).toBeCloseTo(-1);
  });

  it('writes the unit vector for diagonals (all quadrants)', () => {
    const invSqrt2 = 1 / Math.SQRT2;
    normalizeInto(scratch, 3, 3);
    expect(scratch.x).toBeCloseTo(invSqrt2);
    expect(scratch.y).toBeCloseTo(invSqrt2);

    normalizeInto(scratch, -3, 3);
    expect(scratch.x).toBeCloseTo(-invSqrt2);
    expect(scratch.y).toBeCloseTo(invSqrt2);

    normalizeInto(scratch, -3, -3);
    expect(scratch.x).toBeCloseTo(-invSqrt2);
    expect(scratch.y).toBeCloseTo(-invSqrt2);

    normalizeInto(scratch, 3, -3);
    expect(scratch.x).toBeCloseTo(invSqrt2);
    expect(scratch.y).toBeCloseTo(-invSqrt2);
  });

  it('is scale-invariant for any positive length', () => {
    for (const s of [1e-6, 0.5, 1, 430, 1e6]) {
      normalizeInto(scratch, 430 * s, 0);
      expect(scratch.x).toBeCloseTo(1);
      expect(scratch.y).toBeCloseTo(0);
    }
  });

  it('result always has unit length (or exactly zero)', () => {
    for (const [x, y] of [
      [1, 0],
      [0, 1],
      [3, 4],
      [-7, 13],
      [1e-8, -1e-8],
    ] as const) {
      normalizeInto(scratch, x, y);
      expect(Math.hypot(scratch.x, scratch.y)).toBeCloseTo(1);
    }
  });

  it('zero-length input writes (0,0) — never NaN (documented behavior)', () => {
    normalizeInto(scratch, 0, 0);
    expect(scratch.x).toBe(0);
    expect(scratch.y).toBe(0);
    expect(Number.isNaN(scratch.x)).toBe(false);
    expect(Number.isNaN(scratch.y)).toBe(false);
  });

  it('non-finite input also writes (0,0), not NaN (guard requires finite len)', () => {
    normalizeInto(scratch, NaN, 1);
    expect(scratch.x).toBe(0);
    expect(scratch.y).toBe(0);

    // Infinity component: len = Infinity, and Infinity/Infinity would be NaN
    // — the guard must reject it, hence the explicit isFinite check.
    normalizeInto(scratch, 1, Infinity);
    expect(scratch.x).toBe(0);
    expect(scratch.y).toBe(0);

    normalizeInto(scratch, -Infinity, 3);
    expect(scratch.x).toBe(0);
    expect(scratch.y).toBe(0);
  });

  it('mutates the caller-owned scratch in place (no allocation, returns void)', () => {
    const mine = { x: 42, y: -42 };
    const result = normalizeInto(mine, 0, 8);
    expect(result).toBeUndefined();
    expect(mine.x).toBeCloseTo(0);
    expect(mine.y).toBeCloseTo(1);
  });

  it('matches the prediction-path convention (len > 0 ? dir/len : 0)', () => {
    // Characterization: PredictionService/Reconciler inline
    //   len = sqrt(dx*dx + dy*dy); inputX = len > 0 ? dx/len : 0
    const dirX = 0.6;
    const dirY = -0.8;
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    normalizeInto(scratch, dirX, dirY);
    expect(scratch.x).toBe(dirX / len);
    expect(scratch.y).toBe(dirY / len);
  });
});

describe('absAngleDelta (companion relationship)', () => {
  it('equals |shortestAngleDelta| for a dense sweep of finite angles', () => {
    // Characterization: ties absAngleDelta to its signed companion across
    // quadrants and many full wraps of the circle.
    const step = Math.PI / 7;
    for (let i = -14; i <= 14; i++) {
      for (let j = -14; j <= 14; j++) {
        const from = i * step;
        const to = j * step;
        expect(absAngleDelta(from, to)).toBe(Math.abs(shortestAngleDelta(from, to)));
      }
    }
  });
});

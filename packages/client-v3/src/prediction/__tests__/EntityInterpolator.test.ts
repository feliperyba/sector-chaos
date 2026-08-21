import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EntityInterpolator } from '../EntityInterpolator.js';

describe('EntityInterpolator', () => {
  let interp: EntityInterpolator;
  let now: number;
  let out: { x: number; y: number };

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    interp = new EntityInterpolator();
    out = { x: 0, y: 0 };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extrapolation path (velocity provided)', () => {
    it('extrapolates from newest snapshot with velocity', () => {
      interp.push('proj', 0, 0, 1400, 0);
      now = 50;
      const ok = interp.getInterpolatedPosition('proj', out);
      expect(ok).toBe(true);
      // After the FIRST snapshot there is no prior render position to blend
      // from, so the output equals the raw extrapolation target.
      expect(out.x).toBeCloseTo(70, 5);
      expect(out.y).toBeCloseTo(0, 5);
    });

    it('continues extrapolating up to the 300ms cap (no premature freeze)', () => {
      // The old 100ms cap froze projectiles mid-flight whenever a patch was
      // >100ms late (common under server overrun at 30Hz patches). The raised
      // 300ms cap lets the next patch arrive instead of stalling the throw.
      interp.push('proj', 0, 0, 1400, 0);
      now = 200; // 200ms elapsed — under the new 300ms cap
      const ok = interp.getInterpolatedPosition('proj', out);
      expect(ok).toBe(true);
      expect(out.x).toBeCloseTo(280, 0); // 1400 * 0.2 = 280
      expect(out.y).toBeCloseTo(0, 5);
    });

    it('freezes position at 300ms extrapolation cap', () => {
      interp.push('proj', 0, 0, 1400, 0);
      now = 500; // 500ms elapsed — well past the 300ms cap
      const ok = interp.getInterpolatedPosition('proj', out);
      expect(ok).toBe(true);
      expect(out.x).toBeCloseTo(420, 5); // 1400 * 0.3 = 420 (capped)
      expect(out.y).toBeCloseTo(0, 5);
    });

    it('SMOOTHS between patches instead of snapping to the new extrapolation line', () => {
      // The bug: every patch jumped discontinuously from the old extrapolation
      // line (oldVel * elapsed) to the new one (newVel * elapsed). With even
      // slightly different velocities the projectile visibly jittered each
      // patch. The fix blends the output toward the target over a short
      // time-constant so a velocity change glides instead of snapping.
      //
      // Setup: patch 1 at t=0 puts the projectile at x=0 moving +x at 1400.
      // We render once at t=50ms to establish the prior render position (x=70).
      // Then patch 2 at t=67 arrives with a velocity change to 2000 (server
      // corrected the arc). Without smoothing the next render would JUMP to
      // 93.8 + 2000*0.013 = ~120. With smoothing it glides from 70 toward 120.
      interp.push('proj', 0, 0, 1400, 0);
      now = 50;
      interp.getInterpolatedPosition('proj', out); // establish prior render at ~70
      expect(out.x).toBeCloseTo(70, 5);

      now = 67;
      interp.push('proj', 93.8, 0, 2000, 0); // new patch: velocity changed
      now = 80; // 13ms after patch 2
      const ok = interp.getInterpolatedPosition('proj', out);
      expect(ok).toBe(true);
      // Raw target would be 93.8 + 2000*0.013 = 119.8 (a 49.8px jump from 70).
      // Smoothed output must be STRICTLY LESS than the raw target — proving
      // the blend is active and the discontinuous jump is gone.
      const rawTarget = 93.8 + 2000 * 0.013;
      expect(out.x).toBeLessThan(rawTarget - 1); // meaningfully below the snap
      expect(out.x).toBeGreaterThan(70); // but still advancing forward
    });

    it('works with single snapshot (no 2-snapshot requirement)', () => {
      interp.push('proj', 100, 200, 500, -300);
      now = 40;
      const ok = interp.getInterpolatedPosition('proj', out);
      expect(ok).toBe(true);
      expect(out.x).toBeCloseTo(100 + 500 * 0.04, 5);
      expect(out.y).toBeCloseTo(200 + -300 * 0.04, 5);
    });

    it('uses latest velocity after direction change (boomerang) — smoothed', () => {
      // Same setup as the smoothing test: the boomerang's velocity flips
      // sign on patch 2. The output must move BACK toward the target (using
      // the new -1400 velocity) but NOT instantly snap to the new line.
      interp.push('boom', 0, 0, 1400, 0);
      now = 50;
      interp.getInterpolatedPosition('boom', out); // prior render at ~70
      expect(out.x).toBeCloseTo(70, 5);

      now = 70; // 20ms after patch 1's render
      interp.push('boom', 70, 0, -1400, 0); // patch 2: velocity flipped
      const ok = interp.getInterpolatedPosition('boom', out);
      expect(ok).toBe(true);
      // Target at t=70 with new vel: 70 + (-1400)*0 = 70 (elapsed since patch2 = 0)
      // Output blended from prior render (70) toward target (70) ≈ 70.
      expect(out.x).toBeCloseTo(70, 1);
    });

    it('returns false after removeEntity + update', () => {
      interp.push('proj', 0, 0, 1400, 0);
      interp.removeEntity('proj');
      interp.update();
      expect(interp.getInterpolatedPosition('proj', out)).toBe(false);
    });

    it('ignores snap threshold for velocity entities', () => {
      interp.push('proj', 0, 0, 1400, 0);
      now = 67;
      const ok = interp.getInterpolatedPosition('proj', out);
      expect(ok).toBe(true);
      expect(out.x).toBeCloseTo(93.8, 1);
    });
  });

  describe('interpolation path (no velocity)', () => {
    it('returns newest snapshot position with single snapshot', () => {
      interp.push('player', 100, 200);
      const ok = interp.getInterpolatedPosition('player', out);
      expect(ok).toBe(true);
      expect(out).toEqual({ x: 100, y: 200 });
    });

    it('snaps when interpolated position exceeds threshold', () => {
      now = 0;
      interp.push('player', 0, 0);
      now = 100;
      interp.push('player', 100, 0);
      now = 167;
      const ok = interp.getInterpolatedPosition('player', out);
      expect(ok).toBe(true);
      expect(out.x).toBe(100);
    });
  });

  describe('mixed entities', () => {
    it('uses extrapolation for velocity entities and interpolation for others', () => {
      interp.push('player', 0, 0);
      interp.push('proj', 0, 0, 1400, 0);
      now = 50;
      const playerOk = interp.getInterpolatedPosition('player', out);
      expect(playerOk).toBe(true);
      expect(out).toEqual({ x: 0, y: 0 });
      const projOk = interp.getInterpolatedPosition('proj', out);
      expect(projOk).toBe(true);
      expect(out.x).toBeCloseTo(70, 5);
      expect(out.y).toBeCloseTo(0, 5);
    });
  });

  describe('has()', () => {
    it('returns true for pushed entity', () => {
      interp.push('a', 0, 0, 1, 0);
      expect(interp.has('a')).toBe(true);
    });

    it('returns false for unknown entity', () => {
      expect(interp.has('unknown')).toBe(false);
    });

    it('returns false after remove + update', () => {
      interp.push('a', 0, 0);
      interp.removeEntity('a');
      interp.update();
      expect(interp.has('a')).toBe(false);
    });
  });
});

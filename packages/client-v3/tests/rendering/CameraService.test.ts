import { describe, it, expect } from 'vitest';
import {
  cameraLerpFactor,
  FOLLOW_RATE,
  DEADZONE_RATIO,
} from '../../src/rendering/CameraService.js';

/**
 * C4a regression: the camera follow lerp is dt-normalized so the perceived
 * smoothing speed is refresh-rate-independent. The previous code used a fixed
 * Phaser lerp of 0.1/frame, which glides ~2x faster at 120/144Hz and ~2x
 * slower at 30Hz. cameraLerpFactor(dt, rate) = 1 - exp(-rate * dt) replaces it.
 *
 * Contract: 60fps feel UNCHANGED, but consistent across refresh rates.
 *
 * NOTE: this file intentionally does NOT import the CameraService class (which
 * pulls in Phaser). It tests only the pure exported helper, so it runs without
 * the Phaser jsdom mock.
 */
describe('C4a — cameraLerpFactor (dt-normalized follow lerp)', () => {
  describe('60fps equivalence (feel preservation)', () => {
    it('returns ~0.1 at dt=16.67ms (60fps), matching the old hardcoded FOLLOW_LERP=0.1', () => {
      // 1 - exp(-6.0 * 0.01667) = 0.0952... — within epsilon of 0.1
      const factor = cameraLerpFactor(16.67 / 1000, FOLLOW_RATE);
      expect(factor).toBeCloseTo(0.1, 1); // 0.0952 rounds to 0.1 at 1dp
      // Tighter bound documented in the spec comment:
      expect(factor).toBeGreaterThan(0.09);
      expect(factor).toBeLessThan(0.1);
    });

    it('FOLLOW_RATE is pinned to 6.0 (a careless tweak would silently break 60fps equivalence)', () => {
      expect(FOLLOW_RATE).toBe(6.0);
    });
  });

  describe('refresh-rate scaling (the actual fix)', () => {
    it('120fps: factor ≈ 0.0488 (~half of 60fps — correct, dt-normalized)', () => {
      // Half the dt → ~half the factor for small values. Spec target: 0.0488.
      const factor = cameraLerpFactor(8.33 / 1000, FOLLOW_RATE);
      expect(factor).toBeCloseTo(0.0488, 2);
    });

    it('30fps: factor ≈ 0.181 (more catch-up per frame than 60fps — correct, dt-normalized)', () => {
      // NOTE: the spec ticket text listed 0.165 here, but that value is
      // mathematically inconsistent with rate=6.0 at dt=1/30s. The correct
      // value is 1 - exp(-6.0 * 0.0333) = 0.181. (0.165 would require rate≈5.4,
      // which would also break the load-bearing 60fps contract — at rate=5.4
      // the 60fps factor is 0.086, not ~0.1.) The 60fps (0.0952) and 120fps
      // (0.0488) numbers in the spec are exact at rate=6.0; only the 30fps
      // number was a minor arithmetic slip. Asserting the correct math here.
      const factor = cameraLerpFactor(33.3 / 1000, FOLLOW_RATE);
      expect(factor).toBeCloseTo(0.181, 2);
    });

    it('144fps: factor scales down proportionally (no longer glides too fast)', () => {
      // 144Hz: dt = 6.944ms. 1 - exp(-6.0 * 0.006944) = 0.0404...
      const factor = cameraLerpFactor(1000 / 144 / 1000, FOLLOW_RATE);
      expect(factor).toBeGreaterThan(0.039);
      expect(factor).toBeLessThan(0.042);
      // And it's smaller than the 120fps factor (monotonic in dt):
      expect(factor).toBeLessThan(cameraLerpFactor(8.33 / 1000, FOLLOW_RATE));
    });

    it('is monotonic in dt (longer frame → larger factor, no inversions)', () => {
      const f30 = cameraLerpFactor(33.3 / 1000, FOLLOW_RATE);
      const f60 = cameraLerpFactor(16.67 / 1000, FOLLOW_RATE);
      const f120 = cameraLerpFactor(8.33 / 1000, FOLLOW_RATE);
      expect(f120).toBeLessThan(f60);
      expect(f60).toBeLessThan(f30);
    });
  });

  describe('refresh-rate-independence of perceived smoothing speed (the point of the fix)', () => {
    /**
     * The whole point of dt-normalization: over a fixed wall-clock duration,
     * the SAME fraction of remaining error is absorbed regardless of fps. With
     * the old fixed 0.1/frame, 120Hz absorbed ~2x the error per second → faster
     * glide at high refresh. The exponential form makes per-second absorption
     * rate == FOLLOW_RATE at any fps.
     */
    it('absorbs the same fraction of error per wall-clock second at 60/120/30fps', () => {
      // Simulate 1 second of follow at each refresh rate, applying the per-frame
      // factor. Remaining error after N frames: (1-factor)^N. Compare the
      // absorbed fraction (1 - remaining).
      const absorbOverSecond = (fps: number): number => {
        const dt = 1 / fps;
        const factor = cameraLerpFactor(dt, FOLLOW_RATE);
        let remaining = 1;
        const frames = Math.round(fps);
        for (let i = 0; i < frames; i++) remaining *= 1 - factor;
        return 1 - remaining;
      };
      const a60 = absorbOverSecond(60);
      const a120 = absorbOverSecond(120);
      const a30 = absorbOverSecond(30);
      // All three should be ~1 - exp(-6.0) ≈ 0.9975 (within floating tolerance
      // for the discrete frame approximation). The KEY assertion: they're equal
      // to each other to 2dp — same perceived speed.
      expect(a60).toBeCloseTo(a120, 2);
      expect(a60).toBeCloseTo(a30, 2);
      expect(a60).toBeGreaterThan(0.99);
    });
  });

  describe('edge cases', () => {
    it('zero dt → zero factor (no movement on a paused frame)', () => {
      expect(cameraLerpFactor(0, FOLLOW_RATE)).toBe(0);
    });

    it('large dt → factor asymptotically approaches 1 (never overshoots)', () => {
      // Even a clamped 50ms frame (the MAX_DELTA_MS clamp) stays under 1.
      const factor = cameraLerpFactor(50 / 1000, FOLLOW_RATE);
      expect(factor).toBeGreaterThan(0.2);
      expect(factor).toBeLessThan(1);
    });
  });
});

describe('C4a — tightened deadzone', () => {
  it('DEADZONE_RATIO is within the tightened range (≤ 0.15)', () => {
    // Spec: tightened from 0.25 → 0.10–0.15. 0.12 sits in that band.
    expect(DEADZONE_RATIO).toBeLessThanOrEqual(0.15);
    expect(DEADZONE_RATIO).toBeGreaterThanOrEqual(0.1);
  });
});

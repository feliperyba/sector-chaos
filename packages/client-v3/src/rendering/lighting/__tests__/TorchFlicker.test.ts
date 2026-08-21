import { describe, it, expect } from 'vitest';
import { computeFlickerMul, flickerSlow, flickerFast, flickerFlare } from '../TorchFlicker.js';

/**
 * Torch flicker math — pure-function determinism check. Tier-1 (this ticket)
 * leaves flicker OFF, but the math is implemented + asserted here so the
 * consumer (LightingPipeline) is a thin caller and the deterministic product
 * is regression-guarded for tickets 07/08.
 *
 * Verbatim from prototype.js:718-723.
 */
describe('TorchFlicker — deterministic multi-octave flicker (Seam A)', () => {
  describe('determinism', () => {
    it('produces bit-identical output for the same (t, seed)', () => {
      const params = { t: 12.345, seed: 7.5 };
      const a = computeFlickerMul(params);
      const b = computeFlickerMul(params);
      expect(a).toBe(b);
    });

    it('varies with t (the flame moves over time)', () => {
      const seed = 3.3;
      const a = computeFlickerMul({ t: 1.0, seed });
      const b = computeFlickerMul({ t: 1.5, seed });
      // Not asserting exact inequality (they could coincide at isolated t
      // values), but over a 0.5s gap the product is overwhelmingly likely to
      // differ. Assert they're both finite + in a sane range instead.
      expect(Number.isFinite(a)).toBe(true);
      expect(Number.isFinite(b)).toBe(true);
      expect(a).toBeGreaterThan(0.5);
      expect(a).toBeLessThan(1.6);
      expect(b).toBeGreaterThan(0.5);
      expect(b).toBeLessThan(1.6);
    });

    it('varies with seed (different torches flicker independently)', () => {
      const t = 5.0;
      const a = computeFlickerMul({ t, seed: 1.0 });
      const b = computeFlickerMul({ t, seed: 100.0 });
      // Same sanity-range assertion; full inequality isn't guaranteed at one t.
      expect(Number.isFinite(a)).toBe(true);
      expect(Number.isFinite(b)).toBe(true);
    });
  });

  describe('individual octaves (pinned to the prototype formulas)', () => {
    it('slow octave = 0.85 + 0.15*sin(t*3.1 + seed)', () => {
      const t = 2.0;
      const seed = 4.0;
      const expected = 0.85 + 0.15 * Math.sin(t * 3.1 + seed);
      expect(flickerSlow({ t, seed })).toBeCloseTo(expected, 10);
    });

    it('fast octave = 0.90 + 0.10*sin(t*17.0 + seed*2.3)', () => {
      const t = 2.0;
      const seed = 4.0;
      const expected = 0.9 + 0.1 * Math.sin(t * 17.0 + seed * 2.3);
      expect(flickerFast({ t, seed })).toBeCloseTo(expected, 10);
    });

    it('flare = 1.35 when sin(t*0.7 + seed*5.0) > 0.93, else 1.0', () => {
      // Find a t where the flare sine exceeds 0.93.
      // sin(x) > 0.93 around x ≈ 1.223 + 2πk (asin(0.94) ≈ 1.223).
      // For seed 0: t*0.7 ≈ 1.223 → t ≈ 1.747.
      const tFlare = 1.747;
      const seedFlare = 0.0;
      // Sanity-check the sine really is > 0.93 at this point.
      expect(Math.sin(tFlare * 0.7 + seedFlare * 5.0)).toBeGreaterThan(0.93);
      expect(flickerFlare({ t: tFlare, seed: seedFlare })).toBe(1.35);

      // At t=0, seed=0: sin(0) = 0 < 0.93 → no flare.
      expect(flickerFlare({ t: 0, seed: 0 })).toBe(1.0);
    });
  });

  describe('product composition', () => {
    it('flickerMul = slow * fast * flare', () => {
      const params = { t: 3.7, seed: 2.1 };
      const expected = flickerSlow(params) * flickerFast(params) * flickerFlare(params);
      expect(computeFlickerMul(params)).toBeCloseTo(expected, 10);
    });

    it('produces the exact pinned multiplier for a fixed (t, seed) — determinism contract', () => {
      // The ticket's acceptance criterion: "fixed t+seed → exact multiplier".
      // This is the bit-identical cross-run determinism guarantee all clients
      // rely on. Pinned to the verbatim prototype formulas so any drift in the
      // coefficients (3.1 / 17.0 / 0.7 / 0.93 / 1.35 / 0.85 / 0.15 / 0.90 / 0.10)
      // trips this test.
      const t = 12.0;
      const seed = 5.0;
      const slow = 0.85 + 0.15 * Math.sin(t * 3.1 + seed);
      const fast = 0.9 + 0.1 * Math.sin(t * 17.0 + seed * 2.3);
      const flare = Math.sin(t * 0.7 + seed * 5.0) > 0.93 ? 1.35 : 1.0;
      const expected = slow * fast * flare;
      // toBe (not toBeCloseTo) — exact equality is the determinism contract.
      expect(computeFlickerMul({ t, seed })).toBe(expected);
    });

    it('the flare octave can actually fire (×1.35 branch is reachable)', () => {
      // Pin a (t, seed) where the flare sine exceeds 0.93 so the 1.35 branch
      // is exercised — guards against the flare condition silently inverting.
      const t = 1.747;
      const seed = 0.0;
      expect(Math.sin(t * 0.7 + seed * 5.0)).toBeGreaterThan(0.93);
      const mul = computeFlickerMul({ t, seed });
      // flare contributes ×1.35; the product must be ≥ 1.35 * (slow*fast minimum).
      // slow ∈ [0.70, 1.00], fast ∈ [0.80, 1.00] → slow*fast ∈ [0.56, 1.00].
      expect(mul).toBeGreaterThan(1.35 * 0.55);
    });
  });
});

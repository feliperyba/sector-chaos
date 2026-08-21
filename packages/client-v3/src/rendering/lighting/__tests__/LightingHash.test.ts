import { describe, it, expect } from 'vitest';
import { hash2, finalizeHash, flickerSeedFromHash } from '../LightingHash.js';
import { flickerSeedForPlacement } from '../LightPacker.js';

/**
 * Ticket 24 — LightingHash Seam A. The extracted `hash2` helper is shared by
 * three lighting callers (LightPacker.flickerSeedForPlacement,
 * DynamicLightPopulator.flickerSeedFromPosition, ExplosionEventHandler.
 * explosionFlickerSeed); this pins its purity + the bit-for-bit preservation
 * of the historical `(x*73856093) ^ (y*19349663)` mix the callers previously
 * inlined. Cosmetic-only (flicker phase is mood, never vision).
 */
describe('LightingHash — pure shared 2-point integer hash (ticket 24)', () => {
  describe('hash2', () => {
    it('matches the historical `(x*73856093) ^ (y*19349663)` bit layout', () => {
      // Behavior-preservation anchor: the three inlined sites all used this
      // exact mix. The extraction must NOT change the bits.
      expect(hash2(5, 7)).toBe((5 * 73856093) ^ (7 * 19349663));
      expect(hash2(0, 0)).toBe(0);
      expect(hash2(100, -200)).toBe((100 * 73856093) ^ (-200 * 19349663));
    });

    it('is pure: same inputs → same output across calls', () => {
      for (const [x, y] of [
        [0, 0],
        [5, 7],
        [-3, 11],
        [12345, 67890],
      ] as const) {
        expect(hash2(x, y)).toBe(hash2(x, y));
      }
    });

    it('spreads adjacent inputs (cheap diversity — adjacent tiles differ)', () => {
      const s = new Set([hash2(5, 5), hash2(6, 5), hash2(5, 6), hash2(6, 6)]);
      expect(s.size).toBe(4);
    });
  });

  describe('finalizeHash', () => {
    it('is the historical `(h ^ (h >>> 13)) >>> 0` xor-shift finalizer', () => {
      const h = hash2(11, 13);
      expect(finalizeHash(h)).toBe((h ^ (h >>> 13)) >>> 0);
    });

    it('always returns a uint32 in [0, 2^32)', () => {
      for (const h of [0, -1, 123456, -999999, hash2(50, 50)]) {
        const out = finalizeHash(h);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThan(2 ** 32);
        expect(Number.isInteger(out)).toBe(true);
      }
    });
  });

  describe('flickerSeedFromHash', () => {
    it('maps a finalized hash to a stable float in [0, 1000)', () => {
      for (const h of [0, 999999, 1_000_000, 5_000_000, finalizeHash(hash2(7, 9))]) {
        const seed = flickerSeedFromHash(h);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(1000);
      }
    });

    it('is the historical `(h % 1_000_000) / 1000` shape', () => {
      const h = finalizeHash(hash2(11, 13));
      expect(flickerSeedFromHash(h)).toBe((h % 1_000_000) / 1000);
    });
  });

  describe('integration: shared helper drives the placement flicker seed', () => {
    it('flickerSeedForPlacement produces identical bits to the inlined formula', () => {
      // The extraction must be byte-for-byte: the existing LightPacker test
      // suite already pins the public flickerSeedForPlacement output across a
      // range of grid coords; this asserts the new helper-composed path
      // matches the OLD inlined expression for the same coords.
      for (const [gx, gy] of [
        [0, 0],
        [5, 5],
        [11, 13],
        [99, -42],
      ] as const) {
        const mixed = (gx * 73856093) ^ (gy * 19349663);
        const finalized = (mixed ^ (mixed >>> 13)) >>> 0;
        const expected = (finalized % 1_000_000) / 1000;
        expect(flickerSeedForPlacement(gx, gy)).toBeCloseTo(expected, 10);
      }
    });
  });
});

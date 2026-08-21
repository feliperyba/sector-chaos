import { describe, it, expect } from 'vitest';
import {
  REINHARD,
  ACES,
  AMBIENT_FLOOR,
  TIERS,
  TIER1_FALLOFF,
  BLOOM_WEIGHTS,
  BLOOM,
  SOBEL_STRENGTH,
  ACTIVE_TIER,
} from '../LightingTiers.js';

/**
 * Regression guard for the grade/tonemap constants. Every value here is
 * verbatim from the validated 06 prototype
 * (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js`). When the spec
 * and the prototype disagree, the prototype's wired values win — these tests
 * pin the prototype's values so a retune can't sneak in unnoticed.
 */
describe('LightingTiers — grade/tonemap constants regression guard (Seam A)', () => {
  describe('REINHARD (tier-1 tonemap)', () => {
    it('uses x/(x+1) — denominator offset is exactly 1.0', () => {
      expect(REINHARD.denominatorOffset).toBe(1.0);
    });
  });

  describe('ACES filmic (Narkowicz approx, tiers 2+)', () => {
    it('matches the prototype coefficients exactly', () => {
      // prototype.js FINAL_FRAG: const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      expect(ACES.a).toBe(2.51);
      expect(ACES.b).toBe(0.03);
      expect(ACES.c).toBe(2.43);
      expect(ACES.d).toBe(0.59);
      expect(ACES.e).toBe(0.14);
    });
  });

  describe('AMBIENT_FLOOR', () => {
    it('tier-1 uses the brighter baseline ambient vec3(0.38,0.40,0.48)', () => {
      expect(AMBIENT_FLOOR[1]).toEqual([0.38, 0.4, 0.48]);
    });

    it('tiers 2-5 use the C5 lifted warm HDR ambient vec3(0.28,0.24,0.18)', () => {
      // ── ALL FOUR A/B BASELINES (do not silently lose the prior art) ──
      // (a) VERBATIM-PROTOTYPE (prototype.js:662):     [0.16, 0.18, 0.26]  sum 0.60  cool blue-navy (B>R)
      // (b) TICKET 23 warm-ember (commit 033616e):      [0.18, 0.15, 0.12]  sum 0.45  warm (R>G>B)
      // (c) TICKET 06 lifted-warm:                      [0.24, 0.20, 0.16]  sum 0.60  warm (R>G>B)
      // (d) C5 readability rescue (this commit):        [0.28, 0.24, 0.18]  sum 0.70  warm (R>G>B)
      //
      // Rec.601 luma (0.299R + 0.587G + 0.114B):
      //   (a) 0.1831  ← the pre-ticket-23 readability edge
      //   (b) 0.1555  ← −15.1% vs (a); ticket 23 overshot (−25% channel-sum to
      //                buy warm hue). Predicted unlit-tile ACES-mapped luma
      //                dropped to 0.0661 — BELOW the cosmetic-only floor (GDD
      //                docs/GDD.md:210). See A6-darkness-too-aggressive.md §3.
      //   (c) 0.2074  ← +33.4% vs (b); +13.2% vs (a). Restored channel-sum to
      //                the pre-ticket-23 0.60 budget; warm hue preserved
      //                (R≥G≥B). Predicted unlit-tile ACES-mapped luma ~0.1014.
      //   (d) 0.2420  ← +16.7% vs (c). C5 conservative lift to the 0.70 budget
      //                (NOT the aggressive 0.85 — user ruling 2026-08-07, the
      //                moderate middle path). The 0.60 floor still read at
      //                corner ACES-mapped luma ~0.109 once the post-grade chain
      //                crushed it (warmShadow tint, gamma 0.92, vignette) — at
      //                the legibility edge. Lifting to 0.70 + pairing with the
      //                slight vignette STRENGTHEN (final.frag:122 0.25→0.30)
      //                lifts corner to ~0.126 (+15.2%, verified algebraically).
      //                Tuned against the post-C5 core double-count fix
      //                (hdrLit.frag:182,193) so the lifted floor does not blow
      //                out light cores. Cosmetic-only floor upheld (GDD 210).
      expect(AMBIENT_FLOOR[2]).toEqual([0.28, 0.24, 0.18]);
      expect(AMBIENT_FLOOR[3]).toEqual([0.28, 0.24, 0.18]);
      expect(AMBIENT_FLOOR[4]).toEqual([0.28, 0.24, 0.18]);
      expect(AMBIENT_FLOOR[5]).toEqual([0.28, 0.24, 0.18]);
    });

    it('C5: warm hue preserved (R>=G>=B) across all HDR tiers', () => {
      // AAA rule (research §3, §7): warm-dominant in torch-lit spaces. The lift
      // restores MAGNITUDE, not reverts HUE — do NOT revert to the cool-navy
      // [0.16,0.18,0.26]. Every HDR tier must satisfy R>=G>=B.
      for (const tier of [2, 3, 4, 5]) {
        const [r, g, b] = AMBIENT_FLOOR[tier]!;
        expect(r).toBeGreaterThanOrEqual(g);
        expect(g).toBeGreaterThanOrEqual(b);
      }
    });

    it('C5: ambient floor channel-sum lifted to ~0.70 (was ~0.60 — user ruling 2026-08-07)', () => {
      // C5 (user ruling 2026-08-07): the 0.60 floor (c) was the conservative
      // choice but in practice the post-grade chain crushed the corner to
      // ~0.109 luma — at the legibility edge (the "too dark" half of the
      // simultaneous-contrast pair). Lifted to 0.70 (NOT the aggressive 0.85 —
      // the conservative middle path). The constraint per the spec/review is
      // the channel-sum target (~0.70), not a specific per-channel split.
      // Verified net-corner: floor +0.10 sum dominates the paired vignette
      // strengthen (-0.05 corner crush) → corner ACES-mapped luma rises ~15%.
      for (const tier of [2, 3, 4, 5]) {
        const [r, g, b] = AMBIENT_FLOOR[tier]!;
        const sum = r + g + b;
        expect(sum).toBeCloseTo(0.7, 1);
      }
    });
  });

  describe('TIERS (technique flags)', () => {
    it('tier-1 is baseline only (everything OFF)', () => {
      const t1 = TIERS[1]!;
      expect(t1.aces).toBe(false);
      expect(t1.twoTerm).toBe(false);
      expect(t1.specular).toBe(false);
      expect(t1.bloom).toBe(false);
      expect(t1.vignette).toBe(false);
      expect(t1.grade).toBe(false);
      expect(t1.cookie).toBe(false);
      expect(t1.flicker).toBe(false);
    });

    it('each higher tier ADDS techniques (monotonic)', () => {
      // The tier system proves each technique's value via blind A/B.
      // Tier 2 adds ACES + two-term + specular.
      const t2 = TIERS[2]!;
      expect(t2.aces && t2.twoTerm && t2.specular).toBe(true);
      // Tier 3 adds bloom + vignette + grade.
      const t3 = TIERS[3]!;
      expect(t3.bloom && t3.vignette && t3.grade).toBe(true);
      // Tier 4 adds cookie + flicker.
      const t4 = TIERS[4]!;
      expect(t4.cookie && t4.flicker).toBe(true);
      // Tier 5 is all-on.
      const t5 = TIERS[5]!;
      expect(
        t5.aces &&
          t5.twoTerm &&
          t5.specular &&
          t5.bloom &&
          t5.vignette &&
          t5.grade &&
          t5.cookie &&
          t5.flicker,
      ).toBe(true);
    });
  });

  describe('TIER1_FALLOFF (flat smoothstep disk)', () => {
    it('uses t*t*(3-2*t) — polyA=3, polyB=2', () => {
      // prototype.js HDR_LIT_FRAG baseline path: atten = halo * ld.w where
      // halo = t*t*(3-2*t). The polynomial coefficients are pinned here.
      expect(TIER1_FALLOFF.polyA).toBe(3.0);
      expect(TIER1_FALLOFF.polyB).toBe(2.0);
    });
  });

  describe('BLOOM (ticket 08 — bloom chain constants)', () => {
    it('uses the validated 9-tap Gaussian weights', () => {
      // prototype.js BLUR_FRAG: [0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216]
      expect(BLOOM_WEIGHTS.length).toBe(5);
      expect(BLOOM_WEIGHTS[0]).toBeCloseTo(0.227027, 6);
      expect(BLOOM_WEIGHTS[1]).toBeCloseTo(0.1945946, 7);
      expect(BLOOM_WEIGHTS[2]).toBeCloseTo(0.1216216, 7);
      expect(BLOOM_WEIGHTS[3]).toBeCloseTo(0.054054, 6);
      expect(BLOOM_WEIGHTS[4]).toBeCloseTo(0.016216, 6);
    });

    it('uses the validated bright-pass + spread + strength values', () => {
      // prototype.js: threshold 0.55, knee 1.2, boost 1.3, spread 4.0, strength 1.4
      expect(BLOOM.threshold).toBe(0.55);
      expect(BLOOM.knee).toBe(1.2);
      expect(BLOOM.boost).toBe(1.3);
      expect(BLOOM.spread).toBe(4.0);
      expect(BLOOM.strength).toBe(1.4);
    });
  });

  describe('SOBEL_STRENGTH', () => {
    // Lighting-mood pass (67f3626): bumped 2.4 → 3.5 — stronger normal relief
    // so the (albedo-modulated) specular/diffuse terms read as a sheen with
    // surface form, not a faint flat brightening (the "lights not making good
    // use of the effects available" read).
    it('is the single global value 3.5', () => {
      expect(SOBEL_STRENGTH).toBe(3.5);
    });
  });

  describe('ACTIVE_TIER', () => {
    it('ticket 08 ships at tier 5 (full AAA stack — the validated WOW look)', () => {
      // Tier 5 = all-on (two-term + specular + ACES + cookie + flicker + bloom
      // + grade + vignette), A/B-comparable with the live 06 prototype. Flip
      // back to 1 to A/B-regress against the ticket-06 baseline.
      expect(ACTIVE_TIER).toBe(5);
    });

    it('the ship tier carries EVERY AAA technique flag the ticket mandates', () => {
      const t = TIERS[ACTIVE_TIER]!;
      expect(t.aces).toBe(true);
      expect(t.twoTerm).toBe(true);
      expect(t.specular).toBe(true);
      expect(t.cookie).toBe(true);
      expect(t.flicker).toBe(true);
      // Ticket 08's additions: bloom + grade + vignette all ON at tier 5.
      expect(t.bloom).toBe(true);
      expect(t.grade).toBe(true);
      expect(t.vignette).toBe(true);
    });

    it('tier 1 remains the regression baseline (all flags OFF)', () => {
      // The A/B toggle must stay reachable — hard constraint #3.
      const t1 = TIERS[1]!;
      expect(t1.aces).toBe(false);
      expect(t1.twoTerm).toBe(false);
      expect(t1.specular).toBe(false);
      expect(t1.cookie).toBe(false);
      expect(t1.flicker).toBe(false);
    });
  });
});

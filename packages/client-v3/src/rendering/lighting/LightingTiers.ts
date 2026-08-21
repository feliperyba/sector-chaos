/**
 * Lighting tier constants — the regression-guard surface for grade/tonemap/
 * bloom tuning values. Tier 1 is the Reinhard + ambient `vec3(0.38,0.40,0.48)`
 * + flat-smoothstep-disk baseline; tier 5 (ticket 08, ACTIVE_TIER) is all-on —
 * the validated "WOW / PERFECT" look, A/B-comparable with the live prototype.
 *
 * Every value here is verbatim from the validated 06 prototype
 * (`docs/wayfinder/prototypes/06-aaa-lighting/prototype.js`). When the spec
 * and the prototype disagree, the prototype's actual wired values win
 * (spec §"Further Notes"). `LightingTiers.test.ts` asserts these constants
 * exactly — never retune without a recorded HITL verdict.
 */

/** Reinhard tonemap coefficients (used at tier 1). */
export const REINHARD = {
  // vec3 reinhard(vec3 x) { return x / (x + 1.0); }
  // (single coefficient; kept as a record for symmetry with ACES)
  denominatorOffset: 1.0,
} as const;

/** ACES filmic tonemap (Narkowicz approx) — used at tiers 2+. */
export const ACES = {
  a: 2.51,
  b: 0.03,
  c: 2.43,
  d: 0.59,
  e: 0.14,
} as const;

/**
 * Per-tier ambient floor (linear RGB).
 *
 * Tier 1 keeps the brighter baseline ambient so the world stays fully visible
 * without lights doing much work (the "thing we beat"). Higher tiers darken
 * the floor so lights do the heavy lifting — cosmetic only, never a vision
 * mechanic (GDD forbids fog of war).
 *
 * ── ALL FOUR A/B BASELINES (do not silently lose the prior art) ──
 * (a) VERBATIM-PROTOTYPE (prototype.js:662):     [0.16, 0.18, 0.26]  sum 0.60  cool blue-navy (B>R)
 * (b) TICKET 23 warm-ember (commit 033616e):      [0.18, 0.15, 0.12]  sum 0.45  warm (R>G>B)
 * (c) TICKET 06 lifted-warm:                      [0.24, 0.20, 0.16]  sum 0.60  warm (R>G>B)
 * (d) C5 readability rescue (this commit):        [0.28, 0.24, 0.18]  sum 0.70  warm (R>G>B)
 *
 * Rec.601 luma (0.299R + 0.587G + 0.114B) per baseline:
 *   (a) 0.1831  ← the pre-ticket-23 readability edge
 *   (b) 0.1555  ← −15.1% vs (a); ticket 23 overshot (lost 25% channel energy
 *                to the warm hue shift — trading green/blue for red is a
 *                luma-losing trade by photometry). Predicted unlit-tile
 *                ACES-mapped luma dropped to 0.0661 — BELOW the cosmetic-only
 *                floor (GDD docs/GDD.md:210). See A6-darkness-too-aggressive.md §3.
 *   (c) 0.2074  ← +33.4% vs (b); +13.2% vs (a). Restored channel-sum to the
 *                pre-ticket-23 0.60 budget while KEEPING the warm hue (R≥G≥B).
 *                Predicted unlit-tile ACES-mapped luma ~0.1014 — comfortably
 *                readable, still moody (well below the tier-1 [0.38,0.4,0.48]
 *                baseline; lights still do the work).
 *   (d) 0.2420  ← +16.7% vs (c). Conservative lift to the 0.70 budget (NOT the
 *                aggressive 0.85 option — user ruling 2026-08-07, the moderate
 *                middle path). The 0.60 floor read at ACES-mapped corner luma
 *                ~0.109 once the post-grade chain crushed it (warmShadow tint,
 *                gamma 0.92, vignette) — at the legibility edge. Lifting to 0.70
 *                while pairing with a slight vignette STRENGTHEN (final.frag:122
 *                0.25→0.30) lifts the corner to ACES-mapped luma ~0.126 (+15.2%,
 *                verified algebraically — see C5 findings §"net-corner check").
 *                Floor +0.10 sum (+16.7% rel) dominates vignette -0.05 corner
 *                crush (corner multiplier 0.75→0.70, -6.7% rel). Warm hue
 *                preserved (R≥G≥B). Tuned against the post-C2 warm aura +
 *                post-C5 core double-count fix (hdrLit.frag:182,193) so the
 *                lifted floor does not blow out light cores.
 *
 * ── Ticket 06 — readability rescue (the coupled pair with ticket 05) ──
 * Ticket 23's warm-dominant DIRECTION was AAA-correct (research §3: D2R/Diablo
 * IV/Hades all warm-dominant in torch-lit spaces; §7: mood = low-key
 * chiaroscuro) but the MAGNITUDE overshot — it paid for hue in luma. The user
 * ruling: "lift to pre-ticket-23 brightness, warm hue." Lifted (b) → (c):
 * channel-sum restored to 0.60 (exactly the pre-ticket-23 energy budget);
 * warm hue preserved (R≥G≥B); the resulting Rec.601 luma sits ABOVE the old
 * cool-navy because warm hue at equal channel-sum carries more luma (energy
 * moved from low-weight B into high-weight G + R). Tuned against the
 * POST-ticket-05 corrected composite (albedo-modulated emissive at
 * hdrLit.frag:184 — lights no longer stamp over entities), so the lifted floor
 * doesn't blow out light cores. Cosmetic-only floor upheld (GDD line 210):
 * an unlit tile reads at ACES-mapped luma ~0.10, well above the readability
 * edge. Mood lives in the unlit spaces BETWEEN warm sources, not in a dark
 * floor (Level Design Book: main diffuse textures in the 50–100% brightness
 * range; darkness lives in unlit SPACE, not dark TEXTURES).
 *
 * All HDR tiers (2-5) share one value (no per-tier ramp today — the spec
 * flags a tier-2-brighter→tier-5-moodier ramp as an open question; it's a
 * mood-progression feature, out of scope for this readability rescue).
 *
 * ── C5 — simultaneous-contrast pair (the floor half — 2026-08-07) ──
 * The 0.60 floor (c) was the conservative choice but in practice the post-grade
 * chain crushed the corner to ~0.109 luma — the user-reported "too dark" half
 * of the simultaneous-contrast pair ("too dark" AND "cores too bright"). User
 * ruling: lift to 0.70 (NOT 0.85), paired with a slight vignette STRENGTHEN
 * (final.frag:122 0.25→0.30) so mood/contrast is preserved while corner
 * readability is rescued. Cosmetic-only floor upheld (GDD line 210): an unlit
 * tile reads at ACES-mapped corner luma ~0.126 — well above the readability
 * edge. Mood lives in the unlit spaces BETWEEN warm sources, not in a dark
 * floor. The cores half of the pair is fixed at hdrLit.frag:182,193 (drop the
 * double-count + albedo-modulate specular); the floor + cores must ship together
 * (C5 is ONE perceptual problem with two halves).
 */
export const AMBIENT_FLOOR: Readonly<Record<number, readonly [number, number, number]>> = {
  1: [0.38, 0.4, 0.48], // tier-1 baseline (neutral, unchanged — A/B regression anchor)
  2: [0.28, 0.24, 0.18], // C5 — readability rescue (was ticket-06 [0.24,0.2,0.16] sum 0.60; was ticket-23 [0.18,0.15,0.12]; verbatim [0.16,0.18,0.26])
  3: [0.28, 0.24, 0.18],
  4: [0.28, 0.24, 0.18],
  5: [0.28, 0.24, 0.18],
};

/**
 * Per-tier technique flags (uniform-gated; A/B toggle preserved for dev per
 * the spec). Tier 1 = baseline only; each higher tier ADDS techniques.
 */
export interface TierFlags {
  aces: boolean;
  twoTerm: boolean;
  specular: boolean;
  bloom: boolean;
  vignette: boolean;
  grade: boolean;
  cookie: boolean;
  flicker: boolean;
}

export const TIERS: Readonly<Record<number, TierFlags>> = {
  1: {
    aces: false,
    twoTerm: false,
    specular: false,
    bloom: false,
    vignette: false,
    grade: false,
    cookie: false,
    flicker: false,
  },
  2: {
    aces: true,
    twoTerm: true,
    specular: true,
    bloom: false,
    vignette: false,
    grade: false,
    cookie: false,
    flicker: false,
  },
  3: {
    aces: true,
    twoTerm: true,
    specular: true,
    bloom: true,
    vignette: true,
    grade: true,
    cookie: false,
    flicker: false,
  },
  4: {
    aces: true,
    twoTerm: true,
    specular: true,
    bloom: true,
    vignette: true,
    grade: true,
    cookie: true,
    flicker: true,
  },
  5: {
    aces: true,
    twoTerm: true,
    specular: true,
    bloom: true,
    vignette: true,
    grade: true,
    cookie: true,
    flicker: true,
  },
};

/** Tier-1 baseline single-smoothstep disk falloff polynomial coefficients. */
export const TIER1_FALLOFF = {
  // atten = t*t*(3 - 2*t) * intensity, where t = clamp(1 - dist/radius, 0, 1)
  // (the smoothstep polynomial; same `halo` term the two-tier path reuses)
  polyA: 3.0,
  polyB: 2.0,
} as const;

/** Separable 9-tap Gaussian bloom weights (ticket 08 — bloom chain). */
export const BLOOM_WEIGHTS = [0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216] as const;

/** Bloom tuning (ticket 08 — bright-pass + spread + strength). */
export const BLOOM = {
  threshold: 0.55,
  knee: 1.2,
  boost: 1.3,
  spread: 4.0,
  strength: 1.4,
} as const;

/**
 * Sobel normal-generation strength (single global value). Bumped 2.4 → 3.5
 * (lighting-mood pass, 67f3626): the sobel pass generates the fake surface
 * normals that the hdrLit diffuse + specular terms ride. At 2.4 the normals
 * were too flat for the (albedo-modulated) specular to read as a sheen rather
 * than a faint flat brightening — the "lights not making good use of the
 * effects available" read. The bump gives the specular/diffuse actual surface
 * form to catch across tiles, walls and props without introducing edge noise.
 */
export const SOBEL_STRENGTH = 3.5;

/**
 * The tier this client ships at. Ticket 08 raises it to tier 5 (all-on — the
 * validated "WOW / PERFECT" look: two-term + specular + ACES + cookie +
 * flicker + bloom + grade + vignette, A/B-comparable with the live 06
 * prototype). Tier 1 remains the regression baseline; flip ACTIVE_TIER to 1 to
 * A/B against the ticket-06 look.
 */
export const ACTIVE_TIER = 5;

/**
 * Per-kind flicker math — pure functions (no Phaser, no GPU, no Math.random).
 *
 * Ticket 08 (A4): replaces the ONE generic `computeFlickerMul` (a torch-shaped
 * multi-octave noise) with a per-kind FLICKER_PROFILE table. Each flame kind
 * gets its own (amplitude, lowFreqHz, highFreqHz, flare) tuning so a campfire
 * ROARS, a candle steady-flickers, a torch modulates, a lantern is near-steady,
 * a brazier is steady-medium, a fireplace roars like a campfire, and a fire
 * trap is a contained floor-patch fire. The explosion is handled separately
 * (see `ExplosionLightRegistry` — a single pulse, NOT a flicker profile).
 *
 * Composition (the prototype's multi-octave flame noise,
 * `prototype.js:718-723`):
 *   slow  = base - ampLow  + ampLow  * sin(t * 2π * lowFreqHz  + seed)
 *   fast  = base - ampHigh + ampHigh * sin(t * 2π * highFreqHz + seed * 2.3)
 *   flare = (sin(t * 0.7 + seed * 5.0) > flareThreshold) ? flareMul : 1.0
 *   flickerMul = slow * fast * flare
 *
 * Per-kind tuning (DERIVED — no published AAA values; research §6). The qualitative
 * intent (the user's verbatim spec): "a campfire roars, a candle steady-flickers,
 * a torch modulates." The numeric mapping:
 *   - amplitude controls how far the flame swells/dips (campfire ±big, candle ±tiny)
 *   - lowFreqHz controls the dominant roar rate (campfire ~1Hz slow, lantern ~3Hz steady)
 *   - highFreqHz controls the micro-flutter (candle fast, brazier slow)
 *   - flare controls the occasional gust spike (campfire big, lantern none)
 *
 * Pure: given the same `profile` + `t` + `seed`, the product is bit-identical
 * across runs (deterministic per light, so all clients agree on the multiplier
 * for a given seed — the seed is itself deterministic per light from the map
 * RNG stream). NO `Math.random()` anywhere.
 */
import type { FlameKind } from '@sector-battle/shared';

/** Wall-clock seconds + per-light deterministic seed. */
export interface FlickerParams {
  /** Wall-clock seconds. */
  t: number;
  /** Per-light seed (deterministic from the map RNG stream). */
  seed: number;
}

/**
 * The flame-kind discriminator for the flicker-config system. Includes the
 * shared `FlameKind` (torch/campfire/candle/fireplace/brazier/lantern) PLUS
 * the client-only `'fire-trap'` dynamic kind (the active fire trap's
 * `fireAreaActive` light). Excludes non-flame kinds (biome-glow, barrel-fire,
 * aura, poison) — those don't flicker via this table.
 *
 * Note: `barrel-fire` is intentionally NOT a FlickerFlameKind — barrels are
 * inert until they explode, and the explosion is a single pulse (not a flicker),
 * so there's no steady-state barrel-fire flame to flicker.
 */
export type FlickerFlameKind = FlameKind | 'fire-trap';

/**
 * A per-kind flicker tuning. All four levers shape the flame's "character":
 *  - `lowAmp`    — amplitude of the slow drift octave (the roar/swell).
 *  - `lowFreqHz` — frequency of the slow octave (Hz). Campfire ~1Hz (slow roar);
 *                  lantern ~3Hz (steady shimmer); candle ~2.5Hz (steady-flicker).
 *  - `highAmp`   — amplitude of the fast flutter octave (the micro-shimmer).
 *  - `highFreqHz`— frequency of the fast octave (Hz). Candle fast, brazier slow.
 *  - `flareThreshold` — the sine threshold above which a flare fires (lower =
 *                  more frequent flares). 1.01 disables flare (never fires).
 *  - `flareMul`  — the flare multiplier (×1.35 = a 35% gust spike).
 *
 * The product range is roughly `(1-2*lowAmp) × (1-2*highAmp) .. 1 × 1.0`, so
 * the amplitudes must keep the floor safely positive (a negative-intensity light
 * is nonsensical). The configs below are tuned so the floor stays > 0.2 even for
 * the big-amp "roar" kinds (campfire/fireplace dip to ~30-40% during a big dip —
 * that's the roar character, not a bug; the hard floor is "never zero/negative").
 */
export interface FlickerProfile {
  readonly lowAmp: number;
  readonly lowFreqHz: number;
  readonly highAmp: number;
  readonly highFreqHz: number;
  readonly flareThreshold: number;
  readonly flareMul: number;
}

/**
 * The per-kind flicker profile table (ticket 08 / A4 H5). Each flame kind gets
 * a distinct character per the user's spec. The EXPLOSION is NOT in this table
 * — it's a single pulse, not a flicker (see `ExplosionLightRegistry`).
 *
 * The base for both octaves is `1.0` (the slow + fast sines are added as
 * `1 - amp + amp * sin(...)`); the product is the multiplier on the light's
 * base intensity. The floor across all profiles stays ≥0.55 (a flame never goes
 * negative); the ceiling is `1.0 * flareMul` (a gust can briefly push above 1).
 *
 * ── A/B BASELINES (the verbatim-prototype single profile, pre-ticket-08) ──
 * Pre-ticket-08 there was ONE `computeFlickerMul` applied identically to every
 * flame. Its octaves were: slow = 0.85 + 0.15*sin(t*3.1 + seed) (≈ lowAmp 0.15,
 * lowFreqHz ~0.49Hz), fast = 0.9 + 0.1*sin(t*17.0 + seed*2.3) (≈ highAmp 0.10,
 * highFreqHz ~2.7Hz), flare ×1.35 at threshold 0.93. The `torch` profile below
 * is the faithful port of those octaves; the other kinds are tuned relative to
 * it per the user's per-kind spec.
 */
export const FLICKER_PROFILES: Readonly<Record<FlickerFlameKind, FlickerProfile>> = {
  // Torch: the de-facto "modulate" — medium amplitude, moderate frequency.
  // Faithful port of the verbatim-prototype octaves (the A/B baseline above).
  torch: {
    lowAmp: 0.15,
    lowFreqHz: 3.1 / (2 * Math.PI), // ≈ 0.494Hz — the prototype's 3.1 rad/s
    highAmp: 0.1,
    highFreqHz: 17.0 / (2 * Math.PI), // ≈ 2.705Hz — the prototype's 17.0 rad/s
    flareThreshold: 0.93,
    flareMul: 1.35,
  },
  // Candle: the user's "steady-flicker" — tiny amplitude, steady. A candle is
  // the smallest flame; its disk should barely move. Smaller amplitudes than
  // torch on both octaves + a near-disabled flare (a candle rarely gusts).
  //
  // C7 (lighting-system-3): boosted the amplitudes from (0.05 / 0.04) to
  // (0.10 / 0.07) — the prior ~17% worst-case dip was imperceptible; the new
  // ~30% dip reads as alive while staying the calmest flame (still smaller
  // amplitude than torch / campfire). A/B baseline: was lowAmp 0.05, highAmp
  // 0.04 (dip ~17%). Cosmetic-only (GDD `docs/GDD.md:210`).
  candle: {
    lowAmp: 0.1, // C7: was 0.05 (dip ~17% → ~30% — perceptible)
    lowFreqHz: 2.5 / (2 * Math.PI), // ≈ 0.398Hz — slow, steady
    highAmp: 0.07, // C7: was 0.04
    highFreqHz: 22.0 / (2 * Math.PI), // ≈ 3.501Hz — a touch faster flutter than torch
    flareThreshold: 0.985, // very rare flare
    flareMul: 1.1, // small flare
  },
  // Campfire: the user's "roars" — big amplitude, slow frequency, big flares.
  // A campfire's disk swells and dips dramatically with low-frequency gusts.
  campfire: {
    lowAmp: 0.28,
    lowFreqHz: 1.1 / (2 * Math.PI), // ≈ 0.175Hz — a slow roar (sub-Hz)
    highAmp: 0.12,
    highFreqHz: 11.0 / (2 * Math.PI), // ≈ 1.751Hz — slower flutter than torch
    flareThreshold: 0.86, // frequent gusts
    flareMul: 1.6, // big flare
  },
  // Fireplace: the user's "big amp, slow roar (like campfire)". A contained
  // campfire-in-hearth — same character as campfire, slightly steadier (the
  // hearth channels the draft). Reuses campfire's octaves with a marginally
  // smaller amplitude.
  fireplace: {
    lowAmp: 0.25,
    lowFreqHz: 1.1 / (2 * Math.PI), // ≈ 0.175Hz — slow roar (same as campfire)
    highAmp: 0.1,
    highFreqHz: 11.0 / (2 * Math.PI), // ≈ 1.751Hz
    flareThreshold: 0.88,
    flareMul: 1.55,
  },
  // Brazier: the user's "medium amp, steady". A raised bowl of coals — steadier
  // than a campfire (the bowl shelters the flame) but with visible motion.
  brazier: {
    lowAmp: 0.12,
    lowFreqHz: 1.8 / (2 * Math.PI), // ≈ 0.286Hz
    highAmp: 0.08,
    highFreqHz: 13.0 / (2 * Math.PI), // ≈ 2.069Hz
    flareThreshold: 0.92,
    flareMul: 1.3,
  },
  // Lantern: the user's "tiny amp, very steady". An enclosed flame behind a
  // glass — the enclosure damps almost all motion. The smallest amplitudes in
  // the table; flare effectively disabled.
  //
  // C7 (lighting-system-3): boosted the amplitudes from (0.03 / 0.02) to
  // (0.06 / 0.05) — the prior ~10% worst-case dip was near-imperceptible; the
  // new ~21% dip reads as alive while keeping the lantern the calmest flame
  // (still smaller than candle) + the flare stays disabled (an enclosed flame
  // doesn't gust). A/B baseline: was lowAmp 0.03, highAmp 0.02 (dip ~10%).
  //
  // DEVIATION — needs orchestrator sign-off: the C7 spec listed `highAmp 0.04`,
  // but the spec ALSO mandates a ≥20% worst-case dip ("the new floor for
  // perceptibility"). With the spec's exact (0.06, 0.04) the worst-case
  // product is (1-2·0.06)·(1-2·0.04) = 0.88·0.92 = 0.8096 → dip 0.1904, just
  // BENEATH the floor. The two clauses are in tension by ~1%. The ≥20% floor
  // is the load-bearing acceptance criterion (the perceptibility contract),
  // so the minimal fix is `highAmp 0.04 → 0.05` (→ dip ≈0.208, clears the
  // floor). `lowAmp` stays at the spec's 0.06; the lantern remains the calmest
  // flame (still smaller dip than candle/torch). Cosmetic-only (GDD `docs/
  // GDD.md:210`).
  lantern: {
    lowAmp: 0.06, // C7: was 0.03 (dip ~10% → ~21% — perceptible)
    lowFreqHz: 3.0 / (2 * Math.PI), // ≈ 0.477Hz — a steady shimmer
    highAmp: 0.05, // C7: was 0.02 (spec said 0.04 — bumped +0.01 to clear ≥20% dip floor; see DEVIATION note)
    highFreqHz: 19.0 / (2 * Math.PI), // ≈ 3.024Hz — fast but tiny
    flareThreshold: 1.01, // disabled (a lantern doesn't gust) — C7 keeps this off
    flareMul: 1.0,
  },
  // Fire-trap: the user's "medium amp, active". A contained floor-patch fire —
  // between candle and campfire. Active (it's burning aggressively) but smaller
  // than a campfire (it's a patch, not a bonfire).
  'fire-trap': {
    lowAmp: 0.18,
    lowFreqHz: 1.5 / (2 * Math.PI), // ≈ 0.239Hz
    highAmp: 0.1,
    highFreqHz: 14.0 / (2 * Math.PI), // ≈ 2.228Hz
    flareThreshold: 0.9,
    flareMul: 1.4,
  },
};

/**
 * The slow drift octave: `1 - lowAmp + lowAmp * sin(t * 2π * lowFreqHz + seed)`.
 * Generalizes the prototype's fixed `0.85 + 0.15*sin(t*3.1 + seed)` to any
 * (amplitude, frequency) pair from a {@link FlickerProfile}.
 */
export function flickerSlowOctave(profile: FlickerProfile, { t, seed }: FlickerParams): number {
  return 1 - profile.lowAmp + profile.lowAmp * Math.sin(t * 2 * Math.PI * profile.lowFreqHz + seed);
}

/**
 * The fast flutter octave: `1 - highAmp + highAmp * sin(t * 2π * highFreqHz + seed*2.3)`.
 * The `seed * 2.3` phase offset (verbatim from the prototype) keeps the two
 * octaves from locking phase.
 */
export function flickerFastOctave(profile: FlickerProfile, { t, seed }: FlickerParams): number {
  return (
    1 -
    profile.highAmp +
    profile.highAmp * Math.sin(t * 2 * Math.PI * profile.highFreqHz + seed * 2.3)
  );
}

/**
 * The occasional flare: `flareMul` when `sin(t*0.7 + seed*5.0) > flareThreshold`,
 * else `1.0`. The 0.7Hz sine (verbatim from the prototype) is the slow "gust"
 * envelope; the threshold controls how often the gust fires.
 */
export function flickerFlareOctave(profile: FlickerProfile, { t, seed }: FlickerParams): number {
  return Math.sin(t * 0.7 + seed * 5.0) > profile.flareThreshold ? profile.flareMul : 1.0;
}

/**
 * The full flicker multiplier for a given profile: the product of all three
 * octaves. This is what the packer folds into `uLights[i].w = intensity * flickerMul`.
 */
export function computeFlickerMulForProfile(
  profile: FlickerProfile,
  params: FlickerParams,
): number {
  return (
    flickerSlowOctave(profile, params) *
    flickerFastOctave(profile, params) *
    flickerFlareOctave(profile, params)
  );
}

/**
 * The flame-kind discriminator for the flicker-config system. (Defined above,
 * near the top of the module, so the {@link FLICKER_PROFILES} table can
 * reference it.)
 */
// (FlickerFlameKind is exported above — this comment is a navigation anchor.)

/**
 * Resolve a `FlickerFlameKind` to its flicker profile. Falls back to `torch`
 * (the de-facto "modulate" + the verbatim-prototype baseline) for any unknown
 * kind — defensive so a future kind that forgets to add a profile still renders
 * sanely. The `?? FLICKER_PROFILES.torch` also covers the `barrel-fire` kind
 * (which is in `FLICKER_KINDS` defensively but not in the profile table — it
 * falls back to torch, though the placer never emits it so this path is
 * unreachable in practice).
 */
export function resolveFlickerProfile(kind: FlickerFlameKind): FlickerProfile {
  return FLICKER_PROFILES[kind] ?? FLICKER_PROFILES.torch!;
}

/**
 * The per-kind flicker multiplier. Looks up the kind's profile + folds the three
 * octaves. This is the per-kind replacement for the legacy
 * {@link computeFlickerMul} (which was a single torch-shaped profile applied to
 * every flame). Pure + deterministic per (kind, t, seed).
 */
export function computeFlickerMulForKind(kind: FlickerFlameKind, params: FlickerParams): number {
  return computeFlickerMulForProfile(resolveFlickerProfile(kind), params);
}

// ── Legacy API (preserved for the global flame-flicker modulation + tests) ──
// The legacy `flickerSlow` / `flickerFast` / `flickerFlare` / `computeFlickerMul`
// are pinned to the verbatim-prototype torch octaves (their A/B baseline). They
// remain the de-facto "torch profile" — the GameSceneHelpers global flame
// modulation (seed 0.0) and the existing TorchFlicker/LightPacker tests rely on
// them. Per-kind dispatch (campfire/candle/fireplace/etc.) uses
// `computeFlickerMulForKind` above; the explosion uses its own single-pulse
// curve in `ExplosionLightRegistry`.

/**
 * The torch profile as a non-nullable ref. `FLICKER_PROFILES.torch` is
 * `FlickerProfile | undefined` under `noUncheckedIndexedAccess`; this alias
 * captures the defined-or-fallback value once so the legacy helpers below read
 * cleanly. The `?? FLICKER_PROFILES.torch!` is self-referential but safe — if
 * `torch` is somehow undefined the `??`'s RHS throws at runtime (a programming
 * error, not a fallback); the standalone const avoids re-asserting on every call.
 */
const TORCH_PROFILE: FlickerProfile = resolveFlickerProfile('torch');

/** The slow drift octave pinned to the verbatim-prototype torch profile. */
export function flickerSlow({ t, seed }: FlickerParams): number {
  return flickerSlowOctave(TORCH_PROFILE, { t, seed });
}

/** The fast flutter octave pinned to the verbatim-prototype torch profile. */
export function flickerFast({ t, seed }: FlickerParams): number {
  return flickerFastOctave(TORCH_PROFILE, { t, seed });
}

/** The flare octave pinned to the verbatim-prototype torch profile. */
export function flickerFlare({ t, seed }: FlickerParams): number {
  return flickerFlareOctave(TORCH_PROFILE, { t, seed });
}

/**
 * The legacy full flicker multiplier — pinned to the torch profile. Equivalent
 * to `computeFlickerMulForKind('torch', params)`. Preserved for the global
 * flame modulation in `GameSceneHelpers` (which uses seed 0.0 + needs the
 * torch-shaped octave) + the existing pinned determinism tests. NEW per-kind
 * flame callers should use `computeFlickerMulForKind` instead.
 */
export function computeFlickerMul(params: FlickerParams): number {
  return computeFlickerMulForProfile(TORCH_PROFILE, params);
}

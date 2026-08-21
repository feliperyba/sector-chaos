/**
 * Light palette + kind resolver — pure data module (no Phaser, no GPU).
 *
 * Resolves a `LightKind` discriminator to its client-side visual tuning
 * (color, corePower, haloFrac, specPower, cookie texture). The server emits
 * only placements + kind; all visual tuning is client-owned (spec §"Map-gen
 * light data contract").
 *
 * Ticket 07 (A2 findings — GLOBAL radii + diffuseness retune): the verbatim-
 * prototype palette (origin `prototype.js:588-594`, validated by the 06
 * prototype's per-tier blind A/B) is RETUNED here — every kind's corePower is
 * lowered + haloFrac raised so disks read as soft diffuse washes instead of
 * tight hot cores (findings §3: corePower 3.5 dumps 91% of energy inside 50%
 * of radius; the halo is the only term carrying edge energy). The OLD values
 * are recorded in comments per kind as A/B baselines (do NOT silently lose
 * them — same discipline as ticket 23's tone values). Colors are UNCHANGED
 * (the warm fire `[1.0, 0.55, 0.22]` stays — ticket 07 changes falloff shape,
 * not color). `lighting-palette.test.ts` + `LightingTiers.test.ts` are the
 * regression guards.
 */
import type { LightKind } from '@sector-battle/shared';

/**
 * The client-side visual kind set — the shared wire {@link LightKind} (the 8
 * kinds the server emits: torch/campfire/candle/biome-glow/barrel-fire/
 * fireplace/brazier/lantern) PLUS the 3 client-only visual kinds (`fire`,
 * `poison`, `aura`) used by dynamic lights (player auras, fire traps,
 * explosions). Ticket 24 dedupe: the shared `LightPlacementTiled` is now the
 * canonical wire type both client + server consume; this local union is the
 * broader palette-key set so the dynamic-light paths can resolve their extra
 * visual kinds through the same table.
 */
export type ClientLightKind = LightKind | 'fire' | 'poison' | 'aura';

// Re-export the shared LightKind so existing imports from this module keep
// resolving (the canonical type lives in @sector-battle/shared — ticket 24).
export type { LightKind };

/**
 * A resolved light palette entry. Color is linear RGB in [0,1].
 * `cookieKey` names a `light_0*.png` grayscale radial-gradient falloff mask
 * (512×512) — `null` at tier-1 (cookie modulation is ticket 08).
 *
 * D2 (lighting-system-4): `blend` controls how DISTINCT lights of this kind
 * combine in the HdrLit accumulation loop. `'add'` (default — energy should
 * accumulate) for flame/spell/explosion lights; `'max'` for same-color cluster
 * families (aura, biome-glow) where N overlapping lights must NOT sum to white.
 * See `.scratch/lighting-system-4/01-research/light-washout-additive-
 * research.md` Q2 "Technique C — Max-blend instead of additive-blend" (Unity
 * URP "Alpha Blend Overlap Operation"; Godot proposal #891). Packed into
 * `uLightParams[i].w` alongside the cookie index in `LightPacker.packLights`
 * (`cookieIdx + (blend === 'max' ? 10 : 0)` — no separate array, which would
 * overflow `MAX_FRAGMENT_UNIFORM_VECTORS`); read in the HdrLit loop via
 * `lp.w > 9.5`.
 */
export type LightBlendMode = 'max' | 'add';

export interface LightPaletteEntry {
  readonly color: readonly [number, number, number];
  readonly corePower: number;
  readonly haloFrac: number;
  readonly specPower: number;
  readonly cookieKey: string | null;
  /**
   * D2 — how distinct lights of this kind combine in the HdrLit accumulation
   * loop. `'add'` (default): `lit = lit + c - lit*c/K` (energy accumulates, K
   * caps the asymptote). `'max'`: `lit = max(lit, c)` (N same-color lights =
   * brightness of 1). Set `'max'` ONLY on same-color cluster families where
   * summation produces an unplayable whiteout (aura, biome-glow). Everything
   * else stays `'add'` — flame/spell/explosion energy SHOULD accumulate.
   */
  readonly blend: LightBlendMode;
}

/**
 * The validated palette (origin `prototype.js:588-594`).
 *
 * Ticket 07 (A2 findings — GLOBAL radii + diffuseness retune): every kind's
 * `corePower` is lowered (softer core — more energy to the rim) + `haloFrac`
 * raised (more diffuse halo energy). The warm fire color `[1.0, 0.55, 0.22]`
 * is UNCHANGED — only the falloff shape changes (color/intensity/radius live
 * per-light, not per-palette). Radius/intensity tuning lives in the hero
 * overrides + per-light tuning tables (DynamicLightPopulator, etc.).
 *
 * Index ordering matters: `resolveLightKind` reads this table.
 *
 * ── A/B BASELINES (verbatim-prototype → ticket-07) ──
 *   torch       corePower 4.5 → 3.2   haloFrac 0.5  → 0.70
 *   campfire    corePower 4.5 → 3.2   haloFrac 0.5  → 0.75
 *   fire        corePower 5.0 → 3.8   haloFrac 0.4  → 0.65
 *   poison      corePower 4.0 → 3.5   haloFrac 0.6  → 0.70  (aligned, not in A2 table)
 *   candle      corePower 4.2 → 3.2   haloFrac 0.55 → 0.78
 *   biome-glow  corePower 3.5 → 2.8   haloFrac 0.7  → 0.88
 *   barrel-fire corePower 5.0 → 3.8   haloFrac 0.4  → 0.65
 *   aura        corePower 3.5 → 2.5   haloFrac 0.7  → 0.85
 * The OLD (verbatim-prototype) values are load-bearing A/B baselines — the
 * findings doc §3 shows corePower=3.5 dumps 91% of core energy inside 50% of
 * radius; lowering to 2.5 distributes it so the disk reads as a soft wash
 * instead of a tight hot core.
 *
 * ── A/B BASELINE — C2 (lighting-system-3, user ruling 2026-08-07) ──
 *   aura color [0.4, 0.68, 1.0] (cool) → [1.0, 0.95, 0.88] (soft warm-white)
 *   aura cookieKey light_02 (cool) → light_01 (warm) — match the new warm tone
 *   aura radius 256 → 512  (user ruling "2x bigger")
 *   aura intensity 1.2 — UNCHANGED (user said the OLD aura was "too bright"; the
 *   wider radius at the same intensity reads as a softer larger wash, NOT brighter)
 * The OLD cool-blue `[0.4, 0.68, 1.0]` was byte-identical to `biome-glow` and
 * OPPOSITE in hue to every warm flame `[1.0, 0.55, 0.22]` — the aura was the
 * only non-biome-glow cool-blue source in the scene (a hue clash). Soft warm-
 * white matches the RANGED projectile tone `[1.0, 0.96, 0.85]` — "clean light"
 * distinct from flames but no longer clashing. The cool "identity halo" AAA
 * rationale (Lichtner / Jen Zee warm=friend cool=foe) is superseded for the
 * solo-queue context — there is no friend/foe hue-coding benefit to the local
 * player's OWN aura, and the cool blue read as a hue error against an
 * otherwise warm scene. corePower/haloFrac are UNCHANGED (the diffuseness
 * character was correct — the fix is tone + size, not diffuseness).
 */
export const LIGHT_PALETTE: Readonly<Record<ClientLightKind, LightPaletteEntry>> = {
  torch: {
    color: [1.0, 0.55, 0.22], // warm-orange fire — UNCHANGED (ticket 07 changes falloff, not color)
    corePower: 3.2, // was 4.5 (verbatim) — softer core so the halo carries the edge
    haloFrac: 0.7, // was 0.5 — more diffuse halo energy
    specPower: 28.0,
    cookieKey: 'light_01',
    // D2: additive — a single torch's energy should accumulate with adjacent
    // torches (rare in practice; the per-family K asymptote caps the sum).
    blend: 'add',
  },
  campfire: {
    // Campfires use the torch palette (warm) per the prototype's hero override;
    // radius/intensity/flicker come from the placement, not the palette.
    color: [1.0, 0.55, 0.22],
    corePower: 3.2, // was 4.5 — the scene anchor light floods its junction with soft spill
    haloFrac: 0.75, // was 0.5 — widest halo of the warm flame family
    specPower: 28.0,
    cookieKey: 'light_01',
    blend: 'add',
  },
  fire: {
    color: [1.0, 0.3, 0.12], // hot red — UNCHANGED
    corePower: 3.8, // was 5.0 — softer so fire-trap + explosion read as diffuse flame, not dots
    haloFrac: 0.65, // was 0.4
    specPower: 22.0,
    cookieKey: 'light_01',
    // D2: additive — overlapping fire traps / flame patches should sum (energy
    // SHOULD accumulate for flame).
    blend: 'add',
  },
  poison: {
    color: [0.5, 1.0, 0.4],
    corePower: 3.5, // was 4.0 — aligned with the global diffuseness direction (not in the A2 table; A2-derived)
    haloFrac: 0.7, // was 0.6
    specPower: 26.0,
    cookieKey: 'light_03',
    blend: 'add',
  },
  candle: {
    color: [1.0, 0.85, 0.5], // warm gold — UNCHANGED
    corePower: 3.2, // was 4.2 — the smallest flame still reads soft, not a hard dot
    haloFrac: 0.78, // was 0.55 — high halo keeps the candle's small disk diffuse
    specPower: 30.0,
    cookieKey: 'light_01',
    blend: 'add',
  },
  'biome-glow': {
    // Cool magical ambient — already the softest tuning; pushed further diffuse.
    color: [0.4, 0.68, 1.0], // cool — UNCHANGED
    corePower: 2.8, // was 3.5 — the diffuse wash light, flattest core in the palette
    haloFrac: 0.88, // was 0.7 — the most diffuse halo (magical ambient reads as a soft wash)
    // specPower 32 → 20 (lighting-mood pass): 32 was the SHARPEST exponent in
    // the palette, which — under the albedo-modulated specular model — left the
    // crystal's light producing almost no visible sheen on surrounding surfaces
    // (a tight half-vector highlight too small to read). 20 broadens the sheen
    // so a biome-glow crystal actually lights the faces around it; paired with
    // the stronger sobel normal pass + the un-tempered specular scale, crystals
    // finally "use" the specular effect the fire lights already benefit from.
    specPower: 20.0,
    cookieKey: 'light_02',
    // D2: max-blend — clustered magical crystals (same cool color) must NOT
    // sum to white. N same-color biome-glow lights = brightness of 1. Unity
    // URP "Alpha Blend Overlap Operation" (research Q2 Technique C).
    blend: 'max',
  },
  'barrel-fire': {
    // Reuses the hottest fire palette; barrel-fire is an explosive flash.
    color: [1.0, 0.3, 0.12],
    corePower: 3.8, // was 5.0 — aligned with `fire` (explosions/traps now diffuse)
    haloFrac: 0.65, // was 0.4
    specPower: 22.0,
    cookieKey: 'light_01',
    // D2: additive — a barrel explosion is energy that SHOULD accumulate with
    // adjacent flashes (the whiteout complaint was specifically about player
    // clusters, not explosions).
    blend: 'add',
  },
  // ── Ticket 08 (A4): the three new fire-source kinds (fireplace/brazier/
  // lantern). Each inherits the ticket-07 diffuseness conventions (lowered
  // corePower + raised haloFrac) so the disks read as soft warm washes. The
  // warm fire color `[1.0, 0.55, 0.22]` is shared with torch/campfire — these
  // are flame-family fixtures. Radius/intensity live in the hero overrides
  // below (fireplace 320 / brazier 240 / lantern 140 per the A4 §6 + ticket-07
  // tile-units convention). NEW entries — ticket 07 only touched the existing
  // kinds; these are additive. ──
  fireplace: {
    // Fireplace: a large indoor fire (the hearth). Warmest of the three new
    // kinds; a wide soft wash that floods an interior. Palette matches campfire
    // (the user's "roars like a campfire" ruling applies to the FLICKER, not
    // the palette color); radius/intensity tuned via the hero override.
    color: [1.0, 0.55, 0.22],
    corePower: 3.2, // aligned with campfire — soft wide core
    haloFrac: 0.78, // widest halo of the new three (a hearth floods the room)
    specPower: 28.0,
    cookieKey: 'light_01',
    blend: 'add',
  },
  brazier: {
    // Brazier: a raised bowl of coals at a junction/plaza. Steady-medium;
    // tighter than a fireplace (the bowl channels the flame) but wider than a
    // lantern. Slightly hotter core (the coals are concentrated) but still
    // diffuse per ticket 07.
    color: [1.0, 0.5, 0.18], // a touch more orange than torch (coals, not open flame)
    corePower: 3.4, // slightly tighter than fireplace
    haloFrac: 0.72,
    specPower: 26.0,
    cookieKey: 'light_01',
    blend: 'add',
  },
  lantern: {
    // Lantern: an enclosed flame behind glass (corridor accent). The smallest +
    // steadiest of the three; the enclosure damps the flame so the disk reads
    // as a tight steady point of light. Higher corePower (smaller, more
    // concentrated disk) but still soft per ticket 07.
    color: [1.0, 0.7, 0.35], // warmer gold (the glass tints the flame)
    corePower: 3.6, // tighter core (it's a small enclosed flame)
    haloFrac: 0.7,
    specPower: 30.0,
    cookieKey: 'light_01',
    blend: 'add',
  },
  aura: {
    // Soft warm-white player aura — the avatar's "living light source" halo.
    // C2 (lighting-system-3, user ruling 2026-08-07): the OLD cool-blue tone
    // [0.4, 0.68, 1.0] was byte-identical to biome-glow + OPPOSITE hue to every
    // warm flame [1.0, 0.55, 0.22] (the aura was the only non-biome-glow cool
    // source in an otherwise warm scene — a hue clash). Changed to soft warm-
    // white [1.0, 0.95, 0.88], matching the RANGED projectile tone [1.0, 0.96,
    // 0.85] — reads as "clean light," distinct from flames (whiter) but no
    // longer a hue clash. Cookie flipped light_02 (cool) → light_01 (warm) so
    // the cookie doesn't tint the warm color back toward cool. The cool
    // "identity halo" AAA rationale (Lichtner / Jen Zee warm=friend cool=foe)
    // is superseded for the solo-queue context: there is no friend/foe hue-
    // coding benefit to the local player's OWN aura. corePower/haloFrac stay
    // (the soft identity-halo diffuseness was correct).
    color: [1.0, 0.95, 0.88], // C2: was [0.4, 0.68, 1.0] (cool) — soft warm-white neutral
    corePower: 2.0, // D2fix: was 2.5 — flatten the core further so the center reads soft (user: "heat zone too bright")
    haloFrac: 0.85, // was 0.7 — most energy to the diffuse rim
    specPower: 32.0,
    cookieKey: 'light_01', // C2: was 'light_02' (cool) — flip to warm to match the new tone
    // D2: max-blend — THE whiteout fix. 64 players clustered in a sector would
    // otherwise sum 64 same-color auras into an unplayable bright mass (the
    // user's "MANY PLAYERS CLOSE TO EACH OTHER ... IMPOSSIBLE TO PLAY" report).
    // Max-blend makes N same-color auras = brightness of 1 aura — no
    // information lost (all auras are the same warm-white). Unity URP "Alpha
    // Blend Overlap Operation" (research Q2 Technique C, ranked #1 for the
    // exact case).
    blend: 'max',
  },
  beacon: {
    // Map-redesign ticket 04 (DEC-002/005) — the hero-landmark destination
    // light. The palette entry is a NEUTRAL default: every in-game beacon
    // placement carries per-placement color/radius/intensity/pulse overrides
    // authored by the shared generation (theme colors — the sector TYPE's
    // identity hue, map-polish ticket 03 — + value-band-capped tier
    // intensities; see shared `landmarks.ts` BEACON_THEME_LIGHT /
    // BEACON_TIER_LIGHT). No flicker
    // (a beacon breathes, it does not gutter — the packer applies the slow
    // `pulse` sine instead). Additive: beacons never overlap (one per
    // sector), so accumulation is moot.
    //
    // Map-polish ticket 01 (moody retune): the falloff TIGHTENS so the disk
    // reads as a focused, atmospheric distant glow instead of a wide blanket
    // washing the tiles beneath (old rim-heavy halo over 4.5–5.0 tiles lifted
    // mid-disk floor tiles into the wall value band). Radius/intensity are
    // retuned server-side (shared `landmarks.ts`): hero 576→512, band
    // [2.6,2.8]→[2.45,2.6].
    //
    // Map-polish ticket 17 (round 2 — "kill the wash"): ticket-01's
    // 3.2/0.70 was still halo-dominant — the smoothstep rim kept mid-disk
    // atten 1.19, so every pixel with lit-luma ≥0.55 (the bloom bright-pass
    // threshold) bloomed: the beacon read as ONE BIG white-blue BLOOM
    // dominating its region, and the ticket-02 motes (drawn into the albedo
    // beneath that bloom) were invisible. The falloff is re-cut CORE-dominant:
    // a tighter, dimmer hot core + a fast-dropping moody mid. This deviates
    // DELIBERATELY from the ticket-07 diffuseness convention (every flame is
    // halo-dominant): the beacon is a DESTINATION marker read from distance —
    // a lighthouse, not a hearth. DEC-005 hierarchy survives via intensity
    // parity (2.6 == campfire top) + radius dominance (512 vs 320 — the
    // beacon out-delivers every sconce past ~1.5 tiles).
    //
    // Map-polish ticket 30 (round 3 — the motes wash): with the motes moved
    // ABOVE the composite, the glow must become a BACKDROP, not a white-out.
    // Ticket 17's 4.2/0.50 over-saturated the core (peak atten 3.9 — a
    // white-ish blob the sparks cannot read against, even on top). The core
    // is eased to 3.4/0.44: peak atten 3.74 (−21%), still the equal-top
    // static by INTENSITY parity (DEC-005 intensity band 2.45–2.6 in shared
    // `landmarks.ts` UNTOUCHED — palette shaping is client-side presentation
    // only), mid-disk atten 0.82 (still ≤0.7× the ticket-01 baseline — the
    // ticket-17 anti-wash gates all hold; see BeaconLandmark.test.ts).
    // ── A/B BASELINE (map-redesign ticket 04 → ticket 01 → ticket 17 → ticket 30) ──
    //   corePower 2.6 → 3.2 → 4.2 → 3.4   (focused core; round 3 eases the
    //                                       white-out so the glow reads as a
    //                                       backdrop under the over-composite
    //                                       motes — lantern 3.6/fire 3.8 still
    //                                       tighter)
    //   haloFrac  0.85 → 0.70 → 0.50 → 0.44 (below every flame's rim — the
    //                                       mid-disk floor stays IN the floor
    //                                       value band)
    //   specPower 20 → 16 → 16 → 16       (unchanged — already softened)
    // Modeled effect (pure falloff math, hero HOT 2.6/512): mid-disk atten
    // 0.82 (ticket 17: 0.79 — within the moody band, ≤0.7× ticket-01's 1.19);
    // super-albedo (atten>1) radius ≈228px; core peak 3.74 (−21% vs 17's 3.90);
    // bloom-engagement (atten ≳1.7 over gold floors) radius ≈147px (ticket 17:
    // ≈144 — the bloom stays a tight halo around the crystal). The OLD values
    // are the load-bearing A/B baseline.
    color: [1.0, 0.83, 0.4], // never-fires fallback: every beacon placement overrides color per sector theme (ticket 15) — kept only so a missing kind resolves
    corePower: 3.4, // was 4.2 (ticket 17), was 3.2 (ticket 01), was 2.6 (ticket 04) — glow as backdrop (ticket 30)
    haloFrac: 0.44, // was 0.50 (ticket 17), was 0.70 (ticket 01), was 0.85 (ticket 04) — fast-dropping moody mid
    specPower: 16.0, // was 20.0 (ticket 04) — softer specular read at distance
    cookieKey: 'light_02',
    blend: 'add',
  },
};

/** Resolve a `ClientLightKind` to its palette entry. Falls back to `torch`. */
export function resolveLightKind(kind: ClientLightKind): LightPaletteEntry {
  return LIGHT_PALETTE[kind] ?? LIGHT_PALETTE.torch;
}

/**
 * Hero-light radius/intensity overrides (origin: prototype `spawnLights`).
 *
 * Ticket 07 (A2 findings — GLOBAL radii retune): every radius widened, every
 * intensity dimmed so the wider disk doesn't blow out. Tile = 128px; player
 * hitbox = 96×96 (`packages/shared/src/constants/player.ts:13-14`). The
 * principle: wider + softer (palette corePower/haloFrac, see above) + dimmer
 * absolute intensity so the disk reads as a diffuse wash, not a hot stamp.
 *
 * ── A/B BASELINES (verbatim-prototype → ticket-07) ──
 *   campfire  radius 260 (2.03 tiles) → 320 (2.5 tiles)   intensity 3.2 → 2.6
 *   aura      radius 160 (1.25 tiles) → 256 (2.0 tiles)   intensity 1.9 → 1.2
 * ── A/B BASELINE — C2 (lighting-system-3, user ruling 2026-08-07) ──
 *   aura radius 256 (2.0 tiles) → 512 (4.0 tiles)  (user ruling "2x bigger")
 *   aura intensity 1.2 — UNCHANGED (user said the OLD aura was "too bright";
 *   wider radius at the same intensity reads as softer + larger wash, not brighter)
 */
export const HERO_LIGHT_OVERRIDES: Readonly<
  Partial<Record<ClientLightKind, { radius: number; intensity: number; flicker: boolean }>>
> = {
  // Campfire: 320px = 2.5 tiles (was 260 = 2.03). The scene's anchor light —
  // floods a junction with warm spill. Intensity 2.6 (was 3.2) so the wider
  // disk stays soft, not blown. NOTE: pre-C2 the aura was SMALLER than campfire
  // (256 < 320) for proportional hierarchy; C2 widens the aura to 512 (user
  // ruling "2x bigger"), so the aura is now WIDER than the campfire. That's
  // intentional — the aura is a constant companion halo (always around the
  // player), the campfire is a fixed scene anchor; the wider soft aura at
  // intensity 1.2 (vs campfire 2.6) reads as a faint wash, not an overpowering
  // flood, so the hierarchy is preserved in INTENSITY even with the aura wider
  // in RADIUS.
  campfire: { radius: 320, intensity: 2.6, flicker: true },
  // Player aura: 640px = 5.0 tiles (user ruling: +25% on the prior 512 = 4.0
  // tiles, which itself was C2's 2x from the original 256). The halo extends
  // (640-48)=592px = 4.6 tiles past each edge of the 96px hitbox — a wide,
  // soft presence wash.
  // Intensity 0.7 (D2fix: was 1.2 — user: "the heat zone/center of the lights
  // FOR THE PLAYERS are too bright still"). The core peak scales linearly with
  // intensity (`atten = (coreT + halo*haloFrac) * intensity`); 1.2→0.7 was a
  // ~42% core reduction. Paired with corePower 2.5→2.0 (flatter core), the
  // center reads as a soft wash, not a searing hotspot. Cosmetic-only
  // (GDD 210: no fog of war — the aura is a mood halo, NOT a vision mechanic).
  // Lighting-mood pass: 0.7→0.6 — a further modest tone-down so the wide aura
  // (640px) reads as a quieter halo against the moodier fire-lit scene.
  aura: { radius: 640, intensity: 0.6, flicker: false },
  // Candle (ticket 07): the SMALLEST flame prop — keep it tactical (a mood
  // accent, not a flood). 192px = 1.5 tiles (was default 200 = 1.56 — modest
  // widen to the A2 §5 floor of 180-230); intensity 1.4 (was default 2.5).
  // The diffuseness comes from palette corePower 3.2 / haloFrac 0.78, so the
  // small disk reads soft + warm, just smaller than torch/campfire. Proportional
  // hierarchy (A2 §5): campfire (320) > torch/biome-glow (256) > candle (192).
  candle: { radius: 192, intensity: 1.4, flicker: true },
  // ── Ticket 08 (A4): the three new fire-source hero overrides. Radii in tiles
  // per the ticket-07 convention; intensities dimmer so the wider disks stay
  // soft (same principle as ticket 07's aura/campfire cuts). NEW entries —
  // additive to the ticket-07 overrides above. ──
  // Fireplace: 320px = 2.5 tiles (same as campfire — a hearth is a campfire in
  // a wall). The biggest of the three; floods an interior. Intensity 2.6
  // (aligned with campfire) so the wide disk stays soft. Flicker ON (the user's
  // "roars like a campfire" — see TorchFlicker.FLICKER_PROFILES.fireplace).
  fireplace: { radius: 320, intensity: 2.6, flicker: true },
  // Brazier: 240px = 1.875 tiles (between campfire 320 and torch 256). A
  // junction/plaza accent. Intensity 2.1 (steady-medium — the bowl shelters
  // the flame). Flicker ON (the user's "medium amp, steady" — see
  // TorchFlicker.FLICKER_PROFILES.brazier).
  brazier: { radius: 240, intensity: 2.1, flicker: true },
  // Lantern: 140px = 1.09 tiles (the smallest flame prop — smaller than candle
  // 192; an enclosed point of light). A corridor accent. Intensity 1.3 (dim —
  // the enclosure damps the output). Flicker ON but tiny amplitude (the user's
  // "tiny amp, very steady" — see TorchFlicker.FLICKER_PROFILES.lantern).
  lantern: { radius: 140, intensity: 1.3, flicker: true },
  // Beacon (map-redesign ticket 04, retuned map-polish ticket 01): 512px =
  // 4.0 tiles — DEC-005 requires radius ≥ 512 (the SPEC §7 floor) so the
  // landmark glow reads from a distance. Intensity 2.6 sits at the authored
  // [2.45, 2.6] band top (shared `landmarks.ts`): equal to the brightest
  // other static kind (campfire/fireplace peak 2.6) with the WIDEST radius
  // (512 vs their 320 — the beacon dominates its sector well beyond their
  // falloff) and below the explosion VFX band (~4.1), keeping the player/VFX
  // value band supreme. These are the FALLBACK values — in-game placements
  // carry explicit theme-hue + tier-value overrides (2.6/2.55/2.5/2.45
  // intensity coding). Flicker OFF (the pulse flag breathes it). A/B
  // baseline: radius 576 → 512, intensity 2.7 → 2.6.
  beacon: { radius: 512, intensity: 2.6, flicker: false },
};

/**
 * Default hero-light fallbacks for kinds WITHOUT an explicit
 * {@link HERO_LIGHT_OVERRIDES} entry (torch/biome-glow/barrel-fire).
 *
 * Ticket 07 (A2 findings): radius 200 → 256 (2.0 tiles) for torch/biome-glow;
 * intensity 2.5 → 1.9 (dimmer so the wider disk doesn't blow out). Candle
 * gets its own explicit override above (smaller — tactical mood accent).
 *
 * Was: radius 200 (1.56 tiles), intensity 2.5 (verbatim from the prototype's
 * per-kind fallback). Also the historical default in `LightPacker.packLights`
 * and `LightingBudgetStage.select` (centralized here so the two sites stay in
 * sync — ticket 24). Load-bearing for the WOW verdict — do NOT drift.
 */
export const DEFAULT_HERO_LIGHT = {
  radius: 256, // was 200 (1.56 tiles) → 2.0 tiles — torch/biome-glow widened
  intensity: 1.9, // was 2.5 — dimmer so the wider disk reads soft, not blown
} as const;

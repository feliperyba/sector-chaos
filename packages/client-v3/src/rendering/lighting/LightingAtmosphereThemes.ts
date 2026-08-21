/**
 * LightingAtmosphereThemes — per-SECTOR atmosphere recipes (map-polish round 5,
 * reworked in 5c). Owner directive, verbatim: the mood particles must be
 * "different for each theme, not the same circle with the same tone" — and
 * "DO NOT OVER DO IT".
 *
 * ── Round-5c lesson (why this file exists in this shape) ──
 *
 * Round 5b themed the dust per PARTICLE on one shared circle texture, tinted
 * with the district wallTint lifted 50% toward white. Two failures, both
 * owner-reported: (a) the lift BLEACHED the four hues into four pale pastels
 * (luminance 0.79–0.87) — indistinguishable at 3–6px, "the same circle with
 * the same tone"; (b) the envelope (count/size/alpha) overshot into "too much
 * and distracting". 5c therefore moves the theming from per-particle ops to
 * PER-SECTOR EMITTERS: one emitter per district, each with its own SHAPE
 * texture, SATURATED district hue, size band, drift, settle and shimmer band
 * — legibly different silhouettes at a border crossing — with the total
 * budget pulled back (see LightingAtmosphereConfig) and split across the
 * on-screen sectors by area (LightingAtmosphereSectorField).
 *
 * ── Hues: district family, SATURATED (not lifted) ──
 *
 * Each hue stays in its identity-sheet wallTint family (steel / sage / violet
 * / gold — `SECTOR_IDENTITY`) but is authored SATURATED: small additive
 * particles discriminate by HUE, so chroma — not luminance — is what makes
 * two districts' air read differently (the 5b pastels carried luminance but
 * no chroma). Authored constants (not derived) so the table is the single
 * designer-tunable surface; the themes test pins pairwise distinctness.
 *
 * ── Discipline (mood, not weather — and never in the way) ──
 *
 * Peaks (base+amp) ≤ 0.85, settle ≤ 12 px/s, worst-case rendered mote
 * Ø = sizeMax × max parallax band × 2 ≤ 11px (vs the 96px hitbox), and — the
 * round-5d lesson — every district's FAR-band canvas Ø (2 × sizeMin × 0.85)
 * stays ≥ 3px: sub-3px motes are invisible at gameplay attention, which read
 * as "renders nothing at all". All pinned by the themes test. Zero RNG:
 * recipes are static; spawn positions/velocities stay atmosphereSeed-driven
 * (ADR-0035 spirit).
 *
 * Pure + Phaser-free so the Seam A vitest asserts the table WITHOUT booting
 * Phaser. The SHAPE → texture-key mapping + generators live in
 * LightingAtmosphereTextures (Phaser-side).
 */
import { SectorType } from '@sector-battle/shared';
import {
  DUST_COLOR,
  DUST_SHIMMER_AMP,
  DUST_SHIMMER_BASE,
  DUST_SHIMMER_FREQ,
  DUST_SIZE_MAX,
  DUST_SIZE_MIN,
} from './LightingAtmosphereConfig.js';

/**
 * The particle silhouette a district's air carries. One distinct shape per
 * sector (the round-5c ask: not "the same circle") — textures generated
 * procedurally at boot (LightingAtmosphereTextures).
 */
export type SectorParticleShape = 'spark' | 'grain' | 'haze' | 'glint';

/**
 * A sector's full dust recipe — everything one per-sector emitter needs.
 * Owned here so tuning never touches emitter code (SPEC user story 44).
 */
export interface SectorAtmosphereTheme {
  /**
   * Dust body tint — the district's SATURATED family hue (see module header:
   * chroma, not luminance, is the differentiator at particle sizes).
   */
  dustTint: number;
  /** The district's particle silhouette (its texture shape). */
  shape: SectorParticleShape;
  /** Size band (prototype `size` units — a `fillCircle` RADIUS in px). */
  sizeMin: number;
  sizeMax: number;
  /** Drift-speed multiplier (folds into the seeded vx/vy). */
  speedMul: number;
  /** Constant downward drift (px/s) at emit — pollen settles, haze hangs. */
  driftYBias: number;
  /** Shimmer alpha band + speed (per-frame sin, phase from the seed table). */
  shimmerBase: number;
  shimmerAmp: number;
  shimmerFreq: number;
}

/**
 * The neutral fallback recipe — the pre-ticket global dust behavior (canonical
 * cool circle, unit multipliers). Used when the sector-type grid is unknown
 * (demo TMX map, pre-map-load boot, the menu diorama) — no visual cliff.
 */
export const NEUTRAL_ATMOSPHERE_THEME: SectorAtmosphereTheme = {
  dustTint: DUST_COLOR,
  shape: 'spark', // circle-textured in the emitter wiring (see Textures module)
  sizeMin: DUST_SIZE_MIN,
  sizeMax: DUST_SIZE_MAX,
  speedMul: 1,
  driftYBias: 0,
  shimmerBase: DUST_SHIMMER_BASE,
  shimmerAmp: DUST_SHIMMER_AMP,
  shimmerFreq: DUST_SHIMMER_FREQ,
};

/**
 * Per-sector-type recipes (identitySheets.ts district fictions):
 *
 *  - GRID_ARENA "fortified depot yards": sharp steel-blue SPARKS — small,
 *    quick, nervous flicker (vent-charged industrial air).
 *  - OPEN_ARENA "overgrown landing fields": warm sage GRAINS — elongated
 *    pollen, slow living drift, gentle settle, steady shimmer.
 *  - MAZE "abandoned ruins": violet HAZE blobs — the largest, slowest,
 *    dimmest motes; air that hangs dead-still in the ruin halls.
 *  - RESOURCE_RICH "gilded vault district": gold GLINTS — small four-point
 *    sparks with the hardest twinkle (light catching off the treasures).
 */
export const SECTOR_ATMOSPHERE_THEMES: Readonly<Record<SectorType, SectorAtmosphereTheme>> = {
  [SectorType.GRID_ARENA]: {
    dustTint: 0x8fc7ff, // saturated steel-blue (wallTint 0x93a7bd family)
    shape: 'spark',
    sizeMin: 1.8,
    sizeMax: 2.8,
    speedMul: 1.3,
    driftYBias: 0,
    shimmerBase: 0.55,
    shimmerAmp: 0.3,
    shimmerFreq: 2.4, // fast flicker (band 0.25..0.85)
  },
  [SectorType.OPEN_ARENA]: {
    dustTint: 0xcfe08a, // saturated sage-chartreuse (wallTint 0xbcc793 family)
    shape: 'grain',
    sizeMin: 2.2,
    sizeMax: 3.2,
    speedMul: 0.7,
    driftYBias: 8, // gentle pollen settle
    shimmerBase: 0.5,
    shimmerAmp: 0.2,
    shimmerFreq: 0.6, // slow steady breathing (band 0.30..0.70)
  },
  [SectorType.MAZE]: {
    dustTint: 0xb79ce8, // saturated violet (wallTint 0x9d92ae family)
    shape: 'haze',
    sizeMin: 3.0,
    sizeMax: 4.4,
    speedMul: 0.45,
    driftYBias: 0,
    shimmerBase: 0.42,
    shimmerAmp: 0.12,
    shimmerFreq: 0.35, // dim-but-present hanging haze (band 0.30..0.54)
  },
  [SectorType.RESOURCE_RICH]: {
    dustTint: 0xffd77a, // saturated gold (wallTint 0xd2b476 family)
    shape: 'glint',
    sizeMin: 2.2,
    sizeMax: 3.2,
    speedMul: 0.8,
    driftYBias: 3,
    shimmerBase: 0.5,
    shimmerAmp: 0.35,
    shimmerFreq: 1.6, // hard glint spikes (band 0.15..0.85, dark troughs)
  },
};

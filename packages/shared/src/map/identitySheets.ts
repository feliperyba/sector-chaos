import { SectorLootTier, SectorType, type SectorWeather } from './types.js';

/**
 * Sector identity sheets (map-redesign ticket 07 / DEC-006) — the authored,
 * DATA-DRIVEN identity for each sector type: one material fiction line
 * enforced across visuals via
 *
 *   1. a per-type WALL TINT replacing the single global grey 0xbbbbcc
 *      (mid value band, autotiling unaffected — the tint multiplies the same
 *      autotiled wall frames),
 *   2. per-type FLOOR TINT FIELD families (base ± wear near doors, stain near
 *      hazard clusters) painted as seeded macro blobs by the visual-identity
 *      pass (`visualIdentity.ts`),
 *   3. a GATEWAY dressing spec (bracket pair + accent from existing
 *      `game`-atlas DECOR frames only — map-polish ticket 06 bans object
 *      visuals from every bake input; the arch frame was REMOVED by
 *      map-polish ticket 19) composed at every sector corridor opening,
 *   4. WEATHER BIAS weights applied to the per-sector weather roll (mild,
 *      deterministic, fiction + tier keyed).
 *
 * Everything a designer would retune lives HERE (constants only) so tuning
 * never requires touching algorithms (SPEC user story 44). The identity must
 * survive DESATURATION: hue + light temperature + prop silhouette + value
 * band together — the wall tints below are authored so their Rec.709
 * luminances are pairwise separated (the grayscale double-coding; the shared
 * test suite asserts the separation numerically) and all sit inside the mid
 * value band strictly above the floor-field band and strictly below the
 * gameplay/beacon band.
 */

/** The per-sector-type weather roll keys (mirrors `SectorWeather['weatherType']`). */
export type WeatherType = SectorWeather['weatherType'];

// ─── Value bands (DEC-006: floors darkest < walls mid < gameplay brightest) ───

/**
 * The FLOOR field tint band (Rec.709 luminance). Floors are the darkest
 * surface band: the floor tint fields modulate the biome floor downward so
 * walls, entities and lights always read on top.
 */
export const FLOOR_FIELD_VALUE_BAND = { min: 0.16, max: 0.4 } as const;

/**
 * The WALL tint band (Rec.709 luminance). Walls stay in the mid value band —
 * the legacy global grey 0xbbbbcc sits at ~0.738 inside it, so every per-type
 * tint is a mid-band sibling of the old grey, never a value-band break.
 */
export const WALL_VALUE_BAND = { min: 0.55, max: 0.78 } as const;

/**
 * Minimum Rec.709 luminance separation between any two wall tints — the
 * grayscale/desaturation double-coding: with hue removed, the four districts
 * remain distinguishable by wall value alone (paired with per-type landmark
 * silhouettes + light temperature).
 */
export const WALL_TINT_MIN_LUM_SEPARATION = 0.03;

/**
 * Minimum luminance GAP between the floor band ceiling and the wall band
 * floor — the value-band audit's "floors darkest, walls mid" invariant.
 */
export const FLOOR_WALL_VALUE_GAP = 0.15;

/**
 * Rec.709 relative luminance of a 0xRRGGBB tint (the desaturation operator:
 * converting a color to its grayscale value). Used by the identity test
 * suite's value-band audit and by nothing at render time.
 */
export function tintLuminance(tint: number): number {
  const r = ((tint >> 16) & 0xff) / 255;
  const g = ((tint >> 8) & 0xff) / 255;
  const b = (tint & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ─── The sheets ───────────────────────────────────────────────────────────────

/** Per-type floor tint family: base field ± wear ring near doors, stain near hazards. */
export interface FloorTintFamily {
  /** The type's macro base field tint (large soft field, sector-wide read). */
  base: number;
  /** Wear ring tint near corridor doors (trodden ground). */
  wear: number;
  /** Stain field tint near hazard clusters (barrels/traps — damp, marked). */
  stain: number;
  /** Bake alpha for the floor fields (soft overlay, never opaque). */
  alpha: number;
}

/** Per-type gateway frame composition spec (existing `game`-atlas frames only). */
export interface GatewaySpec {
  /**
   * The door/arch frame placed on the opening center tile. EMPTY STRING
   * (map-polish ticket 19, owner ruling: "remove the exit/stairs tile from
   * the middle of the corridor") — no arch is placed: the corridor floor is
   * clean passage. The client bake's missing-frame guard (`gameAtlas.has`)
   * skips the draw, so the empty sentinel removes the placement with zero
   * client changes. If a future ticket restores an arch, the value must be a
   * `DECOR_BAKE_FRAMES` member (never an object visual — map-polish ticket 06).
   */
  archFrame: string;
  /**
   * The sconce-bracket twin frame (visual-only pair member; see gateway
   * bake). Decor frame only — never a wall visual (`wall_half` is banned
   * from bakes by map-polish ticket 06; the mounts are dressing beneath the
   * REAL ticket-10 doorway sconce lights, which stay server placements).
   */
  bracketFrame: string;
  /**
   * Per-type accent prop drawn at the aligned (entering-shot) side. Decor
   * frame only — never a crate/barrel visual (banned from bakes by
   * map-polish ticket 06).
   */
  accentFrame: string;
  /** Neutral tint for the arch (stone reads district-free at the seam). */
  archTint: number;
}

/** The authored identity sheet for one sector type (DEC-006). */
export interface SectorIdentitySheet {
  /** One-line material fiction enforced across the type's visuals. */
  fiction: string;
  /** Wall tint (mid value band; replaces the global 0xbbbbcc grey). */
  wallTint: number;
  /** Floor tint field family (darkest band). */
  floor: FloorTintFamily;
  /** Gateway dressing frame composition spec. */
  gateway: GatewaySpec;
  /** Fiction-keyed weather bias deltas (mild; clamped with the tier bias). */
  weatherBias: Readonly<Partial<Record<WeatherType, number>>>;
}

/**
 * The four identity sheets. Wall tint luminances (pairwise ΔL ≥ 0.03, all in
 * the mid band): GRID_ARENA 0.645 < RESOURCE_RICH 0.713 < OPEN_ARENA 0.757,
 * with MAZE darkest at 0.590 — four distinguishable grayscale steps.
 */
export const SECTOR_IDENTITY: Readonly<Record<SectorType, SectorIdentitySheet>> = {
  [SectorType.GRID_ARENA]: {
    fiction: 'fortified depot yards',
    // Cool steel-blue grey, L≈0.645 — heavy industry reads darker.
    wallTint: 0x93a7bd,
    floor: {
      base: 0x3e4a5c, // slate yard wash (L≈0.285)
      wear: 0x4a5262, // trodden steel plate near doors (L≈0.319)
      stain: 0x2f3846, // oil stain near hazard clusters (L≈0.216)
      alpha: 0.34,
    },
    gateway: {
      // No arch (map-polish ticket 19: the stairs_down exit/stairs frame was
      // removed from corridor midpoints by owner ruling — clean passage); steel
      // rail section = the sconce mount; armored corner plate = the
      // entering-shot marker. (Map-polish ticket 06: all decor frames — the
      // old doorway/crate_small object visuals are banned from bakes.)
      archFrame: '',
      bracketFrame: 'track',
      accentFrame: 'tiles_corner',
      archTint: 0xc6c2b8,
    },
    weatherBias: { HEAVY_RAIN: 5, LIGHT_RAIN: 3, NONE: -8 }, // industrial grime
  },
  [SectorType.OPEN_ARENA]: {
    fiction: 'overgrown landing fields',
    // Sun-bleached sage, L≈0.757 — open fields read lightest.
    wallTint: 0xbcc793,
    floor: {
      base: 0x46523a, // mossy loam wash (L≈0.305)
      wear: 0x5a6140, // worn landing strip near doors (L≈0.365)
      stain: 0x333d2a, // damp grass stain near hazards (L≈0.226)
      alpha: 0.3,
    },
    gateway: {
      // No arch (map-polish ticket 19 — stairs removed from corridor
      // midpoints); timber plank = the sconce mount (overgrown fields
      // fiction). `plants` accent is already decor (kept).
      archFrame: '',
      bracketFrame: 'wood',
      accentFrame: 'plants',
      archTint: 0xc6c2b8,
    },
    weatherBias: { NONE: 5, STORM: -3 }, // open sky, clear heads
  },
  [SectorType.MAZE]: {
    fiction: 'abandoned ruins',
    // Ash violet-grey, L≈0.590 — ruins read darkest-mid.
    wallTint: 0x9d92ae,
    floor: {
      base: 0x453f52, // damp ash wash (L≈0.257)
      wear: 0x524c60, // dust path near doors (L≈0.309)
      stain: 0x302c3c, // cold moss stain near hazards (L≈0.180)
      alpha: 0.36,
    },
    gateway: {
      // No arch (map-polish ticket 19 — stairs removed from corridor
      // midpoints); set stone plate = the sconce mount on the ruin walls.
      // `tiles_cracked` accent is already decor (kept).
      archFrame: '',
      bracketFrame: 'tiles_center',
      accentFrame: 'tiles_cracked',
      archTint: 0xc6c2b8,
    },
    weatherBias: { LIGHT_RAIN: 5, SNOW: 3, NONE: -8 }, // mist-haunted
  },
  [SectorType.RESOURCE_RICH]: {
    fiction: 'gilded vault district',
    // Gilded warm grey-gold, L≈0.713 — wealth reads bright-mid.
    wallTint: 0xd2b476,
    floor: {
      base: 0x5a4a2e, // rich umber wash (L≈0.296)
      wear: 0x6b5c38, // polished approach near doors (L≈0.363)
      stain: 0x3f3520, // old varnish stain near hazards (L≈0.210)
      alpha: 0.32,
    },
    gateway: {
      // No arch (map-polish ticket 19 — stairs removed from corridor
      // midpoints); ornate corbel = the sconce mount; polished path = the
      // entering-shot approach marker. (Map-polish ticket 06: the old
      // wall_half/barrel object visuals are banned from bakes.)
      archFrame: '',
      bracketFrame: 'tiles_decorative',
      accentFrame: 'path',
      archTint: 0xc6c2b8,
    },
    weatherBias: { NONE: 4, HEAVY_RAIN: -2 }, // crisp vault air
  },
};

/** Legacy global wall tint — the demo/fallback read before identity sheets. */
export const GLOBAL_WALL_TINT = 0xbbbbcc;

/**
 * The wall tint for a grid tile: the containing sector's identity-sheet tint
 * when the sector-type grid is available (procedural maps), else the legacy
 * global grey (demo-TMX maps). Pure; used identically by the client's static
 * bake, live-entity tint and siege-wall tint so every wall surface of a
 * district carries the same material.
 */
export function wallTintAt(
  sectorTypes: readonly (readonly SectorType[])[] | null | undefined,
  tileX: number,
  tileY: number,
  sectorTileSize: number,
): number {
  if (!sectorTypes) return GLOBAL_WALL_TINT;
  const row = Math.floor(tileY / sectorTileSize);
  const col = Math.floor(tileX / sectorTileSize);
  const type = sectorTypes[row]?.[col];
  return type ? (SECTOR_IDENTITY[type]?.wallTint ?? GLOBAL_WALL_TINT) : GLOBAL_WALL_TINT;
}

// ─── Weather bias (DEC-006 #6) ────────────────────────────────────────────────

/**
 * The base per-sector weather roll weights (the pre-ticket-07 global table —
 * NONE dominant, storms rare). The identity bias shifts these per sector by
 * fiction + tier; see {@link biasedWeatherWeights}.
 */
export const BASE_WEATHER_WEIGHTS: ReadonlyArray<{ item: WeatherType; weight: number }> = [
  { item: 'NONE', weight: 40 },
  { item: 'LIGHT_RAIN', weight: 20 },
  { item: 'HEAVY_RAIN', weight: 15 },
  { item: 'SNOW', weight: 15 },
  { item: 'STORM', weight: 10 },
];

/**
 * Per-EFFECTIVE-tier weather bias deltas (DEC-006 #6): STORM leans HOT
 * (dramatic tension over the rich districts), SNOW leans the cold outer band
 * (COLD tiers live on the outer ring), NONE stays dominant everywhere else.
 */
export const TIER_WEATHER_BIAS: Readonly<
  Record<SectorLootTier, Readonly<Partial<Record<WeatherType, number>>>>
> = {
  [SectorLootTier.HOT]: { STORM: 12, NONE: -10, LIGHT_RAIN: -2 },
  [SectorLootTier.WARM]: {},
  [SectorLootTier.COLD]: { SNOW: 12, NONE: -10, LIGHT_RAIN: -2 },
};

/**
 * Hard cap on any single weight's total bias (fiction + tier combined). The
 * ticket's "mild weights, max ~±15 points" — a sector may never see a weight
 * move more than 15 points from the base table.
 */
export const MAX_WEATHER_BIAS_POINTS = 15;

/** Floor for any biased weight (keeps every weather kind possible). */
const MIN_WEIGHT = 2;

/**
 * The per-sector weather weight table: base + fiction bias + tier bias, each
 * weight's combined delta clamped to ±{@link MAX_WEATHER_BIAS_POINTS} and
 * floored at {@link MIN_WEIGHT}. Pure function of (type, tier) — the weather
 * roll itself still consumes exactly ONE draw from the SAME main-stream
 * position per sector (16 draws, last consumer), so the identity bias changes
 * OUTCOMES only, never the RNG stream layout (ADR 0035).
 */
export function biasedWeatherWeights(
  type: SectorType,
  tier: SectorLootTier,
): Array<{ item: WeatherType; weight: number }> {
  const fiction = SECTOR_IDENTITY[type]?.weatherBias ?? {};
  const tierBias = TIER_WEATHER_BIAS[tier] ?? {};
  return BASE_WEATHER_WEIGHTS.map(({ item, weight }) => {
    const delta = (fiction[item] ?? 0) + (tierBias[item] ?? 0);
    const clamped = Math.max(-MAX_WEATHER_BIAS_POINTS, Math.min(MAX_WEATHER_BIAS_POINTS, delta));
    return { item, weight: Math.max(MIN_WEIGHT, weight + clamped) };
  });
}

import { BEACON_INTENSITY_MAX, SectorLootTier } from '@sector-battle/shared';

/**
 * Light-hierarchy parameters (map-redesign ticket 05 / DEC-005) — the
 * DATA-SIDE tuning surface for the lighting hierarchy:
 *
 *   beacons (ticket 04, top) > POI glow (reward) > sconce routes
 *   (sanctioned travel) > deliberate dark pockets (risk).
 *
 * Everything a designer would retune lives HERE (constants only — no
 * algorithm change needed to re-balance the mood), per the SPEC user story
 * 44 ("name pools, ... tier tables data-driven so tuning never requires
 * touching algorithms") and the ticket criterion "parameterized so tuning
 * is data-side".
 */

/**
 * Per-EFFECTIVE-tier (base pyramid + per-match hot upgrade, resolved via
 * `effectiveSectorTier`) parameters for the sconce-route + dark-pocket
 * layers.
 *
 * **Dark pockets (DEC-005 #4):** the dark-gap fill pass (LightPlacer
 * Anchor D) is REMOVED in cold/outer sectors (`darkGapFillEnabled: false` —
 * unlit stretches deliberately exist between POIs) and its spacing
 * threshold RAISED elsewhere (`fillGapSpacing`: 14 → 16 in HOT, 18 in WARM)
 * so even lit districts keep thin dark bands between POIs. The gradient
 * reads HOT (brightest, fights need light) > WARM > COLD (darkest, exposed
 * crossings) — the mood double-coding for the tier system.
 *
 * **Route sconces (DEC-005 #3):** `routeSconceCap` bounds how many extra
 * sconces line each sector's gateway→landmark travel lines. HOT sectors
 * (the fights) get the most; COLD keeps a sparse single road marker — the
 * sanctioned route still reads, but the district around it stays dark.
 */
export interface LightHierarchyParams {
  /** Whether the dark-gap fill pass may fire in sectors of this tier. */
  darkGapFillEnabled: boolean;
  /**
   * Minimum Manhattan distance (tiles) from the nearest existing light for
   * a dark-gap fill sconce to fire in this tier. `Infinity` + enabled
   * `false` both disable; kept separate so the lint can report WHY.
   */
  fillGapSpacing: number;
  /** Max route-lining sconces per sector of this tier (gateway→landmark). */
  routeSconceCap: number;
}

/** The per-tier parameter table (the data-side tuning surface). */
export const SECTOR_TIER_LIGHT_PARAMS: Readonly<
  Record<'HOT' | 'WARM' | 'COLD', LightHierarchyParams>
> = {
  HOT: { darkGapFillEnabled: true, fillGapSpacing: 16, routeSconceCap: 2 },
  WARM: { darkGapFillEnabled: true, fillGapSpacing: 18, routeSconceCap: 1 },
  COLD: { darkGapFillEnabled: false, fillGapSpacing: Infinity, routeSconceCap: 1 },
};

/**
 * Fallback parameters for sectors whose tier cannot be resolved (degenerate
 * synthetic maps with no `sectorTiers` — the unit-test fixtures). Matches
 * the legacy `warmTierLookup` default in `EntityPlacer`.
 */
export const DEFAULT_TIER_LIGHT_PARAMS: LightHierarchyParams = SECTOR_TIER_LIGHT_PARAMS.WARM;

/** Resolve a sector's hierarchy parameters from its effective loot tier. */
export function lightParamsForTier(tier: SectorLootTier): LightHierarchyParams {
  switch (tier) {
    case SectorLootTier.HOT:
      return SECTOR_TIER_LIGHT_PARAMS.HOT;
    case SectorLootTier.COLD:
      return SECTOR_TIER_LIGHT_PARAMS.COLD;
    default:
      return SECTOR_TIER_LIGHT_PARAMS.WARM;
  }
}

// ─── POI glow (DEC-005 #2) ────────────────────────────────────────────────────

/**
 * Chebyshev radius (tiles) within which two chests belong to the same
 * cluster. 3 keeps clusters tight (a hoard around one spot, a vault row, a
 * loot-arm segment) without chaining half a sector's chests into one blob —
 * at 5 the single-linkage chains merge across 10+ tiles and one pool stops
 * meaning "this pile of loot".
 */
export const POI_GLOW_CLUSTER_CHEBYSHEV = 3;

/** Minimum chests in a group to count as a cluster (a lone chest keeps only its glint). */
export const POI_GLOW_MIN_CHESTS = 2;

/**
 * Max POI glow pools per sector. The measured cluster count at radius 3
 * (7–14 map-wide across the standard seeds) means most sectors hold ≤1
 * cluster; the cap only shaves the odd 2-cluster sector so the pool layer
 * stays inside the same-or-lower total budget.
 */
export const POI_GLOW_PER_SECTOR_CAP = 1;

/**
 * The warm POI pool tune. ONE pool per chest cluster (never per chest —
 * the chest glints stay as-is): a wide, soft, steady warm-gold wash that
 * reads "reward here" from across a room. Intensity 1.7 sits well below
 * the sconce flames (brazier 2.1 / campfire 2.6) and far below the beacon
 * band (2.45–2.6) — the hierarchy stays legible: destination > reward >
 * road. Emitted as `kind: 'brazier'` (a bowl-of-coals fixture beside the
 * hoard keeps the D3 every-placement-has-a-visible-prop contract) with
 * per-placement color/radius/intensity overrides the packer already
 * honors. No pulse — a reward pool is steady, it does not breathe.
 */
export const POI_GLOW_LIGHT = {
  color: [1.0, 0.72, 0.35] as const,
  radius: 320,
  intensity: 1.7,
  pulse: false,
} as const;

/**
 * Search radius (tiles) around a cluster centroid for the pool's fixture
 * tile (nearest eligible EMPTY tile, deterministic row-major tie-break).
 * 2 covers the usual centroid neighborhood; clusters whose centroid lands
 * in a wall pocket relocate instead of failing.
 */
export const POI_GLOW_SEARCH_RADIUS = 2;

// ─── Route sconces (DEC-005 #3) ───────────────────────────────────────────────

/**
 * Spacing (tiles) between route sconces along a gateway→landmark travel
 * line, measured from the gateway (the doorway sconce covers the threshold
 * itself, so the first route sconce fires one cadence in). 5 ≈ every other
 * screen-tile step — a dotted line you can follow, not a lit highway.
 */
export const ROUTE_SCONCE_CADENCE = 5;

/** Search radius (tiles) around a route sample point for the sconce tile. */
export const ROUTE_SCONCE_SEARCH_RADIUS = 2;

/**
 * Minimum Manhattan distance (tiles) from the nearest existing light for a
 * ROUTE-MID sconce to fire. Route sconces line only genuinely DARK stretches
 * of the sanctioned road — a sample point already within 8 tiles of a
 * doorway sconce / POI pool / crystal / beacon needs no extra lamp (the
 * road reads lit through that stretch anyway). This is the count governor
 * that keeps the total budget same-or-lower: the route pass only spends the
 * budget the shrunken dark-gap fill freed.
 */
export const ROUTE_SCONCE_MIN_GAP = 8;

// ─── Doorway sconce pairs (map-polish ticket 10) ──────────────────────────────

/**
 * Band-end offset (tiles along the opening axis) for the doorway sconce PAIR
 * (map-polish ticket 10: "1 at each corner/side" of every passage). Every
 * `mapData.connections` aperture — a 3-tile opening band carved by
 * `SectorConnector` at local 9/10/11 — carries TWO sconces: the band's center
 * tile (local 10) ± this offset, i.e. the two BAND-END tiles (local 9 and
 * 11), both on sector A's threshold face, mirror-symmetric about the aperture
 * axis (the identity pass's `gatewayMidpoint` centerline). The pair members
 * sit Manhattan `2 × DOORWAY_PAIR_BAND_END_OFFSET` = 2 apart — exactly
 * `LIGHT_MIN_SPACING` (2) — so the pair passes the spacing discipline with NO
 * exemption and the fallback ladder only ever moves a member FURTHER from its
 * sibling. Position is pure geometry from the connection record (zero RNG,
 * ADR-0035); the sconce kind + tone are FIXED (map-polish round-2 ticket 18 —
 * `DOORWAY_SCONCE_KIND`/`DOORWAY_SCONCE_COLOR`, no stream draws).
 */
export const DOORWAY_PAIR_BAND_END_OFFSET = 1;

/**
 * Doorway fallback-ladder reach (tiles). When a band-end tile is ineligible
 * (occupied/claimed by the interactive/wall layers, not walkable floor, or
 * spacing-blocked) the pair steps TOGETHER through the deterministic ladder
 * (map-polish ticket-10 ADDENDUM repair), in documented order: (1) one tile
 * OUTWARD along the opening axis (the shoulder, deeper into the flanking
 * wall band), then (2) one tile INWARD along the travel axis (off the seam,
 * into sector A) — BOTH members advance to the same rung, a rung being void
 * only when the SIBLING cannot take it too, so every complete pair stays
 * mirror-symmetric about the aperture axis
 * (`LightPlacerDoorway.firstPlaceableDoorwayPair`). If no rung fits both
 * members each member falls back to its own band-end/inward solo rung; an
 * aperture loses a flank (single sibling sconce, `doorwayAsymmetric` in the
 * lighting report) only when a member finds no solo rung either. Zero RNG —
 * pure geometry.
 * (This ladder REPLACES the old 5×5 route-biased scoring, whose
 * `positionA/positionB`-derived "midpoint" anchored the search at the band's
 * FIRST tile — the corner — producing the single corner sconce ticket 10
 * fixes. Route-mid sconces, Anchor B2, keep their travel-line logic
 * unchanged.)
 */
export const DOORWAY_FALLBACK_REACH = 1;

/**
 * A fill candidate is "route-adjacent" when within this Chebyshev distance
 * (tiles) of a sector's gateway→landmark travel line. Route-adjacent
 * candidates are offered to the dark-gap fill BEFORE generic ones, so the
 * last-resort budget is spent lining the sanctioned road.
 */
export const ROUTE_ADJACENCY_CHEBYSHEV = 2;

// ─── Discipline gates (DEC-005 #5/#6) ─────────────────────────────────────────

/**
 * Hard ceiling on any STATIC light's resolved intensity (the value-band
 * rule). Equals the beacon band max (`BEACON_INTENSITY_MAX` = 2.6, shared
 * `landmarks.ts`): the beacon is the brightest static kind by contract,
 * so nothing static may exceed it. All sconce kinds resolve below it
 * (campfire/fireplace peak 2.6 — mirrored in `KIND_DEFAULT_INTENSITY`
 * inside `LightingDiscipline.ts`).
 */
export const STATIC_VALUE_CEILING: number = BEACON_INTENSITY_MAX;

/**
 * Floor of the player/VFX value band. The brightest combat feedback — the
 * explosion flash (`ExplosionLightRegistry`: barrel blast ≈ 4.10) — defines
 * the band; projectiles + player auras sit below it but are protected by
 * the budget priorities (PLAYER = 0 wins slots over every static) and the
 * always-on 640px aura. The gate asserts `STATIC_VALUE_CEILING <
 * PLAYER_VFX_VALUE_FLOOR`: in a grayscale view, no static light can
 * out-value the combat band (DEC-005 #6, Shinji's resolution).
 */
export const PLAYER_VFX_VALUE_FLOOR = 4.0;

/** Max distinct active light hue families per sector viewport (DEC-005 #5). */
export const MAX_HUE_FAMILIES_PER_SECTOR = 3;

// ─── Dark pockets + budget report ─────────────────────────────────────────────

/**
 * Distance (tiles, Manhattan) from any static light within which a
 * walkable tile is NOT part of a dark pocket. 5 sits beyond every static
 * light's reach (sconce 256px = 2 tiles, pool 320 = 2.5, crystal 384 = 3,
 * hero beacon 512 = 4, Citadel beacon 576 = 4.5 — map-polish ticket 01
 * pulled the beacon radii in from 4.5/5.0, so the pocket distance still
 * exceeds every reach) so a "dark pocket" tile is genuinely outside every
 * light disk — the exposed-crossing mood unit the ticket asks the map to
 * keep between POIs.
 */
export const DARK_POCKET_LIGHT_DISTANCE = 5;

/** Minimum contiguous walkable tiles for a dark region to count as a pocket. */
export const DARK_POCKET_MIN_TILES = 4;

/**
 * Viewport (world px) used by the budget report's on-screen sampling — a
 * representative zoomed combat view. Slid across the map at half-sector
 * steps; the report records the worst static count any viewport can see
 * (with the client budget's 256px halo margin) against the ≤80 target.
 */
export const LIGHT_REPORT_VIEWPORT = { width: 1600, height: 900 } as const;

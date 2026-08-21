/**
 * Shared types for cross-sector macro features (Wave 2+).
 *
 * A macro feature is a large structure carved through the composite map AFTER
 * sector skeletons, corridors, and border cleanup are complete but BEFORE
 * entities are placed. The current pipeline implements the Highway; future
 * waves may add mega-structures, rivers, etc.
 */

/** Orientation of the highway strip. H = horizontal (runs left-to-right), V = vertical (runs top-to-bottom). */
export type HighwayDirection = 'H' | 'V';

/**
 * Metadata describing the carved highway.
 */
export interface HighwayInfo {
  /** Strip orientation. */
  direction: HighwayDirection;
  /** Always 5 tiles. */
  width: number;
  /**
   * Per-sector-cross-axis center positions (global tile coords).
   * For H: one global ROW per sector column (length = SECTOR_GRID_SIZE).
   * For V: one global COL per sector row (length = SECTOR_GRID_SIZE).
   */
  centerlines: number[];
  /**
   * `"globalRow,globalCol"` keys of every tile the highway cleared (center +
   * shoulders). Used by MacroHealPass (proximity checks) and EntityPlacer
   * (exclusion set).
   */
  carvedTiles: Set<string>;
}

/**
 * Metadata describing the placed mega-structure compound.
 *
 * The compound is a 10×10 tile landmark spanning the seam between two center
 * sectors (or the rare 14×14 Citadel, map-redesign ticket 06 / DEC-004). It
 * has an indestructible outer shell, breakable interior partitions dividing
 * it into rooms, a central courtyard with chests, and 2–3 entry gaps through
 * the shell.
 */
export interface CompoundInfo {
  /** Global row of the compound's top-left corner. */
  originRow: number;
  /** Global col of the compound's top-left corner. */
  originCol: number;
  /** 10 for the standard compound, 14 for the Citadel variant. */
  size: number;
  /**
   * Which interior template was drawn (map-redesign ticket 03 — descriptive
   * metadata only; derived from the template index that `placeCompound`
   * already draws, so no RNG stream is perturbed). Feeds the fortress
   * variant-family word of the map designation (DEC-010). Ticket 06 adds the
   * loot-arm template and the rare Citadel variant (DEC-004).
   */
  variant: CompoundVariant;
  /**
   * `"globalRow,globalCol"` keys of EVERY tile the compound touched (shell,
   * partitions, courtyard, cover, gaps). Used by MacroHealPass (proximity
   * checks) and EntityPlacer (exclusion set).
   */
  carvedTiles: Set<string>;
  /**
   * Authored compound CHEST cells, GLOBAL tile coords (map-redesign ticket
   * 06): the template authors its chests as real loot — `MapGenerator`
   * converts these into `LootPlacement`s (tier authored per the tier tables
   * + LegendaryBudget cap), so compound loot hydrates and opens like every
   * other chest instead of being an inert grid tile.
   */
  chests: Array<{ row: number; col: number }>;
  /**
   * Guardian TRAP cells, GLOBAL tile coords (Citadel only, DEC-004: 2–3
   * guardian traps around the vault approach).
   */
  traps: Array<{ row: number; col: number }>;
  /** Beacon prop anchor, GLOBAL tile coords (per-template, DEC-004.2). */
  beaconAnchor: { row: number; col: number };
  /** Vault chamber center, GLOBAL tile coords (Citadel only). */
  vault: { row: number; col: number } | null;
  /**
   * Entry gaps punched through the (outermost) wall ring: one record per
   * gap, the global coord of the gap's FIRST (lowest-index) cleared cell +
   * the side it opens. 2–3 for the standard compound, exactly 4 (one per
   * side) for the Citadel.
   */
  entryGaps: Array<{ side: 'top' | 'bottom' | 'left' | 'right'; row: number; col: number }>;
}

/**
 * The compound's interior template family (mirrors `COMPOUND_TEMPLATES`
 * order in MegaStructure.ts). Ticket 06 (DEC-004) adds the fourth standard
 * template (LOOT_ARM) and the rare 14×14 CITADEL variant.
 */
export type CompoundVariant =
  | 'CROSS_PARTITION'
  | 'PILLARED_HALL'
  | 'COURTYARD_RING'
  | 'LOOT_ARM'
  | 'CITADEL';

/**
 * MapData-facing fortress projection (map-redesign ticket 06 / DEC-004).
 * Authored by shared generation, rides the one-shot `mapData` payload;
 * the beacon LIGHT itself is appended to `lightPlacements` by the
 * SeedMapAdapter (same channel as the landmark beacons).
 */
export interface FortressInfo {
  /** Which template family was drawn (feeds the designation + naming). */
  variant: CompoundVariant;
  /** Global row of the footprint's top-left corner. */
  originRow: number;
  /** Global col of the footprint's top-left corner. */
  originCol: number;
  /** 10 (standard) or 14 (Citadel). */
  size: number;
  /**
   * Vault chamber center, GLOBAL tile coords (Citadel only) — the anchor of
   * the map's strongest beacon and the guaranteed epic+ chest.
   */
  vault: { tileX: number; tileY: number } | null;
  /**
   * The compound beacon. Standard compounds carry a theme-colored beacon
   * (the beacon anchor sector's TYPE hue, tier-keyed intensity — the same
   * hue=theme, value=tier contract as the hero beacons); the Citadel vault
   * beacon is the STRONGEST static light on the map (intensity at the
   * `BEACON_INTENSITY_MAX` ceiling, radius beyond every hero beacon —
   * DEC-004.1 + DEC-005 value band).
   */
  beacon: {
    tileX: number;
    tileY: number;
    color: readonly [number, number, number];
    intensity: number;
    radius: number;
  };
}

/**
 * Metadata describing the placed Barrier Ridge flavor feature.
 *
 * The ridge is a 1-tile-thick INDESTRUCTIBLE_WALL line drawn diagonally through
 * 2–3 outer-ring sectors. It approaches the center band but never enters the
 * center 2×2 sectors. Two to three 3-tile-wide EMPTY gaps are punched through
 * it so players are not sealed off from the ridge-side of the map.
 *
 * Flavor feature (33% chance when selected): adds per-seed structural variety.
 */
export interface BarrierRidgeInfo {
  /**
   * `"globalRow,globalCol"` keys of every tile the ridge placed (wall tiles
   * only — gap tiles and skipped highway/compound/perimeter tiles are NOT
   * included). Used by MacroHealPass (proximity checks) and EntityPlacer
   * (exclusion set).
   */
  carvedTiles: Set<string>;
  /**
   * Global `{row, col}` of each gap's first cleared tile. Length = number of
   * gaps actually cut (2–3). Recorded for diagnostic / gallery rendering.
   */
  gapPositions: Array<{ row: number; col: number }>;
}

/**
 * Metadata describing the placed Open Commons flavor feature.
 *
 * Merges one pair of adjacent outer-ring sectors by clearing their shared
 * border wall to EMPTY. The merged space keeps both sectors' internal
 * skeletons intact — only the dividing border is removed, producing a
 * double-wide arena in one corner of the map.
 *
 * Flavor feature (33% chance when selected): adds per-seed structural variety.
 */
export interface OpenCommonsInfo {
  /** First sector of the merged pair (sector coords). */
  sectorA: { row: number; col: number };
  /** Second sector of the merged pair (sector coords). */
  sectorB: { row: number; col: number };
  /**
   * `"globalRow,globalCol"` keys of every border tile cleared to EMPTY.
   * Used by MacroHealPass (proximity checks) and EntityPlacer (exclusion set).
   */
  carvedTiles: Set<string>;
}

/**
 * Result bundle returned by {@link MacroFeaturePass.apply}.
 */
export interface MacroFeatureResult {
  /** The highway info, or `null` if no highway was generated. */
  highway: HighwayInfo | null;
  /** The compound info, or `null` if no compound was placed. */
  compound: CompoundInfo | null;
  /** The barrier ridge info, or `null` if no ridge was selected this seed. */
  barrierRidge: BarrierRidgeInfo | null;
  /** The open commons info, or `null` if no commons was selected this seed. */
  openCommons: OpenCommonsInfo | null;
}

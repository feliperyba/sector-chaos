import { TrapType } from '../enums/TrapType.js';
import { WeaponTier } from '../enums/WeaponTier.js';
import { ChestRarity } from '../enums/ChestRarity.js';
import type { SectorSubVariant } from './sectors/subVariants.js';
import type { MacroPoiNames } from './poiNames.js';
import type { LandmarkAssignment } from './landmarks.js';
import type { FortressInfo } from './macro/MacroTypes.js';
import type { VisualIdentityAssignment } from './visualIdentity.js';

export enum SectorType {
  GRID_ARENA = 'GRID_ARENA',
  OPEN_ARENA = 'OPEN_ARENA',
  MAZE = 'MAZE',
  RESOURCE_RICH = 'RESOURCE_RICH',
}

/**
 * Seed-authored loot tier per sector (map-redesign ticket 02 / DEC-003).
 * Drives chest-tier weights, ground-weapon tier tables and the minimap tier
 * tint. Assigned in shared generation on an isolated XOR-salted stream
 * (`lootTiers.ts`).
 */
export enum SectorLootTier {
  HOT = 'HOT',
  WARM = 'WARM',
  COLD = 'COLD',
}

export interface TrapPlacement {
  trapType: TrapType;
  position: { x: number; y: number };
  sectorCoord: { row: number; col: number };
}

export interface MapData {
  seed: number;
  sectors: SectorData[][];
  connections: SectorConnection[];
  spawnPoints: SpawnPoint[];
  exits: ExitData[];
  lootPlacements: LootPlacement[];
  entityPlacements: EntityPlacement[];
  trapPlacements: TrapPlacement[];
  weather: SectorWeather[];
  globalBounds: { width: number; height: number };
  corridorTiles: Set<string>;
  /**
   * Base loot-tier pyramid per sector (map-redesign ticket 02). The hot
   * sector is still WARM in this grid — consumers combine it with
   * `hotSector` via `effectiveSectorTier`.
   */
  sectorTiers: SectorLootTier[][];
  /**
   * Per-match hot sector: one non-central WARM sector upgraded to HOT for
   * this match only, rolled from the match seed (isolated salt). Surfaced to
   * the client via the one-shot `mapData` message for the minimap mark.
   */
  hotSector: { row: number; col: number };
  /**
   * Generated POI display name per sector (4×4, row-major; map-redesign
   * ticket 03 / DEC-001). Composed deterministically on an isolated
   * XOR-salted stream; unique within the map; surfaced as minimap labels,
   * the sector enter-banner and kill-feed location tags. The client renders
   * only — every string originates here, server-side.
   */
  poiNames: string[][];
  /**
   * Fixed-vocabulary macro-feature display names (present features only;
   * map-redesign ticket 03 / DEC-001).
   */
  macroPoiNames: MacroPoiNames;
  /**
   * Map designation, e.g. "RINGROAD • SPIRE • 63" (map-redesign ticket 03 /
   * DEC-010) — derived from the macro rolls (highway orientation × flavor
   * feature × fortress variant family + short seed tag). Shown at match
   * start (phase banner area) and on the results screen.
   */
  designation: string;
  /**
   * Hero landmarks + beacons + junction minor landmarks (map-redesign ticket
   * 04 / DEC-002). Every sector reserves exactly ONE hero landmark on its
   * skeleton-authored anchor site; each carries a theme-colored pulsing beacon
   * light spec (hue = the sector type's identity, value = the loot tier).
   * Assigned in shared generation on an isolated XOR-salted
   * stream (`landmarks.ts`); rides the one-shot `mapData` payload so the
   * client renders (baked composite + beacon + minimap icon) from server
   * data only.
   */
  landmarks: LandmarkAssignment;
  /**
   * The placed fortress (central compound / rare Citadel) projection
   * (map-redesign ticket 06 / DEC-004): variant family, footprint, vault
   * anchor and the per-template beacon spec — the Citadel vault beacon is
   * the strongest static light on the map. Authored by shared generation;
   * the beacon LIGHT rides the light placements appended by the SeedMapAdapter,
   * and the variant feeds the designation + benchmark manifest.
   */
  fortress: FortressInfo | null;
  /**
   * Sector type grid (4×4, map-redesign ticket 07 / DEC-006) — the key the
   * client uses to resolve each district's identity sheet (wall tint, floor
   * tint family, gateway frame spec). Authored by generation; the client
   * renders only (no client-side type inference).
   */
  sectorTypes: SectorType[][];
  /**
   * Visual identity assignment (map-redesign ticket 07 / DEC-006): per-sector
   * floor tint fields (2–3 seeded macro blobs, jittered non-axis borders) +
   * per-connection gateway dressing (lerp-band endpoints, entering-shot
   * alignment). Generated on the isolated IDTY stream; VISUAL-ONLY — no
   * tiles/collision/entities are affected. Rides the one-shot `mapData`
   * payload so the client bakes it at map load (zero per-frame cost).
   */
  identity: VisualIdentityAssignment;
}

export interface SectorData {
  type: SectorType;
  /** The sub-variant (Skeleton) id that produced this sector's layout. */
  subVariant: SectorSubVariant;
  tiles: Uint8Array[];
  elevation: Uint8Array[] | null;
  lootSpots: { x: number; y: number }[];
  /**
   * Hero-landmark anchor site (map-redesign ticket 04 / DEC-002): the
   * signature gameplay structure the sector's landmark sits ON (plaza /
   * sanctum / monument flank / vault core / open hub), authored by the
   * skeleton builder as data (no RNG). Tile coords `{x: col, y: row}`.
   */
  landmarkAnchor: { x: number; y: number };
  /**
   * Whether this sector's skeleton was horizontally mirrored by the seeded
   * mirror pass (map-redesign ticket 08 / DEC-007.2). The lootSpots and
   * landmarkAnchor above are ALREADY re-mapped through the same flip as the
   * tiles, so downstream consumers never transform anything themselves.
   */
  mirrored: boolean;
  /**
   * Bitmask of the PRESENT probabilistic sub-blocks (map-redesign ticket 08 /
   * DEC-007.1): bit `i` = the `i`-th authored block of
   * `SUB_BLOCKS_BY_VARIANT[subVariant]` fired its presence die AND survived
   * the deterministic guards. Generation metadata (audit/manifest/variety
   * histogram); not rendered.
   */
  subBlockMask: number;
  bounds: { x: number; y: number; width: number; height: number };
  theme: 'default' | 'cave' | 'factory';
}

export interface SectorConnection {
  sectorA: { row: number; col: number };
  sectorB: { row: number; col: number };
  width: 3;
  positionA: { x: number; y: number };
  positionB: { x: number; y: number };
}

export interface SpawnPoint {
  x: number;
  y: number;
  sectorCoord: { row: number; col: number };
  priority: number;
}

export interface ExitData {
  id: string;
  position: { x: number; y: number };
  direction: 'N' | 'S' | 'E' | 'W';
  targetSectorCoord: { row: number; col: number } | null;
  cooldown: number;
  isExtraction: boolean;
}

export interface LootPlacement {
  type: 'CHEST' | 'WEAPON_SPAWN' | 'POWERUP_SPAWN';
  tier: ChestRarity | WeaponTier;
  position: { x: number; y: number };
  sectorCoord: { row: number; col: number };
}

export interface SectorWeather {
  sectorCoord: { row: number; col: number };
  weatherType: 'NONE' | 'LIGHT_RAIN' | 'HEAVY_RAIN' | 'SNOW' | 'STORM';
}

export interface EntityPlacement {
  entityType: 'CHEST' | 'BARREL' | 'TRAP' | 'CRATE';
  position: { x: number; y: number };
  sectorCoord: { row: number; col: number };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

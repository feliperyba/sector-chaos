import {
  TileType,
  WeaponTier,
  WeaponType,
  TrapType,
  ChestRarity,
  SectorLootTier,
  SectorType,
  type MapConfig,
  type SpawnPoint,
  type MapData,
  type MacroPoiNames,
  type LandmarkAssignment,
  type FortressInfo,
  type VisualIdentityAssignment,
  type GenerationAudit,
  MapGenerator as SharedMapGenerator,
  buildCompositeGrid,
  TILE_PIXEL_SIZE,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import { logger } from '@sector-battle/shared';

export interface MapResult {
  grid: TileType[][];
  seed: number;
  spawnPoints: SpawnPoint[];
  chestPlacements: Array<{
    gridX: number;
    gridY: number;
    tier: ChestRarity;
    textureKey?: string;
    rotation?: number;
    flipH?: boolean;
    flipV?: boolean;
  }>;
  trapPlacements: Array<{
    gridX: number;
    gridY: number;
    trapType?: TrapType;
    textureKey?: string;
    rotation?: number;
    flipH?: boolean;
    flipV?: boolean;
  }>;
  weaponSpawnPlacements: Array<{
    gridX: number;
    gridY: number;
    tier: WeaponTier;
    weaponType?: WeaponType;
    textureKey?: string;
    rotation?: number;
    flipH?: boolean;
    flipV?: boolean;
  }>;
  destructiblePlacements?: Array<{
    gridX: number;
    gridY: number;
    tileType: TileType;
    textureKey: string;
    rotation?: number;
    flipH?: boolean;
    flipV?: boolean;
  }>;
  powerupPlacements?: Array<{
    gridX: number;
    gridY: number;
    textureKey?: string;
    rotation?: number;
    flipH?: boolean;
    flipV?: boolean;
  }>;
  exitPlacements?: Array<{
    gridX: number;
    gridY: number;
    textureKey: string;
    rotation: number;
    flipH: boolean;
    flipV: boolean;
  }>;
  /**
   * The FINAL light-prop placement list (post hue-discipline enforcement —
   * the same list that rides the one-shot `mapData` message), carried so the
   * match hydration can convert every NON-EXEMPT placement into a `'light'`
   * destructible entity (map-polish ticket 07). Populated by
   * `GameRoomMapBuilder` from the enriched entities; the raw shared
   * `MapGenerator` output does NOT carry it (placements are an enrichment-
   * time product), so a bare `MapGenerator.generate()` result hydrates zero
   * light-prop entities.
   */
  lightPlacements?: LightPlacementTiled[];
  /** The raw MapData from the shared MapGenerator, for use by SeedMapAdapter. */
  rawMapData?: MapData;
  /**
   * Seed-authored loot-tier pyramid (4x4, map-redesign ticket 02). Present
   * for procedural maps only (the demo TMX path has no shared generation).
   */
  sectorTiers?: SectorLootTier[][];
  /**
   * Per-match hot sector (one non-central WARM sector upgraded to HOT for
   * the match, rolled from the match seed). Rides the one-shot `mapData`
   * message so the client minimap can mark it at match start.
   */
  hotSector?: { row: number; col: number };
  /**
   * Generated POI display name per sector (4x4, map-redesign ticket 03 /
   * DEC-001). Rides the one-shot `mapData` message for minimap labels, the
   * enter-banner and kill-feed location tags. Present for procedural maps
   * only.
   */
  poiNames?: string[][];
  /** Fixed-vocabulary macro-feature display names (present features only). */
  macroPoiNames?: MacroPoiNames;
  /**
   * Map designation, e.g. "RINGROAD • SPIRE • 63" (DEC-010) — shown at
   * match start and on the results screen via the `mapData` message.
   */
  designation?: string;
  /**
   * Hero landmarks + beacons + junction minor landmarks (map-redesign ticket
   * 04 / DEC-002). Rides the one-shot `mapData` message so the client bakes
   * the composites, renders beacons via the light placements appended by the
   * SeedMapAdapter, and draws minimap icons. Present for procedural maps
   * only.
   */
  landmarks?: LandmarkAssignment;
  /**
   * The placed fortress projection (map-redesign ticket 06 / DEC-004):
   * variant family, footprint, vault anchor and the per-template beacon —
   * the Citadel vault beacon is the strongest static light on the map.
   * Rides the one-shot `mapData` message + the benchmark manifest. Null on
   * demo-TMX maps.
   */
  fortress?: FortressInfo | null;
  /**
   * Sector type grid (4×4, map-redesign ticket 07 / DEC-006) — the key the
   * client resolves each district's identity sheet from (wall tint, floor
   * family, gateway frame spec). Present for procedural maps only.
   */
  sectorTypes?: SectorType[][];
  /**
   * Visual identity assignment (map-redesign ticket 07 / DEC-006): per-sector
   * floor tint fields + per-connection gateway dressing. Rides the one-shot
   * `mapData` message; the client bakes it at map load (visual-only). Present
   * for procedural maps only.
   */
  identity?: VisualIdentityAssignment;
  /**
   * Per-sector skeleton (sub-variant) ids, 4×4 (map-redesign ticket 08 /
   * DEC-007) — the benchmark generation manifest's skeleton audit surface.
   * Present for procedural maps only.
   */
  sectorSkeletons?: string[][];
  /**
   * Per-sector horizontal-mirror flags, 4×4 (map-redesign ticket 08 /
   * DEC-007.2) — the manifest's mirror audit surface (mirrored + unmirrored
   * instances must both appear across seeds). Present for procedural maps
   * only.
   */
  sectorMirrored?: boolean[][];
  /**
   * Generation-time fairness audit (map-redesign ticket 10 / DEC-009): how
   * many spawns the equity repair pass re-picked, how many attempts the map
   * took, and the post-repair equity audit. Rides the benchmark generation
   * manifest. Present for procedural maps only.
   */
  generationAudit?: GenerationAudit;
}

const TILE_TYPE_MAP: Record<string, TileType> = {
  CRATE: TileType.DESTRUCTIBLE_CRATE,
  BARREL: TileType.DESTRUCTIBLE_BARREL,
  CHEST: TileType.CHEST,
};

export class MapGenerator {
  private shared = new SharedMapGenerator();

  generate(seed: number, config?: MapConfig): MapResult {
    try {
      const mapData = this.shared.generate(seed, config);
      const result = this.adapt(mapData);
      // Map-redesign ticket 10 (DEC-009): the generation-time fairness audit
      // (spawn repair count, attempt count, post-repair equity) rides the
      // server MapResult — NOT MapData, which is the golden-fixture
      // byte-identity surface. The benchmark generation manifest reads it.
      result.generationAudit = this.shared.getLastGenerationAudit() ?? undefined;
      return result;
    } catch (err) {
      logger.error('generate failed', err);
      throw err;
    }
  }

  private adapt(data: MapData): MapResult {
    const uint8Grid = buildCompositeGrid(data.sectors);
    const grid: TileType[][] = uint8Grid.map((row) => Array.from(row) as TileType[]);

    const ts = TILE_PIXEL_SIZE;

    const toGrid = (pos: { x: number; y: number }) => ({
      gridX: Math.floor(pos.x / ts),
      gridY: Math.floor(pos.y / ts),
    });

    const destructiblePlacements = data.entityPlacements
      .filter((e) => e.entityType === 'CRATE' || e.entityType === 'BARREL')
      .map((e) => ({
        ...toGrid(e.position),
        tileType: TILE_TYPE_MAP[e.entityType] ?? TileType.DESTRUCTIBLE_CRATE,
        textureKey: '',
      }));

    const chestPlacements = data.lootPlacements
      .filter((l) => l.type === 'CHEST')
      .map((l) => ({
        ...toGrid(l.position),
        tier: l.tier as ChestRarity,
      }));

    const weaponSpawnPlacements = data.lootPlacements
      .filter((l) => l.type === 'WEAPON_SPAWN')
      .map((l) => ({
        ...toGrid(l.position),
        tier: l.tier as WeaponTier,
      }));

    const powerupPlacements = data.lootPlacements
      .filter((l) => l.type === 'POWERUP_SPAWN')
      .map((l) => toGrid(l.position));

    const trapPlacements = data.trapPlacements.map((t) => ({
      ...toGrid(t.position),
      trapType: t.trapType,
    }));

    return {
      grid,
      seed: data.seed,
      spawnPoints: data.spawnPoints,
      chestPlacements,
      trapPlacements,
      weaponSpawnPlacements,
      destructiblePlacements,
      powerupPlacements,
      rawMapData: data,
      sectorTiers: data.sectorTiers,
      hotSector: data.hotSector,
      poiNames: data.poiNames,
      macroPoiNames: data.macroPoiNames,
      designation: data.designation,
      landmarks: data.landmarks,
      fortress: data.fortress,
      sectorTypes: data.sectorTypes,
      identity: data.identity,
      sectorSkeletons: data.sectors.map((row) => row.map((sector) => sector.subVariant)),
      sectorMirrored: data.sectors.map((row) => row.map((sector) => sector.mirrored)),
    };
  }
}

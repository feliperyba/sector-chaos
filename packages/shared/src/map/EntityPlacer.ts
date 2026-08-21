import { TileType } from '../enums/TileType.js';
import { TrapType } from '../enums/TrapType.js';
import { WeaponTier } from '../enums/WeaponTier.js';
import { ChestRarity } from '../enums/ChestRarity.js';
import type { SeededRNG } from './rng/SeededRNG.js';
import type { SectorData, EntityPlacement, LootPlacement, TrapPlacement } from './types.js';
import { SectorType, SectorLootTier } from './types.js';
import {
  TILE_PIXEL_SIZE,
  BARREL_COUNT_RANGE,
  CHEST_COUNT,
  TRAP_COUNT_RANGE,
  MAX_MAP_LEGENDARY,
} from './constants.js';
import {
  SECTOR_TIER_CHEST_WEIGHTS,
  SECTOR_TIER_WEAPON_WEIGHTS,
} from '../constants/loot-weights.js';
import { LegendaryBudget, type TierLookup } from './lootTiers.js';
import {
  type CellPos,
  collectValidPositions,
  buildPreferredKeys,
  buildStructureBackedPreferred,
  buildCoverProximityPreferred,
  pickPlacement,
  hasMinSpacing,
  placeWithSpacing,
} from './placementUtils.js';

const TRAP_TYPE_WEIGHTS: { item: TrapType; weight: number }[] = [
  { item: TrapType.SPIKE, weight: 1 },
  { item: TrapType.FIRE, weight: 1 },
  { item: TrapType.TELEPORT, weight: 1 },
];

/** Shared empty set used as the default macroTiles exclusion (never mutated). */
const EMPTY_MACRO_TILES: Set<string> = new Set<string>();

/** Legacy/test default: every sector treated as the WARM band. */
const warmTierLookup: TierLookup = () => SectorLootTier.WARM;

interface PlacementResult {
  entityPlacements: EntityPlacement[];
  chestLootPlacements: LootPlacement[];
  groundWeaponPlacements: LootPlacement[];
  trapPlacements: TrapPlacement[];
}

export class EntityPlacer {
  place(
    sectors: SectorData[][],
    corridorTiles: Set<string>,
    rng: SeededRNG,
    macroTiles: Set<string> = EMPTY_MACRO_TILES,
    tierOf: TierLookup = warmTierLookup,
    legendary: LegendaryBudget = new LegendaryBudget(MAX_MAP_LEGENDARY),
  ): PlacementResult {
    const entityPlacements: EntityPlacement[] = [];
    const chestLootPlacements: LootPlacement[] = [];
    const groundWeaponPlacements: LootPlacement[] = [];
    const trapPlacements: TrapPlacement[] = [];

    for (let sRow = 0; sRow < sectors.length; sRow++) {
      for (let sCol = 0; sCol < sectors[sRow]!.length; sCol++) {
        const sector = sectors[sRow]![sCol]!;
        const positions = collectValidPositions(sector, sRow, sCol, corridorTiles, macroTiles);
        if (positions.length === 0) continue;

        const placed = new Set<string>();
        // Loot-framing hook (T7): cache cells a skeleton wants loot to land in.
        // Only ResourceRich populates `lootSpots`. Round 7 (cohesion): chests
        // ALSO prefer structure-backed cells — a cardinal DESTRUCTIBLE_WALL
        // neighbour nests the chest into the smashable composition (vault in a
        // breach bay / camp / pen) instead of floating on the open floor, which
        // read as random scatter. `pickPlacement` consumes the union
        // uniformly-at-random, so both sources stay in play.
        const preferred = buildPreferredKeys(sector, positions);
        for (const key of buildStructureBackedPreferred(positions, sector.tiles)) {
          preferred.add(key);
        }
        const tier = tierOf(sRow, sCol);

        this.placeChests(
          positions,
          CHEST_COUNT[sector.type],
          placed,
          preferred,
          sector,
          sRow,
          sCol,
          rng,
          entityPlacements,
          chestLootPlacements,
          tier,
          legendary,
        );
        // After chests are placed, build a cover-proximity preferred set for
        // barrel/trap bias: positions with ≥2 non-EMPTY 8-neighbours sit near
        // walls/cover — ideal for barrel chain reactions and trap ambushes.
        // The set is shared (barrels consume first, traps get the remainder),
        // matching the chest→weapon sharing pattern above.
        const coverPreferred = buildCoverProximityPreferred(positions, sector.tiles);
        this.placeFixed(
          positions,
          rng.nextInt(BARREL_COUNT_RANGE.min, BARREL_COUNT_RANGE.max),
          placed,
          coverPreferred,
          TileType.DESTRUCTIBLE_BARREL,
          'BARREL',
          sector,
          sRow,
          sCol,
          rng,
          entityPlacements,
        );
        this.placeTraps(
          positions,
          placed,
          coverPreferred,
          sector,
          sRow,
          sCol,
          rng,
          entityPlacements,
          trapPlacements,
        );
        const weaponPlacements = this.placeGroundWeaponSpawns(
          positions,
          placed,
          preferred,
          sector,
          sRow,
          sCol,
          rng,
          tier,
          legendary,
        );
        groundWeaponPlacements.push(...weaponPlacements);
      }
    }

    return { entityPlacements, chestLootPlacements, groundWeaponPlacements, trapPlacements };
  }

  private placeChests(
    positions: CellPos[],
    count: number,
    placed: Set<string>,
    preferred: Set<string>,
    sector: SectorData,
    sRow: number,
    sCol: number,
    rng: SeededRNG,
    entityPlacements: EntityPlacement[],
    chestLootPlacements: LootPlacement[],
    tier: SectorLootTier,
    legendary: LegendaryBudget,
  ): void {
    placeWithSpacing(positions, count, placed, preferred, rng, (chosen) => {
      sector.tiles[chosen.row]![chosen.col] = TileType.CHEST;

      const position = {
        x: sector.bounds.x + chosen.col * TILE_PIXEL_SIZE,
        y: sector.bounds.y + chosen.row * TILE_PIXEL_SIZE,
      };

      entityPlacements.push({
        entityType: 'CHEST',
        position,
        sectorCoord: { row: sRow, col: sCol },
      });

      chestLootPlacements.push({
        type: 'CHEST',
        tier: this.rollChestTier(rng, tier, legendary),
        position,
        sectorCoord: { row: sRow, col: sCol },
      });
    });
  }

  /**
   * Roll a chest rarity from the sector's per-tier table
   * (`SECTOR_TIER_CHEST_WEIGHTS`, map-redesign ticket 02). Consumes exactly
   * one `nextFloat()` per roll (same single draw as the old map-wide table),
   * so downstream RNG stream order is unchanged. A legendary roll beyond the
   * map-wide cap deterministically downgrades to EPIC (no re-roll draw).
   */
  private rollChestTier(
    rng: SeededRNG,
    tier: SectorLootTier,
    legendary: LegendaryBudget,
  ): ChestRarity {
    let rarity = rng.weightedPick(SECTOR_TIER_CHEST_WEIGHTS[tier]);
    if (rarity === ChestRarity.LEGENDARY && !legendary.tryConsume()) {
      rarity = ChestRarity.EPIC;
    }
    return rarity;
  }

  private placeFixed(
    positions: CellPos[],
    count: number,
    placed: Set<string>,
    preferred: Set<string>,
    tileType: TileType,
    entityType: 'BARREL',
    sector: SectorData,
    sRow: number,
    sCol: number,
    rng: SeededRNG,
    placements: EntityPlacement[],
  ): void {
    placeWithSpacing(positions, count, placed, preferred, rng, (chosen) => {
      sector.tiles[chosen.row]![chosen.col] = tileType;

      placements.push({
        entityType,
        position: {
          x: sector.bounds.x + chosen.col * TILE_PIXEL_SIZE,
          y: sector.bounds.y + chosen.row * TILE_PIXEL_SIZE,
        },
        sectorCoord: { row: sRow, col: sCol },
      });
    });
  }

  private placeTraps(
    positions: CellPos[],
    placed: Set<string>,
    preferred: Set<string>,
    sector: SectorData,
    sRow: number,
    sCol: number,
    rng: SeededRNG,
    placements: EntityPlacement[],
    trapPlacements: TrapPlacement[],
  ): void {
    const count = rng.nextInt(TRAP_COUNT_RANGE.min, TRAP_COUNT_RANGE.max);
    placeWithSpacing(positions, count, placed, preferred, rng, (chosen) => {
      const trapType = rng.weightedPick(TRAP_TYPE_WEIGHTS);
      const position = {
        x: sector.bounds.x + chosen.col * TILE_PIXEL_SIZE,
        y: sector.bounds.y + chosen.row * TILE_PIXEL_SIZE,
      };
      placements.push({
        entityType: 'TRAP',
        position,
        sectorCoord: { row: sRow, col: sCol },
      });
      trapPlacements.push({
        trapType,
        position,
        sectorCoord: { row: sRow, col: sCol },
      });
    });
  }

  private placeGroundWeaponSpawns(
    positions: CellPos[],
    placed: Set<string>,
    preferred: Set<string>,
    sector: SectorData,
    sRow: number,
    sCol: number,
    rng: SeededRNG,
    tier: SectorLootTier,
    legendary: LegendaryBudget,
  ): LootPlacement[] {
    const placements: LootPlacement[] = [];
    // 3-4 weapons per sector (enough for 64 players across 16 sectors),
    // RESOURCE_RICH gets 2 extra as high-value loot zones
    let count = rng.nextInt(3, 4);
    const isResourceRich = sector.type === SectorType.RESOURCE_RICH;
    if (isResourceRich) {
      count += 2;
    }
    // Loot-tier pyramid (map-redesign ticket 02, GDD §5.6.1 as amended): the
    // sector's EFFECTIVE tier (base pyramid + per-match hot upgrade) selects
    // the per-tier data table — COLD = Common-only cheap band, HOT = the
    // 60/25/12/3 risk/reward split, WARM between. The generator authors the
    // tier; hydration consumes it as-is.
    for (let i = 0; i < count; i++) {
      const valid = positions.filter((p) => hasMinSpacing(p.row, p.col, placed));
      if (valid.length === 0) break;

      const chosen = pickPlacement(valid, preferred, rng);
      placed.add(`${chosen.row},${chosen.col}`);

      placements.push({
        type: 'WEAPON_SPAWN',
        tier: this.rollTier(rng, tier, legendary),
        position: {
          x: sector.bounds.x + chosen.col * TILE_PIXEL_SIZE,
          y: sector.bounds.y + chosen.row * TILE_PIXEL_SIZE,
        },
        sectorCoord: { row: sRow, col: sCol },
      });
    }

    return placements;
  }

  /**
   * Roll a ground-weapon tier from the sector's per-tier data table
   * (`SECTOR_TIER_WEAPON_WEIGHTS`): COLD = Common only, HOT = 60/25/12/3,
   * WARM = 85/12/3. Consumes exactly one `nextFloat()` per roll — the same
   * single draw the former ring/uniform tables used — so downstream RNG
   * stream order is unchanged and only the authored tier values differ. A
   * legendary roll beyond the map-wide cap downgrades to RARE.
   */
  private rollTier(rng: SeededRNG, tier: SectorLootTier, legendary: LegendaryBudget): WeaponTier {
    let weaponTier = rng.weightedPick(SECTOR_TIER_WEAPON_WEIGHTS[tier]);
    if (weaponTier === WeaponTier.LEGENDARY && !legendary.tryConsume()) {
      weaponTier = WeaponTier.RARE;
    }
    return weaponTier;
  }
}

import { TileType } from '../enums/TileType.js';
import { ChestRarity } from '../enums/ChestRarity.js';
import type { SeededRNG } from './rng/SeededRNG.js';
import type { SectorData, LootPlacement } from './types.js';
import { SectorType, SectorLootTier } from './types.js';
import { TILE_PIXEL_SIZE, SECTOR_GRID_SIZE, MAX_MAP_LEGENDARY } from './constants.js';
import {
  SECTOR_TIER_CHEST_WEIGHTS,
  CENTER_RESOURCE_RICH_WEIGHTS,
} from '../constants/loot-weights.js';
import { LegendaryBudget, type TierLookup } from './lootTiers.js';

export const CHEST_COUNT = 32; // Total loot entities across 16 sectors (~2/sector for 64 players)

const ENTITY_WEIGHTS: { item: 'CHEST' | 'POWERUP_SPAWN'; weight: number }[] = [
  { item: 'CHEST', weight: 45 }, // Reduced from 40 to prevent weapon overcluster
  { item: 'POWERUP_SPAWN', weight: 55 }, // Increased for better balance
];

export class LootSpawner {
  spawn(
    sectors: SectorData[][],
    rng: SeededRNG,
    tierOf: TierLookup = () => SectorLootTier.WARM,
    legendary: LegendaryBudget = new LegendaryBudget(MAX_MAP_LEGENDARY),
  ): LootPlacement[] {
    const placements: LootPlacement[] = [];

    for (let row = 0; row < sectors.length; row++) {
      for (let col = 0; col < sectors[row]!.length; col++) {
        const sector = sectors[row]![col]!;
        const candidates = this.collectCandidates(sector);
        const effectiveCandidates =
          candidates.length > 0 ? candidates : this.fallbackCandidates(sector);
        if (effectiveCandidates.length === 0) continue;

        // Use predefined CHEST_COUNT instead of density-based placement
        const perSector = Math.max(
          1,
          Math.floor(CHEST_COUNT / (SECTOR_GRID_SIZE * SECTOR_GRID_SIZE)),
        );
        const isResourceRich = sector.type === SectorType.RESOURCE_RICH;
        const count = isResourceRich ? perSector + 1 : perSector;
        const shuffled = rng.shuffle(effectiveCandidates);
        // Loot-tier pyramid (map-redesign ticket 02): the sector's effective
        // tier selects the chest-rarity table; the legendary cap is the shared
        // map-wide budget (chests + ground weapons combined, ~10/map).
        const tier = tierOf(row, col);

        let placed = 0;
        for (const pos of shuffled) {
          if (placed >= count) break;

          let lootTier: number = rng.weightedPick(SECTOR_TIER_CHEST_WEIGHTS[tier]);
          if (lootTier === ChestRarity.LEGENDARY && !legendary.tryConsume()) {
            lootTier = ChestRarity.EPIC;
          }

          const entityType = rng.weightedPick(ENTITY_WEIGHTS);

          placements.push({
            type: entityType,
            tier: lootTier,
            position: pos,
            sectorCoord: { row, col },
          });

          placed++;
        }

        if (sector.type === SectorType.RESOURCE_RICH) {
          const centerPlaced = this.placeCenterChest(sector, row, col);
          // Same gating as before the shared budget: headroom check first,
          // roll the RARE/LEGENDARY table, consume only when it lands
          // legendary. With the budget exhausted the chest falls back to EPIC.
          if (centerPlaced && legendary.hasHeadroom()) {
            centerPlaced.tier = rng.weightedPick(CENTER_RESOURCE_RICH_WEIGHTS);
            if (centerPlaced.tier === ChestRarity.LEGENDARY) legendary.tryConsume();
            placements.push(centerPlaced);
          } else if (centerPlaced) {
            centerPlaced.tier = ChestRarity.EPIC;
            placements.push(centerPlaced);
          }
        }
      }
    }

    return placements;
  }

  private collectCandidates(sector: SectorData): { x: number; y: number }[] {
    switch (sector.type) {
      case SectorType.GRID_ARENA:
        return this.gridArenaCandidates(sector);
      case SectorType.OPEN_ARENA:
        return this.openArenaCandidates(sector);
      case SectorType.MAZE:
        return this.mazeCandidates(sector);
      case SectorType.RESOURCE_RICH:
        return this.resourceRichCandidates(sector);
      default:
        return [];
    }
  }

  private gridArenaCandidates(sector: SectorData): { x: number; y: number }[] {
    const candidates: { x: number; y: number }[] = [];
    const tiles = sector.tiles;
    const height = tiles.length;
    const width = tiles[0]!.length;

    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        if (tiles[row]![col] !== TileType.EMPTY) continue;
        const adjacentCrate = this.hasAdjacentTile(tiles, row, col, TileType.DESTRUCTIBLE_WALL);
        if (adjacentCrate) {
          candidates.push({
            x: sector.bounds.x + col * TILE_PIXEL_SIZE,
            y: sector.bounds.y + row * TILE_PIXEL_SIZE,
          });
        }
      }
    }

    return candidates;
  }

  private openArenaCandidates(sector: SectorData): { x: number; y: number }[] {
    const candidates: { x: number; y: number }[] = [];
    const tiles = sector.tiles;
    const height = tiles.length;
    const width = tiles[0]!.length;
    const centerRow = Math.floor(height / 2);
    const centerCol = Math.floor(width / 2);

    const floorTiles: { row: number; col: number; distFromCenter: number }[] = [];
    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        if (tiles[row]![col] !== TileType.EMPTY) continue;
        const dist = Math.abs(row - centerRow) + Math.abs(col - centerCol);
        floorTiles.push({ row, col, distFromCenter: dist });
      }
    }

    floorTiles.sort((a, b) => a.distFromCenter - b.distFromCenter);

    for (const tile of floorTiles) {
      candidates.push({
        x: sector.bounds.x + tile.col * TILE_PIXEL_SIZE,
        y: sector.bounds.y + tile.row * TILE_PIXEL_SIZE,
      });
    }

    return candidates;
  }

  private mazeCandidates(sector: SectorData): { x: number; y: number }[] {
    const candidates: { x: number; y: number }[] = [];
    const tiles = sector.tiles;
    const height = tiles.length;
    const width = tiles[0]!.length;

    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        if (tiles[row]![col] !== TileType.EMPTY) continue;

        let floorNeighbors = 0;
        const dirs = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ];
        for (const dir of dirs) {
          const nr = row + dir[0]!;
          const nc = col + dir[1]!;
          if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
            if (tiles[nr]![nc] === TileType.EMPTY) floorNeighbors++;
          }
        }

        if (floorNeighbors <= 2) {
          candidates.push({
            x: sector.bounds.x + col * TILE_PIXEL_SIZE,
            y: sector.bounds.y + row * TILE_PIXEL_SIZE,
          });
        }
      }
    }

    return candidates;
  }

  private resourceRichCandidates(sector: SectorData): { x: number; y: number }[] {
    const candidates: { x: number; y: number }[] = [];
    const tiles = sector.tiles;
    const height = tiles.length;
    const width = tiles[0]!.length;

    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        if (tiles[row]![col] === TileType.EMPTY) {
          candidates.push({
            x: sector.bounds.x + col * TILE_PIXEL_SIZE,
            y: sector.bounds.y + row * TILE_PIXEL_SIZE,
          });
        }
      }
    }

    return candidates;
  }

  private placeCenterChest(
    sector: SectorData,
    gridRow: number,
    gridCol: number,
  ): LootPlacement | null {
    const tiles = sector.tiles;
    const centerRow = Math.floor(tiles.length / 2);
    const centerCol = Math.floor(tiles[0]!.length / 2);

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = centerRow + dr;
        const c = centerCol + dc;
        if (r >= 0 && r < tiles.length && c >= 0 && c < tiles[0]!.length) {
          if (tiles[r]![c] === TileType.EMPTY) {
            return {
              type: 'CHEST',
              tier: 2,
              position: {
                x: sector.bounds.x + c * TILE_PIXEL_SIZE,
                y: sector.bounds.y + r * TILE_PIXEL_SIZE,
              },
              sectorCoord: { row: gridRow, col: gridCol },
            };
          }
        }
      }
    }

    return null;
  }

  private hasAdjacentTile(tiles: Uint8Array[], row: number, col: number, type: TileType): boolean {
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const dir of dirs) {
      const nr = row + dir[0]!;
      const nc = col + dir[1]!;
      if (nr >= 0 && nr < tiles.length && nc >= 0 && nc < tiles[0]!.length) {
        if (tiles[nr]![nc] === type) return true;
      }
    }
    return false;
  }

  private fallbackCandidates(sector: SectorData): { x: number; y: number }[] {
    const candidates: { x: number; y: number }[] = [];
    const tiles = sector.tiles;
    const height = tiles.length;
    const width = tiles[0]!.length;
    for (let row = 1; row < height - 1; row++) {
      for (let col = 1; col < width - 1; col++) {
        if (tiles[row]![col] === TileType.EMPTY) {
          candidates.push({
            x: sector.bounds.x + col * TILE_PIXEL_SIZE,
            y: sector.bounds.y + row * TILE_PIXEL_SIZE,
          });
        }
      }
    }
    return candidates;
  }
}

import { TileType } from '../../enums/TileType.js';
import type { SectorData } from '../types.js';
import type { MacroFeatureResult } from '../macro/MacroTypes.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';

/** Composite map dimension (80 tiles). */
const MAP_SIZE = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;

/** Outer perimeter index — tiles at 0 or MAP_SIZE-1 must never be healed. */
const PERIMETER_LAST = MAP_SIZE - 1;

const CARDINALS: readonly (readonly [number, number])[] = [
  [-1, 0] as const,
  [1, 0] as const,
  [0, -1] as const,
  [0, 1] as const,
];

const EIGHT_DIRS: readonly (readonly [number, number])[] = [
  [-1, -1] as const,
  [-1, 0] as const,
  [-1, 1] as const,
  [0, -1] as const,
  [0, 1] as const,
  [1, -1] as const,
  [1, 0] as const,
  [1, 1] as const,
];

/**
 * Radius (in tiles) around each highway-carved tile to scan for damage.
 * Stubs and orphaned cover only appear within 1–2 tiles of the highway edge.
 */
const HEAL_RADIUS = 2;

/**
 * Maximum cardinal wall neighbours a tile may have and still be considered a
 * "dangling stub" (≤1 → lone or end-of-line stub).
 */
const STUB_MAX_WALL_NEIGHBORS = 1;

/**
 * Repairs map damage caused by macro features (Highway, the compound, the
 * Barrier Ridge flavor feature, and the Open Commons flavor feature).
 *
 * Two cleanup passes:
 *
 * 1. **Dangling wall stubs** — any wall tile (INDESTRUCTIBLE_WALL or
 *    DESTRUCTIBLE_WALL) within {@link HEAL_RADIUS} of a macro-carved tile
 *    that has ≤1 wall-type cardinal neighbour. These are wall fragments left
 *    isolated when a macro feature ploughed through or stamped over a
 *    structure. Cleared to EMPTY.
 *
 * 2. **Orphaned cover** — any crate/barrel tile within {@link HEAL_RADIUS} of a
 *    macro-carved tile (but NOT itself a macro-carved tile) that has zero
 *    non-EMPTY 8-neighbours. These are cover pieces that lost all their
 *    structural context. Cleared to EMPTY.
 *
 * Tiles written by a macro feature (highway shoulder crates, compound shell /
 * partitions / chests / cover) are INTENTIONAL and skipped by both checks —
 * the heal pass only cleans up damage to NEIGHBOURING tiles. Both passes
 * collect their decisions from the ORIGINAL tile state before applying any
 * mutations, preventing cascading clears.
 */
export class MacroHealPass {
  /**
   * Run the heal pass against the sector grid.
   *
   * @param sectors - the 2D sector grid (mutated in place)
   * @param macroResult - metadata from the preceding macro feature pass
   */
  run(sectors: SectorData[][], macroResult: MacroFeatureResult): void {
    // Merge carved tiles from ALL macro features (highway + compound +
    // barrier ridge + open commons). The heal pass cleans damage around every
    // feature's footprint.
    const carvedTiles = new Set<string>();
    if (macroResult.highway) {
      for (const t of macroResult.highway.carvedTiles) carvedTiles.add(t);
    }
    if (macroResult.compound) {
      for (const t of macroResult.compound.carvedTiles) carvedTiles.add(t);
    }
    if (macroResult.barrierRidge) {
      for (const t of macroResult.barrierRidge.carvedTiles) carvedTiles.add(t);
    }
    if (macroResult.openCommons) {
      for (const t of macroResult.openCommons.carvedTiles) carvedTiles.add(t);
    }
    if (carvedTiles.size === 0) return;

    // Build the candidate check set: all tiles within HEAL_RADIUS of any
    // macro-carved tile.
    const checkSet = new Set<string>();
    for (const key of carvedTiles) {
      const comma = key.indexOf(',');
      const r = parseInt(key.substring(0, comma), 10);
      const c = parseInt(key.substring(comma + 1), 10);
      for (let dr = -HEAL_RADIUS; dr <= HEAL_RADIUS; dr++) {
        for (let dc = -HEAL_RADIUS; dc <= HEAL_RADIUS; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= MAP_SIZE || nc < 0 || nc >= MAP_SIZE) continue;
          checkSet.add(`${nr},${nc}`);
        }
      }
    }

    // Phase 1: Collect tiles to clear based on the ORIGINAL tile state.
    // This prevents cascading where clearing one stub makes an adjacent wall
    // look like a stub too.
    const toClear = new Set<string>();

    for (const key of checkSet) {
      // Skip macro-feature tiles — they are intentional writes (highway
      // shoulder crates, compound shell/partitions/chests/cover). Only
      // NEIGHBOURING tiles that became damaged are candidates for healing.
      if (carvedTiles.has(key)) continue;

      const comma = key.indexOf(',');
      const globalR = parseInt(key.substring(0, comma), 10);
      const globalC = parseInt(key.substring(comma + 1), 10);

      const tile = getTile(sectors, globalR, globalC);
      if (tile === undefined) continue;

      // Dangling wall stub check
      if (tile === TileType.INDESTRUCTIBLE_WALL || tile === TileType.DESTRUCTIBLE_WALL) {
        let wallNeighbors = 0;
        for (const [dr, dc] of CARDINALS) {
          const nTile = getTile(sectors, globalR + dr, globalC + dc);
          if (nTile === TileType.INDESTRUCTIBLE_WALL || nTile === TileType.DESTRUCTIBLE_WALL) {
            wallNeighbors++;
          }
        }
        if (wallNeighbors <= STUB_MAX_WALL_NEIGHBORS) {
          toClear.add(key);
        }
        continue;
      }

      // Orphaned cover check
      if (tile === TileType.DESTRUCTIBLE_CRATE || tile === TileType.DESTRUCTIBLE_BARREL) {
        let hasStructureNeighbor = false;
        for (const [dr, dc] of EIGHT_DIRS) {
          const nTile = getTile(sectors, globalR + dr, globalC + dc);
          if (nTile !== undefined && nTile !== TileType.EMPTY) {
            hasStructureNeighbor = true;
            break;
          }
        }
        if (!hasStructureNeighbor) {
          toClear.add(key);
        }
      }
    }

    // Phase 2: Apply all clears.
    for (const key of toClear) {
      const comma = key.indexOf(',');
      const globalR = parseInt(key.substring(0, comma), 10);
      const globalC = parseInt(key.substring(comma + 1), 10);
      setTile(sectors, globalR, globalC, TileType.EMPTY);
    }
  }
}

/** Read a tile from the composite grid via global coordinates. */
function getTile(sectors: SectorData[][], globalR: number, globalC: number): number | undefined {
  if (globalR < 0 || globalR > PERIMETER_LAST || globalC < 0 || globalC > PERIMETER_LAST) {
    return undefined;
  }
  const sr = Math.floor(globalR / SECTOR_TILE_SIZE);
  const sc = Math.floor(globalC / SECTOR_TILE_SIZE);
  const lr = globalR % SECTOR_TILE_SIZE;
  const lc = globalC % SECTOR_TILE_SIZE;
  return sectors[sr]?.[sc]?.tiles?.[lr]?.[lc];
}

/** Write a tile to the composite grid via global coordinates. */
function setTile(sectors: SectorData[][], globalR: number, globalC: number, value: TileType): void {
  const sr = Math.floor(globalR / SECTOR_TILE_SIZE);
  const sc = Math.floor(globalC / SECTOR_TILE_SIZE);
  const lr = globalR % SECTOR_TILE_SIZE;
  const lc = globalC % SECTOR_TILE_SIZE;
  const sector = sectors[sr]?.[sc];
  if (!sector?.tiles?.[lr]) return;
  sector.tiles[lr]![lc] = value;
}

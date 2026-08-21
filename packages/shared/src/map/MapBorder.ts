import type { SectorData } from './types.js';
import { TileType } from '../enums/TileType.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from './constants.js';

/**
 * Pure border-geometry pass over the sector graph. Carves an
 * {@link TileType.INDESTRUCTIBLE_WALL} ring around the global map perimeter
 * and clears wall-typed tiles from the 1-tile interior buffer inside every
 * sector border so the {@link WallMaskClassifier} sees clean neighbours on the
 * interior side of each border wall.
 *
 * Stateless and RNG-free: both public methods mutate the supplied `sectors`
 * graph in place and touch no other collaborator. This is the zero-determinism-
 * risk extraction of the two border concerns that previously lived inline in
 * {@link MapGenerator}.
 */
export class MapBorder {
  /**
   * Carve an {@link TileType.INDESTRUCTIBLE_WALL} ring around the global map
   * perimeter (top/bottom rows and left/right cols of the outermost sectors,
   * across the full grid). Mutates `sectors` in place. Idempotent (writing an
   * INDESTRUCTIBLE_WALL on a tile that already holds it is a no-op).
   *
   * @param sectors - the full SECTOR_GRID_SIZE × SECTOR_GRID_SIZE sector graph
   */
  carveWalls(sectors: SectorData[][]): void {
    const lastSectorRow = SECTOR_GRID_SIZE - 1;
    const lastSectorCol = SECTOR_GRID_SIZE - 1;
    const lastTile = SECTOR_TILE_SIZE - 1;

    for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
      const topSector = sectors[0]![sCol]!;
      for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
        topSector.tiles[0]![c] = TileType.INDESTRUCTIBLE_WALL;
      }

      const bottomSector = sectors[lastSectorRow]![sCol]!;
      for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
        bottomSector.tiles[lastTile]![c] = TileType.INDESTRUCTIBLE_WALL;
      }
    }

    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      const leftSector = sectors[sRow]![0]!;
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        leftSector.tiles[r]![0] = TileType.INDESTRUCTIBLE_WALL;
      }

      const rightSector = sectors[sRow]![lastSectorCol]!;
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        rightSector.tiles[r]![lastTile] = TileType.INDESTRUCTIBLE_WALL;
      }
    }
  }

  /**
   * Clear wall-type tiles (INDESTRUCTIBLE_WALL, DESTRUCTIBLE_WALL) in the
   * 1-tile buffer inside every sector border so the {@link WallMaskClassifier}
   * sees clean neighbours on the interior side of each border wall — producing
   * correct straight/corner roles matching the demo_map.tmx design.
   *
   * Sector generators may place walls at local row 1 / col 1 / row 18 / col 18
   * (1 tile inside the sector's own border ring). Without this cleanup those
   * interior walls corrupt the 8-neighbour mask of the border cells, causing
   * the classifier to emit corner/junction roles instead of the correct
   * straight roles.
   *
   * Non-wall tiles (crates, barrels, chests, etc.) in the buffer zone are
   * preserved — only wall-type tiles are cleared to {@link TileType.EMPTY}.
   * Mutates `sectors` in place. Idempotent (once a buffer tile is EMPTY it is
   * no longer wall-typed and is skipped on a subsequent pass).
   *
   * @param sectors - the full SECTOR_GRID_SIZE × SECTOR_GRID_SIZE sector graph
   * @param preserve - optional global `"row,col"` keys never to clear (round
   *   5e: the post-stamp re-run passes the macro-feature footprint set — the
   *   Citadel's yard band legitimately authors walls at sector-local 1..2 and
   *   macro features own their tiles, exactly like the prefab/keep paint-gates)
   */
  cleanBuffer(sectors: SectorData[][], preserve?: ReadonlySet<string>): void {
    const lastTile = SECTOR_TILE_SIZE - 1;

    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const tiles = sectors[sRow]![sCol]!.tiles;
        if (!tiles) continue;

        const globalRow = sRow * SECTOR_TILE_SIZE;
        const globalCol = sCol * SECTOR_TILE_SIZE;
        const tryClear = (row: number, col: number): void => {
          if (preserve?.has(`${globalRow + row},${globalCol + col}`)) return;
          this.clearWall(tiles, row, col);
        };

        for (let i = 1; i < lastTile; i++) {
          tryClear(1, i);
          tryClear(lastTile - 1, i);
          tryClear(i, 1);
          tryClear(i, lastTile - 1);
        }
      }
    }
  }

  /**
   * Clear a single wall-type tile to {@link TileType.EMPTY}. Non-wall tiles
   * (crates, barrels, chests, etc.) are preserved.
   *
   * @param tiles - the per-sector tile rows
   * @param row - the local tile row within the sector
   * @param col - the local tile col within the sector
   */
  private clearWall(tiles: Uint8Array[], row: number, col: number): void {
    const t = tiles[row]![col]!;
    if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL) {
      tiles[row]![col] = TileType.EMPTY;
    }
  }
}

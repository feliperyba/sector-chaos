import { describe, expect, it } from 'vitest';

import { MapBorder } from '../MapBorder.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE, TILE_PIXEL_SIZE } from '../constants.js';
import { SectorType } from '../types.js';
import type { SectorData } from '../types.js';
import type { SectorSubVariant } from '../sectors/subVariants.js';
import { TileType } from '../../enums/TileType.js';

const FILL_SENTINEL = TileType.CHEST;

/**
 * Build a synthetic 4×4 grid of 20×20 sectors where every tile is `fill`.
 * All 7 required SectorData fields are populated; the non-tile fields use
 * arbitrary-but-typed values because carveWalls/cleanBuffer read only `tiles`.
 *
 * @param fill - the TileType to fill every tile cell with
 * @returns a fresh SECTOR_GRID_SIZE × SECTOR_GRID_SIZE sector graph
 */
function buildFixtureSectors(fill: TileType): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    sectors[row] = [];
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      const tiles: Uint8Array[] = [];
      const elevation: Uint8Array[] = [];
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        tiles[r] = new Uint8Array(SECTOR_TILE_SIZE).fill(fill);
        elevation[r] = new Uint8Array(SECTOR_TILE_SIZE).fill(0);
      }
      sectors[row]![col] = {
        type: SectorType.OPEN_ARENA,
        subVariant: 'default' as SectorSubVariant,
        tiles,
        elevation,
        lootSpots: [],
        landmarkAnchor: { x: SECTOR_TILE_SIZE >> 1, y: SECTOR_TILE_SIZE >> 1 },
        mirrored: false,
        subBlockMask: 0,
        bounds: {
          x: col * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
          y: row * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
          width: SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
          height: SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
        },
        theme: 'default',
      };
    }
  }
  return sectors;
}

describe('MapBorder', () => {
  it('global outer perimeter is INDESTRUCTIBLE_WALL after carveWalls', () => {
    const sectors = buildFixtureSectors(FILL_SENTINEL);
    new MapBorder().carveWalls(sectors);

    const lastSectorRow = SECTOR_GRID_SIZE - 1;
    const lastSectorCol = SECTOR_GRID_SIZE - 1;
    const lastTile = SECTOR_TILE_SIZE - 1;

    // Top row across all top-row sectors
    for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
      const sector = sectors[0]![sCol]!;
      for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
        expect(sector.tiles[0]![c]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
    // Bottom row across all bottom-row sectors
    for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
      const sector = sectors[lastSectorRow]![sCol]!;
      for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
        expect(sector.tiles[lastTile]![c]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
    // Left col across all left-col sectors
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      const sector = sectors[sRow]![0]!;
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        expect(sector.tiles[r]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
    // Right col across all right-col sectors
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      const sector = sectors[sRow]![lastSectorCol]!;
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        expect(sector.tiles[r]![lastTile]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
  });

  it('interior tiles unchanged after carveWalls', () => {
    const sectors = buildFixtureSectors(FILL_SENTINEL);
    new MapBorder().carveWalls(sectors);

    // Deep-interior tile in sector (1,1) local (5,5) stays the sentinel fill.
    expect(sectors[1]![1]!.tiles[5]![5]).toBe(FILL_SENTINEL);
  });

  it('corner-overlap (tile-space (0,0)) is INDESTRUCTIBLE_WALL', () => {
    const sectors = buildFixtureSectors(FILL_SENTINEL);
    new MapBorder().carveWalls(sectors);

    // The top-left global corner (sector (0,0) local (0,0)) is written by both
    // the top-row loop and the left-col loop — no conflict, single result.
    expect(sectors[0]![0]!.tiles[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
  });

  it('cleanBuffer clears wall-typed tiles in the 1-tile interior buffer (local 1/18) in every sector', () => {
    // Start from a fixture already carved (perimeter INDESTRUCTIBLE_WALL) and
    // additionally seed every interior buffer tile to INDESTRUCTIBLE_WALL so
    // cleanBuffer has something to clear. The outer ring (local 0/19) stays
    // INDESTRUCTIBLE_WALL from carveWalls.
    const sectors = buildFixtureSectors(TileType.INDESTRUCTIBLE_WALL);
    new MapBorder().carveWalls(sectors);
    new MapBorder().cleanBuffer(sectors);

    const lastTile = SECTOR_TILE_SIZE - 1;
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const tiles = sectors[sRow]![sCol]!.tiles;
        for (let i = 1; i < lastTile; i++) {
          expect(tiles[1]![i]).toBe(TileType.EMPTY);
          expect(tiles[lastTile - 1]![i]).toBe(TileType.EMPTY);
          expect(tiles[i]![1]).toBe(TileType.EMPTY);
          expect(tiles[i]![lastTile - 1]).toBe(TileType.EMPTY);
        }
      }
    }
  });

  it('cleanBuffer does NOT touch the outer ring (local 0/19)', () => {
    const sectors = buildFixtureSectors(TileType.INDESTRUCTIBLE_WALL);
    new MapBorder().carveWalls(sectors);
    new MapBorder().cleanBuffer(sectors);

    const lastTile = SECTOR_TILE_SIZE - 1;
    for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
      for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
        const tiles = sectors[sRow]![sCol]!.tiles;
        for (let i = 0; i < SECTOR_TILE_SIZE; i++) {
          expect(tiles[0]![i]).toBe(TileType.INDESTRUCTIBLE_WALL);
          expect(tiles[lastTile]![i]).toBe(TileType.INDESTRUCTIBLE_WALL);
          expect(tiles[i]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
          expect(tiles[i]![lastTile]).toBe(TileType.INDESTRUCTIBLE_WALL);
        }
      }
    }
  });

  it('cleanBuffer preserves non-wall tiles in the buffer zone (CRATE survives)', () => {
    const sectors = buildFixtureSectors(FILL_SENTINEL);
    new MapBorder().carveWalls(sectors);
    // Plant a CRATE at sector (2,2) local (1,5) — inside the buffer zone that
    // cleanBuffer iterates. cleanBuffer must NOT clear it (only wall types are
    // cleared; DESTRUCTIBLE_CRATE is a crate, not a wall).
    sectors[2]![2]!.tiles[1]![5] = TileType.DESTRUCTIBLE_CRATE;
    new MapBorder().cleanBuffer(sectors);

    expect(sectors[2]![2]!.tiles[1]![5]).toBe(TileType.DESTRUCTIBLE_CRATE);
  });

  it('carveWalls is idempotent', () => {
    const sectors = buildFixtureSectors(FILL_SENTINEL);
    const border = new MapBorder();
    border.carveWalls(sectors);
    const after1 = sectors.map((row) => row.map((s) => s.tiles.map((t) => Array.from(t))));
    border.carveWalls(sectors);
    const after2 = sectors.map((row) => row.map((s) => s.tiles.map((t) => Array.from(t))));

    expect(after2).toEqual(after1);
  });

  it('cleanBuffer is idempotent', () => {
    const sectors = buildFixtureSectors(TileType.INDESTRUCTIBLE_WALL);
    const border = new MapBorder();
    border.carveWalls(sectors);
    border.cleanBuffer(sectors);
    const after1 = sectors.map((row) => row.map((s) => s.tiles.map((t) => Array.from(t))));
    border.cleanBuffer(sectors);
    const after2 = sectors.map((row) => row.map((s) => s.tiles.map((t) => Array.from(t))));

    expect(after2).toEqual(after1);
  });
});

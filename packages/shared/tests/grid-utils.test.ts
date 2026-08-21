import { describe, expect, it } from 'vitest';
import { TileType } from '../src/enums/TileType.js';
import {
  isEmptyTile,
  isTraversable,
  buildCompositeGrid,
  getSectorRing,
} from '../src/map/gridUtils.js';
import { SectorType } from '../src/map/types.js';
import type { SectorData } from '../src/map/types.js';
import { SECTOR_TILE_SIZE } from '../src/map/constants.js';

function makeSector(fillTile: TileType = TileType.EMPTY): SectorData {
  const tiles: Uint8Array[] = [];
  for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
    const row = new Uint8Array(SECTOR_TILE_SIZE);
    row.fill(fillTile);
    tiles.push(row);
  }
  return {
    type: SectorType.GRID_ARENA,
    tiles,
    elevation: null,
    lootSpots: [],
    bounds: { x: 0, y: 0, width: 2560, height: 2560 },
    theme: 'default',
  };
}

describe('isEmptyTile', () => {
  it('returns true for EMPTY (0)', () => {
    expect(isEmptyTile(TileType.EMPTY)).toBe(true);
  });

  it('returns false for INDESTRUCTIBLE_WALL', () => {
    expect(isEmptyTile(TileType.INDESTRUCTIBLE_WALL)).toBe(false);
  });

  it('returns false for DESTRUCTIBLE_WALL', () => {
    expect(isEmptyTile(TileType.DESTRUCTIBLE_WALL)).toBe(false);
  });

  it('returns false for CHEST', () => {
    expect(isEmptyTile(TileType.CHEST)).toBe(false);
  });

  it('returns false for EXIT', () => {
    expect(isEmptyTile(TileType.EXIT)).toBe(false);
  });

  it('returns false for DESTRUCTIBLE_CRATE', () => {
    expect(isEmptyTile(TileType.DESTRUCTIBLE_CRATE)).toBe(false);
  });

  it('returns false for DESTRUCTIBLE_BARREL', () => {
    expect(isEmptyTile(TileType.DESTRUCTIBLE_BARREL)).toBe(false);
  });

  it('returns false for INDESTRUCTIBLE_CRATE', () => {
    expect(isEmptyTile(TileType.INDESTRUCTIBLE_CRATE)).toBe(false);
  });

  it('returns true only for value 0', () => {
    const allTileTypes: number[] = [
      TileType.EMPTY,
      TileType.INDESTRUCTIBLE_WALL,
      TileType.DESTRUCTIBLE_WALL,
      TileType.CHEST,
      TileType.EXIT,
      TileType.DESTRUCTIBLE_CRATE,
      TileType.DESTRUCTIBLE_BARREL,
      TileType.INDESTRUCTIBLE_CRATE,
    ];
    const trueCount = allTileTypes.filter((t) => isEmptyTile(t)).length;
    expect(trueCount).toBe(1);
  });
});

describe('isTraversable', () => {
  it('returns true for EMPTY', () => {
    expect(isTraversable(TileType.EMPTY)).toBe(true);
  });

  it('returns true for DESTRUCTIBLE_WALL', () => {
    expect(isTraversable(TileType.DESTRUCTIBLE_WALL)).toBe(true);
  });

  it('returns true for CHEST', () => {
    expect(isTraversable(TileType.CHEST)).toBe(true);
  });

  it('returns true for EXIT', () => {
    expect(isTraversable(TileType.EXIT)).toBe(true);
  });

  it('returns true for DESTRUCTIBLE_CRATE', () => {
    expect(isTraversable(TileType.DESTRUCTIBLE_CRATE)).toBe(true);
  });

  it('returns true for DESTRUCTIBLE_BARREL', () => {
    expect(isTraversable(TileType.DESTRUCTIBLE_BARREL)).toBe(true);
  });

  it('returns false for INDESTRUCTIBLE_WALL', () => {
    expect(isTraversable(TileType.INDESTRUCTIBLE_WALL)).toBe(false);
  });

  it('returns false for INDESTRUCTIBLE_CRATE', () => {
    expect(isTraversable(TileType.INDESTRUCTIBLE_CRATE)).toBe(false);
  });
});

describe('buildCompositeGrid', () => {
  it('2x2 sector grid produces 40x40 output', () => {
    const sectors: SectorData[][] = [
      [makeSector(), makeSector()],
      [makeSector(), makeSector()],
    ];
    const grid = buildCompositeGrid(sectors);
    expect(grid.length).toBe(40);
    for (const row of grid) {
      expect(row.length).toBe(40);
    }
  });

  it('maps sector [sRow][sCol] tiles to correct composite positions', () => {
    const sectors: SectorData[][] = [
      [makeSector(), makeSector()],
      [makeSector(), makeSector()],
    ];
    sectors[1]![1]!.tiles[5]![3] = TileType.INDESTRUCTIBLE_WALL;
    const grid = buildCompositeGrid(sectors);
    const compositeRow = 1 * SECTOR_TILE_SIZE + 5;
    const compositeCol = 1 * SECTOR_TILE_SIZE + 3;
    expect(grid[compositeRow]![compositeCol]).toBe(TileType.INDESTRUCTIBLE_WALL);
  });

  it('single sector grid (1x1) produces 20x20 output', () => {
    const sectors: SectorData[][] = [[makeSector()]];
    const grid = buildCompositeGrid(sectors);
    expect(grid.length).toBe(20);
    for (const row of grid) {
      expect(row.length).toBe(20);
    }
  });

  it('first row of composite matches first row of first sector', () => {
    const sector = makeSector();
    sector.tiles[0]![0] = TileType.INDESTRUCTIBLE_WALL;
    sector.tiles[0]![19] = TileType.DESTRUCTIBLE_WALL;
    const sectors: SectorData[][] = [[sector]];
    const grid = buildCompositeGrid(sectors);
    expect(grid[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(grid[0]![19]).toBe(TileType.DESTRUCTIBLE_WALL);
  });

  it('last row of composite matches last row of last sector', () => {
    const sectors: SectorData[][] = [
      [makeSector(), makeSector()],
      [makeSector(), makeSector()],
    ];
    sectors[1]![1]!.tiles[19]![0] = TileType.CHEST;
    sectors[1]![1]!.tiles[19]![19] = TileType.DESTRUCTIBLE_BARREL;
    const grid = buildCompositeGrid(sectors);
    const lastRow = grid[39]!;
    const sectorColOffset = 1 * SECTOR_TILE_SIZE;
    expect(lastRow![sectorColOffset + 0]).toBe(TileType.CHEST);
    expect(lastRow![sectorColOffset + 19]).toBe(TileType.DESTRUCTIBLE_BARREL);
  });
});

describe('getSectorRing', () => {
  it('returns outer for (0, 0, 4) — top-left corner', () => {
    expect(getSectorRing(0, 0, 4)).toBe('outer');
  });

  it('returns outer for (0, 3, 4) — top-right', () => {
    expect(getSectorRing(0, 3, 4)).toBe('outer');
  });

  it('returns outer for (3, 0, 4) — bottom-left', () => {
    expect(getSectorRing(3, 0, 4)).toBe('outer');
  });

  it('returns outer for (3, 3, 4) — bottom-right', () => {
    expect(getSectorRing(3, 3, 4)).toBe('outer');
  });

  it('returns outer for (0, 2, 4) — top row', () => {
    expect(getSectorRing(0, 2, 4)).toBe('outer');
  });

  it('returns outer for (2, 0, 4) — left col', () => {
    expect(getSectorRing(2, 0, 4)).toBe('outer');
  });

  it('returns center for (1, 1, 4) — interior', () => {
    expect(getSectorRing(1, 1, 4)).toBe('center');
  });

  it('returns center for (1, 2, 4) — interior', () => {
    expect(getSectorRing(1, 2, 4)).toBe('center');
  });

  it('returns center for (2, 2, 4) — interior', () => {
    expect(getSectorRing(2, 2, 4)).toBe('center');
  });

  it('throws for (-1, 0, 4)', () => {
    expect(() => getSectorRing(-1, 0, 4)).toThrow();
  });

  it('throws for (4, 0, 4)', () => {
    expect(() => getSectorRing(4, 0, 4)).toThrow();
  });

  it('throws for (0, -1, 4)', () => {
    expect(() => getSectorRing(0, -1, 4)).toThrow();
  });

  it('throws for (0, 4, 4)', () => {
    expect(() => getSectorRing(0, 4, 4)).toThrow();
  });
});

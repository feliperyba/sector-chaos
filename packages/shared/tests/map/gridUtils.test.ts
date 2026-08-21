import { TileType } from '../../src/enums/TileType.js';
import {
  isEmptyTile,
  isTraversable,
  buildCompositeGrid,
  getSectorRing,
} from '../../src/map/gridUtils.js';
import { SectorType } from '../../src/map/types.js';
import type { SectorData } from '../../src/map/types.js';
import { SECTOR_TILE_SIZE } from '../../src/map/constants.js';

describe('isEmptyTile', () => {
  it('returns true only for EMPTY (0)', () => {
    expect(isEmptyTile(TileType.EMPTY)).toBe(true);
    expect(isEmptyTile(TileType.INDESTRUCTIBLE_WALL)).toBe(false);
    expect(isEmptyTile(TileType.DESTRUCTIBLE_WALL)).toBe(false);
    expect(isEmptyTile(TileType.CHEST)).toBe(false);
    expect(isEmptyTile(TileType.EXIT)).toBe(false);
    expect(isEmptyTile(TileType.DESTRUCTIBLE_CRATE)).toBe(false);
    expect(isEmptyTile(TileType.DESTRUCTIBLE_BARREL)).toBe(false);
    expect(isEmptyTile(TileType.INDESTRUCTIBLE_CRATE)).toBe(false);
  });

  it('returns false for numeric value 0 only', () => {
    expect(isEmptyTile(0)).toBe(true);
    expect(isEmptyTile(1)).toBe(false);
    expect(isEmptyTile(2)).toBe(false);
  });
});

describe('isTraversable', () => {
  it('returns true for all tiles except INDESTRUCTIBLE_WALL and INDESTRUCTIBLE_CRATE', () => {
    expect(isTraversable(TileType.EMPTY)).toBe(true);
    expect(isTraversable(TileType.DESTRUCTIBLE_WALL)).toBe(true);
    expect(isTraversable(TileType.DESTRUCTIBLE_BARREL)).toBe(true);
    expect(isTraversable(TileType.DESTRUCTIBLE_CRATE)).toBe(true);
    expect(isTraversable(TileType.CHEST)).toBe(true);
    expect(isTraversable(TileType.EXIT)).toBe(true);
  });

  it('returns false for INDESTRUCTIBLE_WALL', () => {
    expect(isTraversable(TileType.INDESTRUCTIBLE_WALL)).toBe(false);
  });

  it('returns false for INDESTRUCTIBLE_CRATE', () => {
    expect(isTraversable(TileType.INDESTRUCTIBLE_CRATE)).toBe(false);
  });
});

function makeSector(row: number, col: number, fillTile: TileType = TileType.EMPTY): SectorData {
  const tiles: Uint8Array[] = [];
  for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
    tiles[r] = new Uint8Array(SECTOR_TILE_SIZE);
    tiles[r]!.fill(fillTile);
  }
  return {
    type: SectorType.OPEN_ARENA,
    tiles,
    elevation: null,
    lootSpots: [],
    bounds: {
      x: col * SECTOR_TILE_SIZE * 128,
      y: row * SECTOR_TILE_SIZE * 128,
      width: SECTOR_TILE_SIZE * 128,
      height: SECTOR_TILE_SIZE * 128,
    },
    theme: 'default',
  };
}

describe('buildCompositeGrid', () => {
  it('produces grid of size gridSize * sectorTileSize', () => {
    const sectors: SectorData[][] = [];
    for (let r = 0; r < 4; r++) {
      sectors[r] = [];
      for (let c = 0; c < 4; c++) {
        sectors[r]![c] = makeSector(r, c);
      }
    }
    const grid = buildCompositeGrid(sectors);
    expect(grid.length).toBe(4 * SECTOR_TILE_SIZE);
    for (const row of grid) {
      expect(row.length).toBe(4 * SECTOR_TILE_SIZE);
    }
  });

  it('correctly maps sector tiles into composite positions', () => {
    const sectors: SectorData[][] = [];
    for (let r = 0; r < 4; r++) {
      sectors[r] = [];
      for (let c = 0; c < 4; c++) {
        sectors[r]![c] = makeSector(r, c);
      }
    }
    sectors[1]![2]!.tiles[5]![3] = TileType.INDESTRUCTIBLE_WALL;
    const grid = buildCompositeGrid(sectors);
    const compositeRow = 1 * SECTOR_TILE_SIZE + 5;
    const compositeCol = 2 * SECTOR_TILE_SIZE + 3;
    expect(grid[compositeRow]![compositeCol]).toBe(TileType.INDESTRUCTIBLE_WALL);
  });

  it('preserves all EMPTY tiles from sectors', () => {
    const sectors: SectorData[][] = [];
    for (let r = 0; r < 4; r++) {
      sectors[r] = [];
      for (let c = 0; c < 4; c++) {
        sectors[r]![c] = makeSector(r, c, TileType.EMPTY);
      }
    }
    const grid = buildCompositeGrid(sectors);
    for (const row of grid) {
      for (let c = 0; c < row.length; c++) {
        expect(row[c]).toBe(TileType.EMPTY);
      }
    }
  });
});

describe('getSectorRing', () => {
  it('returns outer for edge sectors', () => {
    expect(getSectorRing(0, 0, 4)).toBe('outer');
    expect(getSectorRing(0, 1, 4)).toBe('outer');
    expect(getSectorRing(0, 2, 4)).toBe('outer');
    expect(getSectorRing(0, 3, 4)).toBe('outer');
    expect(getSectorRing(1, 0, 4)).toBe('outer');
    expect(getSectorRing(2, 0, 4)).toBe('outer');
    expect(getSectorRing(3, 0, 4)).toBe('outer');
    expect(getSectorRing(3, 3, 4)).toBe('outer');
    expect(getSectorRing(3, 1, 4)).toBe('outer');
    expect(getSectorRing(1, 3, 4)).toBe('outer');
  });

  it('returns center for non-edge sectors', () => {
    expect(getSectorRing(1, 1, 4)).toBe('center');
    expect(getSectorRing(1, 2, 4)).toBe('center');
    expect(getSectorRing(2, 1, 4)).toBe('center');
    expect(getSectorRing(2, 2, 4)).toBe('center');
  });

  it('throws for invalid coordinates', () => {
    expect(() => getSectorRing(-1, 0, 4)).toThrow();
    expect(() => getSectorRing(0, -1, 4)).toThrow();
    expect(() => getSectorRing(4, 0, 4)).toThrow();
    expect(() => getSectorRing(0, 4, 4)).toThrow();
    expect(() => getSectorRing(-1, -1, 4)).toThrow();
    expect(() => getSectorRing(99, 99, 4)).toThrow();
  });
});

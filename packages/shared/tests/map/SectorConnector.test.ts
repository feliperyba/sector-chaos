import { SeededRNG } from '../../src/map/rng/SeededRNG.js';
import { SectorConnector } from '../../src/map/SectorConnector.js';
import { TileType } from '../../src/enums/TileType.js';
import { SectorType } from '../../src/map/types.js';
import type { SectorData } from '../../src/map/types.js';
import {
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  SECTOR_GRID_SIZE,
  CORRIDOR_WIDTH,
} from '../../src/map/constants.js';
import { GridArenaGenerator } from '../../src/map/sectors/GridArenaGenerator.js';
import { MazeGenerator } from '../../src/map/sectors/MazeGenerator.js';
import type { SectorConfig } from '../../src/map/sectors/ISectorGenerator.js';

function makeConfig(row: number, col: number, type: SectorType): SectorConfig {
  return {
    width: SECTOR_TILE_SIZE,
    height: SECTOR_TILE_SIZE,
    tileSize: TILE_PIXEL_SIZE,
    type,
    theme: 'default',
    sectorCoord: { row, col },
  };
}

function makeOpenSectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    sectors[row] = [];
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      const tiles: Uint8Array[] = [];
      for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
        tiles[r] = new Uint8Array(SECTOR_TILE_SIZE);
        for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
          tiles[r]![c] =
            r === 0 || r === SECTOR_TILE_SIZE - 1 || c === 0 || c === SECTOR_TILE_SIZE - 1
              ? TileType.INDESTRUCTIBLE_WALL
              : TileType.EMPTY;
        }
      }
      sectors[row]![col] = {
        type: SectorType.OPEN_ARENA,
        tiles,
        elevation: null,
        lootSpots: [],
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

describe('SectorConnector', () => {
  it('creates 24 connections for a 4x4 grid', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    const { connections } = connector.connect(sectors, rng);
    expect(connections.length).toBe(24);
  });

  it('all connections have width === 3', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    const { connections } = connector.connect(sectors, rng);
    for (const conn of connections) {
      expect(conn.width).toBe(3);
    }
  });

  it('horizontal connections are between adjacent columns in same row', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    const { connections } = connector.connect(sectors, rng);

    const horizontal = connections.filter(
      (c) => c.sectorA.row === c.sectorB.row && c.sectorB.col === c.sectorA.col + 1,
    );
    expect(horizontal.length).toBe(12);
  });

  it('vertical connections are between adjacent rows in same column', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    const { connections } = connector.connect(sectors, rng);

    const vertical = connections.filter(
      (c) => c.sectorA.col === c.sectorB.col && c.sectorB.row === c.sectorA.row + 1,
    );
    expect(vertical.length).toBe(12);
  });

  it('corridors are centered at tile offsets [9, 10, 11]', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    const { connections } = connector.connect(sectors, rng);

    for (const conn of connections) {
      const isHorizontal = conn.sectorA.row === conn.sectorB.row;
      const sector = sectors[conn.sectorA.row]![conn.sectorA.col]!;

      if (isHorizontal) {
        const startTileRow = (conn.positionA.y - sector.bounds.y) / TILE_PIXEL_SIZE;
        expect(startTileRow).toBe(9);
      } else {
        const startTileCol = (conn.positionA.x - sector.bounds.x) / TILE_PIXEL_SIZE;
        expect(startTileCol).toBe(9);
      }
    }
  });

  it('carves EMPTY tiles at border positions [9, 10, 11]', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    connector.connect(sectors, rng);

    const offsets = [9, 10, 11];
    const lastTile = SECTOR_TILE_SIZE - 1;

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE - 1; col++) {
        for (const r of offsets) {
          expect(sectors[row]![col]!.tiles[r]![lastTile]).toBe(TileType.EMPTY);
          expect(sectors[row]![col + 1]!.tiles[r]![0]).toBe(TileType.EMPTY);
        }
      }
    }

    for (let row = 0; row < SECTOR_GRID_SIZE - 1; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        for (const c of offsets) {
          expect(sectors[row]![col]!.tiles[lastTile]![c]).toBe(TileType.EMPTY);
          expect(sectors[row + 1]![col]!.tiles[0]![c]).toBe(TileType.EMPTY);
        }
      }
    }
  });

  it('tracks all carved tiles in corridorTiles set', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const sectors = makeOpenSectorGrid();
    const { corridorTiles } = connector.connect(sectors, rng);

    const offsets = [9, 10, 11];
    const lastTile = SECTOR_TILE_SIZE - 1;

    let expectedCount = 0;
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE - 1; col++) {
        for (const r of offsets) {
          expect(corridorTiles.has(`${row},${col},${r},${lastTile}`)).toBe(true);
          expect(corridorTiles.has(`${row},${col + 1},${r},0`)).toBe(true);
          expectedCount += 2;
        }
      }
    }

    for (let row = 0; row < SECTOR_GRID_SIZE - 1; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        for (const c of offsets) {
          expect(corridorTiles.has(`${row},${col},${lastTile},${c}`)).toBe(true);
          expect(corridorTiles.has(`${row + 1},${col},0,${c}`)).toBe(true);
          expectedCount += 2;
        }
      }
    }

    expect(corridorTiles.size).toBe(expectedCount);
  });

  it('ensures interior connectivity with maze sectors', () => {
    const connector = new SectorConnector();
    const rng = new SeededRNG(42);
    const mazeGen = new MazeGenerator();
    const sectors: SectorData[][] = [];
    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      sectors[row] = [];
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        sectors[row]![col] = mazeGen.generate(rng, makeConfig(row, col, SectorType.MAZE));
      }
    }
    connector.connect(sectors, rng);

    const gridSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
    let passableCount = 0;
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const sr = Math.floor(r / SECTOR_TILE_SIZE);
        const sc = Math.floor(c / SECTOR_TILE_SIZE);
        const lr = r % SECTOR_TILE_SIZE;
        const lc = c % SECTOR_TILE_SIZE;
        if (sectors[sr]![sc]!.tiles[lr]![lc] !== TileType.INDESTRUCTIBLE_WALL) {
          passableCount++;
        }
      }
    }
    expect(passableCount).toBeGreaterThan(0);
  });

  it('exports CORRIDOR_WIDTH as 3', () => {
    expect(CORRIDOR_WIDTH).toBe(3);
  });
});

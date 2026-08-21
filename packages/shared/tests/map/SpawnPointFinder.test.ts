import { SeededRNG } from '../../src/map/rng/SeededRNG.js';
import { SpawnPointFinder, MIN_SPAWN_DIST } from '../../src/map/SpawnPointFinder.js';
import { MapGenerator } from '../../src/map/MapGenerator.js';
import { TileType } from '../../src/enums/TileType.js';
import { SectorType } from '../../src/map/types.js';
import type { SectorData, SpawnPoint } from '../../src/map/types.js';
import { SECTOR_TILE_SIZE, TILE_PIXEL_SIZE, SECTOR_GRID_SIZE } from '../../src/map/constants.js';

function makeEmptySectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    sectors[row] = [];
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      sectors[row]![col] = makeOpenSector(row, col);
    }
  }
  return sectors;
}

function makeOpenSector(row: number, col: number): SectorData {
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
  return {
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

function spawnToLocalTile(sp: SpawnPoint, sectors: SectorData[][]): { row: number; col: number } {
  const sector = sectors[sp.sectorCoord.row]![sp.sectorCoord.col]!;
  return {
    col: Math.round((sp.x - sector.bounds.x) / TILE_PIXEL_SIZE),
    row: Math.round((sp.y - sector.bounds.y) / TILE_PIXEL_SIZE),
  };
}

describe('SpawnPointFinder', () => {
  it('places 4 spawns per sector (64 total)', () => {
    const finder = new SpawnPointFinder();
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const spawns = finder.find(sectors, rng);

    expect(spawns.length).toBe(64);

    const bySector = new Map<string, number>();
    for (const sp of spawns) {
      const key = `${sp.sectorCoord.row},${sp.sectorCoord.col}`;
      bySector.set(key, (bySector.get(key) ?? 0) + 1);
    }

    for (const [, count] of bySector) {
      expect(count).toBe(4);
    }
  });

  it('enforces >= 3 tile Manhattan spacing within each sector', () => {
    const finder = new SpawnPointFinder();
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const spawns = finder.find(sectors, rng);

    const bySector = new Map<string, SpawnPoint[]>();
    for (const sp of spawns) {
      const key = `${sp.sectorCoord.row},${sp.sectorCoord.col}`;
      if (!bySector.has(key)) bySector.set(key, []);
      bySector.get(key)!.push(sp);
    }

    for (const [, sectorSpawns] of bySector) {
      for (let i = 0; i < sectorSpawns.length; i++) {
        const a = spawnToLocalTile(sectorSpawns[i]!, sectors);
        for (let j = i + 1; j < sectorSpawns.length; j++) {
          const b = spawnToLocalTile(sectorSpawns[j]!, sectors);
          const dist = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
          expect(dist).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('assigns higher priority to spawns closer to map center', () => {
    const finder = new SpawnPointFinder();
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const spawns = finder.find(sectors, rng);

    const mapCenter = (SECTOR_GRID_SIZE * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE) / 2;
    const sorted = [...spawns].sort((a, b) => b.priority - a.priority);

    for (let i = 0; i < sorted.length - 1; i++) {
      const da = Math.sqrt((sorted[i]!.x - mapCenter) ** 2 + (sorted[i]!.y - mapCenter) ** 2);
      const db = Math.sqrt(
        (sorted[i + 1]!.x - mapCenter) ** 2 + (sorted[i + 1]!.y - mapCenter) ** 2,
      );
      expect(da).toBeLessThanOrEqual(db);
    }
  });

  it('computes pixel positions correctly (tile * TILE_PIXEL_SIZE)', () => {
    const finder = new SpawnPointFinder();
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const spawns = finder.find(sectors, rng);

    for (const sp of spawns) {
      const sector = sectors[sp.sectorCoord.row]![sp.sectorCoord.col]!;
      const localX = sp.x - sector.bounds.x;
      const localY = sp.y - sector.bounds.y;
      expect(localX % TILE_PIXEL_SIZE).toBe(TILE_PIXEL_SIZE / 2);
      expect(localY % TILE_PIXEL_SIZE).toBe(TILE_PIXEL_SIZE / 2);

      const tileCol = Math.floor(localX / TILE_PIXEL_SIZE);
      const tileRow = Math.floor(localY / TILE_PIXEL_SIZE);
      expect(tileCol).toBeGreaterThanOrEqual(1);
      expect(tileCol).toBeLessThan(SECTOR_TILE_SIZE - 1);
      expect(tileRow).toBeGreaterThanOrEqual(1);
      expect(tileRow).toBeLessThan(SECTOR_TILE_SIZE - 1);
      expect(sector.tiles[tileRow]![tileCol]).toBe(TileType.EMPTY);
    }
  });

  it('integration: full pipeline produces 64 spawn points', { timeout: 10000 }, () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    expect(map.spawnPoints.length).toBe(64);
  });

  it('integration: all spawns have valid sector coordinates', { timeout: 10000 }, () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    for (const sp of map.spawnPoints) {
      expect(sp.sectorCoord.row).toBeGreaterThanOrEqual(0);
      expect(sp.sectorCoord.row).toBeLessThan(SECTOR_GRID_SIZE);
      expect(sp.sectorCoord.col).toBeGreaterThanOrEqual(0);
      expect(sp.sectorCoord.col).toBeLessThan(SECTOR_GRID_SIZE);
    }
  });

  it('exports MIN_SPAWN_DIST as 384', () => {
    expect(MIN_SPAWN_DIST).toBe(384);
  });

  it('sectors with few passable tiles still produce valid spawns', () => {
    const finder = new SpawnPointFinder();
    const rng = new SeededRNG(42);
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

    const restricted = sectors[0]![0]!;
    for (let r = 1; r < SECTOR_TILE_SIZE - 1; r++) {
      for (let c = 1; c < SECTOR_TILE_SIZE - 1; c++) {
        restricted.tiles[r]![c] = TileType.INDESTRUCTIBLE_WALL;
      }
    }
    restricted.tiles[10]![10] = TileType.EMPTY;
    restricted.tiles[10]![11] = TileType.EMPTY;
    restricted.tiles[11]![10] = TileType.EMPTY;

    const spawns = finder.find(sectors, rng);
    const sector0Spawns = spawns.filter(
      (sp) => sp.sectorCoord.row === 0 && sp.sectorCoord.col === 0,
    );
    expect(sector0Spawns.length).toBeGreaterThan(0);
    expect(sector0Spawns.length).toBeLessThanOrEqual(3);
    expect(spawns.length).toBeGreaterThanOrEqual(64);
  });
});

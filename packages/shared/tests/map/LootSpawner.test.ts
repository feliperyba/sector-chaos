import { TileType } from '../../src/enums/TileType.ts';
import { SeededRNG } from '../../src/map/rng/SeededRNG.js';
import { SectorType } from '../../src/map/types.js';
import type { SectorData } from '../../src/map/types.js';
import { LootSpawner } from '../../src/map/LootSpawner.js';
import { SectorConnector } from '../../src/map/SectorConnector.js';
import { ExitPlacer } from '../../src/map/ExitPlacer.js';
import { GridArenaGenerator } from '../../src/map/sectors/GridArenaGenerator.js';
import { OpenArenaGenerator } from '../../src/map/sectors/OpenArenaGenerator.js';
import { MazeGenerator } from '../../src/map/sectors/MazeGenerator.js';
import { ResourceRichGenerator } from '../../src/map/sectors/ResourceRichGenerator.js';
import type { SectorConfig } from '../../src/map/sectors/ISectorGenerator.js';

function makeConfig(row: number, col: number, type: SectorType): SectorConfig {
  return {
    width: 20,
    height: 20,
    tileSize: 128,
    type,
    theme: 'default',
    sectorCoord: { row, col },
  };
}

function generateSectorGrid(rng: SeededRNG): SectorData[][] {
  const gridGen = new GridArenaGenerator();
  const openGen = new OpenArenaGenerator();
  const mazeGen = new MazeGenerator();
  const richGen = new ResourceRichGenerator();
  const generators = [gridGen, openGen, mazeGen, richGen];

  const sectors: SectorData[][] = [];
  for (let row = 0; row < 4; row++) {
    sectors[row] = [];
    for (let col = 0; col < 4; col++) {
      const gen = generators[(row + col) % generators.length];
      const type =
        gen === gridGen
          ? SectorType.GRID_ARENA
          : gen === openGen
            ? SectorType.OPEN_ARENA
            : gen === mazeGen
              ? SectorType.MAZE
              : SectorType.RESOURCE_RICH;
      sectors[row][col] = gen.generate(rng, makeConfig(row, col, type));
    }
  }
  return sectors;
}

function makeEmptySectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < 4; row++) {
    sectors[row] = [];
    for (let col = 0; col < 4; col++) {
      const tiles: Uint8Array[] = [];
      for (let r = 0; r < 20; r++) {
        tiles[r] = new Uint8Array(20);
        for (let c = 0; c < 20; c++) {
          if (r === 0 || r === 19 || c === 0 || c === 19) {
            tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
          } else {
            tiles[r][c] = TileType.EMPTY;
          }
        }
      }
      sectors[row][col] = {
        type: SectorType.OPEN_ARENA,
        tiles,
        elevation: null,
        lootSpots: [],
        bounds: {
          x: col * 20 * 128,
          y: row * 20 * 128,
          width: 20 * 128,
          height: 20 * 128,
        },
        theme: 'default',
      };
    }
  }
  return sectors;
}

describe('SectorConnector', () => {
  it('creates connections for all adjacent sector pairs', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    const { connections } = connector.connect(sectors, rng);

    expect(connections.length).toBeGreaterThan(0);

    const horizontalCount = connections.filter(
      (c) => c.sectorA.row === c.sectorB.row && c.sectorB.col === c.sectorA.col + 1,
    ).length;
    const verticalCount = connections.filter(
      (c) => c.sectorA.col === c.sectorB.col && c.sectorB.row === c.sectorA.row + 1,
    ).length;

    expect(horizontalCount).toBe(12);
    expect(verticalCount).toBe(12);
    expect(connections.length).toBe(24);
  });

  it('clears wall tiles to create openings', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    connector.connect(sectors, rng);

    let hasOpening = false;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) {
        for (const r of [9, 10, 11]) {
          if (sectors[row][col].tiles[r][19] === TileType.EMPTY) {
            hasOpening = true;
            break;
          }
        }
      }
    }
    expect(hasOpening).toBe(true);
  });

  it('carves exactly 3-tile width corridors at positions 9,10,11', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    const { corridorTiles } = connector.connect(sectors, rng);

    for (const r of [9, 10, 11]) {
      expect(sectors[0][0].tiles[r][19]).toBe(TileType.EMPTY);
      expect(sectors[0][1].tiles[r][0]).toBe(TileType.EMPTY);
    }
    expect(sectors[0][0].tiles[8][19]).toBe(TileType.INDESTRUCTIBLE_WALL);
    expect(sectors[0][0].tiles[12][19]).toBe(TileType.INDESTRUCTIBLE_WALL);

    expect(corridorTiles.size).toBeGreaterThan(0);
  });

  it('has no corridors on map-facing walls', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    connector.connect(sectors, rng);

    for (let c = 0; c < 4; c++) {
      for (let col = 0; col < 20; col++) {
        expect(sectors[0][c].tiles[0][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
    for (let r = 0; r < 4; r++) {
      for (let row = 0; row < 20; row++) {
        expect(sectors[r][0].tiles[row][0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    }
  });

  it('creates exactly 24 corridors for 4x4 grid', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    const { connections } = connector.connect(sectors, rng);

    expect(connections.length).toBe(24);

    const horizontal = connections.filter((c) => c.sectorA.row === c.sectorB.row);
    const vertical = connections.filter((c) => c.sectorA.col === c.sectorB.col);
    expect(horizontal.length).toBe(12);
    expect(vertical.length).toBe(12);
  });

  it('all corridor tiles are EMPTY', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    const { corridorTiles } = connector.connect(sectors, rng);

    for (const key of corridorTiles) {
      const [sRow, sCol, tRow, tCol] = key.split(',').map(Number);
      expect(sectors[sRow][sCol].tiles[tRow][tCol]).toBe(TileType.EMPTY);
    }
  });

  it('tracks all corridor tiles in metadata', () => {
    const sectors = makeEmptySectorGrid();
    const rng = new SeededRNG(42);
    const connector = new SectorConnector();
    const { corridorTiles } = connector.connect(sectors, rng);

    expect(corridorTiles.size).toBe(144);
  });

  it('is deterministic with same seed', () => {
    const sectorsA = makeEmptySectorGrid();
    const sectorsB = makeEmptySectorGrid();
    const connector = new SectorConnector();

    const resultA = connector.connect(sectorsA, new SeededRNG(42));
    const resultB = connector.connect(sectorsB, new SeededRNG(42));

    expect(resultA.connections.length).toBe(resultB.connections.length);
    for (let i = 0; i < resultA.connections.length; i++) {
      expect(resultA.connections[i].width).toBe(resultB.connections[i].width);
      expect(resultA.connections[i].sectorA).toEqual(resultB.connections[i].sectorA);
      expect(resultA.connections[i].sectorB).toEqual(resultB.connections[i].sectorB);
      expect(resultA.connections[i].positionA).toEqual(resultB.connections[i].positionA);
      expect(resultA.connections[i].positionB).toEqual(resultB.connections[i].positionB);
    }
  });

  it('works with generated sectors', () => {
    const rng = new SeededRNG(42);
    const sectors = generateSectorGrid(rng);
    const connector = new SectorConnector();
    const { connections } = connector.connect(sectors, rng);

    expect(connections.length).toBe(24);
    for (const conn of connections) {
      expect(conn.width).toBe(3);
      expect(conn.positionA.x).toBeGreaterThanOrEqual(0);
      expect(conn.positionA.y).toBeGreaterThanOrEqual(0);
      expect(conn.positionB.x).toBeGreaterThanOrEqual(0);
      expect(conn.positionB.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('LootSpawner', () => {
  it('places loot on generated sectors', () => {
    const rng = new SeededRNG(42);
    const sectors = generateSectorGrid(rng);
    const connector = new SectorConnector();
    connector.connect(sectors, rng);

    const spawner = new LootSpawner();
    const placements = spawner.spawn(sectors, rng);

    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(['CHEST', 'WEAPON_SPAWN', 'POWERUP_SPAWN']).toContain(p.type);
      expect(p.tier).toBeGreaterThanOrEqual(0);
      expect(p.tier).toBeLessThanOrEqual(3);
      expect(p.position.x).toBeGreaterThanOrEqual(0);
      expect(p.position.y).toBeGreaterThanOrEqual(0);
      expect(p.sectorCoord.row).toBeGreaterThanOrEqual(0);
      expect(p.sectorCoord.row).toBeLessThan(4);
      expect(p.sectorCoord.col).toBeGreaterThanOrEqual(0);
      expect(p.sectorCoord.col).toBeLessThan(4);
    }
  });

  it('tier distribution is approximately correct over many runs', () => {
    const tierCounts = [0, 0, 0, 0];
    const runs = 200;

    for (let i = 0; i < runs; i++) {
      const rng = new SeededRNG(i * 31 + 7);
      const sectors = generateSectorGrid(rng);
      const connector = new SectorConnector();
      connector.connect(sectors, rng);

      const spawner = new LootSpawner();
      const placements = spawner.spawn(sectors, rng);

      for (const p of placements) {
        tierCounts[p.tier]++;
      }
    }

    const total = tierCounts[0] + tierCounts[1] + tierCounts[2] + tierCounts[3];
    expect(total).toBeGreaterThan(0);

    const commonRatio = tierCounts[0] / total;
    const uncommonRatio = tierCounts[1] / total;
    const rareRatio = tierCounts[2] / total;
    const legendaryRatio = tierCounts[3] / total;

    expect(commonRatio).toBeGreaterThan(0.55);
    expect(commonRatio).toBeLessThan(0.85);
    expect(uncommonRatio).toBeGreaterThan(0.08);
    expect(rareRatio).toBeGreaterThan(0.02);
    expect(legendaryRatio).toBeLessThan(0.1);
  });

  it('never exceeds 10 legendary items', () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = new SeededRNG(seed);
      const sectors = generateSectorGrid(rng);
      const connector = new SectorConnector();
      connector.connect(sectors, rng);

      const spawner = new LootSpawner();
      const placements = spawner.spawn(sectors, rng);

      const legendaryCount = placements.filter((p) => p.tier === 3).length;
      expect(legendaryCount).toBeLessThanOrEqual(10);
    }
  });

  it('RESOURCE_RICH sectors have more loot', () => {
    const rng = new SeededRNG(42);

    const openSectors: SectorData[][] = [];
    openSectors[0] = [];
    openSectors[1] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const tiles: Uint8Array[] = [];
        for (let r = 0; r < 20; r++) {
          tiles[r] = new Uint8Array(20);
          for (let c = 0; c < 20; c++) {
            tiles[r][c] =
              r === 0 || r === 19 || c === 0 || c === 19
                ? TileType.INDESTRUCTIBLE_WALL
                : TileType.EMPTY;
          }
        }
        openSectors[row][col] = {
          type: SectorType.OPEN_ARENA,
          tiles,
          elevation: null,
          lootSpots: [],
          bounds: { x: col * 20 * 128, y: row * 20 * 128, width: 20 * 128, height: 20 * 128 },
          theme: 'default',
        };
      }
    }

    const richSectors: SectorData[][] = [];
    richSectors[0] = [];
    richSectors[1] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const tiles: Uint8Array[] = [];
        for (let r = 0; r < 20; r++) {
          tiles[r] = new Uint8Array(20);
          for (let c = 0; c < 20; c++) {
            tiles[r][c] =
              r === 0 || r === 19 || c === 0 || c === 19
                ? TileType.INDESTRUCTIBLE_WALL
                : TileType.EMPTY;
          }
        }
        richSectors[row][col] = {
          type: SectorType.RESOURCE_RICH,
          tiles,
          elevation: null,
          lootSpots: [],
          bounds: { x: col * 20 * 128, y: row * 20 * 128, width: 20 * 128, height: 20 * 128 },
          theme: 'default',
        };
      }
    }

    const spawner = new LootSpawner();
    const openPlacements = spawner.spawn(openSectors, new SeededRNG(42));
    const richPlacements = spawner.spawn(richSectors, new SeededRNG(42));

    expect(richPlacements.length).toBeGreaterThan(openPlacements.length);
  });
});

describe('ExitPlacer', () => {
  it('places exits on edge sectors', () => {
    const rng = new SeededRNG(42);
    const sectors = generateSectorGrid(rng);
    const connector = new SectorConnector();
    connector.connect(sectors, rng);

    const placer = new ExitPlacer();
    const exits = placer.place(sectors, rng);

    expect(exits.length).toBeGreaterThan(0);
    expect(exits.length).toBeLessThanOrEqual(8);
  });

  it('enforces minimum distance between exits', () => {
    const rng = new SeededRNG(42);
    const sectors = generateSectorGrid(rng);
    const connector = new SectorConnector();
    connector.connect(sectors, rng);

    const placer = new ExitPlacer();
    const exits = placer.place(sectors, rng);

    for (let i = 0; i < exits.length; i++) {
      for (let j = i + 1; j < exits.length; j++) {
        const dx = exits[i].position.x - exits[j].position.x;
        const dy = exits[i].position.y - exits[j].position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it('does not exceed max 8 exits', () => {
    for (let seed = 0; seed < 20; seed++) {
      const rng = new SeededRNG(seed);
      const sectors = generateSectorGrid(rng);
      const connector = new SectorConnector();
      connector.connect(sectors, rng);

      const placer = new ExitPlacer();
      const exits = placer.place(sectors, rng);

      expect(exits.length).toBeLessThanOrEqual(8);
    }
  });

  it('exits have valid structure', () => {
    const rng = new SeededRNG(42);
    const sectors = generateSectorGrid(rng);
    const connector = new SectorConnector();
    connector.connect(sectors, rng);

    const placer = new ExitPlacer();
    const exits = placer.place(sectors, rng);

    for (const exit of exits) {
      expect(exit.id).toBeTruthy();
      expect(['N', 'S', 'E', 'W']).toContain(exit.direction);
      expect(exit.cooldown).toBe(5000);
      expect(exit.isExtraction).toBe(true);
      expect(exit.targetSectorCoord).toBeNull();
    }
  });
});

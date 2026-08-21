import { TileType } from '../../src/enums/TileType.js';
import { TrapType } from '../../src/enums/TrapType.ts';
import { SeededRNG } from '../../src/map/rng/SeededRNG.js';
import { SectorType } from '../../src/map/types.js';
import type { SectorData } from '../../src/map/types.js';
import { EntityPlacer } from '../../src/map/EntityPlacer.js';
import { SectorConnector } from '../../src/map/SectorConnector.js';
import { GridArenaGenerator } from '../../src/map/sectors/GridArenaGenerator.js';
import { OpenArenaGenerator } from '../../src/map/sectors/OpenArenaGenerator.js';
import { MazeGenerator } from '../../src/map/sectors/MazeGenerator.js';
import { ResourceRichGenerator } from '../../src/map/sectors/ResourceRichGenerator.js';
import type { SectorConfig } from '../../src/map/sectors/ISectorGenerator.js';
import { TILE_PIXEL_SIZE } from '../../src/map/constants.js';

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

function makeEmptySectorGrid(type: SectorType = SectorType.OPEN_ARENA): SectorData[][] {
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
        type,
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

function makeAllWallSectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < 4; row++) {
    sectors[row] = [];
    for (let col = 0; col < 4; col++) {
      const tiles: Uint8Array[] = [];
      for (let r = 0; r < 20; r++) {
        tiles[r] = new Uint8Array(20);
        for (let c = 0; c < 20; c++) {
          tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
        }
      }
      sectors[row][col] = {
        type: SectorType.GRID_ARENA,
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

function placementToTileCoords(
  placement: { position: { x: number; y: number }; sectorCoord: { row: number; col: number } },
  sectors: SectorData[][],
): { row: number; col: number } {
  const sector = sectors[placement.sectorCoord.row][placement.sectorCoord.col];
  return {
    col: Math.round((placement.position.x - sector.bounds.x) / TILE_PIXEL_SIZE),
    row: Math.round((placement.position.y - sector.bounds.y) / TILE_PIXEL_SIZE),
  };
}

describe('EntityPlacer', () => {
  it('places entities across all sectors', () => {
    const rng = new SeededRNG(42);
    const sectors = generateSectorGrid(rng);
    const connector = new SectorConnector();
    const { corridorTiles } = connector.connect(sectors, rng);

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(['CHEST', 'BARREL', 'TRAP', 'CRATE']).toContain(p.entityType);
      expect(p.position.x).toBeGreaterThanOrEqual(0);
      expect(p.position.y).toBeGreaterThanOrEqual(0);
      expect(p.sectorCoord.row).toBeGreaterThanOrEqual(0);
      expect(p.sectorCoord.row).toBeLessThan(4);
      expect(p.sectorCoord.col).toBeGreaterThanOrEqual(0);
      expect(p.sectorCoord.col).toBeLessThan(4);
    }
  });

  it('maintains 2-tile Manhattan spacing within each sector', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const connector = new SectorConnector();
    const { corridorTiles } = connector.connect(sectors, rng);

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    const bySector = new Map<string, typeof placements>();
    for (const p of placements) {
      const key = `${p.sectorCoord.row},${p.sectorCoord.col}`;
      if (!bySector.has(key)) bySector.set(key, []);
      bySector.get(key)!.push(p);
    }

    for (const [, sectorPlacements] of bySector) {
      for (let i = 0; i < sectorPlacements.length; i++) {
        const a = placementToTileCoords(sectorPlacements[i], sectors);
        for (let j = i + 1; j < sectorPlacements.length; j++) {
          const b = placementToTileCoords(sectorPlacements[j], sectors);
          const dist = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
          expect(dist).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('places in priority order: chests before barrels before crates', () => {
    const rng = new SeededRNG(99);
    const sectors = makeEmptySectorGrid(SectorType.RESOURCE_RICH);
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    const firstSectorPlacements = placements.filter(
      (p) => p.sectorCoord.row === 0 && p.sectorCoord.col === 0,
    );
    expect(firstSectorPlacements.length).toBeGreaterThan(0);

    const typeOrder: Record<string, number> = { CHEST: 0, BARREL: 1, TRAP: 2, CRATE: 3 };
    for (let i = 1; i < firstSectorPlacements.length; i++) {
      const prevOrder = typeOrder[firstSectorPlacements[i - 1].entityType];
      const currOrder = typeOrder[firstSectorPlacements[i].entityType];
      expect(currOrder).toBeGreaterThanOrEqual(prevOrder);
    }
  });

  it('skips sectors with no valid positions', () => {
    const rng = new SeededRNG(42);
    const sectors = makeAllWallSectorGrid();
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    expect(placements).toEqual([]);
  });

  it('writes correct tile types into sector tiles', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    for (const p of placements) {
      const tc = placementToTileCoords(p, sectors);
      const sector = sectors[p.sectorCoord.row][p.sectorCoord.col];
      const tileVal = sector.tiles[tc.row][tc.col];

      switch (p.entityType) {
        case 'CHEST':
          expect(tileVal).toBe(TileType.CHEST);
          break;
        case 'BARREL':
          expect(tileVal).toBe(TileType.DESTRUCTIBLE_BARREL);
          break;
        case 'CRATE':
          expect(tileVal).toBe(TileType.DESTRUCTIBLE_CRATE);
          break;
        case 'TRAP':
          expect(tileVal).toBe(TileType.EMPTY);
          break;
      }
    }
  });

  it('does not place entities on corridor tiles', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const connector = new SectorConnector();
    const { corridorTiles } = connector.connect(sectors, rng);

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    for (const p of placements) {
      const tc = placementToTileCoords(p, sectors);
      const key = `${p.sectorCoord.row},${p.sectorCoord.col},${tc.row},${tc.col}`;
      expect(corridorTiles.has(key)).toBe(false);
    }
  });

  it('does not place entities adjacent to INDESTRUCTIBLE_WALL', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const p of placements) {
      const tc = placementToTileCoords(p, sectors);
      const sector = sectors[p.sectorCoord.row][p.sectorCoord.col];

      for (const [dr, dc] of dirs) {
        const nr = tc.row + dr;
        const nc = tc.col + dc;
        if (nr >= 0 && nr < 20 && nc >= 0 && nc < 20) {
          expect(sector.tiles[nr][nc]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
        }
      }
    }
  });

  it('does not place entities in first or last row or column of sector', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid();
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    for (const p of placements) {
      const tc = placementToTileCoords(p, sectors);
      expect(tc.row).toBeGreaterThan(0);
      expect(tc.row).toBeLessThan(19);
      expect(tc.col).toBeGreaterThan(0);
      expect(tc.col).toBeLessThan(19);
    }
  });

  it('respects per-sector-type entity counts', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid(SectorType.RESOURCE_RICH);
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

    const chestCount = placements.filter((p) => p.entityType === 'CHEST').length;
    const barrelCount = placements.filter((p) => p.entityType === 'BARREL').length;
    const crateCount = placements.filter((p) => p.entityType === 'CRATE').length;

    // RESOURCE_RICH has 4 chests/sector (CHEST_COUNT), 16 sectors → 64 total.
    expect(chestCount).toBe(64);
    expect(barrelCount).toBeGreaterThanOrEqual(48);
    expect(barrelCount).toBeLessThanOrEqual(80);
    expect(crateCount).toBe(0);
  });

  it('is deterministic with same seed', () => {
    const sectorsA = makeEmptySectorGrid();
    const sectorsB = makeEmptySectorGrid();
    const corridorTiles = new Set<string>();

    const placer = new EntityPlacer();
    const { entityPlacements: resultA } = placer.place(sectorsA, corridorTiles, new SeededRNG(42));
    const { entityPlacements: resultB } = placer.place(sectorsB, corridorTiles, new SeededRNG(42));

    expect(resultA.length).toBe(resultB.length);
    for (let i = 0; i < resultA.length; i++) {
      expect(resultA[i].entityType).toBe(resultB[i].entityType);
      expect(resultA[i].position).toEqual(resultB[i].position);
      expect(resultA[i].sectorCoord).toEqual(resultB[i].sectorCoord);
    }
  });

  it('higher-priority entities consume slots when positions are limited', () => {
    const sectors: SectorData[][] = [];
    const tiles: Uint8Array[] = [];
    for (let r = 0; r < 20; r++) {
      tiles[r] = new Uint8Array(20);
      for (let c = 0; c < 20; c++) {
        if (r === 0 || r === 19 || c === 0 || c === 19) {
          tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
        } else if (r === 10 && c === 10) {
          tiles[r][c] = TileType.EMPTY;
        } else if ((r === 9 || r === 11) && c === 10) {
          tiles[r][c] = TileType.DESTRUCTIBLE_WALL;
        } else if (r === 10 && (c === 9 || c === 11)) {
          tiles[r][c] = TileType.DESTRUCTIBLE_WALL;
        } else {
          tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
        }
      }
    }
    sectors[0] = [
      {
        type: SectorType.RESOURCE_RICH,
        tiles,
        elevation: null,
        lootSpots: [],
        bounds: { x: 0, y: 0, width: 20 * 128, height: 20 * 128 },
        theme: 'default',
      },
    ];

    const rng = new SeededRNG(42);
    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, new Set<string>(), rng);

    const s0Placements = placements.filter(
      (p) => p.sectorCoord.row === 0 && p.sectorCoord.col === 0,
    );
    expect(s0Placements.length).toBe(1);
    expect(s0Placements[0].entityType).toBe('CHEST');
  });

  it('CrateDensity_GridArenaZero', () => {
    const rng = new SeededRNG(42);
    const sectors = makeEmptySectorGrid(SectorType.GRID_ARENA);
    const placer = new EntityPlacer();
    const { entityPlacements: placements } = placer.place(sectors, new Set<string>(), rng);

    const crateCount = placements.filter((p) => p.entityType === 'CRATE').length;
    expect(crateCount).toBe(0);
  });

  it('CrateDensity_AllSectorTypes', () => {
    const densities: Record<string, number> = {
      GRID_ARENA: 0,
      OPEN_ARENA: 0,
      MAZE: 0,
      RESOURCE_RICH: 0,
    };

    for (const type of [
      SectorType.GRID_ARENA,
      SectorType.OPEN_ARENA,
      SectorType.MAZE,
      SectorType.RESOURCE_RICH,
    ]) {
      const rng = new SeededRNG(42);
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
      const sectors: SectorData[][] = [
        [
          {
            type,
            tiles,
            elevation: null,
            lootSpots: [],
            bounds: { x: 0, y: 0, width: 20 * 128, height: 20 * 128 },
            theme: 'default' as const,
          },
        ],
      ];

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, new Set<string>(), rng);

      const crateCount = placements.filter((p) => p.entityType === 'CRATE').length;
      const target = Math.floor(256 * densities[type]);
      const tol = target * 0.05;

      expect(crateCount).toBeGreaterThanOrEqual(Math.max(0, target - tol));
      expect(crateCount).toBeLessThanOrEqual(target + tol);
    }
  });

  describe('BarrelPlacement', () => {
    it('BarrelPlacement_3To5PerSector', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const sectorBarrels = placements.filter(
            (p) =>
              p.entityType === 'BARREL' && p.sectorCoord.row === row && p.sectorCoord.col === col,
          );
          expect(sectorBarrels.length).toBeGreaterThanOrEqual(3);
          expect(sectorBarrels.length).toBeLessThanOrEqual(5);
        }
      }
    });

    it('BarrelPlacement_TotalCount48To80', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

      const barrelCount = placements.filter((p) => p.entityType === 'BARREL').length;
      expect(barrelCount).toBeGreaterThanOrEqual(48);
      expect(barrelCount).toBeLessThanOrEqual(80);
    });

    it('BarrelPlacement_2TileSpacing', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

      const barrels = placements.filter((p) => p.entityType === 'BARREL');

      for (let i = 0; i < barrels.length; i++) {
        const a = placementToTileCoords(barrels[i], sectors);
        for (let j = 0; j < placements.length; j++) {
          if (barrels[i] === placements[j]) continue;
          if (
            barrels[i].sectorCoord.row !== placements[j].sectorCoord.row ||
            barrels[i].sectorCoord.col !== placements[j].sectorCoord.col
          )
            continue;
          const b = placementToTileCoords(placements[j], sectors);
          const dist = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
          expect(dist).toBeGreaterThanOrEqual(2);
        }
      }
    });

    it('BarrelPlacement_NotOnBorderOrCorridor', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid();
      const connector = new SectorConnector();
      const { corridorTiles } = connector.connect(sectors, rng);

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

      const barrels = placements.filter((p) => p.entityType === 'BARREL');
      for (const b of barrels) {
        const tc = placementToTileCoords(b, sectors);
        expect(tc.row).toBeGreaterThan(0);
        expect(tc.row).toBeLessThan(19);
        expect(tc.col).toBeGreaterThan(0);
        expect(tc.col).toBeLessThan(19);
        const key = `${b.sectorCoord.row},${b.sectorCoord.col},${tc.row},${tc.col}`;
        expect(corridorTiles.has(key)).toBe(false);
      }
    });

    it('BarrelPlacement_NotAdjacentToIndestructibleWall', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid();
      const corridorTiles = new Set<string>();

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

      const barrels = placements.filter((p) => p.entityType === 'BARREL');
      const dirs = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      for (const b of barrels) {
        const tc = placementToTileCoords(b, sectors);
        const sector = sectors[b.sectorCoord.row][b.sectorCoord.col];
        for (const [dr, dc] of dirs) {
          const nr = tc.row + dr;
          const nc = tc.col + dc;
          if (nr >= 0 && nr < 20 && nc >= 0 && nc < 20) {
            expect(sector.tiles[nr][nc]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
          }
        }
      }
    });

    it('BarrelPlacement_PlacedOnEmptyTiles', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();

      const placer = new EntityPlacer();
      const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

      const barrels = placements.filter((p) => p.entityType === 'BARREL');
      for (const b of barrels) {
        const tc = placementToTileCoords(b, sectors);
        const sector = sectors[b.sectorCoord.row][b.sectorCoord.col];
        expect(sector.tiles[tc.row][tc.col]).toBe(TileType.DESTRUCTIBLE_BARREL);
      }
    });

    it('BarrelPlacement_AllSectorTypes', () => {
      for (const type of [
        SectorType.GRID_ARENA,
        SectorType.OPEN_ARENA,
        SectorType.MAZE,
        SectorType.RESOURCE_RICH,
      ]) {
        const rng = new SeededRNG(42);
        const sectors = makeEmptySectorGrid(type);
        const corridorTiles = new Set<string>();

        const placer = new EntityPlacer();
        const { entityPlacements: placements } = placer.place(sectors, corridorTiles, rng);

        const barrelCount = placements.filter((p) => p.entityType === 'BARREL').length;
        expect(barrelCount).toBeGreaterThanOrEqual(48);
        expect(barrelCount).toBeLessThanOrEqual(80);
      }
    });

    it('BarrelPlacement_StillDeterministicWithSameSeed', () => {
      const sectorsA = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const sectorsB = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();

      const placer = new EntityPlacer();
      const { entityPlacements: resultA } = placer.place(
        sectorsA,
        corridorTiles,
        new SeededRNG(42),
      );
      const { entityPlacements: resultB } = placer.place(
        sectorsB,
        corridorTiles,
        new SeededRNG(42),
      );

      const barrelsA = resultA.filter((p) => p.entityType === 'BARREL');
      const barrelsB = resultB.filter((p) => p.entityType === 'BARREL');

      expect(barrelsA.length).toBe(barrelsB.length);
      for (let i = 0; i < barrelsA.length; i++) {
        expect(barrelsA[i].position).toEqual(barrelsB[i].position);
        expect(barrelsA[i].sectorCoord).toEqual(barrelsB[i].sectorCoord);
      }
    });
  });

  describe('ChestPlacement', () => {
    it('ChestPlacement_CountPerSectorType', () => {
      // Expected counts must match CHEST_COUNT in packages/shared/src/map/constants.ts.
      // If these fail, check whether CHEST_COUNT was intentionally tuned.
      const expectedCounts: [SectorType, number][] = [
        [SectorType.GRID_ARENA, 3],
        [SectorType.OPEN_ARENA, 2],
        [SectorType.MAZE, 2],
        [SectorType.RESOURCE_RICH, 4],
      ];

      for (const [type, expected] of expectedCounts) {
        const rng = new SeededRNG(42);
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
        const sectors: SectorData[][] = [
          [
            {
              type,
              tiles,
              elevation: null,
              lootSpots: [],
              bounds: { x: 0, y: 0, width: 20 * 128, height: 20 * 128 },
              theme: 'default' as const,
            },
          ],
        ];

        const placer = new EntityPlacer();
        const { entityPlacements } = placer.place(sectors, new Set<string>(), rng);

        const chestCount = entityPlacements.filter((p) => p.entityType === 'CHEST').length;
        expect(chestCount).toBe(expected);
      }
    });

    it('ChestPlacement_LootPlacementsRecorded', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.RESOURCE_RICH);
      const placer = new EntityPlacer();
      const { entityPlacements, chestLootPlacements } = placer.place(
        sectors,
        new Set<string>(),
        rng,
      );

      const chests = entityPlacements.filter((p) => p.entityType === 'CHEST');
      expect(chests.length).toBe(chestLootPlacements.length);

      for (let i = 0; i < chests.length; i++) {
        expect(chestLootPlacements[i].type).toBe('CHEST');
        expect(chestLootPlacements[i].position).toEqual(chests[i].position);
        expect(chestLootPlacements[i].sectorCoord).toEqual(chests[i].sectorCoord);
        expect(chestLootPlacements[i].tier).toBeGreaterThanOrEqual(0);
        expect(chestLootPlacements[i].tier).toBeLessThanOrEqual(3);
      }
    });

    it('ChestPlacement_TierDistribution', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.RESOURCE_RICH);
      const placer = new EntityPlacer();
      const { chestLootPlacements } = placer.place(sectors, new Set<string>(), rng);

      expect(chestLootPlacements.length).toBeGreaterThan(0);

      const tiers = [0, 0, 0, 0];
      for (const lp of chestLootPlacements) {
        expect(lp.type).toBe('CHEST');
        expect(lp.tier).toBeGreaterThanOrEqual(0);
        expect(lp.tier).toBeLessThanOrEqual(3);
        tiers[lp.tier]++;
      }

      const total = chestLootPlacements.length;
      const commonRatio = tiers[0] / total;
      expect(commonRatio).toBeGreaterThan(0.5);
      expect(commonRatio).toBeLessThan(0.9);
    });

    it('ChestPlacement_NoCorridorOrBorder', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.RESOURCE_RICH);
      const connector = new SectorConnector();
      const { corridorTiles } = connector.connect(sectors, rng);
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);

      const chests = entityPlacements.filter((p) => p.entityType === 'CHEST');
      const dirs = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];

      for (const ch of chests) {
        const tc = placementToTileCoords(ch, sectors);
        expect(tc.row).toBeGreaterThan(0);
        expect(tc.row).toBeLessThan(19);
        expect(tc.col).toBeGreaterThan(0);
        expect(tc.col).toBeLessThan(19);

        const key = `${ch.sectorCoord.row},${ch.sectorCoord.col},${tc.row},${tc.col}`;
        expect(corridorTiles.has(key)).toBe(false);

        const sector = sectors[ch.sectorCoord.row][ch.sectorCoord.col];
        for (const [dr, dc] of dirs) {
          const nr = tc.row + dr;
          const nc = tc.col + dc;
          if (nr >= 0 && nr < 20 && nc >= 0 && nc < 20) {
            expect(sector.tiles[nr][nc]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
          }
        }
      }
    });

    it('ChestPlacement_ReducedWhenNotEnoughPositions', () => {
      const sectors: SectorData[][] = [];
      const tiles: Uint8Array[] = [];
      for (let r = 0; r < 20; r++) {
        tiles[r] = new Uint8Array(20);
        for (let c = 0; c < 20; c++) {
          if (r === 0 || r === 19 || c === 0 || c === 19) {
            tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
          } else if (r === 9 && c === 9) {
            tiles[r][c] = TileType.EMPTY;
          } else if (r === 9 && c === 15) {
            tiles[r][c] = TileType.EMPTY;
          } else if ((r === 8 || r === 10) && (c === 9 || c === 15)) {
            tiles[r][c] = TileType.DESTRUCTIBLE_WALL;
          } else if (r === 9 && (c === 8 || c === 10 || c === 14 || c === 16)) {
            tiles[r][c] = TileType.DESTRUCTIBLE_WALL;
          } else {
            tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
          }
        }
      }
      sectors[0] = [
        {
          type: SectorType.RESOURCE_RICH,
          tiles,
          elevation: null,
          lootSpots: [],
          bounds: { x: 0, y: 0, width: 20 * 128, height: 20 * 128 },
          theme: 'default',
        },
      ];

      const rng = new SeededRNG(42);
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, new Set<string>(), rng);

      const chests = entityPlacements.filter((p) => p.entityType === 'CHEST');
      expect(chests.length).toBeLessThanOrEqual(2);
      expect(chests.length).toBeGreaterThan(0);
    });
  });

  describe('TrapPlacement', () => {
    it('TrapPlacement_1To3PerSector', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const sectorTraps = entityPlacements.filter(
            (p) =>
              p.entityType === 'TRAP' && p.sectorCoord.row === row && p.sectorCoord.col === col,
          );
          expect(sectorTraps.length).toBeGreaterThanOrEqual(1);
          // TRAP_COUNT_RANGE is {min:2, max:4} in constants.ts.
          expect(sectorTraps.length).toBeLessThanOrEqual(4);
        }
      }
    });

    it('TrapPlacement_TotalCount16To48', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
      const trapCount = entityPlacements.filter((p) => p.entityType === 'TRAP').length;
      expect(trapCount).toBeGreaterThanOrEqual(16);
      expect(trapCount).toBeLessThanOrEqual(48);
    });

    it('TrapPlacement_EqualTypeDistribution', { timeout: 60000 }, () => {
      const typeCounts = new Map<number, number>();
      // 200 seeds is statistically sufficient for a 3-way distribution
      // check (χ² with 2 dof at n=200 has plenty of power). 1000 seeds
      // times out on slower CI/VPS environments.
      for (let seed = 0; seed < 200; seed++) {
        const rng = new SeededRNG(seed);
        const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
        const corridorTiles = new Set<string>();
        const placer = new EntityPlacer();
        const { trapPlacements } = placer.place(sectors, corridorTiles, rng);
        for (const tp of trapPlacements) {
          typeCounts.set(tp.trapType, (typeCounts.get(tp.trapType) ?? 0) + 1);
        }
      }
      const total = Array.from(typeCounts.values()).reduce((a, b) => a + b, 0);
      expect(typeCounts.size).toBe(3);
      for (const count of typeCounts.values()) {
        const ratio = count / total;
        expect(ratio).toBeGreaterThan(0.25);
        expect(ratio).toBeLessThan(0.45);
      }
    });

    it('TrapPlacement_OverlayOnEmpty', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements, trapPlacements } = placer.place(sectors, corridorTiles, rng);
      const traps = entityPlacements.filter((p) => p.entityType === 'TRAP');
      expect(traps.length).toBeGreaterThan(0);
      for (const t of traps) {
        const tc = placementToTileCoords(t, sectors);
        const sector = sectors[t.sectorCoord.row][t.sectorCoord.col];
        expect(sector.tiles[tc.row][tc.col]).toBe(TileType.EMPTY);
      }
      expect(trapPlacements.length).toBe(traps.length);
      for (const tp of trapPlacements) {
        expect([TrapType.SPIKE, TrapType.FIRE, TrapType.TELEPORT]).toContain(tp.trapType);
      }
    });

    it('TrapPlacement_2TileSpacing', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
      const traps = entityPlacements.filter((p) => p.entityType === 'TRAP');
      for (let i = 0; i < traps.length; i++) {
        const a = placementToTileCoords(traps[i], sectors);
        for (let j = 0; j < entityPlacements.length; j++) {
          if (traps[i] === entityPlacements[j]) continue;
          if (
            traps[i].sectorCoord.row !== entityPlacements[j].sectorCoord.row ||
            traps[i].sectorCoord.col !== entityPlacements[j].sectorCoord.col
          )
            continue;
          const b = placementToTileCoords(entityPlacements[j], sectors);
          const dist = Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
          expect(dist).toBeGreaterThanOrEqual(2);
        }
      }
    });

    it('TrapPlacement_NotOnBorderOrCorridor', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid();
      const connector = new SectorConnector();
      const { corridorTiles } = connector.connect(sectors, rng);
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
      const traps = entityPlacements.filter((p) => p.entityType === 'TRAP');
      for (const t of traps) {
        const tc = placementToTileCoords(t, sectors);
        expect(tc.row).toBeGreaterThan(0);
        expect(tc.row).toBeLessThan(19);
        expect(tc.col).toBeGreaterThan(0);
        expect(tc.col).toBeLessThan(19);
        const key = `${t.sectorCoord.row},${t.sectorCoord.col},${tc.row},${tc.col}`;
        expect(corridorTiles.has(key)).toBe(false);
      }
    });

    it('TrapPlacement_NotAdjacentToIndestructibleWall', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid();
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
      const traps = entityPlacements.filter((p) => p.entityType === 'TRAP');
      const dirs = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      for (const t of traps) {
        const tc = placementToTileCoords(t, sectors);
        const sector = sectors[t.sectorCoord.row][t.sectorCoord.col];
        for (const [dr, dc] of dirs) {
          const nr = tc.row + dr;
          const nc = tc.col + dc;
          if (nr >= 0 && nr < 20 && nc >= 0 && nc < 20) {
            expect(sector.tiles[nr][nc]).not.toBe(TileType.INDESTRUCTIBLE_WALL);
          }
        }
      }
    });

    it('TrapPlacement_AllSectorTypes', () => {
      for (const type of [
        SectorType.GRID_ARENA,
        SectorType.OPEN_ARENA,
        SectorType.MAZE,
        SectorType.RESOURCE_RICH,
      ]) {
        const rng = new SeededRNG(42);
        const sectors = makeEmptySectorGrid(type);
        const corridorTiles = new Set<string>();
        const placer = new EntityPlacer();
        const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
        const trapCount = entityPlacements.filter((p) => p.entityType === 'TRAP').length;
        expect(trapCount).toBeGreaterThanOrEqual(16);
        expect(trapCount).toBeLessThanOrEqual(48);
      }
    });

    it('TrapPlacement_Deterministic', () => {
      const sectorsA = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const sectorsB = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements: resultA, trapPlacements: trapsA } = placer.place(
        sectorsA,
        corridorTiles,
        new SeededRNG(42),
      );
      const { entityPlacements: resultB, trapPlacements: trapsB } = placer.place(
        sectorsB,
        corridorTiles,
        new SeededRNG(42),
      );
      const trapsResultA = resultA.filter((p) => p.entityType === 'TRAP');
      const trapsResultB = resultB.filter((p) => p.entityType === 'TRAP');
      expect(trapsResultA.length).toBe(trapsResultB.length);
      expect(trapsA.length).toBe(trapsB.length);
      for (let i = 0; i < trapsA.length; i++) {
        expect(trapsA[i].trapType).toBe(trapsB[i].trapType);
        expect(trapsA[i].position).toEqual(trapsB[i].position);
      }
    });

    it('TrapPlacement_SkipsWhenNoValidPositions', () => {
      const rng = new SeededRNG(42);
      const sectors = makeAllWallSectorGrid();
      const corridorTiles = new Set<string>();
      const placer = new EntityPlacer();
      const { entityPlacements } = placer.place(sectors, corridorTiles, rng);
      const trapCount = entityPlacements.filter((p) => p.entityType === 'TRAP').length;
      expect(trapCount).toBe(0);
    });
  });

  describe('RingTiers', () => {
    it('outer sectors get tier 0 only for weapon spawns', () => {
      const rng = new SeededRNG(42);
      const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
      const placer = new EntityPlacer();
      const { groundWeaponPlacements } = placer.place(sectors, new Set<string>(), rng);

      const outerKeys = [
        '0,0',
        '0,1',
        '0,2',
        '0,3',
        '1,0',
        '1,3',
        '2,0',
        '2,3',
        '3,0',
        '3,1',
        '3,2',
        '3,3',
      ];
      const outerWeapons = groundWeaponPlacements.filter((wp) =>
        outerKeys.includes(`${wp.sectorCoord.row},${wp.sectorCoord.col}`),
      );

      for (const wp of outerWeapons) {
        expect(['common', 'uncommon', 'rare', 'legendary']).toContain(wp.tier);
      }
    });

    it('center sectors get weighted tiers for weapon spawns', { timeout: 15000 }, () => {
      const tierCounts = new Map<string, number>();
      for (let seed = 0; seed < 200; seed++) {
        const rng = new SeededRNG(seed);
        const sectors = makeEmptySectorGrid(SectorType.OPEN_ARENA);
        const placer = new EntityPlacer();
        const { groundWeaponPlacements } = placer.place(sectors, new Set<string>(), rng);

        const centerKeys = ['1,1', '1,2', '2,1', '2,2'];
        const centerWeapons = groundWeaponPlacements.filter((wp) =>
          centerKeys.includes(`${wp.sectorCoord.row},${wp.sectorCoord.col}`),
        );

        for (const wp of centerWeapons) {
          tierCounts.set(wp.tier, (tierCounts.get(wp.tier) ?? 0) + 1);
        }
      }

      const total = Array.from(tierCounts.values()).reduce((a, b) => a + b, 0);
      expect(tierCounts.has('common')).toBe(true);
      if (tierCounts.size > 1) {
        const tier0Ratio = (tierCounts.get('common') ?? 0) / total;
        expect(tier0Ratio).toBeGreaterThan(0.4);
      }
    });
  });
});

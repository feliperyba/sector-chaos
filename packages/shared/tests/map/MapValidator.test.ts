import { TileType } from '../../src/enums/TileType.js';
import { MapGenerator } from '../../src/map/MapGenerator.js';
import { MapValidator } from '../../src/map/MapValidator.js';
import type { MapData, SectorData, SpawnPoint, LootPlacement } from '../../src/map/types.js';
import { SectorType } from '../../src/map/types.js';
import { SECTOR_TILE_SIZE, SECTOR_GRID_SIZE } from '../../src/map/constants.js';

function makeMapData(overrides: Partial<MapData> = {}): MapData {
  const sectors = makeEmptySectorGrid();
  return {
    seed: 42,
    sectors,
    connections: [],
    spawnPoints: [],
    exits: [],
    lootPlacements: [],
    weather: [],
    globalBounds: { width: 10240, height: 10240 },
    corridorTiles: new Set<string>(),
    ...overrides,
  };
}

function makeEmptySectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < 4; row++) {
    sectors[row] = [];
    for (let col = 0; col < 4; col++) {
      sectors[row][col] = makeOpenSector(row, col);
    }
  }
  return sectors;
}

function makeOpenSector(row: number, col: number): SectorData {
  const tiles: Uint8Array[] = [];
  for (let r = 0; r < 20; r++) {
    tiles[r] = new Uint8Array(20);
    for (let c = 0; c < 20; c++) {
      tiles[r][c] =
        r === 0 || r === 19 || c === 0 || c === 19 ? TileType.INDESTRUCTIBLE_WALL : TileType.EMPTY;
    }
  }
  return {
    type: SectorType.OPEN_ARENA,
    tiles,
    elevation: null,
    lootSpots: [],
    bounds: { x: col * 2560, y: row * 2560, width: 2560, height: 2560 },
    theme: 'default',
  };
}

function makeAllWallSector(row: number, col: number): SectorData {
  const tiles: Uint8Array[] = [];
  for (let r = 0; r < 20; r++) {
    tiles[r] = new Uint8Array(20);
    for (let c = 0; c < 20; c++) {
      tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
    }
  }
  return {
    type: SectorType.OPEN_ARENA,
    tiles,
    elevation: null,
    lootSpots: [],
    bounds: { x: col * 2560, y: row * 2560, width: 2560, height: 2560 },
    theme: 'default',
  };
}

function connectSectorsH(
  sectors: SectorData[][],
  row: number,
  leftCol: number,
  rightCol: number,
): void {
  sectors[row][leftCol].tiles[10][19] = TileType.EMPTY;
  sectors[row][rightCol].tiles[10][0] = TileType.EMPTY;
}

function connectSectorsV(
  sectors: SectorData[][],
  topRow: number,
  bottomRow: number,
  col: number,
): void {
  sectors[topRow][col].tiles[19][10] = TileType.EMPTY;
  sectors[bottomRow][col].tiles[0][10] = TileType.EMPTY;
}

describe('MapValidator', () => {
  const validator = new MapValidator();

  it('valid map from MapGenerator passes validation', () => {
    const gen = new MapGenerator();
    const mapData = gen.generate(42);
    const result = validator.validate(mapData);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  describe('check 1: flood fill connectivity (80% threshold)', () => {
    it('generated connected map passes', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      expect(result.errors).not.toContain(
        expect.stringContaining('Flood fill connectivity failed'),
      );
    });

    it('all-isolated sectors fail at 80% threshold', () => {
      const sectors = makeEmptySectorGrid();
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('Flood fill connectivity failed'))).toBe(true);
    });

    it('map with no EMPTY tiles produces error', () => {
      const sectors: SectorData[][] = [];
      for (let row = 0; row < 4; row++) {
        sectors[row] = [];
        for (let col = 0; col < 4; col++) {
          sectors[row][col] = makeAllWallSector(row, col);
        }
      }
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('No EMPTY tiles found'))).toBe(true);
    });

    it('80% boundary: 13 of 16 connected sectors pass (81.25%)', () => {
      const sectors = makeEmptySectorGrid();
      for (let row = 0; row < 4; row++) {
        connectSectorsH(sectors, row, 0, 1);
        connectSectorsH(sectors, row, 1, 2);
      }
      for (let col = 0; col < 3; col++) {
        connectSectorsV(sectors, 0, 1, col);
        connectSectorsV(sectors, 1, 2, col);
        connectSectorsV(sectors, 2, 3, col);
      }
      connectSectorsH(sectors, 0, 2, 3);
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors).not.toContain(
        expect.stringContaining('Flood fill connectivity failed'),
      );
    });

    it('80% boundary: 12 of 16 connected sectors fail (75%)', () => {
      const sectors = makeEmptySectorGrid();
      for (let row = 0; row < 4; row++) {
        connectSectorsH(sectors, row, 0, 1);
        connectSectorsH(sectors, row, 1, 2);
      }
      for (let col = 0; col < 3; col++) {
        connectSectorsV(sectors, 0, 1, col);
        connectSectorsV(sectors, 1, 2, col);
        connectSectorsV(sectors, 2, 3, col);
      }
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('Flood fill connectivity failed'))).toBe(true);
    });
  });

  describe('check 2: spawn reachability', () => {
    it('reachable spawns pass', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      for (const err of result.errors) {
        expect(err).not.toContain('not reachable');
      }
    });

    it('spawn on non-passable tile fails', () => {
      const sectors = makeEmptySectorGrid();
      const spawn: SpawnPoint = {
        x: 0,
        y: 0,
        sectorCoord: { row: 0, col: 0 },
        priority: 1,
      };
      const mapData = makeMapData({ sectors, spawnPoints: [spawn] });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('non-passable'))).toBe(true);
    });
  });

  describe('check 3: exit accessibility', () => {
    it('accessible exits pass', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      for (const err of result.errors) {
        expect(err).not.toContain('not reachable from sector interior');
      }
    });
  });

  describe('check 4: loot density', () => {
    it('each sector has at least 1 loot', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      for (const err of result.errors) {
        expect(err).not.toContain('no loot placements');
      }
    });

    it('sector with no loot fails', () => {
      const sectors = makeEmptySectorGrid();
      const loot: LootPlacement[] = [];
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          if (row === 0 && col === 0) continue;
          loot.push({
            type: 'CHEST',
            tier: 0,
            position: { x: col * 2560 + 128, y: row * 2560 + 128 },
            sectorCoord: { row, col },
          });
        }
      }
      const mapData = makeMapData({ sectors, lootPlacements: loot });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('0 loot placements'))).toBe(true);
    });
  });

  describe('check 5: spawn spacing', () => {
    it('well-spaced spawns pass', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      for (const err of result.errors) {
        expect(err).not.toContain('px apart');
      }
    });

    it('spawns too close together fail', () => {
      const sectors = makeEmptySectorGrid();
      const spawns: SpawnPoint[] = [
        { x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 1 },
        { x: 96, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 2 },
      ];
      const mapData = makeMapData({ sectors, spawnPoints: spawns });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('px apart'))).toBe(true);
    });
  });

  it('returns ValidationResult with valid boolean and errors array', () => {
    const gen = new MapGenerator();
    const mapData = gen.generate(42);
    const result = validator.validate(mapData);
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
    expect(typeof result.valid).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  describe('check 6: border walls', () => {
    it('all border tiles of generated map are INDESTRUCTIBLE_WALL', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const compositeSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;

      const allSectors = mapData.sectors.flat();
      const grid: number[][] = [];
      for (let r = 0; r < compositeSize; r++) {
        grid[r] = [];
        for (let c = 0; c < compositeSize; c++) {
          const sr = Math.floor(r / SECTOR_TILE_SIZE);
          const sc = Math.floor(c / SECTOR_TILE_SIZE);
          const lr = r % SECTOR_TILE_SIZE;
          const lc = c % SECTOR_TILE_SIZE;
          grid[r]![c] = allSectors[sr * SECTOR_GRID_SIZE + sc]!.tiles[lr]![lc]!;
        }
      }

      for (let c = 0; c < compositeSize; c++) {
        expect(grid[0]![c]).toBe(TileType.INDESTRUCTIBLE_WALL);
        expect(grid[compositeSize - 1]![c]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
      for (let r = 0; r < compositeSize; r++) {
        expect(grid[r]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
        expect(grid[r]![compositeSize - 1]).toBe(TileType.INDESTRUCTIBLE_WALL);
      }
    });
  });

  describe('check 7: spawn count', () => {
    it('valid generated map has >= 64 spawn points', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      expect(mapData.spawnPoints.length).toBeGreaterThanOrEqual(64);
    });
  });

  describe('check 8: loot density >= 2 per sector', () => {
    it('every sector has at least 2 loot placements', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const sectorLoot = mapData.lootPlacements.filter(
            (lp) => lp.sectorCoord.row === row && lp.sectorCoord.col === col,
          );
          expect(sectorLoot.length).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });

  // --- T1 quality gates ---------------------------------------------------

  describe('quality gate 1: minimum open-space %', () => {
    it('current generator output stays above the open-space floor', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('Open-space too low'))).toBe(false);
    });

    it('an over-dense map (walls fill interiors) is rejected', () => {
      const sectors = makeDenseSectorGrid();
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('Open-space too low'))).toBe(true);
    });
  });

  describe('quality gate 2: per-sector spawn feasibility', () => {
    it('current generator output yields enough spawn-eligible tiles', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('spawn-eligible tiles'))).toBe(false);
      expect(result.errors.some((e) => e.includes('Spawn feasibility'))).toBe(false);
    });

    it('a map that cannot reach 64 spawns is rejected with a per-sector message', () => {
      // All sectors nearly sealed: 1 EMPTY interior tile each => 16 total << 64.
      const sectors = makeNearlySealedSectorGrid();
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('Spawn feasibility'))).toBe(true);
      expect(
        result.errors.some((e) => e.includes('spawn-eligible tiles') && e.includes('[0,0]')),
      ).toBe(true);
    });

    it('one starved sector is tolerated when the overflow rule can still reach 64', () => {
      // 15 open sectors + 1 sealed (1 eligible tile). 15*324 + 1 >= 64.
      const sectors = makeEmptySectorGrid();
      sectors[0][0] = makeSealedSector(0, 0, 1);
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('spawn-eligible tiles'))).toBe(false);
      expect(result.errors.some((e) => e.includes('Spawn feasibility'))).toBe(false);
    });
  });

  describe('quality gate 3: per-sector loot feasibility', () => {
    it('current generator output can host every sector loot budget', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('loot infeasible'))).toBe(false);
    });

    it('a sector with too few eligible tiles for its loot budget is rejected', () => {
      const sectors = makeEmptySectorGrid();
      // Seal sector [1,1] to a few EMPTY tiles, all border-adjacent => 0 eligible.
      sectors[1][1] = makeSealedSector(1, 1, 2);
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('loot infeasible') && e.includes('[1,1]'))).toBe(
        true,
      );
    });
  });

  describe('quality gate 4: no isolated stub walls', () => {
    it('current generator output stays under the lone-wall ceiling', () => {
      const gen = new MapGenerator();
      const mapData = gen.generate(42);
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('isolated stub walls'))).toBe(false);
    });

    it('a map with lone stub walls over threshold is rejected', () => {
      const sectors = makeEmptySectorGrid();
      // Scatter > MAX_LONE_WALLS (120) isolated INDESTRUCTIBLE_WALLs, spaced so
      // no two are 8-neighbours of each other (every 3rd interior tile).
      let placed = 0;
      for (let row = 0; row < 4 && placed < 130; row++) {
        for (let col = 0; col < 4 && placed < 130; col++) {
          const tiles = sectors[row][col].tiles;
          for (let r = 2; r <= 17 && placed < 130; r += 3) {
            for (let c = 2; c <= 17 && placed < 130; c += 3) {
              tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
              placed++;
            }
          }
        }
      }
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('isolated stub walls'))).toBe(true);
    });

    it('a few clustered indestructible walls do NOT trip the lone-wall gate', () => {
      const sectors = makeEmptySectorGrid();
      // A solid 3x3 block: every wall has wall neighbours, so zero lone walls.
      const tiles = sectors[2][2].tiles;
      for (let r = 5; r <= 7; r++) {
        for (let c = 5; c <= 7; c++) {
          tiles[r][c] = TileType.INDESTRUCTIBLE_WALL;
        }
      }
      const mapData = makeMapData({ sectors });
      const result = validator.validate(mapData);
      expect(result.errors.some((e) => e.includes('isolated stub walls'))).toBe(false);
    });
  });
});

/**
 * Builds a 4x4 grid where every sector interior is filled with
 * INDESTRUCTIBLE_WALL, driving the composite open ratio well below the floor.
 * @returns A dense sector grid.
 */
function makeDenseSectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < 4; row++) {
    sectors[row] = [];
    for (let col = 0; col < 4; col++) {
      sectors[row][col] = makeAllWallSector(row, col);
    }
  }
  return sectors;
}

/**
 * Builds an otherwise-walled sector with a fixed number of EMPTY interior tiles,
 * all placed against the border ring so they are border-adjacent (zero
 * loot-eligible tiles), used to starve spawn/loot feasibility.
 * @param row The sector grid row.
 * @param col The sector grid column.
 * @param emptyCount How many interior EMPTY tiles to carve.
 * @returns A nearly-sealed sector.
 */
function makeSealedSector(row: number, col: number, emptyCount: number): SectorData {
  const sector = makeAllWallSector(row, col);
  let placed = 0;
  for (let c = 1; c < 19 && placed < emptyCount; c++) {
    sector.tiles[1][c] = TileType.EMPTY;
    placed++;
  }
  return sector;
}

/**
 * Builds a 4x4 grid of nearly-sealed sectors (1 EMPTY interior tile each), so
 * the map-wide spawn-eligible total (16) is far below the 64 required.
 * @returns A nearly-sealed sector grid.
 */
function makeNearlySealedSectorGrid(): SectorData[][] {
  const sectors: SectorData[][] = [];
  for (let row = 0; row < 4; row++) {
    sectors[row] = [];
    for (let col = 0; col < 4; col++) {
      sectors[row][col] = makeSealedSector(row, col, 1);
    }
  }
  return sectors;
}

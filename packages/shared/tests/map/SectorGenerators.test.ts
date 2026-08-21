import { TileType } from '../../src/enums/TileType.js';
import { GridArenaGenerator } from '../../src/map/sectors/GridArenaGenerator.js';
import { MazeGenerator } from '../../src/map/sectors/MazeGenerator.js';
import { OpenArenaGenerator } from '../../src/map/sectors/OpenArenaGenerator.js';
import { ResourceRichGenerator } from '../../src/map/sectors/ResourceRichGenerator.js';
import { SeededRNG } from '../../src/map/rng/SeededRNG.js';
import { SectorType } from '../../src/map/types.js';
import type { SectorConfig } from '../../src/map/sectors/ISectorGenerator.js';
import { TILE_PIXEL_SIZE } from '../../src/map/constants.js';
import {
  GRID_ARENA_SUB_VARIANTS,
  type SectorSubVariant,
} from '../../src/map/sectors/subVariants.js';

function makeConfig(type: SectorType, subVariant?: SectorSubVariant): SectorConfig {
  return {
    width: 20,
    height: 20,
    tileSize: TILE_PIXEL_SIZE,
    type,
    theme: 'default',
    sectorCoord: { row: 0, col: 0 },
    subVariant,
  };
}

function countTileType(tiles: Uint8Array[], tileType: TileType): number {
  let count = 0;
  for (const row of tiles) {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === tileType) count++;
    }
  }
  return count;
}

function tilesEqual(a: Uint8Array[], b: Uint8Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

function bfsReachableCount(tiles: Uint8Array[]): number {
  const height = tiles.length;
  const width = tiles[0].length;
  let startR = -1;
  let startC = -1;
  for (let r = 0; r < height && startR === -1; r++) {
    for (let c = 0; c < width && startC === -1; c++) {
      if (tiles[r][c] === TileType.EMPTY) {
        startR = r;
        startC = c;
      }
    }
  }
  if (startR === -1) return 0;

  const visited: boolean[][] = [];
  for (let r = 0; r < height; r++) visited[r] = new Array(width).fill(false);
  const queue: { r: number; c: number }[] = [{ r: startR, c: startC }];
  visited[startR][startC] = true;
  let count = 0;
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  while (queue.length > 0) {
    const { r, c } = queue.shift()!;
    count++;
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (
        nr >= 0 &&
        nr < height &&
        nc >= 0 &&
        nc < width &&
        !visited[nr][nc] &&
        tiles[nr][nc] === TileType.EMPTY
      ) {
        visited[nr][nc] = true;
        queue.push({ r: nr, c: nc });
      }
    }
  }
  return count;
}

const SEEDS = [42, 123, 9999];

describe('GridArenaGenerator', () => {
  const gen = new GridArenaGenerator();

  it.each(SEEDS)('produces valid 20x20 grid with seed %s', (seed) => {
    const rng = new SeededRNG(seed);
    const result = gen.generate(rng, makeConfig(SectorType.GRID_ARENA));
    expect(result.tiles.length).toBe(20);
    for (const row of result.tiles) expect(row.length).toBe(20);
  });

  it.each(SEEDS)('is deterministic with seed %s', (seed) => {
    const a = gen.generate(new SeededRNG(seed), makeConfig(SectorType.GRID_ARENA));
    const b = gen.generate(new SeededRNG(seed), makeConfig(SectorType.GRID_ARENA));
    expect(tilesEqual(a.tiles, b.tiles)).toBe(true);
  });

  it('has outer walls on all borders', () => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.GRID_ARENA));
    for (let col = 0; col < 20; col++) {
      expect(result.tiles[0][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(result.tiles[19][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
    for (let row = 0; row < 20; row++) {
      expect(result.tiles[row][0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(result.tiles[row][19]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
  });

  // T4: each sub-variant builds a distinct skeleton on a PERSISTENT
  // INDESTRUCTIBLE_WALL pillar skeleton + breakable fill (ADR 0027 / GDD §5.2.1).

  it.each(GRID_ARENA_SUB_VARIANTS)('builds %s with an indestructible skeleton', (sub) => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.GRID_ARENA, sub));
    expect(result.subVariant).toBe(sub);
    // Interior indestructible pillars exist (skeleton survives the whole match —
    // the arena can never be flattened to an open box).
    let interiorIndestructible = 0;
    for (let r = 1; r < 19; r++) {
      for (let c = 1; c < 19; c++) {
        if (result.tiles[r]![c] === TileType.INDESTRUCTIBLE_WALL) interiorIndestructible++;
      }
    }
    expect(interiorIndestructible).toBeGreaterThan(0);
  });

  // Classic Lattice & Broken Grid are indestructible-pillar-only (no breakable
  // fill); Ring Fortress & Lane Corridors lay breakable cover (ADR 0027 / GDD §5.2.1).
  it.each(['Ring Fortress', 'Lane Corridors'] as const)('%s lays breakable cover fill', (sub) => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.GRID_ARENA, sub));
    const breakable =
      countTileType(result.tiles, TileType.DESTRUCTIBLE_WALL) +
      countTileType(result.tiles, TileType.DESTRUCTIBLE_CRATE);
    expect(breakable).toBeGreaterThan(0);
  });

  it.each(GRID_ARENA_SUB_VARIANTS)('%s is deterministic for a given seed', (sub) => {
    const a = gen.generate(new SeededRNG(123), makeConfig(SectorType.GRID_ARENA, sub));
    const b = gen.generate(new SeededRNG(123), makeConfig(SectorType.GRID_ARENA, sub));
    expect(tilesEqual(a.tiles, b.tiles)).toBe(true);
  });

  it('consumes RNG — two instances of the same sub-variant differ across seeds', () => {
    const a = gen.generate(new SeededRNG(1), makeConfig(SectorType.GRID_ARENA, 'Broken Grid'));
    const b = gen.generate(new SeededRNG(2), makeConfig(SectorType.GRID_ARENA, 'Broken Grid'));
    expect(tilesEqual(a.tiles, b.tiles)).toBe(false);
  });

  it('the four sub-variants produce distinct skeletons', () => {
    const tiles = GRID_ARENA_SUB_VARIANTS.map(
      (sub) => gen.generate(new SeededRNG(42), makeConfig(SectorType.GRID_ARENA, sub)).tiles,
    );
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        expect(tilesEqual(tiles[i]!, tiles[j]!)).toBe(false);
      }
    }
  });

  it.each(GRID_ARENA_SUB_VARIANTS)('%s keeps EMPTY floor connected (>=80%)', (sub) => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.GRID_ARENA, sub));
    const totalFloors = countTileType(result.tiles, TileType.EMPTY);
    const reachable = bfsReachableCount(result.tiles);
    expect(reachable / totalFloors).toBeGreaterThanOrEqual(0.8);
  });

  it("does not place chests (loot is EntityPlacer's job)", () => {
    for (const sub of GRID_ARENA_SUB_VARIANTS) {
      const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.GRID_ARENA, sub));
      for (const row of result.tiles) {
        for (let c = 0; c < row.length; c++) {
          expect(row[c]).not.toBe(TileType.CHEST);
        }
      }
    }
  });
});

describe('OpenArenaGenerator', () => {
  const gen = new OpenArenaGenerator();

  it.each(SEEDS)('produces valid 20x20 grid with seed %s', (seed) => {
    const result = gen.generate(new SeededRNG(seed), makeConfig(SectorType.OPEN_ARENA));
    expect(result.tiles.length).toBe(20);
    for (const row of result.tiles) expect(row.length).toBe(20);
  });

  it.each(SEEDS)('is deterministic with seed %s', (seed) => {
    const a = gen.generate(new SeededRNG(seed), makeConfig(SectorType.OPEN_ARENA));
    const b = gen.generate(new SeededRNG(seed), makeConfig(SectorType.OPEN_ARENA));
    expect(tilesEqual(a.tiles, b.tiles)).toBe(true);
  });

  it('has border walls', () => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.OPEN_ARENA));
    for (let col = 0; col < 20; col++) {
      expect(result.tiles[0][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(result.tiles[19][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
    for (let row = 0; row < 20; row++) {
      expect(result.tiles[row][0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(result.tiles[row][19]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
  });
});

describe('MazeGenerator', () => {
  const gen = new MazeGenerator();

  it.each(SEEDS)('produces valid 20x20 grid with seed %s', (seed) => {
    const result = gen.generate(new SeededRNG(seed), makeConfig(SectorType.MAZE));
    expect(result.tiles.length).toBe(20);
    for (const row of result.tiles) expect(row.length).toBe(20);
  });

  it.each(SEEDS)('is deterministic with seed %s', (seed) => {
    const a = gen.generate(new SeededRNG(seed), makeConfig(SectorType.MAZE));
    const b = gen.generate(new SeededRNG(seed), makeConfig(SectorType.MAZE));
    expect(tilesEqual(a.tiles, b.tiles)).toBe(true);
  });

  it('has significant wall coverage', () => {
    const results = SEEDS.map((s) => gen.generate(new SeededRNG(s), makeConfig(SectorType.MAZE)));
    for (const result of results) {
      const walls = countTileType(result.tiles, TileType.INDESTRUCTIBLE_WALL);
      const ratio = walls / (20 * 20);
      expect(ratio).toBeGreaterThan(0.15);
    }
  });

  it('all floor tiles are connected via BFS', () => {
    const results = SEEDS.map((s) => gen.generate(new SeededRNG(s), makeConfig(SectorType.MAZE)));
    for (const result of results) {
      const totalFloors = countTileType(result.tiles, TileType.EMPTY);
      const reachable = bfsReachableCount(result.tiles);
      expect(reachable).toBe(totalFloors);
    }
  });

  it('does not place crates or chests', () => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.MAZE));
    for (const row of result.tiles) {
      for (let c = 0; c < row.length; c++) {
        expect(row[c]).not.toBe(TileType.DESTRUCTIBLE_CRATE);
        expect(row[c]).not.toBe(TileType.CHEST);
      }
    }
  });
});

describe('ResourceRichGenerator', () => {
  const gen = new ResourceRichGenerator();

  it.each(SEEDS)('produces valid 20x20 grid with seed %s', (seed) => {
    const result = gen.generate(new SeededRNG(seed), makeConfig(SectorType.RESOURCE_RICH));
    expect(result.tiles.length).toBe(20);
    for (const row of result.tiles) expect(row.length).toBe(20);
  });

  it.each(SEEDS)('is deterministic with seed %s', (seed) => {
    const a = gen.generate(new SeededRNG(seed), makeConfig(SectorType.RESOURCE_RICH));
    const b = gen.generate(new SeededRNG(seed), makeConfig(SectorType.RESOURCE_RICH));
    expect(tilesEqual(a.tiles, b.tiles)).toBe(true);
  });

  it('has border walls', () => {
    const result = gen.generate(new SeededRNG(42), makeConfig(SectorType.RESOURCE_RICH));
    for (let col = 0; col < 20; col++) {
      expect(result.tiles[0][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(result.tiles[19][col]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
    for (let row = 0; row < 20; row++) {
      expect(result.tiles[row][0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(result.tiles[row][19]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
  });
});

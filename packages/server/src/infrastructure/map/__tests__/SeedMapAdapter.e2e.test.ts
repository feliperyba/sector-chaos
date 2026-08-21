import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  MapGenerator as SharedMapGenerator,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
} from '@sector-battle/shared';
import { SeedMapAdapter } from '../SeedMapAdapter.js';

const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

describe('SeedMapAdapter E2E', () => {
  it('produces valid EnrichedMapData from seed', () => {
    const gen = new SharedMapGenerator();
    const mapData = gen.generate(42);
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(mapData, 42, TILED_DIR);

    const expectedSize = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;

    // Dimensions
    expect(result.width).toBe(expectedSize);
    expect(result.height).toBe(expectedSize);
    expect(result.grid.length).toBe(expectedSize);
    expect(result.grid[0]!.length).toBe(expectedSize);

    // 5 visual layers (ticket 13: wall_fill sits between decoration and walls)
    expect(result.visualLayers).toHaveLength(5);
    expect(result.visualLayers[0]!.name).toBe('floor');
    expect(result.visualLayers[1]!.name).toBe('decoration');
    expect(result.visualLayers[2]!.name).toBe('wall_fill');
    expect(result.visualLayers[3]!.name).toBe('map_border_walls');
    expect(result.visualLayers[4]!.name).toBe('interactive_layer');

    // Atlas has sprites
    expect(result.atlas.sprites.length).toBeGreaterThan(0);

    // Entities populated
    expect(result.entities.destructibles!.length).toBeGreaterThan(0);
    expect(result.entities.chests!.length).toBeGreaterThan(0);
    expect(result.entities.weapons!.length).toBeGreaterThan(0);
    expect(result.entities.traps!.length).toBeGreaterThan(0);

    // TileSize
    expect(result.tileSize).toBe(128);
  });

  it('is deterministic', () => {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result1 = adapter.adapt(gen.generate(12345), 12345, TILED_DIR);
    const result2 = adapter.adapt(gen.generate(12345), 12345, TILED_DIR);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});

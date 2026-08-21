/**
 * Regression test for perf ticket 18 — MapRenderer grid mutation version.
 *
 * The minimap terrain cache keys on (grid identity, gridVersion): the grid
 * array mutates IN PLACE at every destruction/siege seam, so identity alone
 * cannot detect a mutation. This test pins the version contract of ALL
 * mutation seams the cache relies on:
 *
 *  - `render()` — full grid load (map reload) → always bumps.
 *  - `clearGridCell()` — destructible destroyed / chest taken (event +
 *    state-sync handlers all route here) → bumps ONLY when a tile actually
 *    changes (clearing an already-empty cell is a no-op, not an invalidation).
 *  - `setSiegeWallWithTexture()` — siege wall drop (SiegeVFX coffin landing)
 *    → bumps only when the tile actually becomes a wall.
 *
 * No real Phaser: the renderer only touches the scene through stubbed
 * `add.renderTexture` / `add.graphics` / `cameras` / `textures` seams
 * (`render()` with no atlas skips the static-layer bake entirely).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));

import { MapRenderer } from '../MapRenderer.js';
import type { MapData } from '../../types.js';

function makeSceneStub(): Phaser.Scene {
  const rtStub = {
    setOrigin: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    draw: vi.fn(),
    render: vi.fn(),
  };
  return {
    add: {
      renderTexture: vi.fn(() => rtStub),
      graphics: vi.fn(() => ({
        fillStyle: vi.fn(),
        fillRect: vi.fn(),
        destroy: vi.fn(),
      })),
    },
    cameras: { main: { setBounds: vi.fn() } },
    // `.has()` false → setSiegeWallWithTexture takes the graphics fallback.
    textures: { get: vi.fn(() => ({ has: () => false })) },
  } as unknown as Phaser.Scene;
}

function makeMapData(grid: number[][]): MapData {
  return {
    grid,
    width: grid[0]?.length ?? 0,
    height: grid.length,
    tileSize: 128,
    seed: 1,
  };
}

const GRID: number[][] = [
  [1, 2, 0],
  [0, 0, 0],
  [0, 0, 4],
];

describe('ticket 18 — MapRenderer grid mutation version', () => {
  it('starts at 0 and render() bumps on every grid load', () => {
    const renderer = new MapRenderer(makeSceneStub());
    expect(renderer.getGridVersion()).toBe(0);
    renderer.render(makeMapData(GRID));
    expect(renderer.getGridVersion()).toBe(1);
    renderer.render(makeMapData(GRID));
    expect(renderer.getGridVersion()).toBe(2);
  });

  it('clearGridCell bumps only when a tile actually changes', () => {
    const renderer = new MapRenderer(makeSceneStub());
    renderer.render(makeMapData(GRID));
    const afterLoad = renderer.getGridVersion();

    renderer.clearGridCell(1, 0); // destructible (0,1) destroyed → 2 → 0
    expect(renderer.getGridVersion()).toBe(afterLoad + 1);
    expect(renderer.getGrid()[0]![1]).toBe(0);

    renderer.clearGridCell(1, 0); // already empty → NO invalidation
    expect(renderer.getGridVersion()).toBe(afterLoad + 1);

    renderer.clearGridCell(-1, 0); // out of bounds → no-op
    renderer.clearGridCell(99, 99);
    expect(renderer.getGridVersion()).toBe(afterLoad + 1);
  });

  it('setSiegeWallWithTexture bumps only when the tile becomes a wall', () => {
    const renderer = new MapRenderer(makeSceneStub());
    renderer.render(makeMapData(GRID));
    const before = renderer.getGridVersion();

    renderer.setSiegeWallWithTexture(2, 1, 'coffin'); // SiegeVFX drop seam
    expect(renderer.getGridVersion()).toBe(before + 1);
    expect(renderer.getGrid()[1]![2]).toBe(1);

    renderer.setSiegeWallWithTexture(2, 1, 'coffin'); // already a wall → no bump
    expect(renderer.getGridVersion()).toBe(before + 1);

    renderer.setSiegeWall(0, 2); // bare wrapper delegates with 'wall'
    expect(renderer.getGridVersion()).toBe(before + 2);
    expect(renderer.getGrid()[2]![0]).toBe(1);
  });

  it('version is monotonic across mixed seams', () => {
    const renderer = new MapRenderer(makeSceneStub());
    renderer.render(makeMapData(GRID));
    let last = renderer.getGridVersion();
    renderer.clearGridCell(1, 0);
    renderer.setSiegeWall(1, 0);
    renderer.render(makeMapData(GRID));
    for (const v of [renderer.getGridVersion()]) {
      expect(v).toBeGreaterThan(last);
      last = v;
    }
  });
});

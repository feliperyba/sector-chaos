import { describe, expect, it } from 'vitest';
import { TileType } from '@sector-battle/shared';
import { skipsWallBakeAt, WALL_FILL_LAYER_NAME } from '../MapRendererWallFill.js';

/**
 * Map-polish ticket 13 — the `wall_fill` under-layer client contract.
 *
 * The bake itself is a Phaser render-texture draw (browser-verified); what is
 * unit-testable is the PURE decision logic: which layer/grid combinations the
 * static bake skips (a destroyed wall must never leave baked fill or wall art
 * behind) and the layer-name literal, which mirrors the server's
 * `WALL_FILL_LAYER_NAME` (`packages/server/src/infrastructure/map/WallVisualSelector.ts`)
 * — both sides pin the same string so drift fails a test.
 */

describe('WALL_FILL_LAYER_NAME', () => {
  it('is the exact server-emitted layer name', () => {
    expect(WALL_FILL_LAYER_NAME).toBe('wall_fill');
  });
});

describe('skipsWallBakeAt (ticket 13)', () => {
  const grid = [
    [TileType.EMPTY, TileType.DESTRUCTIBLE_WALL],
    [TileType.INDESTRUCTIBLE_WALL, TileType.EMPTY],
  ];

  it('skips DESTRUCTIBLE_WALL cells in BOTH wall layers (no baked art, no baked fill)', () => {
    expect(skipsWallBakeAt('map_border_walls', grid, 0, 1)).toBe(true);
    expect(skipsWallBakeAt(WALL_FILL_LAYER_NAME, grid, 0, 1)).toBe(true);
  });

  it('bakes indestructible wall cells in both wall layers', () => {
    expect(skipsWallBakeAt('map_border_walls', grid, 1, 0)).toBe(false);
    expect(skipsWallBakeAt(WALL_FILL_LAYER_NAME, grid, 1, 0)).toBe(false);
  });

  it('never skips floor/decoration/interactive layers, whatever the tile', () => {
    for (const layer of ['floor', 'decoration', 'interactive_layer']) {
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r]!.length; c++) {
          expect(skipsWallBakeAt(layer, grid, r, c)).toBe(false);
        }
      }
    }
  });

  it('is total on out-of-bounds coordinates (skips nothing)', () => {
    expect(skipsWallBakeAt('map_border_walls', grid, 99, 99)).toBe(false);
    expect(skipsWallBakeAt(WALL_FILL_LAYER_NAME, grid, -1, 0)).toBe(false);
  });
});

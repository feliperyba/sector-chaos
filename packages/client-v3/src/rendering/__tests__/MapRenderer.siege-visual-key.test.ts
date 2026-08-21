/**
 * Regression test for perf ticket 21 — siege-wall visual override numeric key.
 *
 * `getSiegeWallVisual` fires per tile per collision substep inside
 * ClientCollisionService.findCellVisual (the hottest client loop). The former
 * `` `${gridX},${gridY}` `` template-string key allocated a transient string
 * per lookup; the Map is now keyed by the NUMERIC encoding the `siegeWalls`
 * Set already uses (`gridX * 100000 + gridY`). This test pins the observable
 * contract of that swap:
 *
 *  1. setSiegeWallWithTexture(gx, gy) → getSiegeWallVisual(gx, gy) returns
 *     the injected override (exact fields, siege sprite id).
 *  2. TRANSPOSED / neighbor coords do NOT hit the override (the encoding is
 *     injective on the realizable grid range; string keys behaved the same).
 *  3. The override participates in collision exactly as before —
 *     isPointBlocked at the siege tile center is solid after the drop.
 *  4. No real Phaser: the renderer only touches the scene through stubbed
 *     `add.renderTexture` / `add.graphics` / `cameras` / `textures` seams
 *     (same convention as MapRenderer.grid-version.test.ts).
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

function makeRenderer(): MapRenderer {
  const renderer = new MapRenderer(makeSceneStub());
  // Empty (but non-null) atlas: injectSiegeWallVisual needs a live atlas to
  // append the shared siege-wall sprite def; no visualLayers → no static bake.
  const data: MapData = {
    grid: [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    width: 4,
    height: 4,
    tileSize: 128,
    seed: 1,
    atlas: { sprites: [] },
  };
  renderer.render(data);
  return renderer;
}

describe('ticket 21 — siege visual override numeric key', () => {
  it('setSiegeWallWithTexture injects the override readable at the same coords', () => {
    const renderer = makeRenderer();
    expect(renderer.getSiegeWallVisual(2, 3)).toBeNull();
    renderer.setSiegeWallWithTexture(2, 3, 'wall');
    const override = renderer.getSiegeWallVisual(2, 3);
    expect(override).not.toBeNull();
    expect(override!.spriteId).toBe(0); // first appended siege sprite def
    expect(override!.rotation).toBe(0);
    expect(override!.flipH).toBe(false);
    expect(override!.flipV).toBe(false);
  });

  it('transposed and neighbor coords never alias the override', () => {
    const renderer = makeRenderer();
    renderer.setSiegeWallWithTexture(2, 3, 'wall');
    // (3,2) is a DIFFERENT tile: numeric key 300002 vs string "3,2" both
    // miss — the injective encoding must not fuse the two.
    expect(renderer.getSiegeWallVisual(3, 2)).toBeNull();
    expect(renderer.getSiegeWallVisual(2, 2)).toBeNull();
    expect(renderer.getSiegeWallVisual(2, 4)).toBeNull();
    expect(renderer.getSiegeWallVisual(1, 3)).toBeNull();
    // Out-of-grid reads stay null (never written).
    expect(renderer.getSiegeWallVisual(-1, 3)).toBeNull();
    expect(renderer.getSiegeWallVisual(99, 99)).toBeNull();
  });

  it('the siege tile is solid after the drop (collision reads unchanged)', () => {
    const renderer = makeRenderer();
    const cx = 2 * 128 + 64;
    const cy = 3 * 128 + 64;
    expect(renderer.isPointBlocked(cx, cy)).toBe(false);
    renderer.setSiegeWallWithTexture(2, 3, 'wall');
    expect(renderer.isPointBlocked(cx, cy)).toBe(true);
  });
});

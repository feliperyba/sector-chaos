/**
 * Regression test for perf ticket 18 — minimap STATIC TERRAIN render cache.
 *
 * WHY THE MOCK SEAM (not a real Phaser scene):
 * `MinimapRenderer`'s constructor builds real Phaser objects (`add.graphics`,
 * `add.rectangle`, `Panel`, pooled `Text`), and Phaser has no lightweight
 * headless mode in vitest (documented in KillFeedRenderer.text-cache.test).
 * We mock Phaser (with a REAL Clamp impl — the zone-ring path depends on it),
 * `Panel`, and the sibling label/landmark modules, then record every Graphics
 * command into per-instance logs. `MinimapTerrain` — the code under test — is
 * imported REAL so the asserted command stream is produced by the same source
 * of truth as production.
 *
 * WHAT THIS PROVES:
 *  1. Steady state (identical terrain-pixel inputs) → ZERO commands issue
 *     into the terrain Graphics on subsequent frames (not even `clear`) —
 *     no tile iteration, no re-tessellation. Dynamic overlays (dots, zone
 *     ring, player marker) keep their per-frame path untouched.
 *  2. Invalidation: exact player-position change (sub-tile — terrain
 *     translates continuously with the player, ~1 minimap px per 16.5 world
 *     px, so a tile-window-only key would NOT be pixel-identical), grid
 *     mutation version bump (in-place `clearGridCell`-style edit), and grid
 *     identity swap (map reload) each trigger a terrain redraw.
 *  3. Pixel identity: the frame-1 command stream — terrain Graphics then
 *     dynamic Graphics — is command-for-command, argument-for-argument the
 *     pre-cache single-Graphics sequence (tier tint → wall pass 1 → wall
 *     pass 2 → exit pass → chest/pickup dots → player marker), with the
 *     terrain Graphics inserted FIRST in the display list so the composite
 *     z-order is unchanged.
 *
 * WHAT THIS DOES NOT PROVE (browser verification):
 *  - Rasterized pixels on a real GPU (covered by tsc + the identical-command
 *    guarantees above — Phaser renders Graphics from exactly these commands).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('phaser', () => ({
  default: {
    Math: {
      Clamp: (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)),
    },
  },
}));

vi.mock('../../ui/components/Panel.js', () => ({
  Panel: class {
    setDepth = vi.fn().mockReturnThis();
    setScrollFactor = vi.fn().mockReturnThis();
    destroy = vi.fn();
  },
}));

vi.mock('../MinimapSectorLabels.js', () => ({
  createSectorLabelSlots: vi.fn(() => []),
  updateSectorLabels: vi.fn(),
}));

vi.mock('../MinimapLandmarks.js', () => ({
  drawLandmarkIcons: vi.fn(),
}));

import { MinimapRenderer } from '../MinimapRenderer.js';
import type { MinimapData } from '../MinimapRenderer.js';

// --- Graphics recorder -------------------------------------------------------
type Cmd = [name: string, ...args: number[]];

interface GfxRecorder {
  cmds: Cmd[];
  setPosition: ReturnType<typeof vi.fn>;
  setDepth: ReturnType<typeof vi.fn>;
  setScrollFactor: ReturnType<typeof vi.fn>;
}

function makeGfxRecorder(): GfxRecorder {
  const cmds: Cmd[] = [];
  const rec =
    (name: string) =>
    (...args: number[]) => {
      cmds.push([name, ...args]);
    };
  return {
    cmds,
    setPosition: vi.fn().mockReturnThis(),
    setDepth: vi.fn().mockReturnThis(),
    setScrollFactor: vi.fn().mockReturnThis(),
    clear: rec('clear'),
    fillStyle: rec('fillStyle'),
    fillRect: rec('fillRect'),
    fillCircle: rec('fillCircle'),
    lineStyle: rec('lineStyle'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    strokePath: rec('strokePath'),
  } as unknown as GfxRecorder;
}

// Creation order mirrors create(): [0] = static terrain layer, [1] = dynamic.
let gfxInstances: GfxRecorder[];

function makeSceneStub(): Phaser.Scene {
  gfxInstances = [];
  return {
    scale: { width: 1280, height: 720 },
    add: {
      rectangle: vi.fn(() => ({
        setDepth: vi.fn().mockReturnThis(),
        setScrollFactor: vi.fn().mockReturnThis(),
      })),
      graphics: vi.fn(() => {
        const g = makeGfxRecorder();
        gfxInstances.push(g);
        return g;
      }),
    },
  } as unknown as Phaser.Scene;
}

// --- Fixture -----------------------------------------------------------------
// 4x4 map, tileSize 128 → 512x512 world, player centered at (256, 256) so the
// whole grid sits inside the view window (VIEW_RANGE = 200*16.5/2 - 128 = 1522).
// Template only — `activeGrid` is re-cloned per test (tests mutate it).
const BASE_GRID: number[][] = [
  [1, 2, 0, 0], // (0,0) indestructible wall, (0,1) destructible
  [0, 8, 0, 0], // (1,1) indestructible crate
  [0, 0, 4, 0], // (2,2) exit
  [0, 0, 0, 0],
];
let activeGrid: number[][] = [];
const TIERS = [
  ['HOT', 'WARM'],
  ['COLD', null],
] as unknown as MinimapData['sectorTiers'];

function makeData(overrides: Partial<MinimapData> = {}): MinimapData {
  return {
    playerX: 256,
    playerY: 256,
    worldW: 512,
    worldH: 512,
    zoneCX: 256,
    zoneCY: 256,
    zoneRadius: 0,
    grid: activeGrid,
    tileSize: 128,
    gridVersion: 0,
    pickups: [{ x: 128, y: 128 }],
    pickupCount: 1,
    chests: [{ x: 384, y: 384 }],
    chestCount: 1,
    sectorTiers: TIERS,
    hotSector: null,
    poiNames: null,
    landmarks: null,
    ...overrides,
  };
}

/** Independent re-derivation of the world→minimap transform (player 256,256). */
const mm = (wx: number) => (wx - 256) / 16.5 + 100;
const TILE_PX = 128 / 16.5;
const WALL = TILE_PX + 1;
/** Normalize floats for deep-equality (recorder args are exact IEEE anyway). */
const r6 = (cmds: Cmd[]): Array<Array<number | string>> =>
  cmds.map((c) => c.map((a) => (typeof a === 'number' ? Math.round(a * 1e6) / 1e6 : a)));

const TERRAIN_GOLD = 0xffc94d;
const TERRAIN_WARM = 0xd98b45;
const TERRAIN_COLD = 0x5b8bd6;

describe('ticket 18 — MinimapRenderer terrain cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeGrid = BASE_GRID.map((row) => [...row]);
  });

  it('steady state: zero terrain commands on subsequent frames, dynamic layer still redrawn', () => {
    const renderer = new MinimapRenderer(makeSceneStub());
    renderer.updateMinimap(makeData());
    const terrainCmdsAfterFrame1 = gfxInstances[0]!.cmds.length;
    const dynamicCmdsAfterFrame1 = gfxInstances[1]!.cmds.length;
    expect(terrainCmdsAfterFrame1).toBeGreaterThan(0); // frame 1 drew terrain

    renderer.updateMinimap(makeData()); // identical inputs
    // Frame 2: terrain Graphics untouched — not even a clear.
    expect(gfxInstances[0]!.cmds.length).toBe(terrainCmdsAfterFrame1);
    // Dynamic layer: full per-frame pass (chest + pickup dots + player marker).
    expect(gfxInstances[1]!.cmds.length).toBe(dynamicCmdsAfterFrame1 * 2);
  });

  it('sub-tile player move redraws terrain (terrain translates with the player — pixel identity)', () => {
    const renderer = new MinimapRenderer(makeSceneStub());
    renderer.updateMinimap(makeData());
    const frame1WallRect = gfxInstances[0]!.cmds.find((c) => c[0] === 'fillRect')!;
    const lenAfterFrame1 = gfxInstances[0]!.cmds.length;

    // 8 world px sideways — same tile window, same grid: only the exact
    // position input changed, and terrain MUST follow or the cached layer
    // would drift up to a full minimap px off the uncached render.
    renderer.updateMinimap(makeData({ playerX: 264 }));
    const frame2WallRect = gfxInstances[0]!.cmds
      .slice(lenAfterFrame1)
      .find((c) => c[0] === 'fillRect')!;
    expect(gfxInstances[0]!.cmds.length).toBeGreaterThan(lenAfterFrame1); // redrew
    expect(frame2WallRect[1]).toBeCloseTo((frame1WallRect[1] as number) - 8 / 16.5, 10);
  });

  it('grid mutation (version bump, same array ref — clearGridCell path) invalidates the cache', () => {
    const renderer = new MinimapRenderer(makeSceneStub());
    renderer.updateMinimap(makeData());
    const rectsAfterFrame1 = gfxInstances[0]!.cmds.filter((c) => c[0] === 'fillRect').length;

    // In-place mutation exactly like MapRenderer.clearGridCell: same ref,
    // version++ — identity comparison alone could NOT see this.
    activeGrid[0]![1] = 0;
    renderer.updateMinimap(makeData({ gridVersion: 1 }));

    // Redraw happened, and the destructible (0,1) rect is gone:
    // 3 tint rects + 2 pass-1 wall rects + 1 pass-2 rect before → one fewer now.
    expect(gfxInstances[0]!.cmds.length).toBeGreaterThan(0);
    const rects2 = gfxInstances[0]!.cmds.filter((c) => c[0] === 'fillRect').length;
    expect(rects2).toBe(rectsAfterFrame1 * 2 - 1); // frame1 + frame2 minus the removed tile
  });

  it('grid identity swap (map reload) invalidates even at the same version', () => {
    const renderer = new MinimapRenderer(makeSceneStub());
    renderer.updateMinimap(makeData());
    const lenAfterFrame1 = gfxInstances[0]!.cmds.length;

    const reloaded = activeGrid.map((row) => [...row]);
    renderer.updateMinimap(makeData({ grid: reloaded, gridVersion: 0 }));
    expect(gfxInstances[0]!.cmds.length).toBeGreaterThan(lenAfterFrame1);
  });

  it('zone ring stays a per-frame dynamic overlay (never cached into terrain)', () => {
    const renderer = new MinimapRenderer(makeSceneStub());
    const zoned = makeData({ zoneRadius: 600 });
    renderer.updateMinimap(zoned);
    const terrainAfterFrame1 = gfxInstances[0]!.cmds.length;
    const strokes1 = gfxInstances[1]!.cmds.filter((c) => c[0] === 'strokePath').length;
    expect(strokes1).toBe(48); // full circle = 48 segments

    renderer.updateMinimap(zoned); // steady state
    expect(gfxInstances[0]!.cmds.length).toBe(terrainAfterFrame1); // terrain frozen
    const strokes2 = gfxInstances[1]!.cmds.filter((c) => c[0] === 'strokePath').length;
    expect(strokes2).toBe(96); // ring re-drawn every frame (cumulative log)
  });

  it('pixel identity: frame-1 command stream equals the pre-cache single-Graphics sequence', () => {
    const renderer = new MinimapRenderer(makeSceneStub());
    renderer.updateMinimap(makeData());

    // The exact command order the monolithic pre-ticket draw issued, split
    // only at the terrain/dynamic boundary (terrain gfx renders first →
    // identical composite z-order).
    const expectedTerrain: Array<Array<number | string>> = [
      ['clear'],
      // Sector tier wash (under everything)
      ['fillStyle', TERRAIN_GOLD, 0.1],
      ['fillRect', mm(0), mm(0), TILE_PX, TILE_PX],
      ['fillStyle', TERRAIN_WARM, 0.05],
      ['fillRect', mm(128), mm(0), TILE_PX, TILE_PX],
      ['fillStyle', TERRAIN_COLD, 0.08],
      ['fillRect', mm(0), mm(128), TILE_PX, TILE_PX],
      // Pass 1: indestructible wall (0,0) + crate (1,1)
      ['fillStyle', 0x9999bb, 0.9],
      ['fillRect', mm(0), mm(0), WALL, WALL],
      ['fillRect', mm(128), mm(128), WALL, WALL],
      // Pass 2: destructible (0,1)
      ['fillStyle', 0x886644, 0.75],
      ['fillRect', mm(128), mm(0), WALL, WALL],
      // Pass 3: exit dot (2,2)
      ['fillStyle', 0x44ff44, 1],
      ['fillCircle', mm(256) + TILE_PX / 2, mm(256) + TILE_PX / 2, 3],
    ];
    const expectedDynamic: Array<Array<number | string>> = [
      ['clear'],
      // Chest (gold) then pickup (cyan) dots
      ['fillStyle', 0xffd700, 1],
      ['fillCircle', mm(384), mm(384), 2.5],
      ['fillStyle', 0x00ffff, 1],
      ['fillCircle', mm(128), mm(128), 2.5],
      // Player marker (white ring + red core)
      ['fillStyle', 0xffffff, 1],
      ['fillCircle', 100, 100, 4],
      ['fillStyle', 0xff0000, 1],
      ['fillCircle', 100, 100, 2],
    ];

    expect(r6(gfxInstances[0]!.cmds)).toEqual(expectedTerrain.map(r6cmd));
    expect(r6(gfxInstances[1]!.cmds)).toEqual(expectedDynamic.map(r6cmd));
  });
});

/** Round every numeric arg of an expected command (mirrors r6 normalization). */
function r6cmd(cmd: Array<number | string>): Array<number | string> {
  return cmd.map((a) => (typeof a === 'number' ? Math.round(a * 1e6) / 1e6 : a));
}

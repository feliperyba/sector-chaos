/**
 * LightingAtmosphereSectorField — the per-sector dust-field split regression
 * guard (map-polish round-5c ticket 31, Seam A).
 *
 * Pure-logic asserts (no Phaser): the camera-follow field intersects the
 * sector grid into per-type slices — one slice per type present, weight by
 * covered area, the LARGEST intersection as the emit rect, world-edge
 * overhang handled, degenerate geometry empty, and the caller's out-array
 * objects reused (the per-frame zero-allocation contract).
 */
import { describe, it, expect } from 'vitest';
import { SectorType } from '@sector-battle/shared';
import { splitDustFieldBySector, type DustFieldSlice } from '../LightingAtmosphereSectorField.js';

// Real map geometry: SECTOR_TILE_SIZE(20) × TILE_PIXEL_SIZE(128) = 2560px edge.
const TILE = 128;
const SECTOR_TILES = 20;
const EDGE = TILE * SECTOR_TILES; // 2560

/** A 2×2 grid with one distinct type per cell (quadrant order TL/TR/BL/BR). */
const quadGrid: SectorType[][] = [
  [SectorType.GRID_ARENA, SectorType.OPEN_ARENA],
  [SectorType.MAZE, SectorType.RESOURCE_RICH],
];

const uniformGrid = (t: SectorType): SectorType[][] => [
  [t, t],
  [t, t],
];

describe('splitDustFieldBySector — field ∩ sector grid (round 5c)', () => {
  it('a field entirely inside one sector → single slice, weight 1, rect = the field', () => {
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector({ x: 100, y: 100, w: 800, h: 600 }, quadGrid, TILE, SECTOR_TILES, out);
    expect(out).toHaveLength(1);
    expect(out[0]!.sectorType).toBe(SectorType.GRID_ARENA);
    expect(out[0]!.weight).toBeCloseTo(1, 10);
    expect(out[0]).toMatchObject({ x: 100, y: 100, w: 800, h: 600 });
  });

  it('a field straddling a vertical sector border → two slices weighted by area', () => {
    // Field [2160..2960]×[0..1000]: 400px in col 0 (GRID), 400px in col 1 (OPEN).
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector({ x: 2160, y: 0, w: 800, h: 1000 }, quadGrid, TILE, SECTOR_TILES, out);
    expect(out).toHaveLength(2);
    const total = out.reduce((sum, s) => sum + s.weight, 0);
    expect(total).toBeCloseTo(1, 10);
    for (const slice of out) expect(slice.weight).toBeCloseTo(0.5, 10);
    const types = out.map((s) => s.sectorType).sort();
    expect(types).toEqual([SectorType.GRID_ARENA, SectorType.OPEN_ARENA].sort());
  });

  it('a field over the 2×2 sector corner → four equal quarter slices', () => {
    // Field [2160..2960]²: 400×400 in each of the four cells.
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector({ x: 2160, y: 2160, w: 800, h: 800 }, quadGrid, TILE, SECTOR_TILES, out);
    expect(out).toHaveLength(4);
    for (const slice of out) expect(slice.weight).toBeCloseTo(0.25, 10);
    expect(new Set(out.map((s) => s.sectorType)).size).toBe(4);
  });

  it('the same type in multiple cells folds into ONE slice (weight = summed area, rect = largest)', () => {
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector(
      { x: 2160, y: 0, w: 800, h: 1000 },
      uniformGrid(SectorType.MAZE),
      TILE,
      SECTOR_TILES,
      out,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sectorType).toBe(SectorType.MAZE);
    expect(out[0]!.weight).toBeCloseTo(1, 10); // both halves are MAZE
    // The emit rect is ONE of the intersections (the largest — here equal
    // halves, first kept), inside the field and cell-aligned.
    expect(out[0]!.w).toBe(400);
    expect(out[0]!.h).toBe(1000);
  });

  it('a field overhanging the world edge → weights sum to the covered fraction (< 1), no crash', () => {
    // World is 2×2 sectors (5120px wide); field [4900..5700] covers only
    // [4900..5120] = 220px of real grid → weight 220/800 = 0.275.
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector({ x: 4900, y: 0, w: 800, h: 1000 }, quadGrid, TILE, SECTOR_TILES, out);
    const total = out.reduce((sum, s) => sum + s.weight, 0);
    expect(total).toBeCloseTo(0.275, 10);
  });

  it('degenerate geometry (zero-area field / zero tileSize) → empty result', () => {
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector({ x: 0, y: 0, w: 0, h: 100 }, quadGrid, TILE, SECTOR_TILES, out);
    expect(out).toHaveLength(0);
    splitDustFieldBySector({ x: 0, y: 0, w: 100, h: 100 }, quadGrid, 0, SECTOR_TILES, out);
    expect(out).toHaveLength(0);
  });

  it('reuses the caller’s out-array objects across calls (per-frame zero allocation)', () => {
    const out: DustFieldSlice[] = [];
    splitDustFieldBySector({ x: 100, y: 100, w: 800, h: 600 }, quadGrid, TILE, SECTOR_TILES, out);
    const firstSlice = out[0];
    splitDustFieldBySector({ x: 2160, y: 2160, w: 800, h: 800 }, quadGrid, TILE, SECTOR_TILES, out);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(firstSlice); // same object, mutated in place
    // And a shrinking call truncates the length.
    splitDustFieldBySector({ x: 100, y: 100, w: 800, h: 600 }, quadGrid, TILE, SECTOR_TILES, out);
    expect(out).toHaveLength(1);
  });

  it('is deterministic (same inputs → same slices)', () => {
    const a: DustFieldSlice[] = [];
    const b: DustFieldSlice[] = [];
    const field = { x: 2160, y: 0, w: 800, h: 1000 };
    splitDustFieldBySector(field, quadGrid, TILE, SECTOR_TILES, a);
    splitDustFieldBySector(field, quadGrid, TILE, SECTOR_TILES, b);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toEqual(b[i]);
    }
  });
});

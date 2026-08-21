/**
 * Self-tests for the art-shape ground-truth helpers (map-polish ticket 12).
 *
 * These validate the fixture + helpers BEFORE any audit built on them is
 * trusted — the same discipline the topic-F probe used (a probe-side rotation
 * bug initially produced false corner findings; helper self-tests catch that
 * class of error).
 */

import { describe, it, expect } from 'vitest';
import {
  WALL_ART_SHAPES,
  edgeBand,
  orientedShape,
  rotateShapeBy90s,
  shapeGrid,
  solidEdges,
  solidQuadrants,
} from '@sector-battle/shared';

const ALL_SPRITES = [
  'wall',
  'wall_damaged',
  'wall_corner',
  'wall_edge',
  'inner_round',
  'wall_curve',
  'wall_diagonal',
] as const;

describe('WALL_ART_SHAPES fixture', () => {
  it('covers every wall frame the layer can emit, as 8x8 grids of #/+/.', () => {
    expect(Object.keys(WALL_ART_SHAPES).sort()).toEqual([...ALL_SPRITES].sort());
    for (const name of ALL_SPRITES) {
      const rows = WALL_ART_SHAPES[name]!;
      expect(rows).toHaveLength(8);
      for (const row of rows) {
        expect(row).toHaveLength(8);
        expect(row).toMatch(/^[#+.]{8}$/);
      }
    }
  });
});

describe('rotateShapeBy90s', () => {
  it('rotates a marked cell clockwise: (0,0) -> (0,7) -> (7,7) -> (7,0)', () => {
    const marker: number[][] = Array.from({ length: 8 }, () => Array(8).fill(0));
    marker[0]![0] = 1;
    expect(rotateShapeBy90s(marker, 0)[0]![0]).toBe(1);
    expect(rotateShapeBy90s(marker, 90)[0]![7]).toBe(1);
    expect(rotateShapeBy90s(marker, 180)[7]![7]).toBe(1);
    expect(rotateShapeBy90s(marker, 270)[7]![0]).toBe(1);
    // 360 == identity
    expect(rotateShapeBy90s(marker, 360)).toEqual(marker);
  });

  it('preserves total coverage under rotation for every sprite', () => {
    for (const name of ALL_SPRITES) {
      const g = shapeGrid(name);
      const total = (m: number[][]) => m.flat().reduce((a, b) => a + b, 0);
      const base = total(g);
      for (const rot of [90, 180, 270]) {
        expect(total(rotateShapeBy90s(g, rot))).toBe(base);
      }
    }
  });
});

describe('solidEdges — ticket-cited self-tests', () => {
  it('wall_corner@180 arms = S+E (convex L hugs the south and east edges)', () => {
    const se = solidEdges('wall_corner', 180);
    expect(se).toEqual({ N: false, E: true, S: true, W: false });
  });

  it('wall_corner@0 arms = N+W (the base orientation)', () => {
    const se = solidEdges('wall_corner', 0);
    expect(se).toEqual({ N: true, E: false, S: false, W: true });
  });

  it('wall@0 carries its solid strip on the north half (south transparent)', () => {
    expect(solidEdges('wall', 0)).toEqual({ N: true, E: false, S: false, W: false });
    const q = solidQuadrants('wall', 0);
    expect(q).toEqual({ NE: true, SE: false, SW: false, NW: true });
  });

  it('wall@90/@180/@270 rotate the strip E/S/W (clockwise convention)', () => {
    expect(solidEdges('wall', 90)).toEqual({ N: false, E: true, S: false, W: false });
    expect(solidEdges('wall', 180)).toEqual({ N: false, E: false, S: true, W: false });
    expect(solidEdges('wall', 270)).toEqual({ N: false, E: false, S: false, W: true });
  });

  it('wall_edge shares the wall_corner edge signature (same convex-L art shape)', () => {
    expect(solidEdges('wall_edge', 0)).toEqual(solidEdges('wall_corner', 0));
  });

  it('wall_damaged matches wall (solid north strip)', () => {
    expect(solidEdges('wall_damaged', 0)).toEqual(solidEdges('wall', 0));
  });

  it('inner_round has no full solid edge at any rotation (quarter-round blob)', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      expect(solidEdges('inner_round', rot)).toEqual({ N: false, E: false, S: false, W: false });
    }
  });
});

describe('solidQuadrants', () => {
  it('inner_round@0 places its blob ONLY in the NW quadrant (low threshold)', () => {
    // ~9% of the tile — below the default 0.5, visible at 0.2.
    expect(solidQuadrants('inner_round', 0, 0.2)).toEqual({
      NE: false,
      SE: false,
      SW: false,
      NW: true,
    });
    expect(solidQuadrants('inner_round', 0, 0.5)).toEqual({
      NE: false,
      SE: false,
      SW: false,
      NW: false,
    });
  });

  it('inner_round@180 moves the blob to SE (concave cap rotation)', () => {
    expect(solidQuadrants('inner_round', 180, 0.2)).toEqual({
      NE: false,
      SE: true,
      SW: false,
      NW: false,
    });
  });

  it('wall_corner@0 leaves exactly the SE quadrant open (arms N+W)', () => {
    expect(solidQuadrants('wall_corner', 0)).toEqual({
      NE: true,
      SE: false,
      SW: true,
      NW: true,
    });
  });

  it('wall_curve@0 is a thick NE->SW diagonal band, not a concave cap', () => {
    // Solid mass in the NE and SW quadrants only — a diagonal strip, NOT the
    // single-quadrant concave cap the destructible inner_corner role wants
    // (research D6: atlas role mismatch, inner_round-shaped role served a
    // wall_curve-shaped frame).
    expect(solidQuadrants('wall_curve', 0)).toEqual({
      NE: true,
      SE: false,
      SW: true,
      NW: false,
    });
  });
});

describe('edgeBand', () => {
  it('wall@0: N band solid, S band fully transparent', () => {
    expect(edgeBand('wall', 0, 'N').every((v) => v >= 0.5)).toBe(true);
    expect(edgeBand('wall', 0, 'S').every((v) => v === 0)).toBe(true);
  });

  it('wall@0: W and E bands are top-heavy (strip rows only)', () => {
    const w = edgeBand('wall', 0, 'W');
    expect(w.slice(0, 3).every((v) => v >= 0.5)).toBe(true);
    expect(w.slice(3).every((v) => v === 0)).toBe(true);
  });

  it('orientedShape(90) equals rotateShapeBy90s(shapeGrid, 90)', () => {
    expect(orientedShape('inner_round', 90)).toEqual(
      rotateShapeBy90s(shapeGrid('inner_round'), 90),
    );
  });
});

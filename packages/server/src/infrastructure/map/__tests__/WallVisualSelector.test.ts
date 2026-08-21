/**
 * WallVisualSelector seam tests (map-polish tickets 12 + 13).
 *
 * Ticket 12 extracted wall visual selection out of `SeedMapAdapter.buildWallLayer`
 * as a no-behavior-change prefactor. Ticket 13 CHANGED the behavior by design
 * (thick-aware facing, run-consistency repair, `wall_fill` layer, the D6
 * `wall_edge` remap) — the legacy byte-identical replay pins are gone; this
 * suite now pins the ticket-13 CONTRACT:
 *
 *   - determinism (ADR 0035): selection + fill are pure functions of the grid
 *     (no RNG, no positional `%20` inputs);
 *   - the facing MODES (`open` / `run` / `partner`) are derived from the wall
 *     topology, not from map position — the two behaviors the deleted `%20`
 *     heuristic used to encode (border-facing vs junction-facing) are
 *     re-expressed by explicit topology tests;
 *   - `buildWallRoleSpriteMap` resolves the destructible `inner_corner` to
 *     `wall_edge` (D6: `wall_curve` is a thick diagonal, shape-incompatible
 *     with a concave cap);
 *   - the fill frame resolution is a deterministic existing-atlas
 *     `TileType.EMPTY` frame.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  MapGenerator,
  TileType,
  edgeBand,
  solidQuadrants,
  SOLID_THRESHOLD,
  type EnrichedMapData,
} from '@sector-battle/shared';
import { WallOrientationDetector } from '../WallOrientationDetector.ts';
import { WALL_MASK_BITS } from '../WallMaskClassifier.ts';
import { orientedOuterCornerRotation, QUADRANT_ROTATION } from '../WallVisualSelectorCorners.ts';
import {
  buildWallRoleSpriteMap,
  resolveWallFillSprite,
  selectWallFill,
  selectWallVisuals,
  type WallRoleSpriteMaps,
} from '../WallVisualSelector.ts';
import { SeedMapAdapter } from '../SeedMapAdapter.ts';
import { loadEnvAtlas, loadEnvWallBuckets } from './helpers/wallTestAtlas.ts';

const TILED_DIR = resolve(__dirname, '../../../../../../tiled');
const SEEDS = [1, 42, 12345, 0xdeadbeef];

const envAtlas = loadEnvAtlas();
const buckets = loadEnvWallBuckets();
const fillSprite = resolveWallFillSprite(envAtlas);
const detector = new WallOrientationDetector();

// ── fixtures ──────────────────────────────────────────────────────────────────

const generator = new MapGenerator();
const adapter = new SeedMapAdapter();

const adapted = new Map<number, EnrichedMapData>();
for (const seed of SEEDS) {
  adapted.set(seed, adapter.adapt(generator.generate(seed), seed, TILED_DIR));
}

const layerOf = (enriched: EnrichedMapData, name: string) =>
  enriched.visualLayers.find((l) => l.name === name)!;

/** The adapter's exact role maps, rebuilt through the exported builder. */
function adapterRoleMaps(): WallRoleSpriteMaps {
  return {
    indestructible: buildWallRoleSpriteMap(buckets.wall),
    destructible: buildWallRoleSpriteMap(buckets.destructibleWall),
  };
}

const imagePathById = new Map(envAtlas.sprites.map((s) => [s.id, s.imagePath]));

// ── determinism (ADR 0035) ────────────────────────────────────────────────────

describe('selectWallVisuals + selectWallFill — determinism', () => {
  it('are pure: identical inputs produce identical outputs (with and without fill data)', () => {
    const enriched = adapted.get(12345)!;
    const orientations = detector.detect(enriched.grid);
    const roleMaps = adapterRoleMaps();
    const fill = selectWallFill(enriched.grid, orientations, fillSprite);
    expect(selectWallVisuals(enriched.grid, orientations, roleMaps, { fillCells: fill })).toEqual(
      selectWallVisuals(enriched.grid, orientations, roleMaps, { fillCells: fill }),
    );
    expect(selectWallVisuals(enriched.grid, orientations, roleMaps)).toEqual(
      selectWallVisuals(enriched.grid, orientations, roleMaps),
    );
    expect(selectWallFill(enriched.grid, orientations, fillSprite)).toEqual(
      selectWallFill(enriched.grid, orientations, fillSprite),
    );
  });

  it('consult no RNG: a throwing Math.random spy never fires during selection or fill', () => {
    const enriched = adapted.get(42)!;
    const orientations = detector.detect(enriched.grid);
    const roleMaps = adapterRoleMaps();
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('wall selection must not call Math.random');
    });
    try {
      const fill = selectWallFill(enriched.grid, orientations, fillSprite);
      const cells = selectWallVisuals(enriched.grid, orientations, roleMaps, {
        fillCells: fill,
      });
      expect(cells.length).toBe(enriched.grid.length);
      expect(fill.length).toBe(enriched.grid.length);
    } finally {
      spy.mockRestore();
    }
  });

  it('delegate: the adapter layers equal the exported pure functions for every seed', () => {
    for (const seed of SEEDS) {
      const enriched = adapted.get(seed)!;
      const orientations = detector.detect(enriched.grid);
      const fill = selectWallFill(enriched.grid, orientations, fillSprite);
      expect(
        selectWallVisuals(enriched.grid, orientations, adapterRoleMaps(), { fillCells: fill }),
      ).toEqual(layerOf(enriched, 'map_border_walls').cells);
      expect(fill).toEqual(layerOf(enriched, 'wall_fill').cells);
    }
  });
});

// ── the deleted %20 heuristic, re-expressed as topology rules ─────────────────

describe('facing modes are topology-derived (the %20 heuristic is gone)', () => {
  const roleMaps = adapterRoleMaps();

  function singleWallCellRot(grid: string[], row: number, col: number): number {
    const tileGrid = grid.map((r) =>
      r.split('').map((ch) => (ch === '#' ? TileType.INDESTRUCTIBLE_WALL : TileType.EMPTY)),
    );
    const masks = detector.detect(tileGrid);
    const fill = selectWallFill(tileGrid, masks, fillSprite);
    const cells = selectWallVisuals(tileGrid, masks, roleMaps, { fillCells: fill });
    return cells[row]![col]!.rotation;
  }

  it('world-edge ring tile (wall behind is off-map) keeps the demo border facing: faces its open cardinal', () => {
    // Row 0 triple '###.': the middle tile has W+E walls, N is off-map (wall),
    // S open. Its only open cardinal is S and the wall "behind" (N) is
    // off-map → 'open' mode → the strip faces S (rot 180), like the demo ring.
    expect(singleWallCellRot(['###.', '....', '....', '....'], 0, 1)).toBe(180);
  });

  it('the SAME mask topology placed interior (wall behind in-grid) presents to its floor pocket', () => {
    // Identical neighbourhood (walls N/E/W, open S), but the N wall is a real
    // in-grid tile → the cell is wall_fill-covered (1-open + in-grid wall
    // behind) → ticket 27 render truth: the strip presents toward the lone
    // open cardinal S (rot 180) — the demo-ring convention; the fill carries
    // the seam behind it. The historical axis rule (rot 0) drew the bar into
    // the mass; that reading survives only for UNFILLED destructible run
    // cells (the D3 compromise — see the destructible partner test below).
    expect(singleWallCellRot(['....', '.#..', '###.', '....'], 2, 1)).toBe(180);
  });

  it('a destructible tile backed by a destructible wall faces INTO it (partner) — the unfillable seam', () => {
    // '.#D#.' over '..D..': the D tile has walls W/E and a DESTRUCTIBLE wall
    // behind (S) → partner mode → the full strip band lands on the shared
    // edge (rot 180). The indestructible # tiles hug a D neighbour, so they
    // are fill-bridged (the fill carries the seam from their side).
    const tileGrid = ['.....', '.#D#.', '..D..', '.....'].map((r) =>
      r
        .split('')
        .map((ch) =>
          ch === 'D'
            ? TileType.DESTRUCTIBLE_WALL
            : ch === '#'
              ? TileType.INDESTRUCTIBLE_WALL
              : TileType.EMPTY,
        ),
    );
    const masks = detector.detect(tileGrid);
    const fill = selectWallFill(tileGrid, masks, fillSprite);
    const cells = selectWallVisuals(tileGrid, masks, adapterRoleMaps(), { fillCells: fill });
    expect(cells[1]![2]!.rotation).toBe(180);
    // Destructible walls are NEVER filled (a destroyed wall must not leave
    // baked fill behind) — while the flanking indestructible tiles are.
    expect(fill[1]![2]).toBeNull();
    expect(fill[1]![1]).not.toBeNull();
    expect(fill[1]![3]).not.toBeNull();
  });
});

// ── fill sprite resolution ────────────────────────────────────────────────────

describe('resolveWallFillSprite', () => {
  it('resolves an EXISTING TileType.EMPTY-typed opaque frame from the real atlas', () => {
    expect(fillSprite).not.toBeNull();
    expect(fillSprite!.tileType).toBe(TileType.EMPTY);
    expect(['tiles_center', 'tile', 'tiles', 'tiles_cracked', 'tiles_corner']).toContain(
      fillSprite!.imagePath,
    );
  });

  it('falls back to any EMPTY-typed frame, then null', () => {
    const onlyOne = envAtlas.sprites.filter((s) => s.tileType === TileType.EMPTY).slice(0, 1);
    const resolved = resolveWallFillSprite({ sprites: onlyOne });
    expect(resolved?.tileType).toBe(TileType.EMPTY);
    expect(resolveWallFillSprite({ sprites: [] })).toBeNull();
  });
});

// ── role → sprite resolution (D6 flip) ────────────────────────────────────────

describe('buildWallRoleSpriteMap — role → sprite resolution', () => {
  it('resolves the indestructible material canonically (wall/wall_corner/inner_round/wall_diagonal)', () => {
    const map = buildWallRoleSpriteMap(buckets.wall);
    expect(map.get('straight')!.imagePath).toBe('wall');
    expect(map.get('isolated')!.imagePath).toBe('wall');
    expect(map.get('endcap')!.imagePath).toBe('wall');
    expect(map.get('cross')!.imagePath).toBe('wall');
    expect(map.get('t_junction')!.imagePath).toBe('wall');
    expect(map.get('outer_corner')!.imagePath).toBe('wall_corner');
    expect(map.get('inner_corner')!.imagePath).toBe('inner_round');
    expect(map.get('diagonal')!.imagePath).toBe('wall_diagonal');
  });

  it('resolves the destructible material canonically — inner_corner now wall_edge (ticket 13 / D6: wall_curve is a thick diagonal, never a concave cap)', () => {
    const map = buildWallRoleSpriteMap(buckets.destructibleWall);
    expect(map.get('straight')!.imagePath).toBe('wall_damaged');
    expect(map.get('outer_corner')!.imagePath).toBe('wall_edge');
    // D6 flip: the destructible inner_corner NO LONGER resolves to wall_curve.
    expect(map.get('inner_corner')!.imagePath).toBe('wall_edge');
    expect(map.get('inner_corner')!.imagePath).not.toBe('wall_curve');
    // Ticket 20 (W1c): the destructible DIAGONAL now resolves to wall_curve —
    // an existing DESTRUCTIBLE-typed thick NE↔SW diagonal, shape-perfect for
    // a 45° breakable run (the historical wall_damaged strip connected to
    // nothing). It was only ever rejected for the inner-CORNER role.
    expect(map.get('diagonal')!.imagePath).toBe('wall_curve');
  });

  it('falls back to the straight sprite, then the first sprite, when preferred paths are absent', () => {
    const onlyPlain = buckets.wall.filter((s) => s.imagePath === 'wall');
    const map = buildWallRoleSpriteMap(onlyPlain);
    expect(map.get('outer_corner')!.imagePath).toBe('wall'); // no corner → straight
    const exotic = buckets.wall.filter((s) => s.imagePath === 'wall_diagonal');
    const map2 = buildWallRoleSpriteMap(exotic);
    expect(map2.get('straight')!.imagePath).toBe('wall_diagonal'); // no straight → first
  });
});

// ── client-path data contract on the emitted layers ───────────────────────────

describe('emitted layers satisfy the client collision/entity path contract', () => {
  it('getWallVisualAt semantics: on every DESTRUCTIBLE cell the first non-EMPTY-typed visual resolves to map_border_walls art', () => {
    for (const seed of SEEDS) {
      const enriched = adapted.get(seed)!;
      const layers = enriched.visualLayers;
      let destructibleCells = 0;
      for (let r = 0; r < enriched.height; r++) {
        for (let c = 0; c < enriched.width; c++) {
          if (enriched.grid[r]![c] !== TileType.DESTRUCTIBLE_WALL) continue;
          destructibleCells++;
          // Mirror of MapRenderer.getWallVisualAt: first layer whose cell has a
          // non-EMPTY tileType wins.
          let resolved = -1;
          for (const layer of layers) {
            const cell = layer.cells[r]![c];
            if (!cell) continue;
            const def = enriched.atlas.sprites[cell.spriteId]!;
            if (def.tileType === TileType.EMPTY) continue;
            resolved = cell.spriteId;
            break;
          }
          expect(resolved, `seed ${seed} (${r},${c}) entity wall path`).toBeGreaterThanOrEqual(0);
          // Destructible wall art: the strip, the L piece (corner-readings /
          // D6 remap / ticket-20 corner-dangling hugs) or the thick diagonal
          // (ticket-20 W1c: 45° breakable runs) — never a floor/fill frame.
          expect(['wall_damaged', 'wall_edge', 'wall_curve']).toContain(
            imagePathById.get(resolved),
          );
        }
      }
      expect(destructibleCells).toBeGreaterThan(0);
    }
  });

  it('checkCellCollider semantics: no layer places a non-EMPTY-typed cell on a walkable EMPTY tile', () => {
    // The fill layer must not change collision: fill cells are EMPTY-typed
    // (already asserted in WallContinuityGate) AND only appear where another
    // layer already carries the authoritative wall cell above them.
    for (const seed of SEEDS) {
      const enriched = adapted.get(seed)!;
      const wallLayer = layerOf(enriched, 'map_border_walls');
      const fillLayer = layerOf(enriched, 'wall_fill');
      for (let r = 0; r < enriched.height; r++) {
        for (let c = 0; c < enriched.width; c++) {
          if (!fillLayer.cells[r]![c]) continue;
          expect(
            wallLayer.cells[r]![c],
            `fill at (${r},${c}) must be shadowed by a wall cell`,
          ).not.toBeNull();
        }
      }
    }
  });
});

// ── ticket 23: corner-orientation ground truth ───────────────────────────────

describe('corner orientation model (ticket 23) — elbow/blob ON the floor-side quadrant', () => {
  const B = WALL_MASK_BITS;
  const m = (...dirs: (keyof typeof B)[]): number => dirs.reduce((acc, d) => acc | B[d], 0);

  it('QUADRANT_ROTATION puts each NW-anchored solid feature on its quadrant (art-shape proof)', () => {
    const QUADRANTS = ['NW', 'NE', 'SE', 'SW'] as const;
    const OPPOSITE = { NW: 'SE', NE: 'SW', SE: 'NW', SW: 'NE' } as const;
    for (const q of QUADRANTS) {
      const rot = QUADRANT_ROTATION[q];
      // Convex L frames: the elbow quadrant is solid, the opposite quadrant
      // transparent (the transparent remainder points into the wall mass).
      for (const frame of ['wall_corner', 'wall_edge']) {
        const solid = solidQuadrants(frame, rot);
        expect(solid[q], `${frame}@${rot} elbow must solidify ${q}`).toBe(true);
        expect(solid[OPPOSITE[q]], `${frame}@${rot} opposite quadrant must stay open`).toBe(false);
      }
      // Concave cap: the blob quadrant is solid (threshold 0.2 — the blob is
      // a quarter-round, ~9% of the tile).
      const blob = solidQuadrants('inner_round', rot, 0.2);
      expect(blob[q], `inner_round@${rot} blob must sit on ${q}`).toBe(true);
      expect(blob[OPPOSITE[q]], `inner_round@${rot} opposite quadrant must stay open`).toBe(false);
    }
  });

  it('orientedOuterCornerRotation: open-quadrant table + non-corner masks return null', () => {
    // Clean convex corners: open cardinals → the quadrant between them.
    expect(orientedOuterCornerRotation(m('N', 'W', 'NW'))).toBe(180); // open E+S → SE
    expect(orientedOuterCornerRotation(m('E', 'S', 'SE'))).toBe(0); // open N+W → NW
    expect(orientedOuterCornerRotation(m('N', 'E', 'NE'))).toBe(270); // open S+W → SW
    expect(orientedOuterCornerRotation(m('S', 'W', 'SW'))).toBe(90); // open N+E → NE
    // Not a 2-adjacent-open topology:
    expect(orientedOuterCornerRotation(m('E', 'W'))).toBeNull(); // opposite open (straight)
    expect(orientedOuterCornerRotation(m('NE'))).toBeNull(); // zero wall cardinals (dangling)
    expect(orientedOuterCornerRotation(0)).toBeNull(); // isolated
  });

  it('convex mass corner: every corner cell of a 2x2 block caps the block OUTER corner (no pin-wheel)', () => {
    // The four Ls must render a solid FRAME: each corner's transparent
    // quadrant points INTO the block (its solid elbow is the block's outer
    // corner), i.e. the open quadrant of the mask is the SOLID elbow.
    const tileGrid = ['....', '.##.', '.##.', '....'].map((r) =>
      r.split('').map((ch) => (ch === '#' ? TileType.INDESTRUCTIBLE_WALL : TileType.EMPTY)),
    );
    const masks = detector.detect(tileGrid);
    const cells = selectWallVisuals(tileGrid, masks, adapterRoleMaps());
    const corners: Array<[number, number, 'NW' | 'NE' | 'SE' | 'SW']> = [
      [1, 1, 'NW'],
      [1, 2, 'NE'],
      [2, 1, 'SW'],
      [2, 2, 'SE'],
    ];
    for (const [r, c, openQ] of corners) {
      const cell = cells[r]![c]!;
      const path = imagePathById.get(cell.spriteId)!;
      expect(path, `(${r},${c}) block corner frame`).toBe('wall_corner');
      expect(
        solidQuadrants(path, cell.rotation)[openQ],
        `(${r},${c}) wall_corner@${cell.rotation} elbow must cap the outer ${openQ} corner`,
      ).toBe(true);
    }
    // And the pin-specific rotations (the repair pass never touches filled cells).
    expect(cells[1]![1]!.rotation).toBe(0);
    expect(cells[1]![2]!.rotation).toBe(90);
    expect(cells[2]![1]!.rotation).toBe(270);
    expect(cells[2]![2]!.rotation).toBe(180);
  });

  it('concave pocket: the destructible wall_edge cap hugs the floor pocket (no +180 counter-rotation)', () => {
    // All four cardinals walled, lone floor pocket at NE — the cap's elbow
    // sits ON the pocket (INNER_ROTATION[NE]=90), like the demo's
    // inner_round corners; the historical +180 put the transparent quadrant
    // toward the pocket.
    const tileGrid = ['##..', '#D##', '####'].map((r) =>
      r
        .split('')
        .map((ch) =>
          ch === 'D'
            ? TileType.DESTRUCTIBLE_WALL
            : ch === '#'
              ? TileType.INDESTRUCTIBLE_WALL
              : TileType.EMPTY,
        ),
    );
    const masks = detector.detect(tileGrid);
    const cells = selectWallVisuals(tileGrid, masks, adapterRoleMaps());
    const cell = cells[1]![1]!;
    expect(imagePathById.get(cell.spriteId)).toBe('wall_edge');
    expect(cell.rotation).toBe(90);
    expect(solidQuadrants('wall_edge', 90).NE).toBe(true);
  });

  it('thin clean L-corner: the L traces the arms band contour and connects to both (repair-pass agreement)', () => {
    const tileGrid = ['.....', '.###.', '.#...', '.#...'].map((r) =>
      r.split('').map((ch) => (ch === '#' ? TileType.INDESTRUCTIBLE_WALL : TileType.EMPTY)),
    );
    const masks = detector.detect(tileGrid);
    const fill = selectWallFill(tileGrid, masks, fillSprite);
    const cells = selectWallVisuals(tileGrid, masks, adapterRoleMaps(), { fillCells: fill });
    const corner = cells[1]![1]!;
    expect(imagePathById.get(corner.spriteId)).toBe('wall_corner');
    // Round 5e: the arms FOLLOW the corner (vertical arm faces W, horizontal
    // arm N), so the provisional QUADRANT_ROTATION[NW]=0 elbow band-connects
    // BOTH arms directly — the repair pass no longer rotates the corner onto
    // a mismatched contour (the old pin 90 was the tie-break-facing-arms
    // compromise).
    expect(corner.rotation).toBe(0);
    const shares = (dir: 'N' | 'E' | 'S' | 'W', other: { r: number; c: number }): boolean => {
      const theirSide = dir === 'N' ? 'S' : dir === 'S' ? 'N' : dir === 'E' ? 'W' : 'E';
      const n = cells[other.r]![other.c]!;
      const mine = edgeBand('wall_corner', corner.rotation, dir);
      const theirs = edgeBand(imagePathById.get(n.spriteId)!, n.rotation, theirSide);
      return mine.some((v, i) => v >= SOLID_THRESHOLD && theirs[i]! >= SOLID_THRESHOLD);
    };
    expect(shares('E', { r: 1, c: 2 }), 'corner must band-connect the horizontal arm').toBe(true);
    expect(shares('S', { r: 2, c: 1 }), 'corner must band-connect the vertical arm').toBe(true);
  });
});

// Keep the Math.random spy lifecycle honest even if the suite grows.
afterAll(() => vi.restoreAllMocks());

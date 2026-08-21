import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyWall,
  WALL_MASK_BITS,
  type WallRole,
  type WallTileChoice,
} from '../WallMaskClassifier.ts';

// Resolve the repo-root `tiled/` directory exactly as the existing e2e test does.
const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

// ─────────────────────────────────────────────────────────────────────────────
// Tiled flip-bit decoding — mirrored verbatim from the (module-private) helpers
// in `infrastructure/parsers/TmxParser.ts` so emitted transforms line up with
// the authored tiles. These are intentionally NOT imported from TmxParser
// (exporting them is out of scope for this task); they are replicated here.
// ─────────────────────────────────────────────────────────────────────────────

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const FLIP_MASK = FLIP_H | FLIP_V | FLIP_D;
const GID_MASK = ~FLIP_MASK & 0x1fffffff;

interface DecodedGid {
  gid: number;
  flipH: boolean;
  flipV: boolean;
  flipD: boolean;
}

/** Mirror of TmxParser.decodeGid. */
function decodeGid(raw: number): DecodedGid {
  return {
    gid: raw & GID_MASK,
    flipH: (raw & FLIP_H) !== 0,
    flipV: (raw & FLIP_V) !== 0,
    flipD: (raw & FLIP_D) !== 0,
  };
}

interface AuthoredTransform {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

/** Mirror of TmxParser.computeTileTransform. */
function computeTileTransform(flipH: boolean, flipV: boolean, flipD: boolean): AuthoredTransform {
  if (flipH && flipV && flipD) return { rotation: 90, flipH: true, flipV: false };
  if (flipH && flipV) return { rotation: 180, flipH: false, flipV: false };
  if (flipH && flipD) return { rotation: 90, flipH: false, flipV: false };
  if (flipV && flipD) return { rotation: 270, flipH: false, flipV: false };
  if (flipH) return { rotation: 0, flipH: true, flipV: false };
  if (flipV) return { rotation: 0, flipH: false, flipV: true };
  if (flipD) return { rotation: 90, flipH: false, flipV: true };
  return { rotation: 0, flipH: false, flipV: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo map / tileset parsing (test-local; we only need the wall layer + which
// env tile id each authored GID points at, and which sprite role it represents).
// ─────────────────────────────────────────────────────────────────────────────

const WIDTH = 22;
const HEIGHT = 22;

/** env.tsx wall tile id (firstgid=1 ⇒ tile id = gid - 1) → autotiler role. */
const ROLE_BY_TILE_ID: Record<number, WallRole> = {
  39: 'straight', // wall.png  (straight, top-strip collider)
  40: 'outer_corner', // wall_corner.png  (convex L)
  16: 'inner_corner', // inner_round.png  (concave corner)
};

function readBorderLayer(): number[] {
  const tmx = readFileSync(resolve(TILED_DIR, 'demo_map.tmx'), 'utf-8');
  const match = tmx.match(/name="map_border_walls"[\s\S]*?<data encoding="csv">([\s\S]*?)<\/data>/);
  if (!match) throw new Error('map_border_walls layer not found in demo_map.tmx');
  return match[1]!
    .trim()
    .split(',')
    .map((v) => parseInt(v.trim(), 10));
}

/**
 * Wall/open grid: a cell is wall-like if the author placed any tile there.
 * The demo border is the edge of the world, so out-of-bounds reads as wall —
 * which makes each authored neighbourhood a pure function of the local mask.
 */
function makeWallAt(raw: number[]) {
  return (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return true; // off-map = wall
    return raw[y * WIDTH + x] !== 0;
  };
}

/** Build the 8-neighbour mask in WallMaskClassifier's bit order. */
function maskAt(wallAt: (x: number, y: number) => boolean, x: number, y: number): number {
  let mask = 0;
  if (wallAt(x, y - 1)) mask |= WALL_MASK_BITS.N;
  if (wallAt(x + 1, y - 1)) mask |= WALL_MASK_BITS.NE;
  if (wallAt(x + 1, y)) mask |= WALL_MASK_BITS.E;
  if (wallAt(x + 1, y + 1)) mask |= WALL_MASK_BITS.SE;
  if (wallAt(x, y + 1)) mask |= WALL_MASK_BITS.S;
  if (wallAt(x - 1, y + 1)) mask |= WALL_MASK_BITS.SW;
  if (wallAt(x - 1, y)) mask |= WALL_MASK_BITS.W;
  if (wallAt(x - 1, y - 1)) mask |= WALL_MASK_BITS.NW;
  return mask;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fidelity test — every authored demo wall cell must match classifyWall.
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyWall — demo map fidelity', () => {
  it('reproduces every authored wall tile in map_border_walls', () => {
    const raw = readBorderLayer();
    const wallAt = makeWallAt(raw);

    let checked = 0;
    const mismatches: string[] = [];

    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const cellRaw = raw[y * WIDTH + x]!;
        if (cellRaw === 0) continue; // empty (door gap) — no authored tile

        const decoded = decodeGid(cellRaw);
        const tileId = decoded.gid - 1; // firstgid = 1
        const expectedRole = ROLE_BY_TILE_ID[tileId];
        if (expectedRole === undefined) continue; // not a classified wall sprite

        // Expected transform is DERIVED from the authored flip bits, not guessed.
        const expectedTf = computeTileTransform(decoded.flipH, decoded.flipV, decoded.flipD);

        const got = classifyWall(maskAt(wallAt, x, y));
        checked++;

        const ok =
          got.role === expectedRole &&
          got.rotation === expectedTf.rotation &&
          got.flipH === expectedTf.flipH &&
          got.flipV === expectedTf.flipV;

        if (!ok) {
          mismatches.push(
            `(${x},${y}) mask=${maskAt(wallAt, x, y)} ` +
              `authored={${expectedRole}, rot${expectedTf.rotation}, fH${expectedTf.flipH}, fV${expectedTf.flipV}} ` +
              `got={${got.role}, rot${got.rotation}, fH${got.flipH}, fV${got.flipV}}`,
          );
        }
      }
    }

    // The demo border has 80 authored wall tiles (22×22 ring minus 4 door gaps).
    expect(checked).toBe(80);
    expect(mismatches).toEqual([]);
  });

  it('reproduces the four border corners as concave inner_round', () => {
    // A room-border corner is concave from the floor side, so the author used
    // inner_round (tile 16), NOT wall_corner. Each corner has its two wall arms
    // running along the ring with interior floor on the diagonal between them.
    const raw = readBorderLayer();
    const wallAt = makeWallAt(raw);

    // top-left (0,0): arms run E and S, floor to the SE → inner facing SE → rot180.
    expect(classifyWall(maskAt(wallAt, 0, 0))).toEqual({
      role: 'inner_corner',
      rotation: 180,
      flipH: false,
      flipV: false,
    });
    // top-right (21,0): floor to the SW → rot270.
    expect(classifyWall(maskAt(wallAt, 21, 0))).toEqual({
      role: 'inner_corner',
      rotation: 270,
      flipH: false,
      flipV: false,
    });
    // bottom-left (0,21): floor to the NE → rot90.
    expect(classifyWall(maskAt(wallAt, 0, 21))).toEqual({
      role: 'inner_corner',
      rotation: 90,
      flipH: false,
      flipV: false,
    });
    // bottom-right (21,21): floor to the NW → rot0 (the base orientation).
    expect(classifyWall(maskAt(wallAt, 21, 21))).toEqual({
      role: 'inner_corner',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extrapolated maze-interior cases the demo never shows — asserted by hand
// reasoning (documented inline). Mask bits use the exported WALL_MASK_BITS.
// ─────────────────────────────────────────────────────────────────────────────

const B = WALL_MASK_BITS;
const m = (...dirs: (keyof typeof B)[]): number => dirs.reduce((acc, d) => acc | B[d], 0);

describe('classifyWall — extrapolated cases (hand-reasoned)', () => {
  it('outer/convex corner: wall mass to the N+W, floor wraps the SE outside', () => {
    // The wall block occupies this cell + its N, W and NW neighbours. Floor is
    // open on E and S, and ALL three diagonals on the open side (NE, SE, SW) are
    // floor too, so it is a clean convex corner. wall_corner base opens to SE at
    // rot0, and the open quadrant here is SE → rotation 0.
    expect(classifyWall(m('N', 'W', 'NW'))).toEqual({
      role: 'outer_corner',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  it('inner/concave corner: all cardinals walled, only the SE diagonal is floor', () => {
    // Three quadrants are wall, the SE pocket is the lone floor. inner_round base
    // opens to NW at rot0; open quadrant SE → rotation 180.
    const allButSE = 255 & ~B.SE;
    expect(classifyWall(allButSE)).toEqual({
      role: 'inner_corner',
      rotation: 180,
      flipH: false,
      flipV: false,
    });
  });

  it('T-junction stem renders as a straight (no dedicated T sprite in env.tsx)', () => {
    // A T-stem: floor on the single open cardinal (S here), walls on N, E, W and
    // their inner diagonals. With this tileset that is faithfully a `wall`
    // straight facing the open side (exactly what the demo does for 1-open-face
    // cells). Face = S → rotation 180.
    expect(classifyWall(m('N', 'NE', 'E', 'W', 'NW'))).toEqual({
      role: 'straight',
      rotation: 180,
      flipH: false,
      flipV: false,
    });
  });

  it('cross: a 1-tile-thick wall + junction (all cardinals wall, all diagonals floor)', () => {
    // Four wall arms meet at this cell; every diagonal is open floor. No single
    // open-facing corner exists, so it is the symmetric cross piece (rotation 0).
    expect(classifyWall(m('N', 'E', 'S', 'W'))).toEqual({
      role: 'cross',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  it('cross: a fully buried interior wall (all eight neighbours wall)', () => {
    // No exposed face at all → cross / interior (rotation 0).
    expect(classifyWall(255)).toEqual({
      role: 'cross',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  it('isolated: a lone pillar with floor on every side', () => {
    expect(classifyWall(0)).toEqual({
      role: 'isolated',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  it('endcap: a wall stub connected only to the South', () => {
    // Only the S neighbour is wall; the wall runs vertically (N-S). Straight
    // segments in a vertical wall face E (rot90). The endcap matches so the
    // wall strip continues through the cap instead of breaking perpendicular.
    expect(classifyWall(m('S'))).toEqual({
      role: 'endcap',
      rotation: 90,
      flipH: false,
      flipV: false,
    });
  });

  it('diagonal run: wall continues along the NW–SE axis with open cardinals', () => {
    // The wall chain runs corner-to-corner (NW and SE neighbours are wall, all
    // cardinals open) → a 45° wall_diagonal piece. NW–SE alignment → rotation 0.
    expect(classifyWall(m('NW', 'SE'))).toEqual({
      role: 'diagonal',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  });

  it('diagonal run: the NE–SW alignment uses rotation 90', () => {
    expect(classifyWall(m('NE', 'SW'))).toEqual({
      role: 'diagonal',
      rotation: 90,
      flipH: false,
      flipV: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Total-function / determinism guarantees over all 256 masks.
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyWall — totality and determinism', () => {
  it('returns a valid WallTileChoice for every one of the 256 masks', () => {
    for (let mask = 0; mask < 256; mask++) {
      const c: WallTileChoice = classifyWall(mask);
      expect([0, 90, 180, 270]).toContain(c.rotation);
      expect(typeof c.flipH).toBe('boolean');
      expect(typeof c.flipV).toBe('boolean');
      expect([
        'straight',
        'outer_corner',
        'inner_corner',
        't_junction',
        'cross',
        'endcap',
        'isolated',
        'diagonal',
      ]).toContain(c.role);
    }
  });

  it('is a pure function: identical mask ⇒ identical output', () => {
    for (let mask = 0; mask < 256; mask++) {
      expect(classifyWall(mask)).toEqual(classifyWall(mask));
    }
  });

  it('exposes the bit order as N, NE, E, SE, S, SW, W, NW = 1,2,4,8,16,32,64,128', () => {
    expect(WALL_MASK_BITS).toEqual({
      N: 1,
      NE: 2,
      E: 4,
      SE: 8,
      S: 16,
      SW: 32,
      W: 64,
      NW: 128,
    });
  });
});

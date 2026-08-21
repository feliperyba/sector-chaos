/**
 * Wall RENDER-TRUTH regression (map-polish ticket 27) — the seam that would
 * have caught the straight-run inversion the model-based suites green-lit.
 *
 * The wall suites prior to this ticket verified rotations against the repo's
 * own shape model (`rotateShapeBy90s`/`orientedShape`) — a self-referential
 * oracle that cannot see a convention-level inversion (the model and the
 * selector shared the same wrong assumption, so every test passed while the
 * rendered map was wrong). This suite replaces that trust with PIXELS:
 *
 *   1. The shipped atlas art (`packages/client-v3/public/assets/game.png`,
 *      frame rects from `game.json`) is decoded and each wall frame's alpha
 *      coverage is re-derived — no WALL_ART_SHAPES, no shape-model helpers.
 *   2. The EXACT production transform chain is replicated: parser flip-bit
 *      translation (`TmxParser.computeTileTransform`) → `TileVisual` → the
 *      client bake (`MapRenderer` ~:406 `setRotation(deg→rad)` + flip via
 *      `setScale(±1)`, Phaser `applyITRS` local matrix R(θ)·diag(sx,sy) —
 *      the flip scales the local point FIRST, the clockwise rotation is
 *      applied SECOND; tile center, origin 0.5).
 *   3. A CANONICAL Tiled-spec decode (gid flags 0x80000000/0x40000000/
 *      0x20000000, point map p' = H·V·D·p) cross-oracles the repo chain on
 *      every flip combination.
 *   4. The artist-authored demo border ring (`tiled/demo_map.tmx`) is the
 *      ground truth: its straight cells' band and its corners' blob must sit
 *      on the FLOOR side. If these assertions fail, the harness chain itself
 *      drifted from the client — fix the chain before touching the selector.
 *   5. The selector is then held to the same truth on the sector-ring
 *      topology (a synthetic 2-thick ring: every face cell's band on its own
 *      floor side, all four sides) and the repair pass is proven unable to
 *      undo it (fill-covered cells are skipped by construction + emitted
 *      rotations equal the provisional floor-facing table).
 *
 * Minimal PNG decoding (IHDR/IDAT/zlib/unfilter) — the atlas is RGBA8,
 * non-interlaced; no new dependencies.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TileType } from '@sector-battle/shared';
import { TsxAtlasParser } from '../../parsers/TsxAtlasParser.ts';
import { WallOrientationDetector } from '../WallOrientationDetector.ts';
import {
  buildWallRoleSpriteMap,
  resolveWallFillSprite,
  selectWallFill,
  selectWallVisuals,
} from '../WallVisualSelector.ts';
import { WALL_MASK_BITS } from '../WallMaskClassifier.ts';

// ── repo-root asset paths (server tests read the shipped client atlas) ───────

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const ATLAS_PNG = resolve(REPO_ROOT, 'packages/client-v3/public/assets/game.png');
const ATLAS_JSON = resolve(REPO_ROOT, 'packages/client-v3/public/assets/game.json');
const DEMO_TMX = resolve(REPO_ROOT, 'tiled/demo_map.tmx');
const ENV_TSX = resolve(REPO_ROOT, 'tiled/env.tsx');

const WALL_FRAMES = [
  'wall',
  'wall_damaged',
  'wall_corner',
  'wall_edge',
  'inner_round',
  'wall_curve',
  'wall_diagonal',
] as const;

// ── minimal PNG decoder (RGBA8, non-interlaced) ──────────────────────────────

function decodePng(path: string): { w: number; h: number; rgba: Uint8Array } {
  const data = readFileSync(path);
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunk = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = chunk.readUInt32BE(0);
      h = chunk.readUInt32BE(4);
      expect(chunk[8], 'atlas must be 8-bit').toBe(8);
      expect(chunk[9], 'atlas must be RGBA').toBe(6);
      expect(chunk[12], 'atlas must be non-interlaced').toBe(0);
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const rgba = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[src++]!;
    for (let i = 0; i < stride; i++) {
      const b = raw[src++]!;
      const a = i >= 4 ? cur[i - 4]! : 0;
      const bb = prev[i]!;
      const c = i >= 4 ? prev[i - 4]! : 0;
      let v: number;
      if (filter === 0) v = b;
      else if (filter === 1) v = b + a;
      else if (filter === 2) v = b + bb;
      else if (filter === 3) v = b + ((a + bb) >> 1);
      else {
        const p = a + bb - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - bb);
        const pc = Math.abs(p - c);
        v = b + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c);
      }
      cur[i] = v & 0xff;
    }
    rgba.set(cur, y * stride);
    const t = prev;
    prev = cur;
    cur = t;
  }
  return { w, h, rgba };
}

interface AtlasJson {
  textures: Array<{
    frames: Array<{
      filename: string;
      rotated: boolean;
      trimmed: boolean;
      frame: { x: number; y: number; w: number };
    }>;
  }>;
}

const PNG = decodePng(ATLAS_PNG);
const ATLAS = JSON.parse(readFileSync(ATLAS_JSON, 'utf-8')) as AtlasJson;

/** 8×8 alpha-coverage grid of one atlas frame, straight from PNG pixels. */
function frameCoverage8(name: string): number[][] {
  const frame = ATLAS.textures[0]!.frames.find((f) => f.filename === name);
  if (!frame) throw new Error(`frame ${name} not in atlas`);
  if (frame.rotated || frame.trimmed) throw new Error(`frame ${name} rotated/trimmed`);
  const cell = frame.frame.w / 8;
  const g: number[][] = [];
  for (let gy = 0; gy < 8; gy++) {
    const row: number[] = [];
    for (let gx = 0; gx < 8; gx++) {
      let sum = 0;
      for (let py = 0; py < cell; py++) {
        for (let px = 0; px < cell; px++) {
          const xx = Math.floor(frame.frame.x + gx * cell + px);
          const yy = Math.floor(frame.frame.y + gy * cell + py);
          sum += PNG.rgba[(yy * PNG.w + xx) * 4 + 3]! / 255;
        }
      }
      row.push(sum / (cell * cell));
    }
    g.push(row);
  }
  return g;
}

// ── the production client chain (MapRenderer + Phaser applyITRS) ─────────────

/**
 * p_world = R(θ)·diag(sx,sy)·p_local — MapRenderer.ts ~:406 sets rotation
 * (deg→rad, clockwise on the Y-down screen) and flips via setScale(±1,±1);
 * Phaser's TransformMatrix.applyITRS composes rotate·scale, i.e. the flip
 * mirrors the local grid FIRST, the clockwise quarter-turns apply SECOND.
 * Implemented as the inverse sample map (per output cell → source cell).
 */
function applyClientTransform(
  grid: number[][],
  rotation: number,
  flipH: boolean,
  flipV: boolean,
): number[][] {
  const n = grid.length;
  const cx = (n - 1) / 2;
  const sx = flipH ? -1 : 1;
  const sy = flipV ? -1 : 1;
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ox = c - cx;
      const oy = r - cx;
      const rx = ox * cos - oy * sin;
      const ry = ox * sin + oy * cos;
      out[r]![c] =
        grid[Math.max(0, Math.min(n - 1, Math.round(ry * sy + cx)))]![
          Math.max(0, Math.min(n - 1, Math.round(rx * sx + cx)))
        ]!;
    }
  }
  return out;
}

/** Repo parser translation, copied VERBATIM from TmxParser.computeTileTransform. */
function computeTileTransform(
  flipH: boolean,
  flipV: boolean,
  flipD: boolean,
): { rotation: 0 | 90 | 180 | 270; flipH: boolean; flipV: boolean } {
  if (flipH && flipV && flipD) return { rotation: 90, flipH: true, flipV: false };
  if (flipH && flipV) return { rotation: 180, flipH: false, flipV: false };
  if (flipH && flipD) return { rotation: 90, flipH: false, flipV: false };
  if (flipV && flipD) return { rotation: 270, flipH: false, flipV: false };
  if (flipH) return { rotation: 0, flipH: true, flipV: false };
  if (flipV) return { rotation: 0, flipH: false, flipV: true };
  if (flipD) return { rotation: 90, flipH: false, flipV: true };
  return { rotation: 0, flipH: false, flipV: false };
}

/**
 * CANONICAL Tiled flip decode, independent of the repo parser: point map
 * p' = H·V·D·p with D = transpose (anti-diagonal flag), V = (x,−y), H = (−x,y)
 * applied to the local tile point (inverse-sampled per output cell).
 */
function applyCanonicalTiledFlips(
  grid: number[][],
  h: boolean,
  v: boolean,
  d: boolean,
): number[][] {
  const n = grid.length;
  const cx = (n - 1) / 2;
  const out: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ox = c - cx;
      const oy = r - cx;
      let x = h ? -ox : ox;
      let y = v ? -oy : oy;
      if (d) [x, y] = [y, x];
      out[r]![c] =
        grid[Math.max(0, Math.min(n - 1, Math.round(y + cx)))]![
          Math.max(0, Math.min(n - 1, Math.round(x + cx)))
        ]!;
    }
  }
  return out;
}

// ── band/blob metrics (local; no shape-model imports) ────────────────────────

type Edge = 'N' | 'E' | 'S' | 'W';
type Quadrant = 'NW' | 'NE' | 'SE' | 'SW';

function edgeMass(g: number[][], edge: Edge, depth = 3): number {
  const n = g.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < depth; d++) {
      if (edge === 'N') sum += g[d]![i]!;
      else if (edge === 'S') sum += g[n - 1 - d]![i]!;
      else if (edge === 'W') sum += g[i]![d]!;
      else sum += g[i]![n - 1 - d]!;
    }
  }
  return sum / (n * depth);
}

function bandEdge(g: number[][]): Edge {
  return (
    [
      ['N', edgeMass(g, 'N')],
      ['E', edgeMass(g, 'E')],
      ['S', edgeMass(g, 'S')],
      ['W', edgeMass(g, 'W')],
    ] as Array<[Edge, number]>
  ).sort((a, b) => b[1] - a[1])[0]![0];
}

function quadrantMass(g: number[][], q: Quadrant): number {
  let sum = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      sum += g[q === 'NW' || q === 'NE' ? r : r + 4]![q === 'NW' || q === 'SW' ? c : c + 4]!;
    }
  }
  return sum / 16;
}

function maxQuadrant(g: number[][]): Quadrant {
  return (
    [
      ['NW', quadrantMass(g, 'NW')],
      ['NE', quadrantMass(g, 'NE')],
      ['SE', quadrantMass(g, 'SE')],
      ['SW', quadrantMass(g, 'SW')],
    ] as Array<[Quadrant, number]>
  ).sort((a, b) => b[1] - a[1])[0]![0];
}

// ── shared pipeline fixtures ─────────────────────────────────────────────────

const envAtlas = new TsxAtlasParser().parse(ENV_TSX);
const imagePathById = new Map(envAtlas.sprites.map((s) => [s.id, s.imagePath]));
const TRAP_IMAGE_PATHS = new Set([
  'trap',
  'trap_door',
  'trapdoor_round',
  'trapdoor_square',
  'wall_trap',
]);
const roleMaps = {
  indestructible: buildWallRoleSpriteMap(
    envAtlas.sprites.filter(
      (s) => s.tileType === TileType.INDESTRUCTIBLE_WALL && !TRAP_IMAGE_PATHS.has(s.imagePath),
    ),
  ),
  destructible: buildWallRoleSpriteMap(
    envAtlas.sprites.filter((s) => s.tileType === TileType.DESTRUCTIBLE_WALL),
  ),
};
const fillSprite = resolveWallFillSprite(envAtlas);
const detector = new WallOrientationDetector();

// ── 1. the art base orientation (anchors every convention below) ─────────────

describe('render truth — atlas art base orientation (pixels, not tables)', () => {
  it('wall@0 carries its solid band on the NORTH edge; inner_round@0 its blob in NW', () => {
    // If the atlas art or frame rects change such that this fails, EVERY
    // rotation convention downstream flips meaning — re-derive before
    // touching any rotation table.
    expect(bandEdge(frameCoverage8('wall'))).toBe('N');
    expect(bandEdge(frameCoverage8('wall_damaged'))).toBe('N');
    expect(maxQuadrant(frameCoverage8('inner_round'))).toBe('NW');
    // The convex L arms hug N+W at rotation 0 (open quadrant SE).
    const corner = frameCoverage8('wall_corner');
    expect(edgeMass(corner, 'N')).toBeGreaterThan(edgeMass(corner, 'S'));
    expect(edgeMass(corner, 'W')).toBeGreaterThan(edgeMass(corner, 'E'));
  });
});

// ── 2. parser chain ≡ canonical Tiled spec (all flip combos) ─────────────────

describe('render truth — repo parser+client chain equals the canonical Tiled flip decode', () => {
  it('all 8 flip-bit combinations × every wall frame produce identical grids', () => {
    for (const name of WALL_FRAMES) {
      const base = frameCoverage8(name);
      for (let mask = 0; mask < 8; mask++) {
        const h = (mask & 1) !== 0;
        const v = (mask & 2) !== 0;
        const d = (mask & 4) !== 0;
        const canonical = applyCanonicalTiledFlips(base, h, v, d);
        const tf = computeTileTransform(h, v, d);
        const viaChain = applyClientTransform(base, tf.rotation, tf.flipH, tf.flipV);
        expect(viaChain, `${name} H=${h} V=${v} D=${d}`).toEqual(canonical);
      }
    }
  });
});

// ── 3. the demo authored ring is the artist's ground truth ───────────────────

describe('render truth — demo border ring (authored GIDs decoded both ways)', () => {
  interface BorderCell {
    frame: string;
    tf: ReturnType<typeof computeTileTransform>;
    h: boolean;
    v: boolean;
    d: boolean;
  }

  function demoBorderCell(r: number, c: number): BorderCell {
    const xml = readFileSync(DEMO_TMX, 'utf-8');
    const m =
      /<layer[^>]*name="map_border_walls"[^>]*width="(\d+)"[^>]*height="(\d+)"[\s\S]*?<data[^>]*>\s*([\s\S]*?)<\/data>/.exec(
        xml,
      )!;
    const W = parseInt(m[1]!, 10);
    const raw = m[3]!.split(',').map((s) => parseInt(s.trim(), 10))[r * W + c]!;
    const gid = raw & 0x1fffffff;
    const frame = imagePathById.get(gid - 1)!; // env.tsx firstgid=1 → atlas index = gid-1
    return {
      frame,
      tf: computeTileTransform(
        (raw & 0x80000000) !== 0,
        (raw & 0x40000000) !== 0,
        (raw & 0x20000000) !== 0,
      ),
      h: (raw & 0x80000000) !== 0,
      v: (raw & 0x40000000) !== 0,
      d: (raw & 0x20000000) !== 0,
    };
  }

  it('every authored border STRAIGHT carries its band on the FLOOR side (all four sides)', () => {
    const xml = readFileSync(DEMO_TMX, 'utf-8');
    const layerHdr =
      /<layer[^>]*name="map_border_walls"[^>]*width="(\d+)"[^>]*height="(\d+)"[\s\S]*?<data[^>]*>\s*([\s\S]*?)<\/data>/.exec(
        xml,
      )!;
    const W = parseInt(layerHdr[1]!, 10);
    const H = parseInt(layerHdr[2]!, 10);
    const gids = layerHdr[3]!.split(',').map((s) => parseInt(s.trim(), 10));
    const rawAt = (r: number, c: number): number => gids[r * W + c]!;
    const checks: Array<{ r: number; c: number; floor: Edge }> = [];
    for (let c = 1; c < W - 1; c++) {
      if (rawAt(0, c) !== 0) checks.push({ r: 0, c, floor: 'S' }); // door gaps skipped
      if (rawAt(H - 1, c) !== 0) checks.push({ r: H - 1, c, floor: 'N' });
    }
    for (let r = 1; r < H - 1; r++) {
      if (rawAt(r, 0) !== 0) checks.push({ r, c: 0, floor: 'E' });
      if (rawAt(r, W - 1) !== 0) checks.push({ r, c: W - 1, floor: 'W' });
    }
    expect(checks.length).toBeGreaterThanOrEqual(70); // the ring incl. the door gap
    for (const { r, c, floor } of checks) {
      const cell = demoBorderCell(r, c);
      if (cell.frame === 'inner_round') continue; // corners asserted below
      const base = frameCoverage8(cell.frame);
      const viaRepo = applyClientTransform(base, cell.tf.rotation, cell.tf.flipH, cell.tf.flipV);
      const viaCanon = applyCanonicalTiledFlips(base, cell.h, cell.v, cell.d);
      expect(bandEdge(viaRepo), `demo (${r},${c}) ${cell.frame} repo chain`).toBe(floor);
      expect(bandEdge(viaCanon), `demo (${r},${c}) ${cell.frame} canonical`).toBe(floor);
    }
  });

  it('the four ring corners place the inner_round blob on the INTERIOR floor quadrant', () => {
    const xml = readFileSync(DEMO_TMX, 'utf-8');
    const W = parseInt(/width="(\d+)"/.exec(xml)![1]!, 10);
    const H = parseInt(/height="(\d+)"/.exec(xml)![1]!, 10);
    const corners: Array<{ r: number; c: number; interior: Quadrant }> = [
      { r: 0, c: 0, interior: 'SE' },
      { r: 0, c: W - 1, interior: 'SW' },
      { r: H - 1, c: 0, interior: 'NE' },
      { r: H - 1, c: W - 1, interior: 'NW' },
    ];
    for (const { r, c, interior } of corners) {
      const cell = demoBorderCell(r, c);
      expect(cell.frame, `demo corner (${r},${c})`).toBe('inner_round');
      const g = applyClientTransform(
        frameCoverage8(cell.frame),
        cell.tf.rotation,
        cell.tf.flipH,
        cell.tf.flipV,
      );
      expect(maxQuadrant(g), `demo corner (${r},${c}) blob quadrant`).toBe(interior);
    }
  });
});

// ── 4. the selector held to the same truth on the sector-ring topology ───────

describe('render truth — selector: sector-ring faces present toward their own floor', () => {
  // A closed 2-thick square ring (the sector-ring topology): rows/cols 3-8,
  // floor inside AND outside — every face cell has exactly one open cardinal.
  const N = 12;
  const ringGrid: number[][] = Array.from({ length: N }, () => Array(N).fill(TileType.EMPTY));
  for (let r = 3; r <= 8; r++) {
    for (let c = 3; c <= 8; c++) {
      if (r === 3 || r === 4 || r === 7 || r === 8 || c === 3 || c === 4 || c === 7 || c === 8) {
        ringGrid[r]![c] = TileType.INDESTRUCTIBLE_WALL;
      }
    }
  }
  const masks = detector.detect(ringGrid as TileType[][]);
  const fillCells = selectWallFill(ringGrid as TileType[][], masks, fillSprite);
  const cells = selectWallVisuals(ringGrid as TileType[][], masks, roleMaps, { fillCells });

  it("every 1-open straight's band sits on its lone-open-cardinal (floor) side — all four sides", () => {
    let checked = 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const mask = masks[r]![c]!;
        if (mask === null) continue;
        const open = (['N', 'E', 'S', 'W'] as const).filter(
          (d) => (mask & WALL_MASK_BITS[d]) === 0,
        );
        if (open.length !== 1) continue;
        const cell = cells[r]![c]!;
        const frame = imagePathById.get(cell.spriteId)!;
        if (frame !== 'wall' && frame !== 'wall_damaged') continue;
        const g = applyClientTransform(
          frameCoverage8(frame),
          cell.rotation,
          cell.flipH,
          cell.flipV,
        );
        expect(bandEdge(g), `ring (${r},${c}) ${frame}@${cell.rotation} open=${open[0]}`).toBe(
          open[0],
        );
        checked++;
      }
    }
    // 24 face cells: 4 sides × (2 outer faces + 2 inner faces) + 8 corner-adjacent.
    expect(checked).toBe(24);
  });

  it('the repair pass cannot undo the fix: ring faces keep the floor-facing provisional (fill-skip)', () => {
    // wallRunConsistency skips any cell with a wall_fill entry (its own or the
    // neighbour's) — and every 1-open backed INDESTRUCTIBLE cell is filled by
    // the 2-thick-pair-face rule. So the emitted rotation MUST equal the
    // provisional STRAIGHT_ROTATION[open] table for every ring face.
    const STRAIGHT_ROTATION = { N: 0, E: 90, S: 180, W: 270 } as const;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const mask = masks[r]![c]!;
        if (mask === null) continue;
        const open = (['N', 'E', 'S', 'W'] as const).filter(
          (d) => (mask & WALL_MASK_BITS[d]) === 0,
        );
        if (open.length !== 1) continue;
        expect(fillCells[r]![c], `ring (${r},${c}) must be fill-covered`).not.toBeNull();
        expect(cells[r]![c]!.rotation, `ring (${r},${c}) keeps its provisional floor facing`).toBe(
          STRAIGHT_ROTATION[open[0]!],
        );
      }
    }
  });

  it('the unfillable destructible pair convention survives: bars meet on the seam (partner)', () => {
    // A 2-thick destructible block: neither tile can ever be filled (a
    // destroyed wall must not leave baked fill behind), so partner facing
    // (both strips on the shared seam) is the pair's only connective
    // representation — the render-truth rule deliberately does NOT apply
    // here (a floor-facing bar on each side would open a visible transparent
    // gap in the middle of the wall, and the repair pass rotates one back).
    const block: number[][] = Array.from({ length: 6 }, () => Array(6).fill(TileType.EMPTY));
    for (let r = 1; r <= 4; r++) {
      block[r]![2] = TileType.DESTRUCTIBLE_WALL;
      block[r]![3] = TileType.DESTRUCTIBLE_WALL;
    }
    const m = detector.detect(block as TileType[][]);
    const f = selectWallFill(block as TileType[][], m, fillSprite);
    const c = selectWallVisuals(block as TileType[][], m, roleMaps, { fillCells: f });
    const west = c[2]![2]!; // open W → partner → face E (band on the shared seam)
    const east = c[2]![3]!; // open E → partner → face W (band on the shared seam)
    expect(west.rotation).toBe(90);
    expect(east.rotation).toBe(270);
    expect(f[2]![2]).toBeNull();
    expect(f[2]![3]).toBeNull();
  });
});

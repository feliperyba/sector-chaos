import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import { WallOrientationDetector } from '../../src/infrastructure/map/WallOrientationDetector';
import {
  classifyWall,
  WALL_MASK_BITS,
  type WallRole,
} from '../../src/infrastructure/map/WallMaskClassifier';
import {
  buildWallRoleSpriteMap,
  selectWallFill,
  selectWallVisuals,
  resolveWallFillSprite,
} from '../../src/infrastructure/map/WallVisualSelector';
import { auditWallLayerContinuity } from '../../src/infrastructure/map/__tests__/helpers/wallContinuityAudit';
import {
  TileType,
  TILE_PIXEL_SIZE,
  edgeBand,
  SOLID_THRESHOLD,
  type TileSpriteDef,
  type TileVisual,
  type TileCollider,
  type TileSpriteAtlas,
  type TiledMapLayer,
} from '@sector-battle/shared';

// ── Constants ─────────────────────────────────────────────────────────────────

const TILE = TILE_PIXEL_SIZE; // 128
const HALF = TILE / 2;

// Trap sprites that are tagged INDESTRUCTIBLE_WALL in the atlas but are not walls
const TRAP_PATHS = new Set(['trap', 'trap_door', 'trapdoor_round', 'trapdoor_square', 'wall_trap']);

// ── Geometry helpers (independently implemented — NOT importing ColliderCollision) ──

interface Pt {
  x: number;
  y: number;
}

/** Transform collider to tile-local coordinates after rotation + flip. */
function transformCollider(
  collider: TileCollider,
  rotation: number,
  flipH: boolean,
  flipV: boolean,
): Pt[] {
  let pts: Pt[];
  if (collider.type === 'rect') {
    pts = [
      { x: collider.x, y: collider.y },
      { x: collider.x + collider.width, y: collider.y },
      { x: collider.x + collider.width, y: collider.y + collider.height },
      { x: collider.x, y: collider.y + collider.height },
    ];
  } else {
    pts = collider.points.map((p) => ({ x: p.x, y: p.y }));
  }

  if (flipH) pts = pts.map((p) => ({ x: TILE - p.x, y: p.y }));
  if (flipV) pts = pts.map((p) => ({ x: p.x, y: TILE - p.y }));

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pts.map((p) => {
    const dx = p.x - HALF;
    const dy = p.y - HALF;
    return { x: HALF + dx * cos - dy * sin, y: HALF + dx * sin + dy * cos };
  });
}

/** Bounding box of a point set in tile-local space. */
function bbox(pts: Pt[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Which tile edges does the transformed collider reach? (tolerance in pixels) */
function colliderEdges(collider: TileCollider, rotation: number, tol = 10) {
  const bb = bbox(transformCollider(collider, rotation, false, false));
  return {
    top: bb.minY <= tol,
    bottom: bb.maxY >= TILE - tol,
    left: bb.minX <= tol,
    right: bb.maxX >= TILE - tol,
  };
}

/** Centroid of the transformed collider (to determine which half it sits on). */
function colliderCentroid(collider: TileCollider, rotation: number) {
  const pts = transformCollider(collider, rotation, false, false);
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { cx, cy };
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('Wall Autotiling Integration — @colyseus/testing', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  // Shared state — computed once from the generated room
  let grid: TileType[][];
  let orientations: (number | null)[][];
  let wallLayer: TiledMapLayer;
  let fillLayer: TiledMapLayer;
  let atlas: TileSpriteAtlas;
  let atlasById: Map<number, TileSpriteDef>;
  let roleMaps: {
    indestructible: Map<WallRole, TileSpriteDef>;
    destructible: Map<WallRole, TileSpriteDef>;
  };

  beforeAll(async () => {
    const { room } = await createGameRoom(server, { seed: 42 });
    const gameRoom = room as unknown as GameRoom;
    const payload = gameRoom.buildMapDataPayload();

    grid = payload.grid as TileType[][];
    atlas = payload.atlas!;
    wallLayer = payload.visualLayers!.find((l) => l.name === 'map_border_walls')!;
    fillLayer = payload.visualLayers!.find((l) => l.name === 'wall_fill')!;

    const detector = new WallOrientationDetector();
    orientations = detector.detect(grid);

    atlasById = new Map();
    for (const s of atlas.sprites) atlasById.set(s.id, s);

    const indestructibleSprites = atlas.sprites.filter(
      (s) => s.tileType === TileType.INDESTRUCTIBLE_WALL && !TRAP_PATHS.has(s.imagePath),
    );
    const destructibleSprites = atlas.sprites.filter(
      (s) => s.tileType === TileType.DESTRUCTIBLE_WALL,
    );
    // The production role→sprite resolution (single source: the exported builder).
    roleMaps = {
      indestructible: buildWallRoleSpriteMap(indestructibleSprites),
      destructible: buildWallRoleSpriteMap(destructibleSprites),
    };
  });

  // ── Helper: iterate every wall tile ──────────────────────────────────────

  function* wallTiles(): Generator<{
    r: number;
    c: number;
    mask: number;
    cell: TileVisual;
    sprite: TileSpriteDef;
    role: WallRole;
    tileType: TileType;
  }> {
    for (let r = 0; r < orientations.length; r++) {
      for (let c = 0; c < orientations[r]!.length; c++) {
        const mask = orientations[r]![c];
        if (mask === null || mask === undefined) continue;
        const cell = wallLayer.cells[r]?.[c];
        if (!cell) continue;
        const sprite = atlasById.get(cell.spriteId);
        if (!sprite) continue;
        const tileType = grid[r]![c]!;
        // The ROLE is a pure function of the mask (the ticket-13 one-open
        // facing modes only rotate straights; the destructible corner-reading
        // re-roles 2-adjacent-open tiles and is asserted separately below).
        const role = classifyWall(mask).role;
        yield { r, c, mask, cell, sprite, role, tileType };
      }
    }
  }

  /**
   * Run-consistency repair override (mirrors `wallRunConsistency`, the pass
   * `selectWallVisuals` runs AFTER the per-tile facing this suite models): an
   * UNFILLED wall cell (destructible walls / crates can never be fill-covered)
   * whose provisional facing does not share a solid band with an unfilled
   * wall-like cardinal neighbour — a filled side on either tile connects by
   * construction — is rotated to the FIRST of 0/90/180/270 that satisfies
   * EVERY constrained pair. Band agreement is the shared art-shape ground
   * truth (`edgeBand`/`SOLID_THRESHOLD`), the same one the selector's pass
   * and the continuity audit read. Neighbour rotations come from the emitted
   * layer — exact for leaf repairs, where the neighbours kept their own
   * provisional facings.
   *
   * First exposure — seed 42 tile (27,71), 7f6f753e (plaza archetype grammar):
   * the gate-jamb column at col 72 was re-stamped rows 28-31 → rows 27-29
   * (authored runs are 3 tiles under the new grammar), so (27,72) became
   * INDESTRUCTIBLE_WALL and walled (27,71)'s E side. The tile went from a
   * 2-open outer_corner (old mask open=[N,E]) to a 1-open destructible
   * partner tile (open=N, destructible back S at (28,71)) with provisional
   * facing 180 — which shares no solid band with its run neighbour W
   * (27,70) `wall_damaged`@0 (the mid-run side-flip, defect class D3, the
   * repair exists to kill). The pass rotates it to 270, the unique rotation
   * satisfying both the S pair ((28,71) `wall_edge`@90) and the W pair.
   */
  const repairFacing = (
    r: number,
    c: number,
    sprite: TileSpriteDef,
    provisional: 0 | 90 | 180 | 270,
  ): 0 | 90 | 180 | 270 => {
    if (fillLayer.cells[r]?.[c]) return provisional; // filled ⇒ connected by construction

    const pairs: Array<{ dir: Dir; path: string; rotation: number }> = [];
    for (const dir of ['N', 'E', 'S', 'W'] as Dir[]) {
      const [dr, dc] = DIR_OFFSETS[dir];
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[nr]!.length) continue;
      if (orientations[nr]![nc] === null || orientations[nr]![nc] === undefined) continue; // non-wall
      if (fillLayer.cells[nr]?.[nc]) continue; // filled side ⇒ connected by construction
      const neighbour = wallLayer.cells[nr]?.[nc];
      if (!neighbour) continue;
      pairs.push({
        dir,
        path: atlasById.get(neighbour.spriteId)!.imagePath,
        rotation: neighbour.rotation,
      });
    }
    if (pairs.length === 0) return provisional;

    const sharesBand = (rotation: number): boolean =>
      pairs.every(({ dir, path, rotation: nRot }) => {
        const mine = edgeBand(sprite.imagePath, rotation, dir);
        const theirs = edgeBand(path, nRot, oppositeOf(dir));
        return mine.some((v, i) => v >= SOLID_THRESHOLD && theirs[i]! >= SOLID_THRESHOLD);
      });

    if (sharesBand(provisional)) return provisional;
    for (const candidate of [0, 90, 180, 270] as const) {
      if (candidate === provisional) continue; // already known to fail
      if (sharesBand(candidate)) return candidate;
    }
    return provisional; // no satisfying rotation ⇒ the pass keeps the provisional facing
  };

  // ── 1. Sprite validity ───────────────────────────────────────────────────

  it('every wall tile has a valid sprite from the atlas', () => {
    let count = 0;
    for (const { r, c, cell } of wallTiles()) {
      count++;
      expect(cell.spriteId, `(${r},${c}) spriteId`).toBeGreaterThanOrEqual(0);
      expect(cell.spriteId, `(${r},${c}) spriteId out of range`).toBeLessThan(atlas.sprites.length);
    }
    expect(count, 'should have wall tiles').toBeGreaterThan(0);
  });

  // ── 2. Sprite-role consistency ───────────────────────────────────────────

  it('every wall tile sprite imagePath matches its classifyWall role (destructible corner-readings and corner-dangling re-roles excepted)', () => {
    const CARD_BITS = WALL_MASK_BITS.N | WALL_MASK_BITS.E | WALL_MASK_BITS.S | WALL_MASK_BITS.W;
    const DIAG_BITS = WALL_MASK_BITS.NE | WALL_MASK_BITS.SE | WALL_MASK_BITS.SW | WALL_MASK_BITS.NW;
    for (const { r, c, mask, sprite, role, tileType } of wallTiles()) {
      const roleMap =
        tileType === TileType.DESTRUCTIBLE_WALL ? roleMaps.destructible : roleMaps.indestructible;

      // Ticket 20 corner-dangling re-role: zero wall-like cardinal neighbours
      // + ≥1 wall-like diagonal → the corner-hugging L (`outer_corner`);
      // classifyWall's own role for those masks is `isolated`.
      const dangling = (mask & CARD_BITS) === 0 && (mask & DIAG_BITS) !== 0;
      const expectedRole = dangling && role === 'isolated' ? 'outer_corner' : role;

      // Ticket 20 W1c is dangling-only: a buried (exposed-0) destructible
      // `diagonal` inside a breakable mass keeps the straight-frame fallback.
      const buriedDestructibleDiagonal =
        tileType === TileType.DESTRUCTIBLE_WALL && role === 'diagonal' && !dangling;

      const expected = roleMap.get(
        buriedDestructibleDiagonal ? 'straight' : expectedRole,
      )!.imagePath;

      if (tileType === TileType.DESTRUCTIBLE_WALL && expectedRole === 'straight') {
        // 2-adjacent-open destructible bends use the ticket-13 corner-reading
        // (wall_edge hugging both arms); every other destructible straight is
        // the plain wall_damaged strip.
        const open = openCardinalList(mask);
        const isBend = open.length === 2 && oppositeOf(open[0]!) !== open[1];
        expect(sprite.imagePath, `(${r},${c}) destructible role='straight' open=[${open}]`).toBe(
          isBend ? 'wall_edge' : expected,
        );
        continue;
      }

      expect(
        sprite.imagePath,
        `(${r},${c}) role='${role}' expectedRole='${expectedRole}' tileType=${tileType} expected '${expected}' got '${sprite.imagePath}'`,
      ).toBe(expected);
    }
  });

  // ── 3. The room payload IS the pure seam's output (ticket 12 seam, ticket 13 rules) ──

  it('the emitted wall layer equals selectWallVisuals(grid, masks, roleMaps, {fillCells}) cell-for-cell', () => {
    const expected = selectWallVisuals(grid, orientations, roleMaps, {
      fillCells: fillLayer.cells as (TileVisual | null)[][],
    });
    expect(wallLayer.cells).toEqual(expected);
  });

  it('the emitted wall_fill layer equals selectWallFill(grid, masks, fillSprite) cell-for-cell', () => {
    const expected = selectWallFill(grid, orientations, resolveWallFillSprite(atlas));
    expect(fillLayer.cells).toEqual(expected);
  });

  // ── 4. No flips ──────────────────────────────────────────────────────────

  it('no wall tile has flipH or flipV set', () => {
    for (const { r, c, cell } of wallTiles()) {
      expect(cell.flipH, `(${r},${c}) flipH`).toBe(false);
      expect(cell.flipV, `(${r},${c}) flipV`).toBe(false);
    }
  });

  // ── 5. Collider existence ────────────────────────────────────────────────

  it('every wall sprite has at least one collider', () => {
    for (const { r, c, sprite } of wallTiles()) {
      expect(
        sprite.colliders.length,
        `(${r},${c}) sprite '${sprite.imagePath}' has no colliders`,
      ).toBeGreaterThan(0);
    }
  });

  // ── 6. Collider-side correctness for straight/endcap roles ───────────────

  it('straight/endcap colliders sit on the face side of the tile', () => {
    for (const { r, c, sprite, cell, role } of wallTiles()) {
      if (role !== 'straight' && role !== 'endcap') continue;
      if (sprite.imagePath !== 'wall' && sprite.imagePath !== 'wall_damaged') continue;

      // For straight/endcap, the wall strip should be on the face side.
      // rotation 0   → face N → collider centroid in top half (cy < HALF)
      // rotation 90  → face E → collider centroid in right half (cx > HALF)
      // rotation 180 → face S → collider centroid in bottom half (cy > HALF)
      // rotation 270 → face W → collider centroid in left half (cx < HALF)
      const { cx, cy } = colliderCentroid(sprite.colliders[0]!, cell.rotation);

      const label = `(${r},${c}) role='${role}' rot=${cell.rotation} centroid=(${cx.toFixed(0)},${cy.toFixed(0)})`;
      switch (cell.rotation) {
        case 0:
          expect(cy, `${label} should be top half`).toBeLessThan(HALF);
          break;
        case 90:
          expect(cx, `${label} should be right half`).toBeGreaterThan(HALF);
          break;
        case 180:
          expect(cy, `${label} should be bottom half`).toBeGreaterThan(HALF);
          break;
        case 270:
          expect(cx, `${label} should be left half`).toBeLessThan(HALF);
          break;
      }
    }
  });

  // ── 7. Endcap orientation: aligned with the wall run ─────────────────────

  it('endcap rotation follows the wall connection axis (perpendicular strip), repair-pass adjusted', () => {
    // Ticket 23: the run-consistency repair pass may rotate an UNFILLED
    // endcap off the run axis when the corrected corner orientation of a
    // neighbour breaks their shared band. Most such repairs are leaf
    // repairs the `repairFacing` mirror (below, and in test 11) predicts
    // exactly. A two-step CASCADE can diverge from that mirror: the pass is
    // sequential (row-major sweeps), so an endcap may be rotated against a
    // neighbour's PROVISIONAL rotation and then keep that rotation when the
    // neighbour itself settles elsewhere — both the emitted and the mirror
    // rotation band-connect at the final state, and the pass never reverts
    // a satisfying rotation. Seed-42 has exactly two such cascaded endcaps,
    // both vertical stubs: (34,68) wall_damaged and (73,72) wall. During
    // sweep 1 their S-neighbours ((35,68) wall_edge, (74,72) wall_corner)
    // still held their ticket-23 provisionals whose N-edge bands sit at
    // cols 0-2, so the run-axis 90 band (cols 5-7) shared nothing and
    // rot180 (full-width S band) was the first connecting candidate; the
    // neighbours then settled at rotations whose N-edge bands also overlap
    // cols 5-7, where 90 would connect too. Both cells end band-connected
    // (continuity gate below); their geometry is asserted in test 10.
    const repairCascaded: string[] = [];
    for (const { r, c, cell, role, sprite } of wallTiles()) {
      if (role !== 'endcap') continue;

      // Endcap has exactly 3 open cardinals + 1 wall cardinal.
      // The wall runs in the direction of that wall cardinal.
      // Vertical wall (N/S connection) → endcap rot should be 90.
      // Horizontal wall (E/W connection) → endcap rot should be 0.
      const mask = orientations[r]![c]!;
      const nWall = (mask & WALL_MASK_BITS.N) !== 0;
      const sWall = (mask & WALL_MASK_BITS.S) !== 0;

      // Round 5e: an endcap capping a 2-opposite-open THIN straight adopts
      // its run's effective facing by design (the piers of a symmetric
      // structure mirror) — it legitimately deviates from the axis model and
      // is excluded from the cascade census below.
      const wallDir = nWall ? 'N' : sWall ? 'S' : (mask & WALL_MASK_BITS.E) !== 0 ? 'E' : 'W';
      const capped = neighbourMaskAt(orientations, r, c, wallDir);
      if (capped !== null && areOppositeOpen(capped) && countOpenCardinals(capped) === 2) continue;

      // Exactly 1 wall cardinal
      const eWall = (mask & WALL_MASK_BITS.E) !== 0;
      const wWall = (mask & WALL_MASK_BITS.W) !== 0;
      const wallCount = [nWall, sWall, eWall, wWall].filter(Boolean).length;
      expect(wallCount, `(${r},${c}) endcap should have exactly 1 wall cardinal`).toBe(1);

      const isVertical = nWall || sWall;
      const provisional = (isVertical ? 90 : 0) as 0 | 90 | 180 | 270;
      const model = repairFacing(r, c, sprite, provisional);
      if (cell.rotation !== model) {
        repairCascaded.push(`(${r},${c})@${cell.rotation} model=${model}`);
      }
    }
    // Round 5e: ZERO off-model endcaps remain on this seed. The historical
    // two cascades ((34,68)/(73,72)@180 — sequential-repair artifacts against
    // ticket-23 corner provisionals) are gone: the thin-run/endcap
    // corner-following rules face those stubs from their runs directly, and
    // the thin-run-capping endcaps are excluded above as the sanctioned
    // run-following class. Any entry here is an UNEXPLAINED deviation again.
    expect(repairCascaded).toEqual([]);
  });

  // ── 8. World-edge ring fidelity (replaces the %20 border test) ───────────

  it('world-edge ring tiles whose wall-behind is off-map keep the demo-verified open facing', () => {
    for (const { r, c, mask, cell } of wallTiles()) {
      const open = openCardinalList(mask);
      if (open.length !== 1) continue;
      const back = oppositeOf(open[0]!);
      const backOffMap = !inGridWall(grid, r, c, back);
      const onWorldEdge = r === 0 || c === 0 || r === grid.length - 1 || c === grid[0]!.length - 1;
      if (!backOffMap || !onWorldEdge) continue;

      // The demo border-ring convention: face the open cardinal.
      const baseChoice = classifyWall(mask);
      expect(cell.rotation, `world-edge ring tile (${r},${c}) open=${open[0]}`).toBe(
        baseChoice.rotation,
      );
    }
  });

  // ── 9. Straight-run continuity ───────────────────────────────────────────

  it('horizontally adjacent straight-run tiles share the same rotation', () => {
    for (let r = 0; r < orientations.length; r++) {
      for (let c = 0; c < orientations[r]!.length - 1; c++) {
        const mask1 = orientations[r]![c];
        const mask2 = orientations[r]![c + 1];
        if (mask1 === null || mask2 === null) continue;

        const cell1 = wallLayer.cells[r]?.[c];
        const cell2 = wallLayer.cells[r]?.[c + 1];
        if (!cell1 || !cell2) continue;

        const ch1 = classifyWall(mask1);
        const ch2 = classifyWall(mask2);

        // Only check tiles that are both straight with 2 opposite open cardinals
        // (i.e. a through-wall strip, not a junction edge)
        if (ch1.role !== 'straight' || ch2.role !== 'straight') continue;

        if (countOpenCardinals(mask1) !== 2 || countOpenCardinals(mask2) !== 2) continue;

        // Both must be opposite-open (not adjacent-open)
        if (!areOppositeOpen(mask1) || !areOppositeOpen(mask2)) continue;

        expect(
          cell1.rotation,
          `(${r},${c})-(${r},${c + 1}) straight run: rot mismatch ${cell1.rotation} vs ${cell2.rotation}`,
        ).toBe(cell2.rotation);
      }
    }
  });

  it('vertically adjacent straight-run tiles share the same rotation', () => {
    for (let r = 0; r < orientations.length - 1; r++) {
      for (let c = 0; c < orientations[r]!.length; c++) {
        const mask1 = orientations[r]![c];
        const mask2 = orientations[r + 1]![c];
        if (mask1 === null || mask2 === null) continue;

        const cell1 = wallLayer.cells[r]?.[c];
        const cell2 = wallLayer.cells[r + 1]?.[c];
        if (!cell1 || !cell2) continue;

        const ch1 = classifyWall(mask1);
        const ch2 = classifyWall(mask2);

        if (ch1.role !== 'straight' || ch2.role !== 'straight') continue;

        if (countOpenCardinals(mask1) !== 2 || countOpenCardinals(mask2) !== 2) continue;
        if (!areOppositeOpen(mask1) || !areOppositeOpen(mask2)) continue;

        expect(
          cell1.rotation,
          `(${r},${c})-(${r + 1},${c}) straight run: rot mismatch ${cell1.rotation} vs ${cell2.rotation}`,
        ).toBe(cell2.rotation);
      }
    }
  });

  // ── 10. Endcap-to-straight collider connection ───────────────────────────

  it('endcap colliders reach the shared boundary with adjacent straight tiles (repair-moved endcaps band-connect instead)', () => {
    for (const { r, c, mask, cell, sprite, role } of wallTiles()) {
      if (role !== 'endcap') continue;

      // Endcap has 1 wall cardinal — check the collider reaches toward it
      const nWall = (mask & WALL_MASK_BITS.N) !== 0;
      const sWall = (mask & WALL_MASK_BITS.S) !== 0;
      const eWall = (mask & WALL_MASK_BITS.E) !== 0;
      const wWall = (mask & WALL_MASK_BITS.W) !== 0;

      const isVertical = nWall || sWall;
      const provisional = (isVertical ? 90 : 0) as 0 | 90 | 180 | 270;
      if (cell.rotation === provisional) {
        // Run-axis endcap: the perpendicular strip spans the tile, so the
        // collider reaches BOTH edges along the run axis.
        const edges = colliderEdges(sprite.colliders[0]!, cell.rotation);
        if (nWall || sWall) {
          expect(edges.top, `(${r},${c}) endcap N/S connection should reach top edge`).toBe(true);
          expect(edges.bottom, `(${r},${c}) endcap N/S connection should reach bottom edge`).toBe(
            true,
          );
        }
        if (eWall || wWall) {
          expect(edges.left, `(${r},${c}) endcap E/W connection should reach left edge`).toBe(true);
          expect(edges.right, `(${r},${c}) endcap E/W connection should reach right edge`).toBe(
            true,
          );
        }
      } else {
        // Ticket-23 repair-moved endcap (seed-42: (34,68), (73,72) — see the
        // test-7 derivation): the strip rotated off the run axis to restore
        // the shared band with its connection neighbour, so the geometric
        // reach proxy no longer holds — assert the CONNECTION directly: the
        // touching edges share a solid band (the repair pass's own
        // predicate, the art-shape ground truth).
        const connDir = (nWall ? 'N' : sWall ? 'S' : eWall ? 'E' : 'W') as Dir;
        const [dr, dc] = DIR_OFFSETS[connDir];
        const neighbour = wallLayer.cells[r + dr]?.[c + dc];
        expect(
          neighbour,
          `(${r},${c}) repair-moved endcap should have its wall neighbour`,
        ).toBeTruthy();
        const nPath = atlasById.get(neighbour!.spriteId)!.imagePath;
        const mySide = connDir as 'N' | 'E' | 'S' | 'W';
        const theirSide = oppositeOf(mySide);
        const mine = edgeBand(sprite.imagePath, cell.rotation, mySide);
        const theirs = edgeBand(nPath, neighbour!.rotation, theirSide);
        expect(
          mine.some((v, i) => v >= SOLID_THRESHOLD && theirs[i]! >= SOLID_THRESHOLD),
          `(${r},${c}) repair-moved endcap must band-connect to (${r + dr},${c + dc}) ${nPath}@${neighbour!.rotation}`,
        ).toBe(true);
      }
    }
  });

  // ── 11. Topology-derived junction facing (replaces the %20 internal test) ──

  it('1-open-cardinal tiles face per their wall topology: floor-facing (backed indestructible) / partner+run (unfillable destructible)', () => {
    for (const { r, c, mask, cell, sprite, tileType } of wallTiles()) {
      const open = openCardinalList(mask);
      if (open.length !== 1) continue;
      const openDir = open[0]!;
      const back = oppositeOf(openDir);

      let expectedRot: 0 | 90 | 180 | 270;
      if (!inGridWall(grid, r, c, back)) {
        // World edge: demo border facing.
        expectedRot = faceRotation(openDir);
      } else {
        const [br, bc] = offsetOf(back);
        const backTile = grid[r + br]![c + bc]!;
        if (tileType === TileType.DESTRUCTIBLE_WALL) {
          // Destructible: partner into a destructible back (unfillable seam);
          // otherwise run-facing — even when mutual, an indestructible back
          // is fill-bridged (junctionFill's destructible-hug clause), exactly
          // mirroring oneOpenFaceMode. The unfillable tile keeps the axis
          // compromise: facing the floor pocket instead breaks the pinned D5
          // T-stem residual bound (53-seed sweep: 31 → 43).
          expectedRot =
            backTile === TileType.DESTRUCTIBLE_WALL ? faceRotation(back) : runFacing(mask);
        } else {
          // Ticket 27 render truth: EVERY backed INDESTRUCTIBLE 1-open cell
          // (mutual 2-thick pair, wall-mass edge, abutment) is wall_fill-
          // covered (selectWallFill: 1-open + in-grid wall behind) and the
          // fill closes the seam, so the bar presents toward the lone open
          // cardinal — its floor — on every sector side. The historical
          // partner/run facings buried the bar into the wall mass (the
          // owner's "side walls on the inner side of the tile").
          expectedRot = faceRotation(openDir);
        }
      }
      // The provisional facing is then subject to the selector's
      // run-consistency repair pass (first seed-42 exposure: 7f6f753e,
      // tile (27,71) — see repairFacing for the topology derivation).
      expectedRot = repairFacing(r, c, sprite, expectedRot);
      expect(cell.rotation, `(${r},${c}) tileType=${tileType} open=${openDir} back=${back}`).toBe(
        expectedRot,
      );
    }
  });

  // ── 12. Role distribution sanity ─────────────────────────────────────────

  it('produces a healthy role distribution across the map', () => {
    const counts: Record<string, number> = {};
    for (const { role } of wallTiles()) {
      counts[role] = (counts[role] ?? 0) + 1;
    }
    // Straight should be the majority (border + strips)
    expect(counts.straight, 'straight should be > 0').toBeGreaterThan(0);
    // Should have at least some corners
    const corners = (counts.outer_corner ?? 0) + (counts.inner_corner ?? 0);
    expect(corners, 'should have corners').toBeGreaterThan(0);
    // Should have endcaps
    expect(counts.endcap ?? 0, 'should have endcaps').toBeGreaterThan(0);
  });

  // ── 13. Rotation values are always quantized ────────────────────────────

  it('all rotations are 0/90/180/270', () => {
    for (const { r, c, cell } of wallTiles()) {
      expect(cell.rotation, `(${r},${c}) rotation must be 0/90/180/270`).toBeOneOf([
        0, 90, 180, 270,
      ]);
    }
  });

  // ── 14. wall_fill layer contract (ticket 13) ────────────────────────────

  it('wall_fill: EMPTY-typed frames, never on destructible tiles, always beneath a wall cell', () => {
    let fillCount = 0;
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r]!.length; c++) {
        const cell = fillLayer.cells[r]?.[c];
        if (!cell) continue;
        fillCount++;
        const def = atlasById.get(cell.spriteId)!;
        // No collision / no entity-path visibility: EMPTY-typed frame.
        expect(def.tileType, `fill (${r},${c}) must be an EMPTY-typed frame`).toBe(TileType.EMPTY);
        // A destroyed destructible wall must never leave baked fill behind.
        expect(grid[r]![c]!, `fill (${r},${c}) must not cover a destructible tile`).toBe(
          TileType.INDESTRUCTIBLE_WALL,
        );
        // Beneath the wall layer: the wall cell above is authoritative.
        expect(
          wallLayer.cells[r]?.[c],
          `fill (${r},${c}) must be shadowed by a wall cell`,
        ).toBeTruthy();
      }
    }
    // Sector seams are 2-thick by construction — the fill layer is never empty.
    expect(fillCount, 'wall_fill layer should carry seam/interior cells').toBeGreaterThan(0);
  });

  // ── 15. Fill-aware continuity gate, end-to-end through the room payload ──

  it('fill-aware continuity audit: ZERO adjacent wall pairs without a shared solid band', () => {
    const audit = auditWallLayerContinuity(
      wallLayer.cells as (TileVisual | null)[][],
      atlas.sprites,
      { fillCells: fillLayer.cells as (TileVisual | null)[][] },
    );
    expect(audit.violations, JSON.stringify(audit.violations.slice(0, 5))).toEqual([]);
    expect(audit.seamCount).toBe(0);
    expect(audit.interiorCount).toBe(0);
  });
});

// ── Mask helpers ─────────────────────────────────────────────────────────────

type Dir = 'N' | 'E' | 'S' | 'W';

const DIR_OFFSETS: Record<Dir, [number, number]> = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};

function openCardinalList(mask: number): Dir[] {
  const out: Dir[] = [];
  if (!(mask & WALL_MASK_BITS.N)) out.push('N');
  if (!(mask & WALL_MASK_BITS.E)) out.push('E');
  if (!(mask & WALL_MASK_BITS.S)) out.push('S');
  if (!(mask & WALL_MASK_BITS.W)) out.push('W');
  return out;
}

function oppositeOf(dir: Dir): Dir {
  if (dir === 'N') return 'S';
  if (dir === 'S') return 'N';
  if (dir === 'E') return 'W';
  return 'E';
}

function offsetOf(dir: Dir): [number, number] {
  return DIR_OFFSETS[dir];
}

/** In-grid wall-likeness (off-map = not in-grid). */
function inGridWall(grid: TileType[][], r: number, c: number, dir: Dir): boolean {
  const [dr, dc] = DIR_OFFSETS[dir];
  const nr = r + dr;
  const nc = c + dc;
  if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[nr]!.length) return false;
  const t = grid[nr]![nc]!;
  return (
    t === TileType.INDESTRUCTIBLE_WALL ||
    t === TileType.DESTRUCTIBLE_WALL ||
    t === TileType.INDESTRUCTIBLE_CRATE
  );
}

/** Straight-piece rotation that faces `dir` (rot0=N, rot90=E, rot180=S, rot270=W). */
function faceRotation(dir: Dir): 0 | 90 | 180 | 270 {
  return dir === 'N' ? 0 : dir === 'E' ? 90 : dir === 'S' ? 180 : 270;
}

/** Run-axis facing: horizontal run (E+W walled) → face N, vertical → face E. */
function runFacing(mask: number): 0 | 90 {
  const eWall = (mask & WALL_MASK_BITS.E) !== 0;
  const wWall = (mask & WALL_MASK_BITS.W) !== 0;
  return eWall && wWall ? 0 : 90;
}

function countOpenCardinals(mask: number): number {
  return openCardinalList(mask).length;
}

/** The 8-bit mask of the neighbour one step in `dir`, or null (off-grid / non-wall). */
function neighbourMaskAt(
  orientations: (number | null)[][],
  r: number,
  c: number,
  dir: Dir,
): number | null {
  const [dr, dc] = DIR_OFFSETS[dir];
  const nr = r + dr;
  const nc = c + dc;
  if (nr < 0 || nr >= orientations.length || nc < 0 || nc >= orientations[nr]!.length) return null;
  return orientations[nr]![nc];
}

function areOppositeOpen(mask: number): boolean {
  const nOpen = !(mask & WALL_MASK_BITS.N);
  const sOpen = !(mask & WALL_MASK_BITS.S);
  const eOpen = !(mask & WALL_MASK_BITS.E);
  const wOpen = !(mask & WALL_MASK_BITS.W);
  return (nOpen && sOpen) || (eOpen && wOpen);
}

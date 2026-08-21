// @vitest-environment node
// No DOM usage — node env keeps this runnable where the jsdom install is
// broken/unavailable (same convention as ClientCollisionService.test.ts).
import { describe, it, expect, vi } from 'vitest';
import {
  AABBCollision,
  forEachOverlappingTile,
  isSimpleTileBlocked,
  type AABB,
  type MTV,
  TileType,
} from '@sector-battle/shared';
import { ClientCollisionService } from '../ClientCollisionService.js';

/**
 * Ticket 43 re-triage (option b) — CLIENT parity gate.
 *
 * The client's non-atlas fallback branch (the duplicated per-tile two-axis MTV
 * loop with OOB=SOLID semantics) was DELETED and resolveCollision now
 * delegates to the shared pure helper `resolveSimpleTileCollision` (the same
 * body the server's CollisionService.resolveSimple runs). This file proves the
 * delegation is numerically identical to a verbatim replica of the deleted
 * branch (the session-1 oracle convention: transcribe the old code into the
 * test, exact `===` equality), with an out-of-bounds-heavy position battery:
 * positions straddling every grid edge, fully outside each edge, all four
 * outside corners, and exact tile-boundary alignments.
 *
 * Premise being preserved (why the branch was NOT routed through the shared
 * enriched resolver's no-visual fallback): the shared
 * `resolveTileCollisionEnriched` SKIPS out-of-grid tiles
 * (`grid[gy]?.[gx] === undefined → return`, resolveTileCollision.ts) while the
 * old client branch treats OOB as SOLID — a 31% divergence over session 1's
 * 231k-position sweep. Option (b) keeps OOB=SOLID by sharing the server's
 * resolveSimple loop instead; option (a) (changing the shared resolver) was
 * forbidden.
 */

const TILE_SIZE = 128;
const HALF_W = 48;
const HALF_H = 48;

function makeGrid(
  rows: number,
  cols: number,
  fill: TileType,
  overrides?: Array<{ x: number; y: number; tile: TileType }>,
): number[][] {
  const grid: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  if (overrides) for (const o of overrides) grid[o.y]![o.x] = o.tile;
  return grid;
}

/** Mock renderer with NO enriched data — forces the fallback branch. */
function makeMockMapRenderer(grid: number[][]) {
  return {
    getGrid: vi.fn().mockReturnValue(grid),
    getTileSize: vi.fn().mockReturnValue(TILE_SIZE),
    getAtlas: vi.fn().mockReturnValue(null),
    getVisualLayers: vi.fn().mockReturnValue([]),
    getSiegeWallVisual: vi.fn().mockReturnValue(null),
    isWalkable: vi.fn(),
  } as any;
}

// ── Verbatim replica of the DELETED fallback branch (pre-ticket 43) ─────────
//
// Transcribed exactly as it stood in ClientCollisionService.resolveCollision's
// `else` branch (ticket-#36 scratch form): isTileBlocked with OOB=SOLID
// (`grid[0]?.length ?? 0` col bounds), writeTileAabb/setAabb scratch writes,
// X-then-Y two-axis MTV with the same recompute timing. The surrounding
// resolveCollision stages (entity setup, per-axis clamp, center conversion)
// are the unchanged production code, replicated here so the comparison is
// end-to-end center→center.
class OldFallbackBranchOracle {
  private readonly mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  private readonly entityAabb: AABB = { x: 0, y: 0, width: 0, height: 0 };
  private readonly testAabb: AABB = { x: 0, y: 0, width: 0, height: 0 };
  private readonly tileAabb: AABB = { x: 0, y: 0, width: 0, height: 0 };

  constructor(private readonly mapRenderer: any) {}

  resolveCollision(
    centerX: number,
    centerY: number,
    halfW: number,
    halfH: number,
  ): { x: number; y: number } {
    const grid = this.mapRenderer.getGrid();
    const tileSize = this.mapRenderer.getTileSize();

    if (grid.length === 0) {
      return { x: centerX, y: centerY };
    }

    const entity = this.entityAabb;
    entity.x = centerX - halfW;
    entity.y = centerY - halfH;
    entity.width = halfW * 2;
    entity.height = halfH * 2;

    const atlas = this.mapRenderer.getAtlas();
    const visualLayers = this.mapRenderer.getVisualLayers();
    const hasEnriched = atlas !== null && visualLayers.length > 0;
    if (hasEnriched) throw new Error('oracle models the fallback branch only');

    let resolvedX = entity.x;
    let resolvedY = entity.y;

    forEachOverlappingTile(
      resolvedX,
      resolvedY,
      entity.width,
      entity.height,
      tileSize,
      (tileX: number, tileY: number) => {
        if (!this.isTileBlocked(tileX, tileY, grid)) return;
        const tileAABB = this.writeTileAabb(tileX, tileY, tileSize);
        const testX = this.setAabb(this.testAabb, resolvedX, entity.y, entity.width, entity.height);
        const mtv = this.mtvScratch;
        if (AABBCollision.getMTVInto(testX, tileAABB, mtv) && Math.abs(mtv.x) > Math.abs(mtv.y)) {
          resolvedX += mtv.x > 0 ? mtv.depth : -mtv.depth;
        }
        const testY = this.setAabb(
          this.testAabb,
          resolvedX,
          resolvedY,
          entity.width,
          entity.height,
        );
        if (
          AABBCollision.getMTVInto(testY, tileAABB, mtv) &&
          Math.abs(mtv.y) >= Math.abs(mtv.x)
        ) {
          resolvedY += mtv.y > 0 ? mtv.depth : -mtv.depth;
        }
      },
    );

    const maxCols = grid[0]?.length ?? 0;
    const maxRows = grid.length;
    resolvedX = this.clampBounds(resolvedX, entity.width, maxCols * tileSize);
    resolvedY = this.clampBounds(resolvedY, entity.height, maxRows * tileSize);

    return { x: resolvedX + halfW, y: resolvedY + halfH };
  }

  /** Public only so the predicate-equality sweep can drive it directly (the
   * production original was private; body is verbatim). */
  isTileBlocked(gridX: number, gridY: number, grid: number[][]): boolean {
    if (gridY < 0 || gridY >= grid.length) return true;
    if (gridX < 0 || gridX >= (grid[0]?.length ?? 0)) return true;
    const tile = grid[gridY]![gridX]!;
    return tile !== TileType.EMPTY && tile !== TileType.EXIT;
  }

  private writeTileAabb(gridX: number, gridY: number, tileSize: number): AABB {
    const tile = this.tileAabb;
    tile.x = gridX * tileSize;
    tile.y = gridY * tileSize;
    tile.width = tileSize;
    tile.height = tileSize;
    return tile;
  }

  private setAabb(target: AABB, x: number, y: number, width: number, height: number): AABB {
    target.x = x;
    target.y = y;
    target.width = width;
    target.height = height;
    return target;
  }

  private clampBounds(pos: number, size: number, mapExtent: number): number {
    if (pos < 0) pos = 0;
    if (pos + size > mapExtent) pos = mapExtent - size;
    return pos;
  }
}

// ── Battery ─────────────────────────────────────────────────────────────────

function gridBattery(): Array<{ label: string; grid: number[][] }> {
  return [
    { label: 'empty-4x4', grid: makeGrid(4, 4, TileType.EMPTY) },
    {
      label: 'single-wall',
      grid: makeGrid(4, 4, TileType.EMPTY, [{ x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL }]),
    },
    {
      // Walls hugging every edge/corner — forces OOB-solid neighbors to matter.
      label: 'edge-hugging-walls',
      grid: makeGrid(4, 4, TileType.EMPTY, [
        { x: 0, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
        { x: 3, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
        { x: 0, y: 3, tile: TileType.INDESTRUCTIBLE_WALL },
        { x: 3, y: 3, tile: TileType.DESTRUCTIBLE_WALL },
        { x: 1, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
        { x: 0, y: 1, tile: TileType.DESTRUCTIBLE_CRATE },
      ]),
    },
    { label: 'all-walls-1x1', grid: makeGrid(1, 1, TileType.INDESTRUCTIBLE_WALL) },
    { label: 'single-empty-row', grid: makeGrid(1, 3, TileType.EMPTY) },
    {
      // Ragged grid: row 1 shorter than row 0 → grid[1][2] undefined → the
      // old predicate's `!== EMPTY && !== EXIT` reads undefined as BLOCKED.
      // Both sides must keep this quirk identically (characterization).
      label: 'ragged-rows',
      grid: [
        [TileType.EMPTY, TileType.EMPTY, TileType.INDESTRUCTIBLE_WALL],
        [TileType.EMPTY],
      ],
    },
    {
      label: 'exit-mixed',
      grid: makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 0, tile: TileType.EXIT },
        { x: 2, y: 2, tile: TileType.EXIT },
        { x: 0, y: 2, tile: TileType.CHEST },
      ]),
    },
    { label: 'empty-grid-rows', grid: [] },
  ];
}

/** Position families: dense sweep + OOB edge/corner straddles + fully outside. */
function positionFamily(grid: number[][]): Array<{ x: number; y: number; label: string }> {
  const cols = grid[0]?.length ?? 0;
  const rows = grid.length;
  const mapW = cols * TILE_SIZE;
  const mapH = rows * TILE_SIZE;
  const positions: Array<{ x: number; y: number; label: string }> = [];

  // Dense sweep across the map plus generous OOB margins on both axes.
  for (let x = -3 * TILE_SIZE; x <= mapW + 3 * TILE_SIZE; x += 32) {
    for (let y = -3 * TILE_SIZE; y <= mapH + 3 * TILE_SIZE; y += 32) {
      positions.push({ x, y, label: 'dense' });
    }
  }

  // Edge straddles: centers whose 96px AABB crosses each grid edge by sub-
  // hitbox/hitbox offsets (including exact alignment — the TILE_EDGE_EPSILON
  // boundary — and half-pixel offsets that dodge it).
  const offsets = [-97, -96.5, -96, -95, -49, -48.5, -48, -47, -1, -0.5, 0, 0.5, 1, 47, 48, 48.5, 49, 95, 96, 96.5, 97];
  const insideX = mapW / 2;
  const insideY = mapH / 2;
  for (const off of offsets) {
    positions.push({ x: 0 + off, y: insideY, label: 'straddle-left-edge' });
    positions.push({ x: mapW + off, y: insideY, label: 'straddle-right-edge' });
    positions.push({ x: insideX, y: 0 + off, label: 'straddle-top-edge' });
    positions.push({ x: insideX, y: mapH + off, label: 'straddle-bottom-edge' });
  }

  // Fully outside (whole AABB beyond the edge) on each side, all four outside
  // corners, and one far-outside probe.
  positions.push({ x: -200, y: insideY, label: 'outside-left' });
  positions.push({ x: mapW + 200, y: insideY, label: 'outside-right' });
  positions.push({ x: insideX, y: -200, label: 'outside-top' });
  positions.push({ x: insideX, y: mapH + 200, label: 'outside-bottom' });
  positions.push({ x: -200, y: -200, label: 'outside-corner-tl' });
  positions.push({ x: mapW + 200, y: -200, label: 'outside-corner-tr' });
  positions.push({ x: -200, y: mapH + 200, label: 'outside-corner-bl' });
  positions.push({ x: mapW + 200, y: mapH + 200, label: 'outside-corner-br' });
  positions.push({ x: -10000, y: 10000, label: 'far-outside' });

  return positions;
}

describe('ClientCollisionService fallback → shared resolveSimpleTileCollision (ticket 43 option b)', () => {
  it('is numerically identical to the verbatim old client branch across the OOB-heavy battery', () => {
    let compared = 0;

    for (const scenario of gridBattery()) {
      const renderer = makeMockMapRenderer(scenario.grid);
      const modern = new ClientCollisionService(renderer);
      const oracle = new OldFallbackBranchOracle(renderer);

      const halfPairs: Array<[number, number]> = [
        [48, 48], // production PLAYER hitbox
        [24, 48],
        [64, 32],
      ];
      for (const [halfW, halfH] of halfPairs) {
        for (const p of positionFamily(scenario.grid)) {
          const a = modern.resolveCollision(p.x, p.y, halfW, halfH);
          const b = oracle.resolveCollision(p.x, p.y, halfW, halfH);
          compared++;
          // Exact equality: identical float ops in identical order.
          if (a.x !== b.x || a.y !== b.y) {
            throw new Error(
              `parity drift [${scenario.label}] half=(${halfW},${halfH}) at (${p.x},${p.y}) ` +
                `[${p.label}]: modern=(${a.x},${a.y}) old-branch=(${b.x},${b.y})`,
            );
          }
        }
      }
    }
    // Sanity: the battery is non-trivial (thousands of positions).
    expect(compared).toBeGreaterThan(3000);
  });

  it('keeps OOB=SOLID observable: an entity straddling the left grid edge is pushed back', () => {
    // The shared enriched resolver's no-visual fallback would SKIP the
    // out-of-grid column and leave the entity overlapping it; the old client
    // branch (and now the shared resolveSimple loop) resolves against it as a
    // solid full-tile AABB. This pins the exact OOB=SOLID behavior that
    // option (b) was chosen to preserve.
    //
    // Hand-traced (same geometry as the server OOB test): AABB corner at
    // (-30, 100) → the two OOB tiles at gx=-1 resolve y +28 then x +30 →
    // corner {0, 128} → clamps no-op → center {0+48, 128+48} = {48, 176}.
    const grid = makeGrid(3, 3, TileType.EMPTY);
    const service = new ClientCollisionService(makeMockMapRenderer(grid));
    const out = service.resolveCollision(-30 + HALF_W, 100 + HALF_H, HALF_W, HALF_H);
    expect(out.x).toBe(48);
    expect(out.y).toBe(128 + HALF_H);
  });

  it('shared isSimpleTileBlocked equals the old client predicate for every in/out-of-bounds coordinate', () => {
    for (const scenario of gridBattery()) {
      if (scenario.grid.length === 0) continue;
      const cols = scenario.grid[0]!.length;
      const rows = scenario.grid.length;
      const oracle = new OldFallbackBranchOracle({ getGrid: () => scenario.grid });
      for (let gy = -3; gy <= rows + 3; gy++) {
        for (let gx = -3; gx <= cols + 3; gx++) {
          expect(isSimpleTileBlocked(scenario.grid, gx, gy)).toBe(
            oracle.isTileBlocked(gx, gy, scenario.grid),
          );
        }
      }
    }
  });
});

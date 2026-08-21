import { describe, it, expect } from 'vitest';
import {
  AABBCollision,
  forEachOverlappingTile,
  isSimpleTileBlocked,
  type AABB,
  type MTV,
  TileType,
} from '@sector-battle/shared';
import { CollisionService } from '../../../src/domain/services/CollisionService.ts';

/**
 * Ticket 43 re-triage (option b) — SERVER bit-identity gate.
 *
 * `CollisionService.resolveSimple` now delegates its per-tile loop to the
 * shared pure helper `resolveSimpleTileCollision`. This file proves that
 * routing is BIT-EXACT against a verbatim replica of the pre-ticket inline
 * loop (the session-1 oracle convention: transcribe the deleted code into the
 * test, exact `===` equality on resolved positions), including the
 * out-of-bounds=SOLID boundary cases and degenerate-grid shapes.
 *
 * The service under test is the REAL CollisionService with NO enriched grid
 * (setEnrichedGrid never called), so `resolveTileCollision` dispatches to the
 * resolveSimple path — the exact production non-enriched branch.
 */

const TILE_SIZE = 128;

function makeGrid(
  rows: number,
  cols: number,
  fill: TileType,
  overrides?: Array<{ x: number; y: number; tile: TileType }>,
): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  if (overrides) for (const o of overrides) grid[o.y]![o.x] = o.tile;
  return grid;
}

// ── Verbatim replica of the deleted resolveSimple loop (pre-ticket 43) ──────

class LegacyResolveSimpleOracle {
  private readonly mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
  constructor(private readonly tileSize: number) {}

  isTileBlocked(gridX: number, gridY: number, grid: TileType[][]): boolean {
    if (gridY < 0 || gridY >= grid.length) return true;
    if (gridX < 0 || gridX >= grid[0]!.length) return true;
    const tile = grid[gridY]![gridX]!;
    return tile !== TileType.EMPTY && tile !== TileType.EXIT;
  }

  tileToAABB(gridX: number, gridY: number): AABB {
    return {
      x: gridX * this.tileSize,
      y: gridY * this.tileSize,
      width: this.tileSize,
      height: this.tileSize,
    };
  }

  resolve(entity: AABB, grid: TileType[][]): { x: number; y: number } {
    let resolvedX = entity.x;
    let resolvedY = entity.y;

    forEachOverlappingTile(
      entity.x,
      entity.y,
      entity.width,
      entity.height,
      this.tileSize,
      (tileX, tileY) => {
        if (!this.isTileBlocked(tileX, tileY, grid)) return;

        const tileAABB = this.tileToAABB(tileX, tileY);

        const testX: AABB = { ...entity, x: resolvedX };
        const mtv = this.mtvScratch;
        if (AABBCollision.getMTVInto(testX, tileAABB, mtv) && Math.abs(mtv.x) > Math.abs(mtv.y)) {
          resolvedX += mtv.x > 0 ? mtv.depth : -mtv.depth;
        }

        const testY: AABB = { ...entity, x: resolvedX, y: resolvedY };
        if (
          AABBCollision.getMTVInto(testY, tileAABB, mtv) &&
          Math.abs(mtv.y) >= Math.abs(mtv.x)
        ) {
          resolvedY += mtv.y > 0 ? mtv.depth : -mtv.depth;
        }
      },
    );

    return { x: resolvedX, y: resolvedY };
  }
}

// ── Shared battery of grids + position families ─────────────────────────────

function gridBattery(): Array<{ label: string; grid: TileType[][] }> {
  return [
    { label: 'empty-4x4', grid: makeGrid(4, 4, TileType.EMPTY) },
    {
      label: 'single-wall',
      grid: makeGrid(4, 4, TileType.EMPTY, [{ x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL }]),
    },
    {
      // Walls hugging every edge/corner — the OOB-solid neighbor interactions.
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
      // Ragged grid: row 1 shorter than row 0 → grid[1][2] is undefined → the
      // predicate's `!== EMPTY && !== EXIT` evaluates undefined as BLOCKED.
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
  ];
}

/** Position families: dense sweep + OOB edge/corner straddles + fully outside. */
function positionFamily(grid: TileType[][]): Array<{ x: number; y: number; label: string }> {
  const cols = grid[0]!.length;
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

  // Edge straddles: centers whose 96px AABB crosses each grid edge by a
  // family of sub-hitbox/hitbox offsets (including exact alignment, the
  // TILE_EDGE_EPSILON boundary case).
  const offsets = [-97, -96.5, -96, -95, -49, -48.5, -48, -47, -1, -0.5, 0, 0.5, 1, 47, 48, 48.5, 49, 95, 96, 96.5, 97];
  const insideX = mapW / 2;
  const insideY = mapH / 2;
  for (const off of offsets) {
    positions.push({ x: 0 + off, y: insideY, label: 'straddle-left-edge' });
    positions.push({ x: mapW + off, y: insideY, label: 'straddle-right-edge' });
    positions.push({ x: insideX, y: 0 + off, label: 'straddle-top-edge' });
    positions.push({ x: insideX, y: mapH + off, label: 'straddle-bottom-edge' });
  }

  // Fully outside (whole AABB beyond the edge) on each side + all four
  // outside corners + far outside.
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

describe('CollisionService.resolveSimple → shared resolveSimpleTileCollision (ticket 43 option b)', () => {
  it('is bit-identical to the verbatim pre-ticket inline loop across the full battery', () => {
    const service = new CollisionService(TILE_SIZE);
    const oracle = new LegacyResolveSimpleOracle(TILE_SIZE);
    let compared = 0;

    for (const scenario of gridBattery()) {
      const halfPairs: Array<[number, number]> = [
        [48, 48], // production PLAYER hitbox
        [24, 48],
        [64, 32],
      ];
      for (const [halfW, halfH] of halfPairs) {
        for (const p of positionFamily(scenario.grid)) {
          const entity: AABB = { x: p.x, y: p.y, width: halfW * 2, height: halfH * 2 };
          const viaService = service.resolveTileCollision(entity, scenario.grid);
          const viaOracle = oracle.resolve(entity, scenario.grid);
          compared++;
          if (viaService.x !== viaOracle.x || viaService.y !== viaOracle.y) {
            throw new Error(
              `bit-drift [${scenario.label}] half=(${halfW},${halfH}) at (${p.x},${p.y}) ` +
                `[${p.label}]: service=(${viaService.x},${viaService.y}) ` +
                `oracle=(${viaOracle.x},${viaOracle.y})`,
            );
          }
        }
      }
    }
    // Sanity: the battery is non-trivial (hundreds of positions per shape).
    expect(compared).toBeGreaterThan(3000);
  });

  it('keeps OOB=SOLID observable: an entity pushed past the left grid edge is resolved back', () => {
    // The shared enriched resolver's no-visual fallback SKIPS out-of-grid
    // tiles; resolveSimple (and the shared helper) treats them as solid. This
    // pins the exact behavior option (b) was chosen to preserve.
    //
    // Hand-traced: entity AABB [-30..66]×[100..196] overlaps the two virtual
    // OOB tiles at gx=-1 (rows gy=0 and gy=1). Tile (-1,0): overlapX=30 >
    // overlapY=28 → Y-axis MTV +28 (entity is below that tile) → y=128.
    // Tile (-1,1): overlapX=30 < overlapY=68 → X-axis MTV +30 → x=0 (the
    // left-edge push-back), then no residual Y overlap. Final {0, 128}.
    const service = new CollisionService(TILE_SIZE);
    const grid = makeGrid(3, 3, TileType.EMPTY);
    const entity: AABB = { x: -30, y: 100, width: 96, height: 96 };
    const out = service.resolveTileCollision(entity, grid);
    expect(out.x).toBe(0);
    expect(out.y).toBe(128);
  });

  it('shared isSimpleTileBlocked equals the oracle predicate for every in/out-of-bounds coordinate', () => {
    const oracle = new LegacyResolveSimpleOracle(TILE_SIZE);
    for (const scenario of gridBattery()) {
      const cols = scenario.grid[0]!.length;
      const rows = scenario.grid.length;
      for (let gy = -3; gy <= rows + 3; gy++) {
        for (let gx = -3; gx <= cols + 3; gx++) {
          expect(isSimpleTileBlocked(scenario.grid, gx, gy)).toBe(
            oracle.isTileBlocked(gx, gy, scenario.grid),
          );
        }
      }
    }
  });

  it('still returns the original position on a throwing (null) grid via the try/catch fallback', () => {
    const service = new CollisionService(TILE_SIZE);
    const entity: AABB = { x: 100, y: 200, width: 24, height: 24 };
    const result = service.resolveTileCollision(entity, null as unknown as TileType[][]);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });
});

// @vitest-environment node
// No DOM usage — node env keeps this runnable where the jsdom install is
// broken/unavailable (same convention as enriched-atlas-parity.test.ts).
import { describe, it, expect, vi } from 'vitest';
import {
  AABBCollision,
  forEachOverlappingTile,
  resolveTileCollisionEnriched,
  selectTileVisual,
  TileType,
  type AABB,
  type MTV,
  type TiledMapLayer,
} from '@sector-battle/shared';
import { ClientCollisionService } from '../ClientCollisionService.js';

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

function makeMockMapRenderer(
  grid: number[][],
  opts?: {
    atlas?: unknown;
    visualLayers?: unknown[];
    siegeWallVisual?: unknown;
  },
) {
  return {
    getGrid: vi.fn().mockReturnValue(grid),
    getTileSize: vi.fn().mockReturnValue(TILE_SIZE),
    getAtlas: vi.fn().mockReturnValue(opts?.atlas ?? null),
    getVisualLayers: vi.fn().mockReturnValue(opts?.visualLayers ?? []),
    getSiegeWallVisual: vi.fn().mockReturnValue(opts?.siegeWallVisual ?? null),
    isWalkable: vi.fn(),
  } as any;
}

describe('ClientCollisionService', () => {
  describe('resolveCollision', () => {
    it('returns unchanged position on empty grid', () => {
      const grid = makeGrid(3, 3, TileType.EMPTY);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const result = service.resolveCollision(62, 62, HALF_W, HALF_H);
      expect(result.x).toBeCloseTo(62, 4);
      expect(result.y).toBeCloseTo(62, 4);
    });

    it('pushes entity out on X axis when overlapping wall', () => {
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const centerX = 120 + HALF_W;
      const centerY = 10 + HALF_H;
      const result = service.resolveCollision(centerX, centerY, HALF_W, HALF_H);
      expect(result.x).toBeLessThan(centerX);
      expect(result.y).toBeCloseTo(centerY, 4);
    });

    it('pushes entity out on Y axis when overlapping wall', () => {
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 0, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const centerX = 10 + HALF_W;
      const centerY = 120 + HALF_H;
      const result = service.resolveCollision(centerX, centerY, HALF_W, HALF_H);
      expect(result.y).toBeLessThan(centerY);
      expect(result.x).toBeCloseTo(centerX, 4);
    });

    it('allows entity to slide along wall face', () => {
      const grid = makeGrid(1, 5, TileType.EMPTY, [
        { x: 2, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const centerX = 246 + HALF_W;
      const centerY = 10 + HALF_H;
      const result = service.resolveCollision(centerX, centerY, HALF_W, HALF_H);
      expect(result.x).not.toBe(centerX);
    });

    it('resolves both axes at corner with two walls', () => {
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
        { x: 0, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const centerX = 118 + HALF_W / 2;
      const centerY = 118 + HALF_H / 2;
      const result = service.resolveCollision(centerX, centerY, HALF_W / 2, HALF_H / 2);
      expect(result.x !== centerX || result.y !== centerY).toBe(true);
    });

    it('clamps entity within map bounds', () => {
      const grid = makeGrid(2, 2, TileType.EMPTY);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const result = service.resolveCollision(240 + HALF_W, 240 + HALF_H, HALF_W, HALF_H);
      expect(result.x).toBeLessThan(240 + HALF_W);
      expect(result.y).toBeLessThan(240 + HALF_H);
    });

    it('pushes entity out when fully inside wall', () => {
      const grid: number[][] = [[TileType.INDESTRUCTIBLE_WALL]];
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const result = service.resolveCollision(50 + HALF_W, 50 + HALF_H, HALF_W, HALF_H);
      expect(result.x !== 50 + HALF_W || result.y !== 50 + HALF_H).toBe(true);
    });

    it('returns unchanged position when grid is empty', () => {
      const mock = {
        getGrid: vi.fn().mockReturnValue([]),
        getTileSize: vi.fn().mockReturnValue(TILE_SIZE),
        getAtlas: vi.fn().mockReturnValue(null),
        getVisualLayers: vi.fn().mockReturnValue([]),
        isWalkable: vi.fn(),
      } as any;
      const service = new ClientCollisionService(mock);
      const result = service.resolveCollision(100, 200, HALF_W, HALF_H);
      expect(result.x).toBe(100);
      expect(result.y).toBe(200);
    });

    it('treats EXIT tile as walkable', () => {
      const grid = makeGrid(3, 3, TileType.EXIT);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const result = service.resolveCollision(62, 62, HALF_W, HALF_H);
      expect(result.x).toBeCloseTo(62, 4);
      expect(result.y).toBeCloseTo(62, 4);
    });

    it('uses enriched SAT colliders when atlas and visualLayers are present', () => {
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const atlas = {
        sprites: [
          {
            id: 0,
            imagePath: 'wall',
            tileType: TileType.INDESTRUCTIBLE_WALL,
            colliders: [{ type: 'rect' as const, x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
          },
        ],
      };
      const visualLayers = [
        {
          name: 'test',
          cells: Array.from({ length: 3 }, (_, r) =>
            Array.from({ length: 3 }, (_, c) =>
              r === 1 && c === 1
                ? { spriteId: 0, rotation: 0 as const, flipH: false, flipV: false }
                : { spriteId: -1, rotation: 0 as const, flipH: false, flipV: false },
            ),
          ),
        },
      ];
      const mock = {
        getGrid: vi.fn().mockReturnValue(grid),
        getTileSize: vi.fn().mockReturnValue(TILE_SIZE),
        getAtlas: vi.fn().mockReturnValue(atlas),
        getVisualLayers: vi.fn().mockReturnValue(visualLayers),
        getSiegeWallVisual: vi.fn().mockReturnValue(null),
        isWalkable: vi.fn(),
      } as any;
      const service = new ClientCollisionService(mock);
      const centerX = TILE_SIZE + HALF_W;
      const centerY = TILE_SIZE + HALF_H;
      const result = service.resolveCollision(centerX, centerY, HALF_W, HALF_H);
      expect(result.x !== centerX || result.y !== centerY).toBe(true);
    });

    it('falls back to simple AABB for enriched tiles with no visual data', () => {
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const atlas = { sprites: [] };
      const visualLayers = [
        {
          name: 'test',
          cells: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => null)),
        },
      ];
      const mock = {
        getGrid: vi.fn().mockReturnValue(grid),
        getTileSize: vi.fn().mockReturnValue(TILE_SIZE),
        getAtlas: vi.fn().mockReturnValue(atlas),
        getVisualLayers: vi.fn().mockReturnValue(visualLayers),
        getSiegeWallVisual: vi.fn().mockReturnValue(null),
        isWalkable: vi.fn(),
      } as any;
      const service = new ClientCollisionService(mock);
      const centerX = 120 + HALF_W;
      const centerY = 10 + HALF_H;
      const result = service.resolveCollision(centerX, centerY, HALF_W, HALF_H);
      expect(result.x).toBeLessThan(centerX);
      expect(result.y).toBeCloseTo(centerY, 4);
    });
  });

  // ── Ticket #36 parity sweep ─────────────────────────────────────────────
  //
  // LegacyClientCollisionService is a VERBATIM transcription of the
  // pre-ticket-36 resolveCollision (per-call entity literal, per-call
  // CollisionGridProvider literal, per-tile tileToAABB literals, spread-copied
  // testX/testY, per-nearby-player moving/otherAabb literals). The sweep below
  // asserts the zero-allocation scratch rewrite produces NUMERICALLY IDENTICAL
  // resolved positions (exact ===, not closeTo — the float expressions and
  // their evaluation order are unchanged, so any drift is a regression).
  class LegacyClientCollisionService {
    private mapRenderer: any;
    private readonly mtvScratch: MTV = { x: 0, y: 0, depth: 0 };
    private nearbyPlayers: ReadonlyArray<{ x: number; y: number }> = [];

    constructor(mapRenderer: any) {
      this.mapRenderer = mapRenderer;
    }

    setNearbyPlayers(positions: ReadonlyArray<{ x: number; y: number }>): void {
      this.nearbyPlayers = positions;
    }

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

      const entity: AABB = {
        x: centerX - halfW,
        y: centerY - halfH,
        width: halfW * 2,
        height: halfH * 2,
      };

      const atlas = this.mapRenderer.getAtlas();
      const visualLayers = this.mapRenderer.getVisualLayers();
      const hasEnriched = atlas !== null && visualLayers.length > 0;

      let resolvedX = entity.x;
      let resolvedY = entity.y;

      if (hasEnriched) {
        const provider = {
          getVisual: (gx: number, gy: number) => this.findCellVisual(gx, gy, visualLayers),
          getSprite: (spriteId: number) => atlas.sprites[spriteId],
          getTileSize: () => tileSize,
        };
        const resolved = { x: 0, y: 0 };
        resolveTileCollisionEnriched(entity, grid, provider, this.mtvScratch, resolved);
        resolvedX = resolved.x;
        resolvedY = resolved.y;
      } else {
        forEachOverlappingTile(
          resolvedX,
          resolvedY,
          entity.width,
          entity.height,
          tileSize,
          (tileX: number, tileY: number) => {
            if (!this.isTileBlocked(tileX, tileY, grid)) return;
            const tileAABB = this.tileToAABB(tileX, tileY, tileSize);
            const testX: AABB = { ...entity, x: resolvedX };
            const mtv = this.mtvScratch;
            if (
              AABBCollision.getMTVInto(testX, tileAABB, mtv) &&
              Math.abs(mtv.x) > Math.abs(mtv.y)
            ) {
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
      }

      const maxCols = grid[0]?.length ?? 0;
      const maxRows = grid.length;
      resolvedX = this.clampBounds(resolvedX, entity.width, maxCols * tileSize);
      resolvedY = this.clampBounds(resolvedY, entity.height, maxRows * tileSize);

      let outX = resolvedX + halfW;
      let outY = resolvedY + halfH;
      const others = this.nearbyPlayers;
      if (others.length > 0) {
        const mtv = this.mtvScratch;
        for (let i = 0; i < others.length; i++) {
          const o = others[i]!;
          const moving: AABB = {
            x: outX - halfW,
            y: outY - halfH,
            width: halfW * 2,
            height: halfH * 2,
          };
          const otherAabb: AABB = {
            x: o.x - halfW,
            y: o.y - halfH,
            width: halfW * 2,
            height: halfH * 2,
          };
          if (AABBCollision.getMTVInto(moving, otherAabb, mtv)) {
            const ox = mtv.x !== 0 ? mtv.x * mtv.depth : 0;
            const oy = mtv.y !== 0 ? mtv.y * mtv.depth : 0;
            outX += ox;
            outY += oy;
          }
        }
      }

      return { x: outX, y: outY };
    }

    private isTileBlocked(gridX: number, gridY: number, grid: number[][]): boolean {
      if (gridY < 0 || gridY >= grid.length) return true;
      if (gridX < 0 || gridX >= (grid[0]?.length ?? 0)) return true;
      const tile = grid[gridY]![gridX]!;
      return tile !== TileType.EMPTY && tile !== TileType.EXIT;
    }

    private tileToAABB(gridX: number, gridY: number, tileSize: number): AABB {
      return {
        x: gridX * tileSize,
        y: gridY * tileSize,
        width: tileSize,
        height: tileSize,
      };
    }

    private findCellVisual(gridX: number, gridY: number, visualLayers: TiledMapLayer[]) {
      const siegeOverride = this.mapRenderer.getSiegeWallVisual(gridX, gridY);
      if (siegeOverride) return siegeOverride;
      return selectTileVisual(visualLayers, gridX, gridY);
    }

    private clampBounds(pos: number, size: number, mapExtent: number): number {
      if (pos < 0) pos = 0;
      if (pos + size > mapExtent) pos = mapExtent - size;
      return pos;
    }
  }

  describe('zero-alloc scratch parity (ticket #36)', () => {
    const HALF_PAIRS: Array<[number, number]> = [
      [48, 48],
      [24, 48],
      [64, 32],
    ];
    const NEARBY_CONFIGS: Array<Array<{ x: number; y: number }>> = [
      [],
      [{ x: 300, y: 300 }], // exact self-overlap at a sweep position
      [
        { x: 260, y: 300 }, // X-only overlap
        { x: 300, y: 340 }, // Y-only overlap
      ],
      [
        { x: 272, y: 272 },
        { x: 352, y: 312 },
        { x: 308, y: 384 }, // multi-player MTV accumulation chain
      ],
    ];

    function visualLayersFor(
      rows: number,
      cols: number,
      marked: Array<{ x: number; y: number; spriteId: number; rotation?: number }>,
    ): TiledMapLayer[] {
      const cells = Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => {
          const hit = marked.find((m) => m.x === c && m.y === r);
          if (!hit) return { spriteId: -1, rotation: 0, flipH: false, flipV: false };
          return {
            spriteId: hit.spriteId,
            rotation: hit.rotation ?? 0,
            flipH: false,
            flipV: false,
          };
        }),
      );
      return [{ name: 'parity', cells }] as unknown as TiledMapLayer[];
    }

    it('produces numerically identical resolved positions across a geometric sweep', () => {
      // Deterministic scenario set: plain-grid branches (empty / walls /
      // out-of-bounds probes) plus enriched branches (SAT collider, rotated SAT
      // collider, enriched no-visual AABB fallback).
      const scenarios: Array<{
        label: string;
        grid: number[][];
        atlas?: unknown;
        visualLayers?: TiledMapLayer[];
      }> = [
        {
          label: 'empty-4x4',
          grid: makeGrid(4, 4, TileType.EMPTY),
        },
        {
          label: 'single-wall',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
          ]),
        },
        {
          label: 'corner-walls',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 2, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 0, y: 2, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 2, y: 2, tile: TileType.DESTRUCTIBLE_WALL },
          ]),
        },
        {
          label: 'wall-lines-5x5',
          grid: makeGrid(5, 5, TileType.EMPTY, [
            { x: 2, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 2, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 2, y: 2, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 0, y: 3, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 3, y: 3, tile: TileType.DESTRUCTIBLE_WALL },
            { x: 4, y: 3, tile: TileType.INDESTRUCTIBLE_WALL },
          ]),
        },
        {
          label: 'all-walls-3x3',
          grid: makeGrid(3, 3, TileType.INDESTRUCTIBLE_WALL),
        },
        {
          label: 'exit-row',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 0, y: 2, tile: TileType.EXIT },
            { x: 1, y: 2, tile: TileType.EXIT },
          ]),
        },
        {
          label: 'enriched-sat-fulltile',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
          ]),
          atlas: {
            sprites: [
              {
                id: 0,
                imagePath: 'wall',
                tileType: TileType.INDESTRUCTIBLE_WALL,
                colliders: [{ type: 'rect', x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
              },
            ],
          },
          visualLayers: visualLayersFor(4, 4, [{ x: 1, y: 1, spriteId: 0 }]),
        },
        {
          label: 'enriched-sat-rotated-half',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 1, y: 2, tile: TileType.INDESTRUCTIBLE_WALL },
            { x: 2, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
          ]),
          atlas: {
            sprites: [
              {
                id: 0,
                imagePath: 'wall-half',
                tileType: TileType.INDESTRUCTIBLE_WALL,
                colliders: [
                  {
                    type: 'rect',
                    x: TILE_SIZE / 4,
                    y: TILE_SIZE / 4,
                    width: TILE_SIZE / 2,
                    height: TILE_SIZE / 2,
                  },
                ],
              },
            ],
          },
          // (2,0) grid-marked wall but spriteId -1 → enriched AABB fallback;
          // (1,2) rotated half-tile collider → SAT path.
          visualLayers: visualLayersFor(4, 4, [{ x: 1, y: 2, spriteId: 0, rotation: 90 }]),
        },
      ];

      for (const scenario of scenarios) {
        const renderer = makeMockMapRenderer(scenario.grid, {
          atlas: scenario.atlas,
          visualLayers: scenario.visualLayers,
        });
        const modern = new ClientCollisionService(renderer);
        const legacy = new LegacyClientCollisionService(renderer);

        for (const nearby of NEARBY_CONFIGS) {
          // Ticket #37: modern takes (array, count); count === length here so
          // both sides consider the identical full set.
          modern.setNearbyPlayers(nearby, nearby.length);
          legacy.setNearbyPlayers(nearby);

          for (const [halfW, halfH] of HALF_PAIRS) {
            // Sweep centers across the map plus out-of-bounds margins on both
            // axes: exercises tile MTVs, corner double-resolution, bounds
            // clamping, out-of-bounds blocked tiles, and the nearby-player
            // separation loop (overlapping at various sweep positions).
            // Step 32 against TILE_SIZE 128 / halves 48/24/64 phases the AABB
            // edges across tile boundaries (including exact alignments).
            for (let cx = -64; cx <= 4 * TILE_SIZE + 64; cx += 32) {
              for (let cy = -64; cy <= 4 * TILE_SIZE + 64; cy += 32) {
                const a = modern.resolveCollision(cx, cy, halfW, halfH);
                // Perf ticket 21: the pooled out-param variant (the hot-path
                // form the prediction/reconciler seams now use) must be
                // numerically identical to the fresh-object path — same body,
                // caller-owned receptacle.
                const pooled = modern.resolveCollisionInto(cx, cy, halfW, halfH, {
                  x: Number.NaN,
                  y: Number.NaN,
                });
                if (pooled.x !== a.x || pooled.y !== a.y) {
                  throw new Error(
                    `pooled-variant drift [${scenario.label}] at (${cx},${cy}): ` +
                      `fresh=(${a.x},${a.y}) pooled=(${pooled.x},${pooled.y})`,
                  );
                }
                const b = legacy.resolveCollision(cx, cy, halfW, halfH);
                // Exact equality: identical float ops in identical order.
                if (a.x !== b.x || a.y !== b.y) {
                  throw new Error(
                    `parity drift [${scenario.label}] nearby=${JSON.stringify(nearby)} ` +
                      `half=(${halfW},${halfH}) at (${cx},${cy}): ` +
                      `modern=(${a.x},${a.y}) legacy=(${b.x},${b.y})`,
                  );
                }
              }
            }
          }
        }
      }
    });

    it('ignores the stale pool tail beyond count — identical to the pre-#37 slice (ticket #37)', () => {
      // Production shape post-#37: GameScene publishes the POOLED array whose
      // live prefix is [0, count); the tail holds earlier frames' entries.
      // Oracle: pre-#37 behavior — GameScene delivered pool.slice(0, count)
      // to the length-bounded service (the frozen legacy class models that).
      // Exact equality across the sweep proves no stale tail entry is ever
      // consulted: the tail below is adversarial (clustered near the map
      // center so many sweep centers overlap it and would shove if read).
      const STALE_TAIL: Array<{ x: number; y: number }> = [
        { x: 256, y: 256 },
        { x: 288, y: 272 },
        { x: 240, y: 304 },
      ];
      const scenarios: Array<{
        label: string;
        grid: number[][];
        atlas?: unknown;
        visualLayers?: TiledMapLayer[];
      }> = [
        { label: 'empty-4x4', grid: makeGrid(4, 4, TileType.EMPTY) },
        {
          label: 'single-wall',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
          ]),
        },
        {
          label: 'enriched-sat-fulltile',
          grid: makeGrid(4, 4, TileType.EMPTY, [
            { x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
          ]),
          atlas: {
            sprites: [
              {
                id: 0,
                imagePath: 'wall',
                tileType: TileType.INDESTRUCTIBLE_WALL,
                colliders: [{ type: 'rect', x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
              },
            ],
          },
          visualLayers: visualLayersFor(4, 4, [{ x: 1, y: 1, spriteId: 0 }]),
        },
      ];

      for (const scenario of scenarios) {
        const renderer = makeMockMapRenderer(scenario.grid, {
          atlas: scenario.atlas,
          visualLayers: scenario.visualLayers,
        });
        const modern = new ClientCollisionService(renderer);
        const legacy = new LegacyClientCollisionService(renderer);

        for (const live of NEARBY_CONFIGS) {
          // Pooled array = live prefix + stale tail; count covers only live.
          const pooled = [...live, ...STALE_TAIL];
          modern.setNearbyPlayers(pooled, live.length);
          // What the OLD GameScene delivered: a copy of exactly [0, count).
          legacy.setNearbyPlayers(live);

          for (const [halfW, halfH] of HALF_PAIRS) {
            for (let cx = -64; cx <= 4 * TILE_SIZE + 64; cx += 32) {
              for (let cy = -64; cy <= 4 * TILE_SIZE + 64; cy += 32) {
                const a = modern.resolveCollision(cx, cy, halfW, halfH);
                const b = legacy.resolveCollision(cx, cy, halfW, halfH);
                if (a.x !== b.x || a.y !== b.y) {
                  throw new Error(
                    `stale-tail parity drift [${scenario.label}] live=${JSON.stringify(live)} ` +
                      `half=(${halfW},${halfH}) at (${cx},${cy}): ` +
                      `modern=(${a.x},${a.y}) legacy-slice=(${b.x},${b.y})`,
                  );
                }
              }
            }
          }
        }
      }
    });

    it('a coincident stale entry past the count does not separate (ticket #37)', () => {
      const grid = makeGrid(4, 4, TileType.EMPTY);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      // Entry 0 is live but far away (no interaction); entry 1 is STALE tail
      // sitting exactly on the query center. getMTVInto on coincident 96×96
      // AABBs (overlapX = overlapY = 96 → Y branch, sign +1) shoves +Y by 96
      // — so if the loop ever regressed to .length-bounded, this fails loudly.
      const pool = [
        { x: 5000, y: 5000 },
        { x: 320, y: 320 },
      ];
      service.setNearbyPlayers(pool, 1);
      const out = service.resolveCollision(320, 320, HALF_W, HALF_H);
      expect(out.x).toBe(320);
      expect(out.y).toBe(320);
      // Control: the SAME tail entry IS consulted once the count covers it —
      // guards against the assertions above passing vacuously.
      service.setNearbyPlayers(pool, 2);
      const outShoved = service.resolveCollision(320, 320, HALF_W, HALF_H);
      expect(outShoved.x !== 320 || outShoved.y !== 320).toBe(true);
    });
  });

  // ── Perf ticket 21 — pooled out-param receptacle ─────────────────────────
  describe('resolveCollisionInto (pooled out-param)', () => {
    it('returns the caller-owned receptacle identity and fully overwrites it', () => {
      const grid = makeGrid(4, 4, TileType.EMPTY, [
        { x: 1, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const out = { x: Number.NaN, y: Number.NaN };
      const ret = service.resolveCollisionInto(200, 200, HALF_W, HALF_H, out);
      expect(ret).toBe(out); // documented: returns `out` itself
      expect(Number.isFinite(ret.x)).toBe(true); // NaN sentinels fully overwritten
      expect(Number.isFinite(ret.y)).toBe(true);
    });

    it('writes the empty-grid passthrough into the receptacle (no stale values)', () => {
      const mock = {
        getGrid: vi.fn().mockReturnValue([]),
        getTileSize: vi.fn().mockReturnValue(TILE_SIZE),
        getAtlas: vi.fn().mockReturnValue(null),
        getVisualLayers: vi.fn().mockReturnValue([]),
        isWalkable: vi.fn(),
      } as any;
      const service = new ClientCollisionService(mock);
      const out = { x: 12345, y: -6789 };
      service.resolveCollisionInto(100, 200, HALF_W, HALF_H, out);
      expect(out.x).toBe(100);
      expect(out.y).toBe(200);
    });

    it('one reused box across a sequential substep burst yields fresh results per call', () => {
      // Models the production seam: simulatePhysicsStepInto reads .x/.y
      // synchronously, then the SAME box is reused for the next substep —
      // each call must fully overwrite the receptacle (no cross-substep
      // contamination from the previous resolved position).
      const grid = makeGrid(4, 4, TileType.EMPTY, [
        { x: 2, y: 2, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const service = new ClientCollisionService(makeMockMapRenderer(grid));
      const out = { x: 0, y: 0 };
      for (let cx = 64; cx < 4 * 128; cx += 16) {
        const expected = service.resolveCollision(cx, 192, HALF_W, HALF_H);
        service.resolveCollisionInto(cx, 192, HALF_W, HALF_H, out);
        expect(out.x).toBe(expected.x);
        expect(out.y).toBe(expected.y);
      }
    });
  });
});

import { TileType } from '@sector-battle/shared';
import type { AABB } from '@sector-battle/shared';
import { CollisionService } from '../../../src/domain/services/CollisionService.ts';

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

describe('CollisionService', () => {
  describe('constructor', () => {
    it('creates instance without error', () => {
      const service = new CollisionService(TILE_SIZE);
      expect(service).toBeDefined();
    });
  });

  describe('isTileBlocked', () => {
    describe('walkable tiles', () => {
      it('returns false for EMPTY', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.EMPTY]])).toBe(false);
      });

      it('returns false for EXIT', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.EXIT]])).toBe(false);
      });
    });

    describe('blocking tiles', () => {
      it('returns true for INDESTRUCTIBLE_WALL', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.INDESTRUCTIBLE_WALL]])).toBe(true);
      });

      it('returns true for DESTRUCTIBLE_WALL', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.DESTRUCTIBLE_WALL]])).toBe(true);
      });

      it('returns true for DESTRUCTIBLE_CRATE', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.DESTRUCTIBLE_CRATE]])).toBe(true);
      });

      it('returns true for DESTRUCTIBLE_BARREL', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.DESTRUCTIBLE_BARREL]])).toBe(true);
      });

      it('returns true for INDESTRUCTIBLE_CRATE', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.INDESTRUCTIBLE_CRATE]])).toBe(true);
      });

      it('returns true for CHEST', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.CHEST]])).toBe(true);
      });

      it('returns true for DOOR_CLOSED', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 0, [[TileType.DOOR_CLOSED]])).toBe(true);
      });
    });

    describe('out of bounds', () => {
      it('returns true for negative X', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(-1, 0, [[TileType.EMPTY]])).toBe(true);
      });

      it('returns true for negative Y', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, -1, [[TileType.EMPTY]])).toBe(true);
      });

      it('returns true when X exceeds grid width', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(5, 0, [[TileType.EMPTY]])).toBe(true);
      });

      it('returns true when Y exceeds grid height', () => {
        const service = new CollisionService(TILE_SIZE);
        expect(service.isTileBlocked(0, 5, [[TileType.EMPTY]])).toBe(true);
      });
    });
  });

  describe('resolveTileCollision', () => {
    it('returns unchanged position on empty grid', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid = makeGrid(3, 3, TileType.EMPTY);
      const entity: AABB = { x: 50, y: 50, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, grid);
      expect(result.x).toBe(50);
      expect(result.y).toBe(50);
    });

    it('pushes entity out on X axis when overlapping wall', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const entity: AABB = { x: 120, y: 10, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, grid);
      expect(result.x).toBeLessThan(120);
      expect(result.y).toBe(10);
    });

    it('pushes entity out on Y axis when overlapping wall', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 0, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const entity: AABB = { x: 10, y: 120, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, grid);
      expect(result.y).toBeLessThan(120);
      expect(result.x).toBe(10);
    });

    it('allows entity to slide along wall face', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid = makeGrid(1, 5, TileType.EMPTY, [
        { x: 2, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const entity: AABB = { x: 246, y: 10, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, grid);
      const xChanged = result.x !== entity.x;
      const yChanged = result.y !== entity.y;
      expect(xChanged || yChanged).toBe(true);
    });

    it('resolves both axes at corner with two walls', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid = makeGrid(3, 3, TileType.EMPTY, [
        { x: 1, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
        { x: 0, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const entity: AABB = { x: 118, y: 118, width: 20, height: 20 };
      const result = service.resolveTileCollision(entity, grid);
      expect(result.x !== 118 || result.y !== 118).toBe(true);
    });

    it('pushes entity back in-bounds at map edge', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid = makeGrid(2, 2, TileType.EMPTY);
      const entity: AABB = { x: 240, y: 240, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, grid);
      expect(result.x).toBeLessThan(entity.x);
      expect(result.y).toBeLessThan(entity.y);
    });

    it('pushes entity out when fully inside wall', () => {
      const service = new CollisionService(TILE_SIZE);
      const grid: TileType[][] = [[TileType.INDESTRUCTIBLE_WALL]];
      const entity: AABB = { x: 50, y: 50, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, grid);
      expect(result.x !== entity.x || result.y !== entity.y).toBe(true);
    });

    it('returns original position on null grid (safe fallback)', () => {
      const service = new CollisionService(TILE_SIZE);
      const entity: AABB = { x: 100, y: 200, width: 24, height: 24 };
      const result = service.resolveTileCollision(entity, null as unknown as TileType[][]);
      expect(result.x).toBe(100);
      expect(result.y).toBe(200);
    });
  });
});

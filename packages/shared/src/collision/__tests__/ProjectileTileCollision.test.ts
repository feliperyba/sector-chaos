import { describe, it, expect } from 'vitest';
import { TileType } from '../../enums/TileType.js';
import type { TileColliderData } from '../../map/tiledTypes.js';
import { ProjectileTileCollision } from '../ProjectileTileCollision.js';

const TILE_SIZE = 64;

function makeColliderData(spriteId: number): TileColliderData {
  return {
    tileSize: TILE_SIZE,
    atlas: {
      sprites: [
        {
          id: spriteId,
          imagePath: 'test.png',
          tileType: TileType.INDESTRUCTIBLE_WALL,
          colliders: [{ type: 'rect', x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE }],
        },
      ],
    },
    visuals: [],
  };
}

function makeGrid(tileType: TileType, rows = 3, cols = 3): TileType[][] {
  const grid: TileType[][] = [];
  for (let y = 0; y < rows; y++) {
    const row: TileType[] = [];
    for (let x = 0; x < cols; x++) {
      row.push(tileType);
    }
    grid.push(row);
  }
  return grid;
}

function makeVisuals(spriteId: number, rows = 3, cols = 3) {
  const visuals: TileColliderData['visuals'] = [];
  for (let y = 0; y < rows; y++) {
    const row: TileColliderData['visuals'][number] = [];
    for (let x = 0; x < cols; x++) {
      row.push({ spriteId, rotation: 0, flipH: false, flipV: false });
    }
    visuals.push(row);
  }
  return visuals;
}

describe('ProjectileTileCollision', () => {
  describe('three-path collision', () => {
    it('skips EMPTY tiles', () => {
      const grid = makeGrid(TileType.EMPTY);
      const colliderData = makeColliderData(0);
      colliderData.visuals = makeVisuals(0);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, colliderData);

      expect(result.collided).toBe(false);
    });

    it('resolves sprite colliders on solid tile (wall)', () => {
      const grid = makeGrid(TileType.INDESTRUCTIBLE_WALL);
      const colliderData = makeColliderData(0);
      colliderData.visuals = makeVisuals(0);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, colliderData);

      expect(result.collided).toBe(true);
      expect(result.tileType).toBe(TileType.INDESTRUCTIBLE_WALL);
    });

    it('resolves sprite colliders on DESTRUCTIBLE_WALL tile', () => {
      const grid = makeGrid(TileType.DESTRUCTIBLE_WALL);
      const colliderData = makeColliderData(0);
      colliderData.visuals = makeVisuals(0);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, colliderData);

      expect(result.collided).toBe(true);
      expect(result.tileType).toBe(TileType.DESTRUCTIBLE_WALL);
    });

    it('CHEST tile now blocks projectiles (collider path)', () => {
      const grid = makeGrid(TileType.CHEST);
      const colliderData = makeColliderData(0);
      colliderData.visuals = makeVisuals(0);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, colliderData);

      expect(result.collided).toBe(true);
      expect(result.tileType).toBe(TileType.CHEST);
    });

    it('CHEST tile blocks projectiles (fallback AABB path when no collider data)', () => {
      const grid = makeGrid(TileType.CHEST);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, null);

      expect(result.collided).toBe(true);
      expect(result.tileType).toBe(TileType.CHEST);
    });

    it('skips EXIT tiles', () => {
      const grid = makeGrid(TileType.EXIT);
      const colliderData = makeColliderData(0);
      colliderData.visuals = makeVisuals(0);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, colliderData);

      expect(result.collided).toBe(false);
    });

    it('tile with zero colliders is passable', () => {
      const grid = makeGrid(TileType.INDESTRUCTIBLE_WALL);
      const colliderData: TileColliderData = {
        tileSize: TILE_SIZE,
        atlas: {
          sprites: [
            {
              id: 0,
              imagePath: 'test.png',
              tileType: TileType.INDESTRUCTIBLE_WALL,
              colliders: [],
            },
          ],
        },
        visuals: makeVisuals(0),
      };

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, colliderData);

      expect(result.collided).toBe(false);
    });

    it('fallback AABB when no collider data provided', () => {
      const grid = makeGrid(TileType.DESTRUCTIBLE_BARREL);

      const entity = {
        x: TILE_SIZE + 1,
        y: TILE_SIZE + 1,
        width: TILE_SIZE - 2,
        height: TILE_SIZE - 2,
      };

      const result = ProjectileTileCollision.check(entity, grid, TILE_SIZE, null);

      expect(result.collided).toBe(true);
      expect(result.tileType).toBe(TileType.DESTRUCTIBLE_BARREL);
    });
  });
});

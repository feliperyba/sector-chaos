import { TileType, emptyTileVisual, type TileColliderData } from '@sector-battle/shared';
import type { ICollisionService } from '../services/ICollisionService.ts';

export function isTileBlocked(grid: TileType[][], gridX: number, gridY: number): boolean {
  if (gridY < 0 || gridY >= grid.length) return true;
  if (gridX < 0 || gridX >= grid[0]!.length) return true;
  const tile = grid[gridY]![gridX]!;
  return (
    tile === TileType.INDESTRUCTIBLE_WALL ||
    tile === TileType.DESTRUCTIBLE_WALL ||
    tile === TileType.DESTRUCTIBLE_BARREL ||
    tile === TileType.INDESTRUCTIBLE_CRATE ||
    tile === TileType.DESTRUCTIBLE_CRATE ||
    tile === TileType.CHEST ||
    tile === TileType.DOOR_CLOSED
  );
}

export function getTileAt(grid: TileType[][], gridX: number, gridY: number): TileType {
  if (gridY < 0 || gridY >= grid.length) return TileType.INDESTRUCTIBLE_WALL;
  if (gridX < 0 || gridX >= grid[0]!.length) return TileType.INDESTRUCTIBLE_WALL;
  return grid[gridY]![gridX]!;
}

export function clearColliderVisual(
  colliderData: TileColliderData | null,
  gridX: number,
  gridY: number,
  collisionService: ICollisionService,
): void {
  if (colliderData) {
    const row = colliderData.visuals[gridY];
    if (row) row[gridX] = emptyTileVisual();
  }
  collisionService.clearEnrichedVisual(gridX, gridY);
}

export function setTileAt(
  grid: TileType[][],
  gridX: number,
  gridY: number,
  type: TileType,
  colliderData: TileColliderData | null,
  collisionService: ICollisionService,
): void {
  if (gridY >= 0 && gridY < grid.length && gridX >= 0 && gridX < grid[0]!.length) {
    grid[gridY]![gridX] = type;
    if (type === TileType.EMPTY) clearColliderVisual(colliderData, gridX, gridY, collisionService);
  }
}

export function worldToGrid(
  tileWidth: number,
  tileHeight: number,
  worldX: number,
  worldY: number,
): { gridX: number; gridY: number } {
  return {
    gridX: Math.floor(worldX / tileWidth),
    gridY: Math.floor(worldY / tileHeight),
  };
}

import type { Vec2 } from '../BotContext.ts';
import type { Pathfinder } from './Pathfinder.ts';

/**
 * Pathfinder line-of-sight helpers. Pure mechanical extraction from the
 * original Pathfinder class — bodies verbatim, `this.→pf.` only.
 */

export function pathfinderHasLineOfSight(pf: Pathfinder, from: Vec2, to: Vec2): boolean {
  const fromGrid = pf.worldToGrid(from);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = pf.worldToGrid(to);
  const toX = toGrid.x,
    toY = toGrid.y;
  const key = pf.cacheKeyNum(fromX, fromY, toX, toY);
  const cached = pf.losCache.get(key);
  if (cached !== undefined) return cached;

  const hasLOS = hasLineOfSightGrid(pf, fromX, fromY, toX, toY);
  pf.losCache.set(key, hasLOS);
  return hasLOS;
}

export function hasLineOfSightGrid(
  pf: Pathfinder,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let x = x0;
  let y = y0;
  const grid = pf.grid;
  const cols = pf.cols;

  while (true) {
    if (x < 0 || x >= cols || y < 0 || y >= grid.length || !grid[y]![x]) {
      return false;
    }

    if (x === x1 && y === y1) return true;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

export function pathfinderHasLineOfSightWorld(pf: Pathfinder, from: Vec2, to: Vec2): boolean {
  const fromGrid = pf.worldToGrid(from);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = pf.worldToGrid(to);
  const toX = toGrid.x,
    toY = toGrid.y;
  const key = pf.cacheKeyNum(fromX, fromY, toX, toY);
  const cached = pf.losCache.get(key);
  if (cached !== undefined) return cached;
  const result = hasLineOfSightGrid(pf, fromX, fromY, toX, toY);
  pf.losCache.set(key, result);
  return result;
}

export function pathfinderInvalidateLOSCache(pf: Pathfinder): void {
  pf.losCache.clear();
}

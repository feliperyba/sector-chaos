import { describe, it, expect } from 'vitest';
import { Pathfinder } from '../Pathfinder.ts';

const TILE = 128;

function allWalkable(rows: number, cols: number): boolean[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(true));
}

function withWall(grid: boolean[][], x: number, y: number): boolean[][] {
  const copy = grid.map((r) => [...r]);
  copy[y]![x] = false;
  return copy;
}

describe('Pathfinder.hasLineOfSight', () => {
  it('returns true when both points are in the same cell', () => {
    const pf = new Pathfinder(allWalkable(5, 5), TILE);
    expect(pf.hasLineOfSight({ x: 10, y: 10 }, { x: 20, y: 20 })).toBe(true);
  });

  it('returns true for unobstructed line on an empty grid', () => {
    const pf = new Pathfinder(allWalkable(5, 5), TILE);
    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 3 * TILE, y: 64 + 3 * TILE })).toBe(true);
  });

  it('returns false when a wall blocks the Bresenham line', () => {
    const base = allWalkable(5, 5);
    const grid = withWall(base, 1, 0);
    const pf = new Pathfinder(grid, TILE);
    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(false);
  });

  it('caches result — second call for the same pair hits cache', () => {
    const pf = new Pathfinder(allWalkable(5, 5), TILE);
    const fromX = 64;
    const fromY = 64;
    const toX = 64 + 3 * TILE;
    const toY = 64 + 2 * TILE;

    const first = pf.hasLineOfSight({ x: fromX, y: fromY }, { x: toX, y: toY });
    const second = pf.hasLineOfSight({ x: fromX, y: fromY }, { x: toX, y: toY });
    expect(second).toBe(first);
  });

  it('is symmetric: A→B and B→A return the same result and share one cache entry', () => {
    const base = allWalkable(5, 5);
    const grid = withWall(base, 2, 2);
    const pf = new Pathfinder(grid, TILE);

    const fromX = 64;
    const fromY = 64;
    const toX = 64 + 4 * TILE;
    const toY = 64 + 4 * TILE;

    const ab = pf.hasLineOfSight({ x: fromX, y: fromY }, { x: toX, y: toY });
    const ba = pf.hasLineOfSight({ x: toX, y: toY }, { x: fromX, y: fromY });
    expect(ab).toBe(ba);
  });

  it('returns false for a blocked line, verifying cache stores the correct value', () => {
    const base = allWalkable(5, 5);
    const grid = withWall(base, 2, 2);
    const pf = new Pathfinder(grid, TILE);

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 + 4 * TILE })).toBe(false);
  });
});

describe('Pathfinder.invalidateLOSCache', () => {
  it('clears the cache so the next call recomputes', () => {
    const base = allWalkable(5, 5);
    let grid = base;
    const pf = new Pathfinder(grid, TILE);

    const r1 = pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 3 * TILE, y: 64 + 3 * TILE });
    expect(r1).toBe(true);

    grid = withWall(base, 1, 0);
    pf.updateGrid(grid);
    pf.invalidateLOSCache();

    const r2 = pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 });
    expect(r2).toBe(false);
  });

  it('is cleared alongside the A* cache on updateGrid', () => {
    const pf = new Pathfinder(allWalkable(5, 5), TILE);
    pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 3 * TILE, y: 64 + 3 * TILE });

    pf.updateGrid(withWall(allWalkable(5, 5), 1, 0));

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(false);
  });

  it('is cleared alongside the A* cache on markCellWalkable', () => {
    const grid = withWall(allWalkable(5, 5), 1, 0);
    const pf = new Pathfinder(grid, TILE);
    const blocked = pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 });
    expect(blocked).toBe(false);

    pf.markCellWalkable(1, 0);

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(true);
  });

  it('is cleared alongside the A* cache on updateHazards', () => {
    const pf = new Pathfinder(allWalkable(5, 5), TILE);
    pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 3 * TILE, y: 64 + 3 * TILE });

    pf.updateHazards(new Set(['1,1']));

    pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 3 * TILE, y: 64 + 3 * TILE });
  });
});

describe('Pathfinder LOS cache — siege wall invalidation scenario', () => {
  it('LOS changes from true to false after a wall appears and cache is invalidated', () => {
    const grid = allWalkable(5, 5);
    const pf = new Pathfinder(grid, TILE);

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(true);

    grid[0]![1] = false;
    pf.invalidateLOSCache();

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(false);
  });
});

describe('Pathfinder LOS cache — destructible destroyed scenario', () => {
  it('LOS changes from false to true after a wall is removed and cache is invalidated', () => {
    const grid = withWall(allWalkable(5, 5), 1, 0);
    const pf = new Pathfinder(grid, TILE);

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(false);

    grid[0]![1] = true;
    pf.invalidateLOSCache();

    expect(pf.hasLineOfSight({ x: 64, y: 64 }, { x: 64 + 4 * TILE, y: 64 })).toBe(true);
  });
});

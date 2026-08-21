import { Pathfinder } from '../../src/ai/navigation/Pathfinder.ts';

function createGrid(width: number, height: number, walkable: boolean = true): boolean[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => walkable));
}

describe('Pathfinder', () => {
  it('finds path between two walkable cells', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const path = pathfinder.findPath({ x: 64, y: 64 }, { x: 448, y: 448 });

    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    expect(path![0]).toEqual({ x: 64, y: 64 });
    expect(path![path!.length - 1]).toEqual({ x: 448, y: 448 });
  });

  it('returns null when destination is blocked', () => {
    const grid = createGrid(5, 5);
    grid[4][4] = false;
    const pathfinder = new Pathfinder(grid);

    const path = pathfinder.findPath({ x: 64, y: 64 }, { x: 576, y: 576 });

    expect(path).toBeNull();
  });

  it('finds shortest path with exact waypoints', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const path = pathfinder.findPath({ x: 64, y: 64 }, { x: 64, y: 320 });

    expect(path).not.toBeNull();
    expect(path!.length).toBe(3);
    expect(path![0]).toEqual({ x: 64, y: 64 });
    expect(path![1]).toEqual({ x: 64, y: 192 });
    expect(path![2]).toEqual({ x: 64, y: 320 });
  });

  it('avoids hazard cells when alternative exists', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const hazards = new Set(['2,2']);

    const path = pathfinder.findPathAvoidingHazards({ x: 64, y: 64 }, { x: 448, y: 448 }, hazards);

    expect(path).not.toBeNull();
    for (const wp of path!) {
      const gx = Math.floor(wp.x / 128);
      const gy = Math.floor(wp.y / 128);
      expect(`${gx},${gy}`).not.toBe('2,2');
    }
  });

  it('returns null when hazards block the only path', () => {
    // findPathAvoidingHazards treats hazard cells as blocked. When the only
    // path goes through a hazard, it returns null (no fallback to using
    // hazards). This is the current contract — bots must find an alternative
    // route or give up, never intentionally walk through fire.
    const grid = createGrid(3, 3);
    grid[0][1] = false;
    grid[2][1] = false;

    const pathfinder = new Pathfinder(grid);

    const hazards = new Set(['1,1']);

    const path = pathfinder.findPathAvoidingHazards({ x: 64, y: 64 }, { x: 320, y: 64 }, hazards);

    expect(path).toBeNull();
  });

  it('smooths path by removing unnecessary waypoints', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const path = pathfinder.findPath({ x: 64, y: 64 }, { x: 448, y: 448 });

    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThanOrEqual(2);

    const smoothed = pathfinder.smoothPath(path!);

    expect(smoothed.length).toBeLessThanOrEqual(path!.length);
    expect(smoothed[0]).toEqual(path![0]);
    expect(smoothed[smoothed.length - 1]).toEqual(path![path!.length - 1]);
  });

  it('cache hit within TTL', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const path1 = pathfinder.findPath({ x: 64, y: 64 }, { x: 448, y: 448 });

    const cached = pathfinder.getCachedPath({ x: 64, y: 64 }, { x: 448, y: 448 });

    expect(cached).toEqual(path1);
  });

  it('cache miss after TTL expiry', () => {
    vi.useFakeTimers();
    try {
      const grid = createGrid(5, 5);
      const pathfinder = new Pathfinder(grid);

      pathfinder.findPath({ x: 64, y: 64 }, { x: 448, y: 448 });

      vi.advanceTimersByTime(600);

      const cached = pathfinder.getCachedPath({ x: 64, y: 64 }, { x: 448, y: 448 });
      expect(cached).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cache invalidated on grid update', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    pathfinder.findPath({ x: 64, y: 64 }, { x: 448, y: 448 });

    pathfinder.updateGrid(createGrid(5, 5));

    const cached = pathfinder.getCachedPath({ x: 64, y: 64 }, { x: 448, y: 448 });
    expect(cached).toBeUndefined();
  });

  it('converts world to grid coordinates', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const result = pathfinder.worldToGrid({ x: 192, y: 320 });

    expect(result).toEqual({ x: 1, y: 2 });
  });

  it('converts grid to world coordinates', () => {
    const grid = createGrid(5, 5);
    const pathfinder = new Pathfinder(grid);

    const result = pathfinder.gridToWorld({ x: 1, y: 2 });

    expect(result).toEqual({ x: 192, y: 320 });
  });
});

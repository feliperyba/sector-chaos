import { describe, expect, it } from 'vitest';
import { TileType } from '@sector-battle/shared';
import {
  CARDINAL_DIRS,
  CACHE_TTL,
  Pathfinder,
} from '../../src/ai/navigation/Pathfinder.ts';
import { packGridKey } from '../../src/ai/BotDestructibles.ts';
import type { Vec2 } from '../../src/ai/BotContext.ts';

/**
 * Perf ticket 31 — bot-pathfinder-search-dedup parity tests.
 *
 * The production find-path pipeline now (a) converts world→grid and packs the
 * cache key exactly once per call, (b) emits world coordinates directly from
 * the A* reconstruction (the intermediate grid-path array is gone), and (c)
 * uses module-level getCostXY/heuristic instead of per-search closures.
 *
 * These tests pin path-output parity against a verbatim inline transcription
 * of the OLD algorithm (git HEAD pre-ticket-31) — the same oracle pattern as
 * BotPathCursor.test.ts ("≡ old shift semantics"). The oracle approach is
 * deterministic and self-contained (no recorded fixtures to go stale).
 *
 * Oracle divergences from the old production code, all behavior-neutral:
 *  - Own cache map (sharing pf.cache would let one side serve the other's
 *    cached array and make the comparison self-referential).
 *  - Fresh per-call A* buffers (fresh zeroed arrays ≡ the gen-stamped shared
 *    buffers for a single search: every `visited[x] !== gen` starts true).
 *  - The 24/tick search budget is elided; the battery resets pf.beginTick()
 *    before every production call so the cap never trips in either side.
 */

type OracleCacheEntry = { path: Vec2[] | null; timestamp: number };
type OracleCache = Map<number, OracleCacheEntry>;

/* ------------------------------------------------------------------ */
/* OLD algorithm — verbatim transcription (pre-ticket-31)              */
/* ------------------------------------------------------------------ */

function oldWorldToGrid(worldPos: Vec2, tileSize: number): { x: number; y: number } {
  return { x: Math.floor(worldPos.x / tileSize), y: Math.floor(worldPos.y / tileSize) };
}

function oldCacheKeyNum(fromX: number, fromY: number, toX: number, toY: number): number {
  return (
    (fromX & 0x3ff) +
    (fromY & 0x3ff) * 1024 +
    (toX & 0x3ff) * 1048576 +
    (toY & 0x3ff) * 1073741824
  );
}

/** OLD pathfinderGetCachedPath — double conversion included (that was the point). */
function oldGetCachedPath(
  cache: OracleCache,
  from: Vec2,
  to: Vec2,
  tileSize: number,
): Vec2[] | null | undefined {
  const fromGrid = oldWorldToGrid(from, tileSize);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = oldWorldToGrid(to, tileSize);
  const toX = toGrid.x,
    toY = toGrid.y;
  const key = oldCacheKeyNum(fromX, fromY, toX, toY);
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.timestamp >= CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  return entry.path;
}

/** OLD pathfinderSearch — grid-coordinate output, per-search closures. */
function oldSearch(
  pf: Pathfinder,
  startId: number,
  endId: number,
  opts: {
    blockedCells?: Set<number>;
    destructibleCost?: Map<number, number>;
  },
): { x: number; y: number }[] | null {
  const cols = pf.cols;
  const rows = pf.rows;
  const grid = pf.grid;
  const tileGrid = pf.tileGrid;
  const blocked = opts.blockedCells;
  const dCost = opts.destructibleCost;

  const startX = startId % cols;
  const startY = (startId / cols) | 0;
  const endX = endId % cols;
  const endY = (endId / cols) | 0;

  if (startX < 0 || startX >= cols || startY < 0 || startY >= rows) return null;
  if (endX < 0 || endX >= cols || endY < 0 || endY >= rows) return null;
  if (!grid[startY]![startX]!) return null;
  if (!grid[endY]![endX]!) return null;
  if (startId === endId) return [{ x: startX, y: startY }];

  if (blocked !== undefined && blocked.has(startId)) return null;
  if (blocked !== undefined && blocked.has(endId)) return null;

  const getCostXY = (x: number, y: number): number => {
    const cellId = y * cols + x;
    if (blocked !== undefined && blocked.has(cellId)) return 0;
    // Check destructible cost override BEFORE grid walkability.
    // When findPathThroughDestructibles passes a cost map, those cells
    // are walls (grid says false) but we want A* to treat them as
    // high-cost passable terrain. This must take priority.
    if (dCost !== undefined) {
      const c = dCost.get(cellId);
      if (c !== undefined) return c;
    }
    if (grid[y]![x]!) return 1;
    return 0;
  };

  if (getCostXY(startX, startY) === 0) return null;
  if (getCostXY(endX, endY) === 0) return null;

  // Fresh per-call buffers ≡ the old gen-stamped shared buffers.
  const total = Math.max(1, cols * rows);
  const gen = 1;
  const gScore = new Float64Array(total);
  const parent = new Int32Array(total);
  const visited = new Int32Array(total);
  const closed = new Int32Array(total);
  const heapIds = new Int32Array(total * 2);
  const heapF = new Float64Array(total * 2);
  let heapCount = 0;

  const heuristic = (x: number, y: number): number => {
    const dx = Math.abs(x - endX);
    const dy = Math.abs(y - endY);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };

  gScore[startId] = 0;
  visited[startId] = gen;
  parent[startId] = -1;
  heapIds[0] = startId;
  heapF[0] = heuristic(startX, startY);
  heapCount = 1;

  let expanded = 0;
  const MAX_EXPANSIONS = Math.min(pf.cols * pf.rows, 2000);

  while (heapCount > 0) {
    if (expanded++ >= MAX_EXPANSIONS) break;
    const currentId: number = heapIds[0]!;
    heapCount--;
    if (heapCount > 0) {
      heapIds[0] = heapIds[heapCount]!;
      heapF[0] = heapF[heapCount]!;
      let i = 0;
      for (;;) {
        let smallest = i;
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        if (left < heapCount && heapF[left]! < heapF[smallest]!) smallest = left;
        if (right < heapCount && heapF[right]! < heapF[smallest]!) smallest = right;
        if (smallest === i) break;
        const ti = heapIds[smallest]!;
        const tf = heapF[smallest]!;
        heapIds[smallest] = heapIds[i]!;
        heapF[smallest] = heapF[i]!;
        heapIds[i] = ti;
        heapF[i] = tf;
        i = smallest;
      }
    }

    if (currentId === endId) {
      const path: { x: number; y: number }[] = [];
      let cur = endId;
      while (cur !== -1) {
        path.push({ x: cur % cols, y: (cur / cols) | 0 });
        cur = parent[cur]!;
      }
      path.reverse();
      return path;
    }

    if (closed[currentId] === gen) continue;
    closed[currentId] = gen;

    const cx = currentId % cols;
    const cy: number = (currentId / cols) | 0;
    const currentG = gScore[currentId]!;

    for (const dir of CARDINAL_DIRS) {
      const nx = cx + dir.x;
      const ny: number = cy + dir.y;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const nId = ny * cols + nx;

      if (closed[nId] === gen) continue;

      const cellCost = getCostXY(nx, ny);
      if (cellCost === 0) continue;

      if (dir.cost > 1) {
        // Standard no-corner-cutting rule: disallow diagonal when EITHER
        // orthogonal neighbor is solid. This prevents the 96px hitbox from
        // clipping wall corners on diagonal moves.
        const o1Cost = getCostXY(cx + dir.x, cy);
        const o2Cost = getCostXY(cx, cy + dir.y);

        const o1Solid = o1Cost === 0;
        const o2Solid = o2Cost === 0;

        if (o1Solid || o2Solid) {
          // Check if the solid orthogonal(s) are destructibles — allow cutting
          // through destructibles but NOT through solid walls.
          let canCut = true;
          if (tileGrid !== null) {
            if (o1Solid) {
              const t1 = tileGrid[cy]![cx + dir.x]!;
              const isDestructible1 =
                t1 === TileType.DESTRUCTIBLE_WALL ||
                t1 === TileType.DESTRUCTIBLE_CRATE ||
                t1 === TileType.DESTRUCTIBLE_BARREL;
              if (!isDestructible1) canCut = false;
            }
            if (canCut && o2Solid) {
              const t2 = tileGrid[cy + dir.y]![cx]!;
              const isDestructible2 =
                t2 === TileType.DESTRUCTIBLE_WALL ||
                t2 === TileType.DESTRUCTIBLE_CRATE ||
                t2 === TileType.DESTRUCTIBLE_BARREL;
              if (!isDestructible2) canCut = false;
            }
          } else {
            canCut = false; // No tileGrid info — be safe, don't allow corner cutting
          }
          if (!canCut) continue;
        }
      }

      const tentativeG = currentG + dir.cost * cellCost;

      if (visited[nId] !== gen || tentativeG < gScore[nId]!) {
        gScore[nId] = tentativeG;
        parent[nId] = currentId;
        visited[nId] = gen;
        const f = tentativeG + heuristic(nx, ny);

        heapIds[heapCount] = nId;
        heapF[heapCount] = f;
        let j = heapCount;
        heapCount++;
        while (j > 0) {
          const pj = (j - 1) >> 1;
          if (heapF[pj]! <= heapF[j]!) break;
          const tj = heapIds[pj]!;
          const tf2 = heapF[pj]!;
          heapIds[pj] = heapIds[j]!;
          heapF[pj] = heapF[j]!;
          heapIds[j] = tj;
          heapF[j] = tf2;
          j = pj;
        }
      }
    }
  }

  return null;
}

/** OLD pathfinderFindPath — 4x worldToGrid (2 own + 2 via getCachedPath),
 *  2x cacheKeyNum (getCachedPath + store), grid path → world path mapping. */
function oldFindPath(pf: Pathfinder, from: Vec2, to: Vec2, cache: OracleCache): Vec2[] | null {
  const fromGrid = oldWorldToGrid(from, pf.tileSize);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = oldWorldToGrid(to, pf.tileSize);
  const toX = toGrid.x,
    toY = toGrid.y;

  if (
    fromX < 0 ||
    fromX >= pf.cols ||
    fromY < 0 ||
    fromY >= pf.rows ||
    toX < 0 ||
    toX >= pf.cols ||
    toY < 0 ||
    toY >= pf.rows
  ) {
    return null;
  }

  const cached = oldGetCachedPath(cache, from, to, pf.tileSize);
  if (cached !== undefined) return cached;

  // (per-tick search budget elided in the oracle — see file header)

  const fromId = fromY * pf.cols + fromX;
  const toId = toY * pf.cols + toX;
  const gridPath = oldSearch(pf, fromId, toId, {});
  let result: Vec2[] | null = null;
  if (gridPath !== null) {
    // eslint-disable-next-line unicorn/no-new-array
    result = new Array(gridPath.length);
    for (let i = 0; i < gridPath.length; i++) {
      const p = gridPath[i]!;
      result[i] = {
        x: p.x * pf.tileSize + pf.tileSize / 2,
        y: p.y * pf.tileSize + pf.tileSize / 2,
      };
    }
  }

  cache.set(oldCacheKeyNum(fromX, fromY, toX, toY), {
    path: result,
    timestamp: Date.now(),
  });

  return result;
}

/** OLD pathfinderFindPathAvoidingHazards (with its own option Set + cache). */
function oldFindPathAvoidingHazards(
  pf: Pathfinder,
  from: Vec2,
  to: Vec2,
  hazardCells: Set<string>,
  cache: OracleCache,
): Vec2[] | null {
  const fromGrid = oldWorldToGrid(from, pf.tileSize);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = oldWorldToGrid(to, pf.tileSize);
  const toX = toGrid.x,
    toY = toGrid.y;

  const hasHazards = hazardCells.size > 0;
  if (!hasHazards) {
    return oldFindPath(pf, from, to, cache);
  }

  const hazardKey = -oldCacheKeyNum(fromX, fromY, toX, toY) - 2;
  const cached = cache.get(hazardKey);
  if (cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.path;
  }

  const fromId = fromY * pf.cols + fromX;
  const toId = toY * pf.cols + toX;

  const blockedCells = new Set<number>();
  for (const cellKey of hazardCells) {
    const sep = cellKey.indexOf(',');
    const x = Number(cellKey.slice(0, sep));
    const y = Number(cellKey.slice(sep + 1));
    blockedCells.add(y * pf.cols + x);
  }

  const gridPath = oldSearch(pf, fromId, toId, { blockedCells });
  if (gridPath !== null) {
    // eslint-disable-next-line unicorn/no-new-array
    const result: Vec2[] = new Array(gridPath.length);
    for (let i = 0; i < gridPath.length; i++) {
      const p = gridPath[i]!;
      result[i] = {
        x: p.x * pf.tileSize + pf.tileSize / 2,
        y: p.y * pf.tileSize + pf.tileSize / 2,
      };
    }
    return result;
  }

  cache.set(hazardKey, { path: null, timestamp: Date.now() });
  return null;
}

/** OLD pathfinderFindPathThroughDestructibles (own option Map + cache). */
function oldFindPathThroughDestructibles(
  pf: Pathfinder,
  from: Vec2,
  to: Vec2,
  destructibleMap: Map<number, number>,
  cache: OracleCache,
): Vec2[] | null {
  const fromGrid = oldWorldToGrid(from, pf.tileSize);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = oldWorldToGrid(to, pf.tileSize);
  const toX = toGrid.x,
    toY = toGrid.y;

  const key = -oldCacheKeyNum(fromX, fromY, toX, toY) - 1;
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.path;
  }

  const fromId = fromY * pf.cols + fromX;
  const toId = toY * pf.cols + toX;

  const destructibleCost = new Map<number, number>();
  destructibleMap.forEach((hp, dKey) => {
    const gx = dKey % 10000;
    const gy = (dKey / 10000) | 0;
    destructibleCost.set(gy * pf.cols + gx, hp * 10);
  });

  const gridPath = oldSearch(pf, fromId, toId, { destructibleCost });
  let result: Vec2[] | null = null;
  if (gridPath !== null) {
    // eslint-disable-next-line unicorn/no-new-array
    result = new Array(gridPath.length);
    for (let i = 0; i < gridPath.length; i++) {
      const p = gridPath[i]!;
      result[i] = {
        x: p.x * pf.tileSize + pf.tileSize / 2,
        y: p.y * pf.tileSize + pf.tileSize / 2,
      };
    }
  }

  cache.set(key, {
    path: result,
    timestamp: Date.now(),
  });

  return result;
}

/* ------------------------------------------------------------------ */
/* Battery fixture                                                     */
/* ------------------------------------------------------------------ */

const W = 24;
const H = 24;
const TS = 128; // TILE_PIXEL_SIZE (default pathfinder tile size)

/** Deterministic mixed map: solid walls with gaps, destructible walls/crates/
 *  barrels (blocked in `grid`, typed in `tileGrid`), a sealed unreachable
 *  room, and scattered pillars to force diagonal corner-cut decisions both
 *  allowed (destructible solids) and disallowed (indestructible solids). */
function buildBatteryGrid(): { grid: boolean[][]; tileGrid: number[][] } {
  const grid: boolean[][] = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => true),
  );
  const tileGrid: number[][] = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => TileType.EMPTY as number),
  );
  const block = (gx: number, gy: number, type: number) => {
    grid[gy]![gx] = false;
    tileGrid[gy]![gx] = type;
  };

  // Horizontal indestructible walls with narrow gaps
  for (let x = 0; x < W; x++) {
    if (x !== 4 && x !== 15) block(x, 5, TileType.INDESTRUCTIBLE_WALL);
    if (x !== 8 && x !== 19) block(x, 12, TileType.INDESTRUCTIBLE_WALL);
  }
  // Vertical indestructible wall with a gap
  for (let y = 13; y < H; y++) {
    if (y !== 18) block(7, y, TileType.INDESTRUCTIBLE_WALL);
  }
  // Destructible cluster (mixed tile types)
  block(10, 8, TileType.DESTRUCTIBLE_WALL);
  block(11, 8, TileType.DESTRUCTIBLE_CRATE);
  block(12, 8, TileType.DESTRUCTIBLE_BARREL);
  block(10, 9, TileType.DESTRUCTIBLE_CRATE);
  block(11, 9, TileType.DESTRUCTIBLE_WALL);
  block(12, 9, TileType.DESTRUCTIBLE_BARREL);
  // Destructible wall segment
  block(20, 3, TileType.DESTRUCTIBLE_WALL);
  block(21, 3, TileType.DESTRUCTIBLE_WALL);
  block(20, 4, TileType.DESTRUCTIBLE_CRATE);
  // Solid block (unreachable as a goal)
  for (let y = 16; y <= 18; y++) for (let x = 16; x <= 18; x++) block(x, y, TileType.INDESTRUCTIBLE_WALL);
  // Sealed room — interior walkable but unreachable
  for (let x = 2; x <= 4; x++) {
    block(x, 18, TileType.INDESTRUCTIBLE_WALL);
    block(x, 20, TileType.INDESTRUCTIBLE_WALL);
  }
  for (let y = 19; y <= 19; y++) {
    block(2, y, TileType.INDESTRUCTIBLE_WALL);
    block(4, y, TileType.INDESTRUCTIBLE_WALL);
  }
  // Non-destructible non-wall solid (CHEST) — corner-cut must NOT cut it
  block(5, 10, TileType.CHEST);
  block(17, 2, TileType.DOOR_CLOSED);
  // Scattered pillars
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x % 6 === 3 && y % 7 === 2) block(x, y, TileType.INDESTRUCTIBLE_WALL);
    }
  }
  return { grid, tileGrid };
}

function destructibleMapFor(tileGrid: number[][]): Map<number, number> {
  const map = new Map<number, number>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = tileGrid[y]![x]!;
      if (
        t === TileType.DESTRUCTIBLE_WALL ||
        t === TileType.DESTRUCTIBLE_CRATE ||
        t === TileType.DESTRUCTIBLE_BARREL
      ) {
        // Deterministic hp 1..9 → A* cost 10..90
        map.set(packGridKey(x, y), 1 + ((x * 3 + y * 5) % 9));
      }
    }
  }
  return map;
}

function cellAt(gx: number, gy: number): Vec2 {
  return { x: gx * TS + TS / 2, y: gy * TS + TS / 2 };
}

/** Start/goal battery: anchor cross product + LCG random world pairs (no
 *  Math.random) + explicit out-of-bounds case. */
function buildCases(): Array<{ from: Vec2; to: Vec2; label: string }> {
  const anchors: Array<[number, number]> = [
    [1, 1],
    [22, 22],
    [12, 12],
    [4, 6],
    [19, 11],
    [11, 9], // inside the destructible cluster
    [3, 19], // sealed-room interior (unreachable)
    [7, 15], // on the vertical wall
    [0, 23],
    [23, 0],
  ];
  const cases: Array<{ from: Vec2; to: Vec2; label: string }> = [];
  for (const a of anchors) {
    for (const b of anchors) {
      cases.push({
        from: cellAt(a[0]!, a[1]!),
        to: cellAt(b[0]!, b[1]!),
        label: `anchor (${a[0]},${a[1]})→(${b[0]},${b[1]})`,
      });
    }
  }

  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const rand = lcg(20260814);
  for (let i = 0; i < 40; i++) {
    const fx = Math.floor(rand() * (W + 2)) - 1; // -1 occasionally → out of bounds
    const fy = Math.floor(rand() * (H + 2)) - 1;
    const jx = rand() * TS; // non-center world offsets exercise floor conversion
    const jy = rand() * TS;
    const tx = Math.floor(rand() * (W + 2)) - 1;
    const ty = Math.floor(rand() * (H + 2)) - 1;
    const kx = rand() * TS;
    const ky = rand() * TS;
    cases.push({
      from: { x: fx * TS + jx, y: fy * TS + jy },
      to: { x: tx * TS + kx, y: ty * TS + ky },
      label: `lcg#${i} (${fx},${fy})→(${tx},${ty})`,
    });
  }

  cases.push({ from: { x: -300, y: 64 }, to: { x: 99_999, y: 99_999 }, label: 'out-of-bounds' });
  return cases;
}

function expectSameWaypoints(prod: Vec2[] | null, ref: Vec2[] | null, label: string): void {
  if (ref === null) {
    expect(prod, `${label}: expected null`).toBeNull();
    return;
  }
  expect(prod, `${label}: expected non-null`).not.toBeNull();
  expect(prod!.length, `${label}: length`).toBe(ref.length);
  for (let i = 0; i < ref.length; i++) {
    expect(prod![i]!.x, `${label}: wp[${i}].x`).toBe(ref[i]!.x);
    expect(prod![i]!.y, `${label}: wp[${i}].y`).toBe(ref[i]!.y);
  }
}

/* ------------------------------------------------------------------ */
/* Parity battery                                                      */
/* ------------------------------------------------------------------ */

describe('PathfinderSearch ≡ old find-path pipeline (ticket 31)', () => {
  const cases = buildCases();

  it('plain tier produces identical waypoint lists', () => {
    const { grid, tileGrid } = buildBatteryGrid();
    const pf = new Pathfinder(grid, TS, tileGrid);
    const oracleCache: OracleCache = new Map();
    let nonNull = 0;

    cases.forEach((c, i) => {
      pf.clearCache();
      pf.beginTick(i);
      oracleCache.clear();
      const ref = oldFindPath(pf, c.from, c.to, oracleCache);
      const prod = pf.findPath(c.from, c.to);
      expectSameWaypoints(prod, ref, `plain ${c.label}`);
      if (ref !== null) nonNull++;
    });
    expect(cases.length).toBe(141);
    expect(nonNull).toBeGreaterThan(40); // battery is not vacuous
  });

  it('destructible-aware tier produces identical waypoint lists', () => {
    const { grid, tileGrid } = buildBatteryGrid();
    const pf = new Pathfinder(grid, TS, tileGrid);
    const dMap = destructibleMapFor(tileGrid);
    const oracleCache: OracleCache = new Map();
    let nonNull = 0;

    cases.forEach((c, i) => {
      pf.clearCache();
      pf.beginTick(i);
      oracleCache.clear();
      const ref = oldFindPathThroughDestructibles(pf, c.from, c.to, dMap, oracleCache);
      const prod = pf.findPathThroughDestructibles(c.from, c.to, dMap);
      expectSameWaypoints(prod, ref, `destructible ${c.label}`);
      if (ref !== null) nonNull++;
    });
    expect(nonNull).toBeGreaterThan(40); // battery is not vacuous
  });

  it('destructible-cost branch fires: full-width destructible wall is crossable (and matches the oracle)', () => {
    // Mini-map where crossing requires stepping on destructible cells: the
    // destructible-cost override (grid says wall, cost map says passable)
    // MUST fire or no path exists. Plain tier is null on the same map.
    const w = 7;
    const grid: boolean[][] = Array.from({ length: w }, () =>
      Array.from({ length: w }, () => true),
    );
    const tileGrid: number[][] = Array.from({ length: w }, () =>
      Array.from({ length: w }, () => TileType.EMPTY as number),
    );
    const dMap = new Map<number, number>();
    for (let x = 0; x < w; x++) {
      grid[3]![x] = false;
      tileGrid[3]![x] = TileType.DESTRUCTIBLE_WALL;
      dMap.set(packGridKey(x, 3), 1); // hp 1 → cost 10
    }
    const pf = new Pathfinder(grid, TS, tileGrid);
    const oracleCache: OracleCache = new Map();
    const from = cellAt(3, 1);
    const to = cellAt(3, 5);

    const ref = oldFindPathThroughDestructibles(pf, from, to, dMap, oracleCache);
    pf.beginTick(0);
    const prod = pf.findPathThroughDestructibles(from, to, dMap);
    expectSameWaypoints(prod, ref, 'mini destructible');

    expect(ref).not.toBeNull();
    let through = 0;
    for (const wp of prod!) {
      const gx = Math.floor(wp.x / TS);
      const gy = Math.floor(wp.y / TS);
      if (dMap.has(packGridKey(gx, gy))) through++;
    }
    expect(through).toBeGreaterThan(0); // genuinely traversed destructibles

    pf.beginTick(1);
    expect(pf.findPath(from, to)).toBeNull(); // plain tier: wall is a wall
  });

  it('hazard-avoiding tier produces identical waypoint lists', () => {
    const { grid, tileGrid } = buildBatteryGrid();
    const pf = new Pathfinder(grid, TS, tileGrid);
    // Deterministic hazards on routes/corridor cells. Only ONE gap per
    // indestructible wall is blocked so the map stays connected and the
    // hazard tier genuinely re-routes (rather than nulling everything).
    const hazardCells = new Set([
      '12,12',
      '8,12', // one gap cell in the y=12 wall (other gap at 19 stays open)
      '4,5', // one gap cell in the y=5 wall (other gap at 15 stays open)
      '11,9', // anchor cell (inside the destructible cluster)
      '6,6',
      '9,15',
      '14,20',
      '3,3',
      '20,2',
    ]);
    const oracleCache: OracleCache = new Map();
    let nonNull = 0;

    cases.forEach((c, i) => {
      pf.clearCache();
      pf.beginTick(i);
      oracleCache.clear();
      const ref = oldFindPathAvoidingHazards(pf, c.from, c.to, hazardCells, oracleCache);
      const prod = pf.findPathAvoidingHazards(c.from, c.to, hazardCells);
      expectSameWaypoints(prod, ref, `hazard ${c.label}`);
      if (ref !== null) nonNull++;
    });
    expect(nonNull).toBeGreaterThan(50); // battery is not vacuous
  });
});

import { TileType } from '@sector-battle/shared';
import type { Vec2 } from '../BotContext.ts';
import { CARDINAL_DIRS, CACHE_TTL, type Pathfinder } from './Pathfinder.ts';

/**
 * Pathfinder A* search + path-finding variants. Pure mechanical extraction
 * from the original Pathfinder class — bodies verbatim, `this.→pf.` only.
 *
 * Perf ticket 31 (search-dedup): each find-* entry point converts world→grid
 * and packs its cache key exactly ONCE per call (the old pipeline re-ran
 * worldToGrid up to 4x and cacheKeyNum 2x per call), and the A* search emits
 * world coordinates directly — the intermediate grid-coordinate path array is
 * gone. getCostXY/heuristic are module-level functions instead of per-search
 * closures. Path outputs are byte-identical (pinned by
 * tests/ai/PathfinderSearchParity.test.ts).
 */

/** TTL-aware path-cache read shared by every find-* variant. Returns the
 *  stored path (which may be null — unreachable results are cached too), or
 *  undefined on miss/expiry. Expired entries are deleted, exactly as the old
 *  per-variant inline reads / pathfinderGetCachedPath did. */
function readCachedPath(pf: Pathfinder, key: number): Vec2[] | null | undefined {
  const entry = pf.cache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.timestamp >= CACHE_TTL) {
    pf.cache.delete(key);
    return undefined;
  }
  return entry.path;
}

/** Plain cached A* find given pre-converted grid coordinates. Shared by
 *  pathfinderFindPath and the no-hazard fast path of
 *  pathfinderFindPathAvoidingHazards so the conversions/key run once per
 *  call and are simply passed through. `priority` (0=T0 … 2=T2) is the
 *  ticket-11 priority-ordered search class. */
function findPathFromGridCoords(
  pf: Pathfinder,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  priority = 0,
): Vec2[] | null {
  // Sentinel = the most recent find-* call: clear at entry, only the
  // budget-miss branch sets it (a completed search used to leave a previous
  // caller's deferred flag standing; an out-of-bounds null could inherit it).
  pf.lastFindDeferred = false;
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

  const key = pf.cacheKeyNum(fromX, fromY, toX, toY);
  const cached = readCachedPath(pf, key);
  if (cached !== undefined) {
    return cached;
  }

  if (!pf.canSearch(priority)) {
    // A*-CAP DEFERRED SENTINEL (DEC-005.5): budget exhaustion — global OR the
    // caller's priority class (ticket 11) — is NOT unreachability; flag the
    // miss so callers retry next tick instead of collapsing into unreachable
    // fallbacks.
    pf.lastFindDeferred = true;
    return null;
  }
  pf.consumeSearch(priority);

  const fromId = fromY * pf.cols + fromX;
  const toId = toY * pf.cols + toX;
  // pathfinderSearch emits world coordinates directly — single allocation.
  const result = pf.search(fromId, toId, {});

  pf.cache.set(key, {
    path: result,
    timestamp: Date.now(),
  });

  return result;
}

export function pathfinderFindPath(
  pf: Pathfinder,
  from: Vec2,
  to: Vec2,
  priority = 0,
): Vec2[] | null {
  const fromGrid = pf.worldToGrid(from);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = pf.worldToGrid(to);
  const toX = toGrid.x,
    toY = toGrid.y;

  return findPathFromGridCoords(pf, fromX, fromY, toX, toY, priority);
}

export function pathfinderFindPathAvoidingHazards(
  pf: Pathfinder,
  from: Vec2,
  to: Vec2,
  hazardCells: Set<string>,
  priority = 0,
): Vec2[] | null {
  pf.lastFindDeferred = false; // sentinel = the most recent find-* call
  const fromGrid = pf.worldToGrid(from);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = pf.worldToGrid(to);
  const toX = toGrid.x,
    toY = toGrid.y;

  const hasHazards = hazardCells.size > 0;
  if (!hasHazards) {
    return findPathFromGridCoords(pf, fromX, fromY, toX, toY, priority);
  }

  // Cache hazard-avoiding paths under a separate key namespace (negative)
  // so they don't collide with standard paths. The cache is already cleared
  // on updateHazards(), so between calls the cached hazard paths are valid.
  const hazardKey = -pf.cacheKeyNum(fromX, fromY, toX, toY) - 2;
  const cached = readCachedPath(pf, hazardKey);
  if (cached !== undefined) {
    return cached;
  }

  if (!pf.canSearch(priority)) {
    pf.lastFindDeferred = true; // DEC-005.5 deferred sentinel (budget miss)
    return null;
  }
  pf.consumeSearch(priority);

  const fromId = fromY * pf.cols + fromX;
  const toId = toY * pf.cols + toX;

  const blockedCells = pf.blockedCellsBuf;
  blockedCells.clear();
  for (const cellKey of hazardCells) {
    const sep = cellKey.indexOf(',');
    const x = Number(cellKey.slice(0, sep));
    const y = Number(cellKey.slice(sep + 1));
    blockedCells.add(y * pf.cols + x);
  }

  // Search emits world coordinates directly — single allocation.
  const result = pf.search(fromId, toId, { blockedCells });
  if (result !== null) return result;

  // Cache the null result too so we don't re-run A* for unreachable targets
  pf.cache.set(hazardKey, { path: null, timestamp: Date.now() });
  return null;
}

export function pathfinderFindPathThroughDestructibles(
  pf: Pathfinder,
  from: Vec2,
  to: Vec2,
  destructibleMap: Map<number, number>,
  priority = 0,
): Vec2[] | null {
  pf.lastFindDeferred = false; // sentinel = the most recent find-* call
  const fromGrid = pf.worldToGrid(from);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = pf.worldToGrid(to);
  const toX = toGrid.x,
    toY = toGrid.y;

  const key = -pf.cacheKeyNum(fromX, fromY, toX, toY) - 1;
  const cached = readCachedPath(pf, key);
  if (cached !== undefined) {
    return cached;
  }

  if (!pf.canSearch(priority)) {
    pf.lastFindDeferred = true; // DEC-005.5 deferred sentinel (budget miss)
    return null;
  }
  pf.consumeSearch(priority);

  const fromId = fromY * pf.cols + fromX;
  const toId = toY * pf.cols + toX;

  const destructibleCost = pf.destructibleCostBuf;
  destructibleCost.clear();
  destructibleMap.forEach((hp, dKey) => {
    const gx = dKey % 10000;
    const gy = (dKey / 10000) | 0;
    destructibleCost.set(gy * pf.cols + gx, hp * 10);
  });

  // Search emits world coordinates directly — single allocation.
  const result = pf.search(fromId, toId, { destructibleCost });

  pf.cache.set(key, {
    path: result,
    timestamp: Date.now(),
  });

  return result;
}

export function pathfinderGetCachedPath(
  pf: Pathfinder,
  from: Vec2,
  to: Vec2,
): Vec2[] | null | undefined {
  const fromGrid = pf.worldToGrid(from);
  const fromX = fromGrid.x,
    fromY = fromGrid.y;
  const toGrid = pf.worldToGrid(to);
  const toX = toGrid.x,
    toY = toGrid.y;
  return readCachedPath(pf, pf.cacheKeyNum(fromX, fromY, toX, toY));
}

export function pathfinderSmoothPath(pf: Pathfinder, path: Vec2[]): Vec2[] {
  if (path.length <= 2) return path;

  const smoothed: Vec2[] = [path[0]!];
  let current = 0;

  while (current < path.length - 1) {
    let furthest = current + 1;
    const maxLook = Math.min(path.length, current + 24);
    for (let i = current + 2; i < maxLook; i++) {
      if (pf.hasLineOfSightWorld(path[current]!, path[i]!)) {
        furthest = i;
      }
    }
    smoothed.push(path[furthest]!);
    current = furthest;
  }

  return padFromWalls(pf, smoothed);
}

/** Push intermediate waypoints away from adjacent walls so bots don't
 *  scrape wall corners on diagonal paths. Endpoints are left untouched
 *  to preserve exact start/goal positions. */
function padFromWalls(pf: Pathfinder, path: Vec2[]): Vec2[] {
  if (path.length <= 2) return path;
  const ts = pf.tileSize;
  const margin = ts * 0.25; // 25% of tile size — subtle nudge
  const result = path.slice();

  for (let i = 1; i < result.length - 1; i++) {
    const wp = result[i]!;
    const gx = Math.floor(wp.x / ts);
    const gy = Math.floor(wp.y / ts);

    // Check 4 cardinal neighbors — count walls
    let pushX = 0;
    let pushY = 0;

    if (!pf.isWalkable(gx - 1, gy)) pushX += 1;
    if (!pf.isWalkable(gx + 1, gy)) pushX -= 1;
    if (!pf.isWalkable(gx, gy - 1)) pushY += 1;
    if (!pf.isWalkable(gx, gy + 1)) pushY -= 1;

    if (pushX !== 0 || pushY !== 0) {
      const mag = Math.sqrt(pushX * pushX + pushY * pushY);
      result[i] = {
        x: wp.x + (pushX / mag) * margin,
        y: wp.y + (pushY / mag) * margin,
      };
    }
  }

  return result;
}

/** Cell cost for A* relaxation. Module-level function (was a per-search
 *  closure) — body verbatim. Params are what the closure used to capture. */
function getCostXY(
  grid: boolean[][],
  cols: number,
  blocked: Set<number> | undefined,
  dCost: Map<number, number> | undefined,
  x: number,
  y: number,
): number {
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
}

/** Octile-distance heuristic. Module-level function (was a per-search
 *  closure) — body verbatim. */
function heuristicXY(x: number, y: number, endX: number, endY: number): number {
  const dx = Math.abs(x - endX);
  const dy = Math.abs(y - endY);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/** A* search. Returns the path in WORLD coordinates (tile centers) or null.
 *  Perf ticket 31: the world conversion happens here, at reconstruction
 *  time, using the exact expression the old callers applied afterwards —
 *  `gx * tileSize + tileSize / 2` — so outputs are bit-identical while the
 *  intermediate grid-coordinate array is gone. */
export function pathfinderSearch(
  pf: Pathfinder,
  startId: number,
  endId: number,
  opts: {
    blockedCells?: Set<number>;
    destructibleCost?: Map<number, number>;
  },
): Vec2[] | null {
  const cols = pf.cols;
  const rows = pf.rows;
  const grid = pf.grid;
  const tileGrid = pf.tileGrid;
  const ts = pf.tileSize;
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
  if (startId === endId) return [{ x: startX * ts + ts / 2, y: startY * ts + ts / 2 }];

  if (blocked !== undefined && blocked.has(startId)) return null;
  if (blocked !== undefined && blocked.has(endId)) return null;

  if (getCostXY(grid, cols, blocked, dCost, startX, startY) === 0) return null;
  if (getCostXY(grid, cols, blocked, dCost, endX, endY) === 0) return null;

  const gen = ++pf.searchGen;
  const gScore = pf.gScoreBuf;
  const parent = pf.parentBuf;
  const visited = pf.visitedBuf;
  const closed = pf.closedBuf;
  const heapIds = pf.heapIdsBuf;
  const heapF = pf.heapFBuf;
  let heapCount = 0;

  gScore[startId] = 0;
  visited[startId] = gen;
  parent[startId] = -1;
  heapIds[0] = startId;
  heapF[0] = heuristicXY(startX, startY, endX, endY);
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
      // Emit world coordinates directly at reconstruction time. The grid
      // derivation (`cur % cols`, `(cur / cols) | 0`) and the center math
      // (`* ts + ts / 2`) are identical to the old grid push + caller-side
      // world mapping, evaluated in the same order.
      const path: Vec2[] = [];
      let cur = endId;
      while (cur !== -1) {
        path.push({
          x: (cur % cols) * ts + ts / 2,
          y: ((cur / cols) | 0) * ts + ts / 2,
        });
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

      const cellCost = getCostXY(grid, cols, blocked, dCost, nx, ny);
      if (cellCost === 0) continue;

      if (dir.cost > 1) {
        // Standard no-corner-cutting rule: disallow diagonal when EITHER
        // orthogonal neighbor is solid. This prevents the 96px hitbox from
        // clipping wall corners on diagonal moves.
        const o1Cost = getCostXY(grid, cols, blocked, dCost, cx + dir.x, cy);
        const o2Cost = getCostXY(grid, cols, blocked, dCost, cx, cy + dir.y);

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
        const f = tentativeG + heuristicXY(nx, ny, endX, endY);

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

import type { Vec2 } from '../BotContext.ts';
import { TILE_PIXEL_SIZE } from '@sector-battle/shared';
import {
  pathfinderSearch,
  pathfinderFindPath,
  pathfinderFindPathAvoidingHazards,
  pathfinderFindPathThroughDestructibles,
  pathfinderGetCachedPath,
  pathfinderSmoothPath,
} from './PathfinderSearch.ts';
import {
  pathfinderHasLineOfSight,
  pathfinderHasLineOfSightWorld,
  pathfinderInvalidateLOSCache,
} from './PathfinderLOS.ts';
import { packGridKey } from '../BotDestructibles.ts';

export const CARDINAL_DIRS = [
  { x: 0, y: -1, cost: 1 },
  { x: 0, y: 1, cost: 1 },
  { x: -1, y: 0, cost: 1 },
  { x: 1, y: 0, cost: 1 },
  { x: -1, y: -1, cost: Math.SQRT2 },
  { x: 1, y: -1, cost: Math.SQRT2 },
  { x: -1, y: 1, cost: Math.SQRT2 },
  { x: 1, y: 1, cost: Math.SQRT2 },
];

export const CACHE_TTL = 500;

/** Maximum A-star searches per tick before returning cached/null results.
 *  Prevents thundering-herd spikes when many bots' caches expire simultaneously.
 *  At 60fps with 64 bots and PATH_PERSIST=10, average is ~6 searches per tick.
 *  Profiling (scripts/diag-prof.ts) shows the whole simulation runs at
 *  P50~1.1ms / P99~9ms wall-clock with this cap; the rare >16ms tick is a
 *  single cold-cache A* burst, not a sustained load problem. Lowering the cap
 *  makes it WORSE (deferred searches backlog and burst later), so 24 stays. */
export const MAX_SEARCHES_PER_TICK = 24;

/**
 * PRIORITY-ORDERED SEARCH CLASSES (bot-ai-v2 ticket 11, DEC-012.3): the
 * shared cap above is now allocated by caller priority — T0 (combat/near)
 * first, on top of ticket 06's deferred sentinel. Class indices are the
 * LodTier values (0=T0 highest … 2=T2); class caps guarantee that even when
 * every low-priority bot searches FIRST, (14 + 6) = 20 of the 24 global
 * slots can be consumed before any T0 request — ≥4 slots always remain for
 * T0. A class at its cap returns the RETRYABLE deferred sentinel (a "not
 * now", never "unreachable") exactly like a global-cap miss.
 */
export const SEARCH_CLASS_CAPS: readonly [number, number, number] = [24, 14, 6];

export interface PathfinderCacheEntry {
  path: Vec2[] | null;
  timestamp: number;
}

/**
 * Pathfinder — grid-based A* with caching.
 *
 * NOTE: data fields and internal helpers are intentionally public (not
 * `private`) so the helper modules `PathfinderSearch.ts` (A* + path-finding
 * variants) and `PathfinderLOS.ts` (line-of-sight) — extracted from the
 * original monolithic class — can read/write them. External callers should
 * treat the field surface as internal; the public API is the find/query
 * methods.
 */
export class Pathfinder {
  grid: boolean[][];
  cols: number;
  rows: number;
  tileSize: number;
  hazards: Set<string>;
  cache: Map<number, PathfinderCacheEntry>;
  losCache: Map<number, boolean>;

  /** Original tile-type grid (nullable). Used to distinguish destructible
   *  tiles from solid walls when relaxing diagonal corner-cutting prevention. */
  tileGrid: number[][] | null;

  gScoreBuf: Float64Array;
  parentBuf: Int32Array;
  visitedBuf: Int32Array;
  closedBuf: Int32Array;
  heapIdsBuf: Int32Array;
  heapFBuf: Float64Array;
  searchGen: number;

  /**
   * Reusable transient containers for A* options, cleared per search. Avoids
   * allocating a fresh Set/Map on every hazard-avoiding / destructible search
   * (up to ~24 searches/tick). Searches are sequential, so a single buffer of
   * each kind is safe.
   */
  blockedCellsBuf: Set<number> = new Set();
  destructibleCostBuf: Map<number, number> = new Map();

  /** Per-tick A* call counter — reset by beginTick(). */
  searchesThisTick: number;
  /** Per-tick counter per priority class (0=T0 … 2=T2; SEARCH_CLASS_CAPS) —
   *  the priority-ordered allocation (ticket 11). Reset by beginTick(). */
  searchesByPriority: Int32Array;
  lastSearchTick: number;

  /**
   * A*-CAP DEFERRED SENTINEL (bot-ai-v2 ticket 06, DEC-005.5): true when the
   * LAST find-* entry point bailed because the shared per-tick search budget
   * (`MAX_SEARCHES_PER_TICK`) was exhausted — a RETRYABLE "not now", distinct
   * from a cached-null "unreachable". Reset at the top of every find-* call
   * and set only at the budget bail, so a caller reading it immediately
   * after its own call sees that call's status (single-threaded: nothing
   * interleaves between the call and the read).
   *
   * Consumers must treat `null + lastFindDeferred` as "search again next
   * tick", never as unreachable — no target drops, no wander fallback, no
   * spurious demolition on a budget miss.
   */
  lastFindDeferred = false;

  readonly _scratchGrid = { x: 0, y: 0 };
  readonly _scratchWorld = { x: 0, y: 0 };

  constructor(grid: boolean[][], tileSize?: number, tileGrid?: number[][] | null) {
    this.grid = grid;
    this.rows = grid.length;
    this.cols = this.rows > 0 ? grid[0]!.length : 0;
    this.tileSize = tileSize ?? TILE_PIXEL_SIZE;
    this.tileGrid = tileGrid ?? null;
    this.hazards = new Set();
    this.cache = new Map();
    this.losCache = new Map();
    const total = Math.max(1, this.cols * this.rows);
    this.gScoreBuf = new Float64Array(total);
    this.parentBuf = new Int32Array(total);
    this.visitedBuf = new Int32Array(total);
    this.closedBuf = new Int32Array(total);
    this.heapIdsBuf = new Int32Array(total * 2);
    this.heapFBuf = new Float64Array(total * 2);
    this.searchGen = 0;
    this.searchesThisTick = 0;
    this.searchesByPriority = new Int32Array(SEARCH_CLASS_CAPS.length);
    this.lastSearchTick = 0;
  }

  /** Called at the start of each server tick to reset the per-tick A* counters. */
  beginTick(_tick: number): void {
    this.lastSearchTick = _tick;
    this.searchesThisTick = 0;
    this.searchesByPriority.fill(0);
  }

  /** Returns true if the per-tick A* budget allows another search for the
   *  given priority class (0=T0 highest … 2=T2; defaults to T0 — callers that
   *  don't care keep the pre-ticket-11 behavior of the full shared cap). */
  canSearch(priority = 0): boolean {
    const p = priority < 0 ? 0 : priority > 2 ? 2 : priority;
    return (
      this.searchesThisTick < MAX_SEARCHES_PER_TICK &&
      this.searchesByPriority[p]! < SEARCH_CLASS_CAPS[p]!
    );
  }

  consumeSearch(priority = 0): void {
    this.searchesThisTick++;
    this.searchesByPriority[Math.min(2, Math.max(0, priority))]!++;
  }

  updateGrid(grid: boolean[][], tileGrid?: number[][] | null): void {
    this.grid = grid;
    this.rows = grid.length;
    this.cols = this.rows > 0 ? grid[0]!.length : 0;
    if (tileGrid !== undefined) {
      this.tileGrid = tileGrid;
    }
    const total = Math.max(1, this.cols * this.rows);
    if (this.gScoreBuf.length < total) {
      this.gScoreBuf = new Float64Array(total);
      this.parentBuf = new Int32Array(total);
      this.visitedBuf = new Int32Array(total);
      this.closedBuf = new Int32Array(total);
      this.heapIdsBuf = new Int32Array(total * 2);
      this.heapFBuf = new Float64Array(total * 2);
      this.searchGen = 0;
    }
    this.cache.clear();
    this.losCache.clear();
  }

  markCellWalkable(gridX: number, gridY: number): void {
    if (gridY >= 0 && gridY < this.grid.length && gridX >= 0 && gridX < this.grid[gridY]!.length) {
      if (!this.grid[gridY]![gridX]!) {
        this.grid[gridY]![gridX] = true;
        // Invalidate both caches. A walkability change can flip LOS (a wall
        // removed opens a sightline; a wall added closes one) and re-open A*
        // paths through this cell. Stale LOS entries here caused bots to
        // believe they had no shot at targets that had just become visible.
        // The A* cache relies on the 500ms TTL elsewhere, but a grid mutation
        // at a specific cell is cheap to invalidate and semantically must.
        this.losCache.clear();
      }
    }
  }

  updateHazards(hazards: Set<string>): void {
    this.hazards = hazards;
    this.cache.clear();
    this.losCache.clear();
  }

  isWalkable(gridX: number, gridY: number): boolean {
    if (gridY < 0 || gridY >= this.grid.length) return false;
    if (gridX < 0 || gridX >= this.grid[gridY]!.length) return false;
    return this.grid[gridY]![gridX]!;
  }

  getTileSize(): number {
    return this.tileSize;
  }

  getGrid(): boolean[][] {
    return this.grid;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Find nearest walkable grid tile to (gx, gy) within maxRadius.
   *  Used by callers that need to snap arbitrary positions to walkable tiles. */
  findNearestWalkable(gx: number, gy: number, maxRadius = 5): { x: number; y: number } | null {
    const rows = this.grid.length;
    const cols = rows > 0 ? this.grid[0]!.length : 0;
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = gx + dx;
          const ny = gy + dy;
          if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && this.grid[ny]![nx]!) {
            return { x: nx, y: ny };
          }
        }
      }
    }
    return null;
  }

  worldToGrid(worldPos: Vec2): { x: number; y: number } {
    this._scratchGrid.x = Math.floor(worldPos.x / this.tileSize);
    this._scratchGrid.y = Math.floor(worldPos.y / this.tileSize);
    return this._scratchGrid;
  }

  gridToWorld(gridPos: { x: number; y: number }): Vec2 {
    this._scratchWorld.x = gridPos.x * this.tileSize + this.tileSize / 2;
    this._scratchWorld.y = gridPos.y * this.tileSize + this.tileSize / 2;
    return this._scratchWorld;
  }

  /** Pack 4 grid coords into a unique key for maps up to 1024x1024. Each coord
   *  occupies a non-overlapping 10-bit lane (multipliers are powers of 1024).
   *  The old bitwise form (`<< 16` / `<< 32`) collapsed under JavaScript's
   *  32-bit shift masking — every reversed path and many unrelated pairs
   *  collided, which poisoned the path and line-of-sight caches with stale
   *  null results and made bots fail to path/see targets that were reachable.
   */
  cacheKeyNum(fromX: number, fromY: number, toX: number, toY: number): number {
    return (
      (fromX & 0x3ff) +
      (fromY & 0x3ff) * 1024 +
      (toX & 0x3ff) * 1048576 +
      (toY & 0x3ff) * 1073741824
    );
  }

  cacheKeyWorld(from: Vec2, to: Vec2): number {
    const fromGrid = this.worldToGrid(from);
    const fromX = fromGrid.x,
      fromY = fromGrid.y;
    const toGrid = this.worldToGrid(to);
    const toX = toGrid.x,
      toY = toGrid.y;
    return this.cacheKeyNum(fromX, fromY, toX, toY);
  }

  // --- Path-finding public API (delegates to PathfinderSearch.ts) ---
  // The optional `priority` (0=T0 … 2=T2, LodTier values — ticket 11) selects
  // the caller's search class for the priority-ordered cap; omitted = T0
  // (the historical full-shared-cap behavior).

  findPath(from: Vec2, to: Vec2, priority = 0): Vec2[] | null {
    return pathfinderFindPath(this, from, to, priority);
  }

  findPathAvoidingHazards(
    from: Vec2,
    to: Vec2,
    hazardCells: Set<string>,
    priority = 0,
  ): Vec2[] | null {
    return pathfinderFindPathAvoidingHazards(this, from, to, hazardCells, priority);
  }

  findPathThroughDestructibles(
    from: Vec2,
    to: Vec2,
    destructibleMap: Map<number, number>,
    priority = 0,
  ): Vec2[] | null {
    return pathfinderFindPathThroughDestructibles(this, from, to, destructibleMap, priority);
  }

  getCachedPath(from: Vec2, to: Vec2): Vec2[] | null | undefined {
    return pathfinderGetCachedPath(this, from, to);
  }

  isDestructibleWaypoint(
    gridX: number,
    gridY: number,
    destructibleMap: Map<number, number>,
  ): boolean {
    return destructibleMap.has(packGridKey(gridX, gridY));
  }

  smoothPath(path: Vec2[]): Vec2[] {
    return pathfinderSmoothPath(this, path);
  }

  /** Search internals — exposed for the partial helpers in PathfinderSearch.ts.
   *  Returns the path in WORLD coordinates (tile centers) or null. */
  search(
    startId: number,
    endId: number,
    opts: {
      blockedCells?: Set<number>;
      destructibleCost?: Map<number, number>;
    },
  ): Vec2[] | null {
    return pathfinderSearch(this, startId, endId, opts);
  }

  // --- Line-of-sight public API (delegates to PathfinderLOS.ts) ---

  hasLineOfSight(from: Vec2, to: Vec2): boolean {
    return pathfinderHasLineOfSight(this, from, to);
  }

  hasLineOfSightWorld(from: Vec2, to: Vec2): boolean {
    return pathfinderHasLineOfSightWorld(this, from, to);
  }

  invalidateLOSCache(): void {
    pathfinderInvalidateLOSCache(this);
  }
}

import type { MapData, SectorData } from './types.js';
import { SectorLootTier } from './types.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE, TILE_PIXEL_SIZE } from './constants.js';
import { buildCompositeGrid, isEmptyTile, isTraversable } from './gridUtils.js';

/**
 * Geometry + statistics model for the per-spawn fairness pass (map-redesign
 * ticket 10 / DEC-009). Split from spawnFairness.ts per the 500-line file
 * gate: this module owns the pure measurement layer —
 *
 * - the value-vector components' measurement (chamfer distance fields for
 *   weapon/chest/clump proximity, multi-source BFS for the hot-path),
 * - the DEC-003.5 "bait clump" interpretation (ground-weapon clustering),
 * - the sector eligible-pool enumeration (SpawnPointFinder's interior EMPTY
 *   tiles MINUS the server-side destructible-clearance tiles — see
 *   {@link computeBlockedTiles}: a repaired spawn must never land on a tile
 *   SpawnService.isSpawnPointValid would reject, or the server's valid-spawn
 *   pool shrinks below 64 and spawn REUSE + jitter produces clustered
 *   spawns, regressing the bot-spawn-distribution gate),
 * - the per-sector offer medians + worst-ratio scoring.
 *
 * Everything here is deterministic and RNG-free (ADR 0035).
 */

/** The map slices the fairness pass reads (MapData-compatible subset). */
export type SpawnEquityInput = Pick<
  MapData,
  'sectors' | 'spawnPoints' | 'lootPlacements' | 'sectorTiers' | 'hotSector' | 'entityPlacements'
>;

/**
 * Destructible clearance around a spawn tile (Manhattan, tiles). Mirrors the
 * SERVER-side `SpawnService.SPAWN_VALIDATION_CLEARANCE` (packages/server/src/
 * domain/services/SpawnService.ts) — shared code cannot import server code, so
 * the value is duplicated and unit-tested against generated maps
 * (map-spawn-equity.test.ts asserts no repaired spawn sits within this
 * clearance of a CRATE/BARREL placement).
 */
export const SPAWN_DESTRUCTIBLE_CLEARANCE = 1;

/** The value-vector components (keys used by the audit + manifest). */
export type SpawnEquityComponent = 'weapon' | 'chest' | 'clump' | 'hot';

export const SPAWN_EQUITY_COMPONENTS: readonly SpawnEquityComponent[] = [
  'weapon',
  'chest',
  'clump',
  'hot',
] as const;

/**
 * Single-linkage distance for the field-loot clump interpretation: ≤ 2.5
 * tiles between cluster members (EntityPlacer keeps ≥ 2-tile Manhattan
 * spacing, so genuine clumps are the placements that still land close).
 */
const CLUMP_LINK_PX = 2.5 * TILE_PIXEL_SIZE;

/** Sentinel for an unreachable hot-path (BFS never visited the tile). */
const UNREACHABLE_HOT_DIST = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE * 2;

const COMPOSITE_SIZE = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE;
/** Chamfer weights in 1/3-tile units: cardinal 3, diagonal 4. */
const CHAMFER_CARDINAL = 3;
const CHAMFER_DIAGONAL = 4;
const FIELD_INF = Number.MAX_SAFE_INTEGER;

/** Per-component values for one position (px for distances, tiles for hot). */
export interface SpawnEquityValues {
  weapon: number;
  chest: number;
  clump: number;
  hot: number;
}

/** Precomputed fairness model: distance fields + hot-path BFS. */
export interface EquityModel {
  /** Chamfer(3-4) tile-resolution distance fields, px units (see buildDistanceField). */
  weaponField: Float64Array;
  chestField: Float64Array;
  clumpField: Float64Array;
  /** BFS distance (tiles) from each composite tile to the nearest hot tile. */
  hotDist: Int32Array;
}

/**
 * Per-sector eligible pools + their offer medians, computed once and shared
 * by the audit and the repair pass (repair moves only spawns, so the pools
 * and medians are stable across the repair pass).
 */
export interface SectorEquityContext {
  pools: Array<Array<{ row: number; col: number; x: number; y: number }>>;
  medians: Array<Record<SpawnEquityComponent, number>>;
}

/**
 * Multi-source chamfer(3-4) distance transform over the composite tile grid
 * (px units, tile-center to tile-center). All placements and spawn candidates
 * sit on tile centers, so the field resolution is exact up to the chamfer
 * approximation of Euclidean distance (≤ ~6% underestimate — applied
 * identically to every spawn value and pool median, so the gate's RATIOS are
 * effectively exact). Two-pass O(grid) instead of a per-point nearest scan:
 * keeps the whole fairness pass ~1-2ms per generated map.
 */
function buildDistanceField(points: Array<{ x: number; y: number }>): Float64Array {
  const size = COMPOSITE_SIZE;
  const field = new Float64Array(size * size).fill(FIELD_INF);
  for (const p of points) {
    const r = Math.floor(p.y / TILE_PIXEL_SIZE);
    const c = Math.floor(p.x / TILE_PIXEL_SIZE);
    if (r >= 0 && r < size && c >= 0 && c < size) field[r * size + c] = 0;
  }
  const at = (r: number, c: number): number =>
    r < 0 || r >= size || c < 0 || c >= size ? FIELD_INF : field[r * size + c]!;
  // Forward pass (top-left -> bottom-right).
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      let d = field[idx]!;
      d = Math.min(d, at(r, c - 1) + CHAMFER_CARDINAL);
      d = Math.min(d, at(r - 1, c) + CHAMFER_CARDINAL);
      d = Math.min(d, at(r - 1, c - 1) + CHAMFER_DIAGONAL);
      d = Math.min(d, at(r - 1, c + 1) + CHAMFER_DIAGONAL);
      field[idx] = d;
    }
  }
  // Backward pass (bottom-right -> top-left).
  for (let r = size - 1; r >= 0; r--) {
    for (let c = size - 1; c >= 0; c--) {
      const idx = r * size + c;
      let d = field[idx]!;
      d = Math.min(d, at(r, c + 1) + CHAMFER_CARDINAL);
      d = Math.min(d, at(r + 1, c) + CHAMFER_CARDINAL);
      d = Math.min(d, at(r + 1, c + 1) + CHAMFER_DIAGONAL);
      d = Math.min(d, at(r + 1, c - 1) + CHAMFER_DIAGONAL);
      field[idx] = d;
    }
  }
  // Scale 1/3-tile units -> px; unreachable stays FIELD_INF (clamped below).
  const scale = TILE_PIXEL_SIZE / CHAMFER_CARDINAL;
  for (let i = 0; i < field.length; i++) {
    const d = field[i]!;
    field[i] = d >= FIELD_INF / 2 ? UNREACHABLE_HOT_DIST * TILE_PIXEL_SIZE : d * scale;
  }
  return field;
}

/**
 * Single-linkage clustering of the ground-weapon placements at
 * `CLUMP_LINK_PX`; members of clusters of size >= 2 become clump points.
 * (The DEC-003.5 "bait clump" interpretation — see spawnFairness.ts docs.)
 */
function computeClumpPoints(
  weapons: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const n = weapons.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = weapons[i]!.x - weapons[j]!.x;
      const dy = weapons[i]!.y - weapons[j]!.y;
      if (Math.sqrt(dx * dx + dy * dy) <= CLUMP_LINK_PX) parent[find(i)] = find(j);
    }
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  const clumps: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    if ((sizes.get(find(i)) ?? 0) >= 2) clumps.push(weapons[i]!);
  }
  return clumps;
}

/**
 * Multi-source 4-dir BFS from every traversable tile inside an EFFECTIVE-HOT
 * sector (base HOT + the per-match hot sector). Returns per-tile distance in
 * tiles (-1 unreachable).
 */
function computeHotDistances(input: SpawnEquityInput): Int32Array {
  const grid = buildCompositeGrid(input.sectors);
  const size = grid.length;
  const dist = new Int32Array(size * size).fill(-1);
  const queue: number[] = [];
  const isHotSector = (row: number, col: number): boolean =>
    input.sectorTiers[row]?.[col] === SectorLootTier.HOT ||
    (input.hotSector.row === row && input.hotSector.col === col);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const sRow = Math.floor(r / SECTOR_TILE_SIZE);
      const sCol = Math.floor(c / SECTOR_TILE_SIZE);
      if (isHotSector(sRow, sCol) && isTraversable(grid[r]![c]!)) {
        dist[r * size + c] = 0;
        queue.push(r * size + c);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++]!;
    const r = (idx / size) | 0;
    const c = idx % size;
    const next = dist[idx]! + 1;
    if (r > 0 && dist[idx - size] === -1 && isTraversable(grid[r - 1]![c]!)) {
      dist[idx - size] = next;
      queue.push(idx - size);
    }
    if (r < size - 1 && dist[idx + size] === -1 && isTraversable(grid[r + 1]![c]!)) {
      dist[idx + size] = next;
      queue.push(idx + size);
    }
    if (c > 0 && dist[idx - 1] === -1 && isTraversable(grid[r]![c - 1]!)) {
      dist[idx - 1] = next;
      queue.push(idx - 1);
    }
    if (c < size - 1 && dist[idx + 1] === -1 && isTraversable(grid[r]![c + 1]!)) {
      dist[idx + 1] = next;
      queue.push(idx + 1);
    }
  }
  return dist;
}

function buildEquityModel(input: SpawnEquityInput): EquityModel {
  const weapons = input.lootPlacements
    .filter((l) => l.type === 'WEAPON_SPAWN')
    .map((l) => l.position);
  const chests = input.lootPlacements.filter((l) => l.type === 'CHEST').map((l) => l.position);
  // When no clump exists map-wide (possible on sparse seeds), the clump
  // component degenerates to the weapon component — documented fallback that
  // keeps the gate well-defined (the bound still applies to the median).
  const clumps = computeClumpPoints(weapons);
  return {
    weaponField: buildDistanceField(weapons),
    chestField: buildDistanceField(chests),
    clumpField: buildDistanceField(clumps.length > 0 ? clumps : weapons),
    hotDist: computeHotDistances(input),
  };
}

function componentValues(model: EquityModel, x: number, y: number): SpawnEquityValues {
  const tile = Math.floor(y / TILE_PIXEL_SIZE) * COMPOSITE_SIZE + Math.floor(x / TILE_PIXEL_SIZE);
  const hot = model.hotDist[tile]!;
  return {
    weapon: model.weaponField[tile]!,
    chest: model.chestField[tile]!,
    clump: model.clumpField[tile]!,
    hot: hot === -1 ? UNREACHABLE_HOT_DIST : hot,
  };
}

/**
 * Composite-grid tiles the SERVER's SpawnService would reject as spawn
 * positions: every tile within `SPAWN_DESTRUCTIBLE_CLEARANCE` (Manhattan) of
 * a CRATE/BARREL placement (destructibles sit on EMPTY floor tiles, so the
 * EMPTY-tile check alone does not catch them). The fairness pass excludes
 * these from the eligible pool so a repaired spawn is always server-valid —
 * a spawn the server rejects shrinks the valid pool below 64 and forces
 * spawn reuse + jitter, producing clustered spawns. Keys are packed
 * `row * COMPOSITE_SIZE + col`.
 */
function computeBlockedTiles(entityPlacements: SpawnEquityInput['entityPlacements']): Set<number> {
  const blocked = new Set<number>();
  for (const e of entityPlacements) {
    if (e.entityType !== 'CRATE' && e.entityType !== 'BARREL') continue;
    const gx = Math.floor(e.position.x / TILE_PIXEL_SIZE);
    const gy = Math.floor(e.position.y / TILE_PIXEL_SIZE);
    for (let dr = -SPAWN_DESTRUCTIBLE_CLEARANCE; dr <= SPAWN_DESTRUCTIBLE_CLEARANCE; dr++) {
      for (let dc = -SPAWN_DESTRUCTIBLE_CLEARANCE; dc <= SPAWN_DESTRUCTIBLE_CLEARANCE; dc++) {
        if (Math.abs(dr) + Math.abs(dc) > SPAWN_DESTRUCTIBLE_CLEARANCE) continue;
        const r = gy + dr;
        const c = gx + dc;
        if (r >= 0 && r < COMPOSITE_SIZE && c >= 0 && c < COMPOSITE_SIZE) {
          blocked.add(r * COMPOSITE_SIZE + c);
        }
      }
    }
  }
  return blocked;
}

/**
 * The sector's eligible spawn pool — SpawnPointFinder's candidate set
 * (interior rows/cols in [1, SECTOR_TILE_SIZE-2], EMPTY tiles only, same
 * row-major order) MINUS the server-rejected destructible-clearance tiles
 * (see {@link computeBlockedTiles}), so repair re-picks from tiles that are
 * genuinely offerable as spawns end-to-end.
 */
function eligiblePool(
  sector: SectorData,
  sRow: number,
  sCol: number,
  blocked: Set<number>,
): Array<{ row: number; col: number; x: number; y: number }> {
  const tiles = sector.tiles;
  const pool: Array<{ row: number; col: number; x: number; y: number }> = [];
  for (let r = 1; r < SECTOR_TILE_SIZE - 1; r++) {
    for (let c = 1; c < SECTOR_TILE_SIZE - 1; c++) {
      if (!isEmptyTile(tiles[r]![c]!)) continue;
      if (
        blocked.has((sRow * SECTOR_TILE_SIZE + r) * COMPOSITE_SIZE + (sCol * SECTOR_TILE_SIZE + c))
      )
        continue;
      pool.push({
        row: r,
        col: c,
        x: sector.bounds.x + c * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
        y: sector.bounds.y + r * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
      });
    }
  }
  return pool;
}

/** Lower median (element at floor(n/2) of the sorted values) — deterministic.
 *  Float64Array.sort() is the native numeric sort — no JS comparator, ~10x
 *  faster than an array sort with a callback on these sizes. */
function lowerMedian(values: Float64Array): number {
  if (values.length === 0) return 0;
  values.sort();
  return values[Math.floor(values.length / 2)]!;
}

function buildSectorEquityContext(
  model: EquityModel,
  input: SpawnEquityInput,
): SectorEquityContext {
  const sectors = input.sectors;
  const blocked = computeBlockedTiles(input.entityPlacements);
  const pools: Array<Array<{ row: number; col: number; x: number; y: number }>> = [];
  const medians: Array<Record<SpawnEquityComponent, number>> = [];
  for (let sRow = 0; sRow < SECTOR_GRID_SIZE; sRow++) {
    for (let sCol = 0; sCol < SECTOR_GRID_SIZE; sCol++) {
      const pool = eligiblePool(sectors[sRow]![sCol]!, sRow, sCol, blocked);
      const weapon = new Float64Array(pool.length);
      const chest = new Float64Array(pool.length);
      const clump = new Float64Array(pool.length);
      const hot = new Float64Array(pool.length);
      for (let t = 0; t < pool.length; t++) {
        const tile = pool[t]!;
        const v = componentValues(model, tile.x, tile.y);
        weapon[t] = v.weapon;
        chest[t] = v.chest;
        clump[t] = v.clump;
        hot[t] = v.hot;
      }
      pools[sRow * SECTOR_GRID_SIZE + sCol] = pool;
      medians[sRow * SECTOR_GRID_SIZE + sCol] = {
        weapon: lowerMedian(weapon),
        chest: lowerMedian(chest),
        clump: lowerMedian(clump),
        hot: lowerMedian(hot),
      };
    }
  }
  return { pools, medians };
}

/** Worst component ratio of a position's values against the sector medians. */
function ratioOf(values: SpawnEquityValues, medians: Record<SpawnEquityComponent, number>): number {
  let worst = 0;
  for (const component of SPAWN_EQUITY_COMPONENTS) {
    const median = medians[component];
    if (median <= 0) continue;
    worst = Math.max(worst, values[component] / median);
  }
  return worst;
}

export {
  buildEquityModel,
  buildSectorEquityContext,
  componentValues,
  computeBlockedTiles,
  ratioOf,
};

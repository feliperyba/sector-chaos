import { TileType } from '../enums/TileType.js';
import type { SectorData } from './types.js';
import { SectorType } from './types.js';
import {
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  CHEST_COUNT,
  BARREL_COUNT_RANGE,
  MIN_LOOT_PER_SECTOR,
} from './constants.js';
import { isEmptyTile, isWallLikeTile, buildCompositeGrid } from './gridUtils.js';
import type { TileSpriteDef, TileVisual } from './tiledTypes.js';
import { edgeBand, WALL_ART_SHAPES } from './wallArtShapes.js';
import { auditCornerDangling, type CornerDanglingViolation } from './validatorCorners.js';

// The corner-dangling audit lives in `validatorCorners` (ticket 20); the
// violation type is re-exported so the public validator API stays one module.
export type { CornerDanglingViolation } from './validatorCorners.js';

const COMPOSITE_LAST = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE - 1;

const CARDINAL_DIRS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/**
 * Computes the fraction of the composite interior (excluding the outer border
 * ring) that is EMPTY (walkable).
 * @param sectors The 2D grid of sector layouts.
 * @returns The open-space ratio in [0, 1]; 0 when there is no interior.
 */
export function computeOpenRatio(sectors: SectorData[][]): number {
  const grid = buildCompositeGrid(sectors);
  let empty = 0;
  let total = 0;
  for (let r = 1; r < COMPOSITE_LAST; r++) {
    for (let c = 1; c < COMPOSITE_LAST; c++) {
      total++;
      if (isEmptyTile(grid[r]![c]!)) empty++;
    }
  }
  return total === 0 ? 0 : empty / total;
}

/**
 * Counts spawn-eligible EMPTY tiles in a sector's interior. Mirrors
 * SpawnPointFinder.collectCandidates EXACTLY: rows/cols in
 * [1, SECTOR_TILE_SIZE-2], EMPTY tiles only.
 * @param sector The sector whose interior is scanned.
 * @returns The number of spawn-eligible EMPTY interior tiles.
 */
export function countSpawnEligible(sector: SectorData): number {
  const tiles = sector.tiles;
  let count = 0;
  for (let r = 1; r < SECTOR_TILE_SIZE - 1; r++) {
    for (let c = 1; c < SECTOR_TILE_SIZE - 1; c++) {
      if (isEmptyTile(tiles[r]![c]!)) count++;
    }
  }
  return count;
}

/**
 * The minimum tile budget a sector's loot needs: its chests, the lower barrel
 * count, and the minimum loot floor.
 * @param type The sector type whose budget is computed.
 * @returns The number of eligible tiles the sector must be able to host.
 */
export function lootBudget(type: SectorType): number {
  return (CHEST_COUNT[type] ?? 0) + BARREL_COUNT_RANGE.min + MIN_LOOT_PER_SECTOR;
}

/**
 * Whether a tile has at least one cardinal neighbour that is an indestructible wall.
 * @param tiles The sector tile grid.
 * @param row The tile row.
 * @param col The tile column.
 * @returns True when at least one cardinal neighbour is INDESTRUCTIBLE_WALL.
 */
function isAdjacentToIndestructibleWall(tiles: Uint8Array[], row: number, col: number): boolean {
  for (const [dr, dc] of CARDINAL_DIRS) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < tiles.length && nc >= 0 && nc < tiles[0]!.length) {
      if (tiles[nr]![nc] === TileType.INDESTRUCTIBLE_WALL) return true;
    }
  }
  return false;
}

/**
 * Counts loot-eligible tiles in a sector, mirroring EntityPlacer's rule:
 * interior EMPTY tiles that are not corridor tiles and not cardinally adjacent
 * to an indestructible wall.
 * @param sector The sector whose interior is scanned.
 * @param sRow The sector's grid row (for corridor keys).
 * @param sCol The sector's grid column (for corridor keys).
 * @param corridorTiles The set of corridor tile keys to exclude.
 * @returns The number of loot-eligible tiles in the sector.
 */
export function countLootEligible(
  sector: SectorData,
  sRow: number,
  sCol: number,
  corridorTiles: Set<string>,
): number {
  const tiles = sector.tiles;
  const last = SECTOR_TILE_SIZE - 1;
  let count = 0;
  for (let r = 1; r < last; r++) {
    for (let c = 1; c < last; c++) {
      if (!isEmptyTile(tiles[r]![c]!)) continue;
      if (corridorTiles.has(`${sRow},${sCol},${r},${c}`)) continue;
      if (isAdjacentToIndestructibleWall(tiles, r, c)) continue;
      count++;
    }
  }
  return count;
}

/**
 * Counts isolated stub walls across the composite interior: INDESTRUCTIBLE_WALL
 * tiles (excluding the outer border ring) whose 8 neighbours contain zero other
 * wall tiles (INDESTRUCTIBLE_WALL or DESTRUCTIBLE_WALL).
 * @param sectors The 2D grid of sector layouts.
 * @returns The number of isolated stub walls.
 */
export function countIsolatedStubWalls(sectors: SectorData[][]): number {
  const grid = buildCompositeGrid(sectors);
  let lone = 0;
  for (let r = 1; r < COMPOSITE_LAST; r++) {
    for (let c = 1; c < COMPOSITE_LAST; c++) {
      if (grid[r]![c]! !== TileType.INDESTRUCTIBLE_WALL) continue;
      if (countWallNeighbours8(grid, r, c) === 0) lone++;
    }
  }
  return lone;
}

/**
 * Counts the 8-neighbour wall tiles around a composite cell. A wall is either
 * INDESTRUCTIBLE_WALL or DESTRUCTIBLE_WALL.
 * @param grid The composite tile grid.
 * @param r The cell row.
 * @param c The cell column.
 * @returns The number of neighbouring wall tiles (0-8).
 */
function countWallNeighbours8(grid: Uint8Array[], r: number, c: number): number {
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > COMPOSITE_LAST || nc < 0 || nc > COMPOSITE_LAST) continue;
      const v = grid[nr]![nc]!;
      if (v === TileType.INDESTRUCTIBLE_WALL || v === TileType.DESTRUCTIBLE_WALL) count++;
    }
  }
  return count;
}

// ── wall composition validator (map-polish ticket 14) ────────────────────────

/**
 * One adjacent wall-tile pair whose touching edges share NO solid band on the
 * rendered visuals (a "gap" — floor shows through the whole shared edge).
 */
export interface WallCompositionViolation {
  /** Cell the pair is reported from (the upper/left tile). */
  row: number;
  col: number;
  /** Direction of the neighbour: E = (row, col+1), S = (row+1, col). */
  dir: 'E' | 'S';
  imagePath: string;
  rotation: number;
  neighborImagePath: string;
  neighborRotation: number;
  /** Composite-grid tile types of the pair (for residual classification). */
  tile: TileType;
  neighborTile: TileType;
  bucket: 'seam' | 'interior';
  /** Human-readable edge dump, e.g. `myEdge=........ theirEdge=........`. */
  detail: string;
}

/** An interior wall tile with zero wall-like 8-neighbours (a 1-tile stub). */
export interface OrphanStubCell {
  row: number;
  col: number;
  tile: TileType;
}

/** Result of {@link validateWallComposition} — all fields pure counts/lists. */
export interface WallCompositionAudit {
  /** Continuity violations on sector-border tiles (the 2-thick seam lines). */
  seamViolations: number;
  /** Continuity violations everywhere else (side-flipped runs, mass edges…). */
  interiorViolations: number;
  /**
   * Unsanctioned orphan 1-tile INDESTRUCTIBLE stubs — wall tiles with zero
   * wall-like 8-neighbours outside sanctioned cover-object placements (see
   * {@link collectSanctionedStubCells}). Zero is the ticket-14 gate.
   */
  orphanStubWalls: number;
  /** The unsanctioned orphan cells themselves (capped list for messages). */
  orphanStubs: OrphanStubCell[];
  /**
   * Orphaned DESTRUCTIBLE walls (shards). Zero after the ticket-14
   * composition pass (orphans become crates); telemetry so a regression
   * is visible before it becomes a rendering defect.
   */
  destructibleShardCount: number;
  /** Isolated indestructible stubs exempted as sanctioned (telemetry). */
  sanctionedStubCount: number;
  /** All continuity violations, seam bucket first (row-major order). */
  violations: WallCompositionViolation[];
  /**
   * Corner-dangling violations (ticket 20): wall tiles whose only wall-like
   * attachment is diagonal but whose art leaves that corner quadrant
   * transparent. Zero is the gate — such cells must render corner-hugging
   * art (see `server/infrastructure/map/WallVisualSelectorCorners.ts`).
   */
  cornerDanglingViolations: number;
  /** The corner-dangling violations themselves (row-major order). */
  cornerViolations: CornerDanglingViolation[];
  /**
   * Art-limited corner cells (telemetry): corner-dangling tiles with a
   * wall-like diagonal in ALL FOUR quadrants — a checkerboard pocket. No
   * single atlas frame solidifies four corner quadrants (the convex L — the
   * densest piece — covers three), so the best hug always leaves one corner
   * open. Not a violation; documented art gap.
   */
  cornerArtLimitedCells: number;
}

/** Options for {@link validateWallComposition}. */
export interface WallCompositionOptions {
  /** The server-emitted `wall_fill` layer cells: a filled side connects a pair. */
  fillCells?: (TileVisual | null)[][];
  /** The sprite atlas the wall layer's `spriteId`s index into. */
  atlasSprites?: TileSpriteDef[];
  /** Sanctioned orphan-stub cells ("r,c" keys), see {@link collectSanctionedStubCells}. */
  sanctionedStubCells?: ReadonlySet<string>;
  /** Sector size in tiles for the seam bucket (default 20, the map standard). */
  sectorSize?: number;
}

/**
 * Whether a wall tile sits at a pure-destructible T-stem topology — the
 * documented D5 art-coverage exception (the strip kit has no T piece; a
 * T-stem needs three connective edges but one strip carries one cap band).
 *
 * A tile is T-stem-class iff it is a T JUNCTION cell (walls on exactly three
 * cardinals) or the STEM of one (exactly one wall cardinal, whose neighbour is
 * a junction). Neighbouring is wall-like (`isWallLikeTile`), matching what the
 * masks/visuals see.
 *
 * Module-private (ticket 16): zero consumers outside this file — it exists to
 * serve {@link isPureDestructibleTStemPair}, which is the exported classifier.
 */
function isTStemTopology(grid: TileType[][], row: number, col: number): boolean {
  const wallCardinals = (r: number, c: number): number => {
    let count = 0;
    for (const [dr, dc] of CARDINAL_DIRS) {
      const v = grid[r + dr]?.[c + dc];
      if (v !== undefined && isWallLikeTile(v)) count++;
    }
    return count;
  };
  const own = wallCardinals(row, col);
  if (own === 3) return true;
  if (own === 1) {
    for (const [dr, dc] of CARDINAL_DIRS) {
      const nr = row + dr;
      const nc = col + dc;
      const v = grid[nr]?.[nc];
      if (v !== undefined && isWallLikeTile(v) && wallCardinals(nr, nc) >= 3) return true;
    }
  }
  return false;
}

/**
 * Whether a continuity-violating pair is the pure-destructible T-stem class:
 * BOTH tiles DESTRUCTIBLE_WALL and at least one in T topology. Every residual
 * under the committed sweep bound must satisfy this — any other residual is a
 * representable defect (a real regression), not an art-coverage exception.
 */
export function isPureDestructibleTStemPair(
  grid: TileType[][],
  row: number,
  col: number,
  dir: 'E' | 'S',
): boolean {
  const nRow = dir === 'E' ? row : row + 1;
  const nCol = dir === 'E' ? col + 1 : col;
  const a = grid[row]?.[col];
  const b = grid[nRow]?.[nCol];
  if (a !== TileType.DESTRUCTIBLE_WALL || b !== TileType.DESTRUCTIBLE_WALL) return false;
  return isTStemTopology(grid, row, col) || isTStemTopology(grid, nRow, nCol);
}

/**
 * Collect the SANCTIONED orphan-stub cells of a generated map: isolated
 * INDESTRUCTIBLE_WALL tiles inside MAZE-type sectors. Maze skeletons carve
 * corridors out of a solid block; the surviving 1×1 separator residue between
 * carved corridors is the authored maze pillar topology — a deliberate
 * cover-object placement, not a defect (removing it would thin every maze).
 * Every other isolated indestructible stub (gate-jamb remnants, heal-pass
 * collateral) is unsanctioned and must be eliminated by the composition pass.
 */
export function collectSanctionedStubCells(sectors: SectorData[][]): Set<string> {
  const grid = buildCompositeGrid(sectors);
  const cells = new Set<string>();
  for (let r = 1; r < COMPOSITE_LAST; r++) {
    for (let c = 1; c < COMPOSITE_LAST; c++) {
      if (grid[r]![c]! !== TileType.INDESTRUCTIBLE_WALL) continue;
      if (countWallLikeNeighbours8(grid, r, c) !== 0) continue;
      const sector = sectors[Math.floor(r / SECTOR_TILE_SIZE)]![Math.floor(c / SECTOR_TILE_SIZE)]!;
      if (sector.type === SectorType.MAZE) cells.add(`${r},${c}`);
    }
  }
  return cells;
}

/** 8-neighbourhood wall-like count (render semantics — incl. indestructible crates). */
function countWallLikeNeighbours8(grid: Uint8Array[], r: number, c: number): number {
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const v = grid[r + dr]?.[c + dc];
      if (v !== undefined && isWallLikeTile(v)) count++;
    }
  }
  return count;
}

function fmtBand(band: number[]): string {
  return band.map((v) => (v >= 0.5 ? '#' : v > 0 ? '+' : '.')).join('');
}

/**
 * THE wall-composition quality gate (map-polish ticket 14): audit the
 * composite grid + the RENDERED wall visuals (+ the `wall_fill` layer) for the
 * user-reported wall-shape defect classes.
 *
 * - Continuity: every adjacent wall-tile pair must share at least one solid
 *   edge band on the art-shape ground truth (`wallArtShapes.ts`) — a filled
 *   side (either tile of the pair carries a `wall_fill` cell) connects by
 *   construction. Violations bucket into `seam` (sector-border tiles, the
 *   2-thick lines) and `interior`.
 * - Orphan stubs: interior wall tiles with zero wall-like 8-neighbours.
 *   `orphanStubWalls` counts UNSANCTIONED indestructible stubs (the
 *   sanctioned maze-pillar set is passed in via opts); destructible shards are
 *   reported separately (`destructibleShardCount`).
 * - Corner-dangling coverage (ticket 20): a wall tile whose ONLY wall-like
 *   attachment is diagonal must render art whose 2×2 corner quadrant toward
 *   that diagonal is at least 3/4 solid (a fill cell counts as fully solid) —
 *   otherwise the wall reads as a floating shard detached from its only
 *   attachment. This audits the DIAGONAL links the continuity pass cannot
 *   see (it only measures cardinal E/S pairs).
 *
 * Pure and deterministic (ADR 0035): a strict function of the grid, visuals,
 * fill layer and atlas — no RNG, no wall-clock, no global state. The same
 * inputs always produce the identical audit.
 *
 * @param grid The composite tile grid (e.g. `EnrichedMapData.grid`).
 * @param wallCells The `map_border_walls` visual-layer cells.
 * @param opts Fill layer, atlas, sanctioned stubs and sector size.
 */
export function validateWallComposition(
  grid: TileType[][],
  wallCells: (TileVisual | null)[][],
  opts: WallCompositionOptions = {},
): WallCompositionAudit {
  const sectorSize = opts.sectorSize ?? SECTOR_TILE_SIZE;
  const byId = new Map((opts.atlasSprites ?? []).map((s) => [s.id, s]));
  const onSectorSeam = (r: number, c: number): boolean => {
    const lr = r % sectorSize;
    const lc = c % sectorSize;
    return lr === 0 || lr === sectorSize - 1 || lc === 0 || lc === sectorSize - 1;
  };

  // ── continuity: adjacent wall pairs must share a solid band ──
  const violations: WallCompositionViolation[] = [];
  const record = (row: number, col: number, dir: 'E' | 'S'): void => {
    const a = wallCells[row]?.[col];
    if (!a) return;
    const nRow = dir === 'E' ? row : row + 1;
    const nCol = dir === 'E' ? col + 1 : col;
    const b = wallCells[nRow]?.[nCol];
    if (!b) return;
    if (opts.fillCells) {
      if (opts.fillCells[row]?.[col] || opts.fillCells[nRow]?.[nCol]) return;
    }
    const defA = byId.get(a.spriteId);
    const defB = byId.get(b.spriteId);
    if (!defA || !defB) return;
    if (!WALL_ART_SHAPES[defA.imagePath] || !WALL_ART_SHAPES[defB.imagePath]) return;

    const myEdge =
      dir === 'E'
        ? edgeBand(defA.imagePath, a.rotation, 'E')
        : edgeBand(defA.imagePath, a.rotation, 'S');
    const theirEdge =
      dir === 'E'
        ? edgeBand(defB.imagePath, b.rotation, 'W')
        : edgeBand(defB.imagePath, b.rotation, 'N');
    if (myEdge.some((v, i) => v >= 0.5 && theirEdge[i]! >= 0.5)) return;

    violations.push({
      row,
      col,
      dir,
      imagePath: defA.imagePath,
      rotation: a.rotation,
      neighborImagePath: defB.imagePath,
      neighborRotation: b.rotation,
      tile: grid[row]?.[col] ?? TileType.EMPTY,
      neighborTile: grid[nRow]?.[nCol] ?? TileType.EMPTY,
      bucket: onSectorSeam(row, col) || onSectorSeam(nRow, nCol) ? 'seam' : 'interior',
      detail: `myEdge=${fmtBand(myEdge)} theirEdge=${fmtBand(theirEdge)}`,
    });
  };
  for (let row = 0; row < wallCells.length; row++) {
    for (let col = 0; col < wallCells[row]!.length; col++) {
      record(row, col, 'E');
      record(row, col, 'S');
    }
  }

  // ── orphan stubs: interior wall tiles with zero wall-like neighbours ──
  const orphanStubs: OrphanStubCell[] = [];
  let destructibleShards = 0;
  let sanctioned = 0;
  const last = Math.min(grid.length, wallCells.length) - 1;
  for (let r = 1; r < last; r++) {
    const rowCells = grid[r] ?? [];
    for (let c = 1; c < Math.min(rowCells.length, wallCells[r]?.length ?? 0) - 1; c++) {
      const tile = rowCells[c]!;
      if (!isWallLikeTile(tile)) continue;
      let isolated = true;
      for (let dr = -1; dr <= 1 && isolated; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const v = grid[r + dr]?.[c + dc];
          if (v !== undefined && isWallLikeTile(v)) {
            isolated = false;
            break;
          }
        }
      }
      if (!isolated) continue;
      if (tile === TileType.DESTRUCTIBLE_WALL) {
        destructibleShards++;
        continue;
      }
      if (tile !== TileType.INDESTRUCTIBLE_WALL) continue; // indestructible crates: objects
      if (opts.sanctionedStubCells?.has(`${r},${c}`)) {
        sanctioned++;
        continue;
      }
      orphanStubs.push({ row: r, col: c, tile });
    }
  }

  // ── corner-dangling coverage (ticket 20) ──
  const cornerAudit = auditCornerDangling(grid, wallCells, {
    fillCells: opts.fillCells,
    atlasSprites: opts.atlasSprites,
  });

  return {
    seamViolations: violations.filter((v) => v.bucket === 'seam').length,
    interiorViolations: violations.filter((v) => v.bucket === 'interior').length,
    orphanStubWalls: orphanStubs.length,
    orphanStubs,
    destructibleShardCount: destructibleShards,
    sanctionedStubCount: sanctioned,
    violations,
    cornerDanglingViolations: cornerAudit.violations.length,
    cornerViolations: cornerAudit.violations,
    cornerArtLimitedCells: cornerAudit.artLimitedCells,
  };
}

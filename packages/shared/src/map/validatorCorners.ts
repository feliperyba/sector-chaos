/**
 * validatorCorners — the corner-dangling coverage audit (map-polish round-2,
 * ticket 20; extracted beside `validatorGates` for the 500-line gate).
 *
 * A wall tile whose ONLY wall-like attachment is DIAGONAL (zero wall-like
 * cardinal neighbours, ≥1 wall-like diagonal — a "corner-dangling" cell)
 * must render art whose 2×2 corner quadrant toward each such diagonal is at
 * least 3/4 solid (a `wall_fill` cell counts as fully solid). Otherwise the
 * wall visually detaches from its only attachment and reads as a floating
 * shard — the "validator-green but visually wrong" class the cardinal-pair
 * continuity audit cannot see (it only measures E/S pairs).
 *
 * Art limit: a checkerboard pocket (a wall-like diagonal in ALL FOUR
 * quadrants) cannot be fully corner-covered by any single atlas frame (the
 * convex L — the densest piece — solidifies three quadrants), so those cells
 * are reported as telemetry (`artLimitedCells`), not violations.
 *
 * Pure and deterministic (ADR 0035): a strict function of the grid, wall
 * visuals, fill layer and atlas. Off-grid reads as wall-like, mirroring
 * `WallOrientationDetector.detect` (the world ends in wall — border-ring
 * tiles always have cardinal walls and are never corner-dangling).
 */

import { TileType } from '../enums/TileType.js';
import { isWallLikeTile } from './gridUtils.js';
import type { TileSpriteDef, TileVisual } from './tiledTypes.js';
import { orientedShape, SOLID_THRESHOLD, WALL_ART_SHAPES } from './wallArtShapes.js';

/** One corner-dangling cell whose art leaves a diagonal corner quadrant open. */
export interface CornerDanglingViolation {
  row: number;
  col: number;
  /** The diagonal the wall-like neighbour sits on. */
  dir: 'NE' | 'SE' | 'SW' | 'NW';
  imagePath: string;
  rotation: number;
  /** How many of the corner quadrant's 4 sub-cells are solid (needs ≥ 3). */
  cornerSolid: number;
}

export interface CornerAuditOptions {
  /** The `wall_fill` layer cells: a filled tile is fully solid by construction. */
  fillCells?: (TileVisual | null)[][];
  /** The sprite atlas the wall layer's `spriteId`s index into. */
  atlasSprites?: TileSpriteDef[];
}

const CORNER_CELLS: Record<'NE' | 'SE' | 'SW' | 'NW', Array<[number, number]>> = {
  NE: [
    [0, 6],
    [0, 7],
    [1, 6],
    [1, 7],
  ],
  SE: [
    [6, 6],
    [6, 7],
    [7, 6],
    [7, 7],
  ],
  SW: [
    [6, 0],
    [6, 1],
    [7, 0],
    [7, 1],
  ],
  NW: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ],
};

const DIAG_OFFSETS: Array<{ dir: 'NE' | 'SE' | 'SW' | 'NW'; dr: number; dc: number }> = [
  { dir: 'NE', dr: -1, dc: 1 },
  { dir: 'SE', dr: 1, dc: 1 },
  { dir: 'SW', dr: 1, dc: -1 },
  { dir: 'NW', dr: -1, dc: -1 },
];

/**
 * Audit the wall layer for corner-dangling coverage violations (see header).
 * The grid argument mirrors `validateWallComposition`'s composite grid; when
 * it is empty (the continuity-only helper path) every read is off-grid =
 * wall-like, so nothing is corner-dangling and the audit is inert.
 */
export function auditCornerDangling(
  grid: TileType[][],
  wallCells: (TileVisual | null)[][],
  opts: CornerAuditOptions = {},
): { violations: CornerDanglingViolation[]; artLimitedCells: number } {
  const byId = new Map((opts.atlasSprites ?? []).map((s) => [s.id, s]));
  const wallLikeAt = (r: number, c: number): boolean => {
    const v = grid[r]?.[c];
    return v === undefined ? true : isWallLikeTile(v);
  };
  const violations: CornerDanglingViolation[] = [];
  let artLimited = 0;

  for (let r = 0; r < wallCells.length; r++) {
    for (let c = 0; c < wallCells[r]!.length; c++) {
      const cell = wallCells[r]![c];
      if (!cell) continue;
      // Dangling = zero wall-like cardinal neighbours (all four open).
      if (
        wallLikeAt(r - 1, c) ||
        wallLikeAt(r + 1, c) ||
        wallLikeAt(r, c - 1) ||
        wallLikeAt(r, c + 1)
      ) {
        continue;
      }
      const wallDiagonals = DIAG_OFFSETS.filter(({ dr, dc }) => wallLikeAt(r + dr, c + dc));
      if (wallDiagonals.length === 0) continue; // true lone pillar: not corner-audited
      if (wallDiagonals.length === DIAG_OFFSETS.length) {
        // Checkerboard pocket: no single atlas frame covers four corners.
        artLimited++;
        continue;
      }
      const def = byId.get(cell.spriteId);
      const filled = opts.fillCells ? opts.fillCells[r]?.[c] != null : false;
      const shape =
        filled || !def || !WALL_ART_SHAPES[def.imagePath]
          ? null
          : orientedShape(def.imagePath, cell.rotation);
      for (const { dir } of wallDiagonals) {
        let solid = 4; // a fill cell is fully solid by construction
        if (shape) {
          solid = 0;
          for (const [y, x] of CORNER_CELLS[dir]) {
            if ((shape[y]?.[x] ?? 0) >= SOLID_THRESHOLD) solid++;
          }
        }
        if (solid >= 3) continue;
        violations.push({
          row: r,
          col: c,
          dir,
          imagePath: def?.imagePath ?? '',
          rotation: cell.rotation,
          cornerSolid: solid,
        });
      }
    }
  }

  return { violations, artLimitedCells: artLimited };
}

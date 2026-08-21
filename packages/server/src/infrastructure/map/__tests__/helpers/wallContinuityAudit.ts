/**
 * Geometric continuity audit for a wall visual layer (map-polish tickets 12+
 * 13; shared-canonical since ticket 14).
 *
 * Promoted from the map-polish topic-F research probe (`wall-audit-probe.mts`)
 * into a repo test util. For every pair of ADJACENT wall tiles it checks the
 * art ground truth (`shared/map/wallArtShapes.ts`): the two touching edges
 * must share at least one solid band (an index where both 8-cell coverage
 * bands are ≥ 0.5). If they do not, the pair is a *continuity violation* —
 * literally "the open side does not connect to the adjacent wall, creating a
 * gap" — because floor shows through the whole shared edge.
 *
 * Violations are bucketed:
 *   - `seam`     — either tile sits on a sector border (local row/col 0 or
 *                  `sectorSize - 1`; default 20): the 2-tile-thick walls the
 *                  sector-ring stacking builds at cols/rows 19|20, 39|40, 59|60.
 *   - `interior` — everything else (side-flipped runs, wall-mass edges, …).
 *
 * Ticket 13: the audit is FILL-AWARE — pass the server-emitted `wall_fill`
 * layer cells and any pair with at least one filled tile counts as connected
 * (the opaque fill beneath the strip art provides the shared solid band). The
 * seed-sweep gate asserts ZERO violations, seam or interior.
 *
 * Ticket 14: the pair logic now LIVES IN SHARED (`validatorGates.
 * validateWallComposition` — the generation-side gate) and this helper is a
 * thin adapter over it, so this test gate and the shipped validator can never
 * drift. The validator also audits orphan stubs; the adapter passes an empty
 * grid, so this helper stays continuity-only (its historical contract).
 */

import type { TileSpriteDef, TileVisual } from '@sector-battle/shared';
import { validateWallComposition } from '@sector-battle/shared';

export interface ContinuityViolation {
  /** Cell the pair is reported from (the upper/left tile). */
  row: number;
  col: number;
  /** Direction of the neighbour: E = (row, col+1), S = (row+1, col). */
  dir: 'E' | 'S';
  imagePath: string;
  rotation: number;
  neighborImagePath: string;
  neighborRotation: number;
  bucket: 'seam' | 'interior';
  /** Human-readable edge dump, e.g. `myEdge=........ theirEdge=........`. */
  detail: string;
}

export interface ContinuityAuditResult {
  violations: ContinuityViolation[];
  seamCount: number;
  interiorCount: number;
}

export interface ContinuityAuditOptions {
  /** Sector size in tiles for the seam bucket (default 20, the map standard). */
  sectorSize?: number;
  /**
   * The `wall_fill` layer cells (ticket 13). When provided, a pair with a
   * filled tile on either side is connected — the fill is a full-tile opaque
   * frame, so both touching edges carry a solid band by construction.
   */
  fillCells?: (TileVisual | null)[][];
}

/**
 * Audit a wall visual layer for geometric continuity.
 *
 * @param wallCells the `map_border_walls` layer cells (from
 *   `EnrichedMapData.visualLayers` or `selectWallVisuals` directly).
 * @param atlas the sprite atlas the layer's `spriteId`s index into.
 */
export function auditWallLayerContinuity(
  wallCells: (TileVisual | null)[][],
  atlas: TileSpriteDef[],
  opts: ContinuityAuditOptions = {},
): ContinuityAuditResult {
  const audit = validateWallComposition([], wallCells, {
    fillCells: opts.fillCells,
    atlasSprites: atlas,
    sectorSize: opts.sectorSize,
  });
  return {
    violations: audit.violations,
    seamCount: audit.seamViolations,
    interiorCount: audit.interiorViolations,
  };
}

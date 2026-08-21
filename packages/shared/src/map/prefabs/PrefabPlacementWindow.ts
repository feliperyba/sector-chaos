/**
 * Prefab placement window scan (partial of {@link "./PrefabPlacementPass.js"})
 * — the pure window-qualification half of the placement engine: the 5×5 scan
 * constants, the corridor-key format, and `windowQualifies` (extracted from the
 * pass at the F8 500-line gate; zero behavior change).
 */

import { TileType } from '../../enums/TileType.js';
import { SECTOR_TILE_SIZE } from '../constants.js';
import type { SectorData } from '../types.js';

/** Scan window half-width (5×5 — the dead-zone pass's legacy window size;
 *  stamp footprints may extend past the box, every out-of-box cell is still
 *  per-cell paint-gated + conflict-clipped). */
export const WINDOW_HALF = 2;

/**
 * Ticket-28 mostly-open rule: a window qualifies when at least this many of its
 * 25 cells are EMPTY. ≤7 non-EMPTY cells (authored skeleton geometry at the
 * window's edge) are tolerated — the stamp's per-cell paint-gate never writes
 * them. 18/25 = 72% open keeps the composition read while letting prefabs
 * frame around skeleton structure instead of only landing in virgin pockets.
 */
export const MIN_WINDOW_EMPTY = 18;

/**
 * Round-7 phase-1 framing ceiling: a window FRAMES structure when at most this
 * many of its 25 cells are EMPTY (≥2 authored skeleton cells inside the box).
 * Phase 1 stamps only framing windows; phase 2 admits every mostly-open window
 * (virgin open-field pockets fill last, only while the cap has room).
 */
export const WINDOW_MAX_EMPTY_FOR_FRAMING = 23;

/** First/last interior ANCHOR coords whose 5×5 box stays inside rows/cols 1..18. */
export const ANCHOR_LO = 1 + WINDOW_HALF;
export const ANCHOR_HI = SECTOR_TILE_SIZE - 2 - WINDOW_HALF;

/** Chebyshev clearance required between the window box and the landmark anchor. */
const ANCHOR_KEEP_CLEAR = 2;

/** Corridor-tile key format used by SectorConnector (`sRow,sCol,tRow,tCol`). */
export function corridorKey(row: number, col: number, tileRow: number, tileCol: number): string {
  return `${row},${col},${tileRow},${tileCol}`;
}

/**
 * Whether the 5×5 box around the anchor is a mostly-open pocket eligible for
 * a prefab (ticket 28): every cell interior, none a corridor/macro/reserved
 * cell, the whole box clear of the landmark anchor's keep zone, and at least
 * {@link MIN_WINDOW_EMPTY} of the 25 cells EMPTY. Non-EMPTY cells (authored
 * skeleton geometry) never receive prefab writes — the per-cell paint-gate in
 * the pass's stampPrefab enforces that for every footprint cell.
 *
 * Round 7 `requireFraming` (phase-1 scan): the box must additionally HOLD ≥2
 * non-EMPTY cells — authored structure the composition frames around, the
 * backed-on read; virgin 25/25-empty boxes only qualify in the phase-2 fill.
 */
export function windowQualifies(
  sector: SectorData,
  sRow: number,
  sCol: number,
  anchorRow: number,
  anchorCol: number,
  corridorTiles: Set<string>,
  macroTiles: Set<string>,
  reserved: Set<string>,
  requireFraming: boolean,
): boolean {
  const anchor = sector.landmarkAnchor;
  let emptyCells = 0;
  for (let dr = -WINDOW_HALF; dr <= WINDOW_HALF; dr++) {
    for (let dc = -WINDOW_HALF; dc <= WINDOW_HALF; dc++) {
      const r = anchorRow + dr;
      const c = anchorCol + dc;
      if (r < 1 || r > SECTOR_TILE_SIZE - 2 || c < 1 || c > SECTOR_TILE_SIZE - 2) return false;
      if (sector.tiles[r]![c] === TileType.EMPTY) emptyCells++;
      if (corridorTiles.has(corridorKey(sRow, sCol, r, c))) return false;
      if (macroTiles.has(`${sRow * SECTOR_TILE_SIZE + r},${sCol * SECTOR_TILE_SIZE + c}`)) {
        return false;
      }
      if (reserved.has(`${r},${c}`)) return false;
      if (
        Math.max(Math.abs(c - anchor.x), Math.abs(r - anchor.y)) <=
        WINDOW_HALF + ANCHOR_KEEP_CLEAR
      ) {
        return false;
      }
    }
  }
  if (emptyCells < MIN_WINDOW_EMPTY) return false;
  // Phase 1: the box frames authored structure (≤ WINDOW_MAX_EMPTY_FOR_FRAMING
  // EMPTY cells = at least 2 skeleton cells inside the box).
  return !requireFraming || emptyCells <= WINDOW_MAX_EMPTY_FOR_FRAMING;
}

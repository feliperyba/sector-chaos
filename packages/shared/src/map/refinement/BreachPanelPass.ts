import { TileType } from '../../enums/TileType.js';
import type { SectorData } from '../types.js';
import { isWallLikeTile } from '../gridUtils.js';
import { SECTOR_TILE_SIZE } from '../constants.js';
import { getTile, setTile, GRID_SIZE } from './GridAccess.js';

/**
 * Breach Panel Pass (map-polish round 6) — the wall MATERIAL policy that turns
 * the map's authored indestructible geometry into partially breachable
 * structure: straight wall runs and exactly-2-thick wall bands keep rigid
 * anchors (endpoints, corners/junctions, thick cores, the map-edge ring) but
 * their MIDDLE spans convert to {@link TileType.DESTRUCTIBLE_WALL} in a
 * periodic panel rhythm, so players can smash structural breaches to reach
 * enemies or escape instead of being railroaded through authored gates.
 *
 * Owner directive (round 6, verbatim intent): "The internal walls in the
 * sector must have more destructible walls in the middle of the structure
 * composition and layout, not scattered around, but with the structure
 * geometry itself, so the users can create paths and open ways to reach their
 * enemies or escape."
 *
 * RULES (pure geometry — a tile converts only when its whole cardinal context
 * is structural):
 * - **Rigid by definition** (never converts): the sector border rings — the
 *   double seam bands between sectors and the global map-edge ring (OWNER
 *   RULE, round 6 correction: borders are never breachable, only the INTERNAL
 *   composition of a sector converts — sector-local rows/cols 1..18); any tile
 *   inside the `preserve` footprint (the compound/Citadel authors its own
 *   breach segments — its yard ring is already breakable and its shell is the
 *   rigid vault by design); run endpoints (fewer than 2 axial wall cardinals);
 *   corners / tees / crosses (wall cardinals on BOTH axes); every 2-thick
 *   band and thicker mass (only 1-thick straight-run middles are eligible —
 *   converted bands create 2×2 destructible blocks whose partner-seam
 *   facings deadlock the run-consistency repair, the round-6 D-D flip class).
 *   The GDD §5.2.1 "arena can never be flattened to an open box" invariant
 *   survives on these anchors: every 2×2 pillar, every junction, every seam,
 *   every thick structure, and the world boundary stay indestructible.
 * - **Straight-run middles**: a tile whose ONLY wall-like cardinals are the two
 *   OPPOSITE ones along its run axis (the classic 1-thick wall run interior).
 * - **Panel rhythm**: within each maximal contiguous breachable span, spans of
 *   2–4 tiles convert whole; longer spans convert in a 2-on/2-off cadence
 *   (panels of 2 separated by rigid ribs of 2 — a battlement read, never a
 *   scattered single). Spans of 1 never convert (no orphan scatter), and a
 *   cadence remainder of 1 stays rigid (no trailing 1-tile panel).
 *
 * The pass changes ONLY tile material (INDESTRUCTIBLE_WALL →
 * DESTRUCTIBLE_WALL): wall-likeness, neighbour masks, autotiler roles,
 * connectivity, and every placement gate are material-agnostic or read the
 * same wall-like set, so downstream passes are unaffected apart from seeing
 * the new materials.
 *
 * Determinism contract (ADR 0035): a PURE function of the sector tiles — no
 * RNG, no wall-clock, no global state. Two-phase (classify + collect flips
 * against the ORIGINAL grid, then apply) — flips cannot change any
 * classification input (wall-likeness is material-independent), so phase order
 * is immaterial, but the two-phase shape mirrors {@link WallCompositionPass}.
 */
export class BreachPanelPass {
  /**
   * Run the breach material pass (mutates `sectors` in place).
   *
   * @param sectors The 2D sector grid, AFTER every wall-writing pass
   *   (skeletons, connector, macro features + heal, prefab compositions,
   *   plaza keeps, border-buffer re-clean) and BEFORE the wall composition
   *   pass / entity placement.
   * @param preserve Global `row,col` keys of tiles that keep their authored
   *   material (the compound/Citadel footprint — same contract as
   *   `MapBorder.cleanBuffer`'s preserve set).
   * @returns Telemetry: tiles converted + panels written.
   */
  run(sectors: SectorData[][], preserve?: ReadonlySet<string>): BreachPanelStats {
    const flipH = this.blankMask();
    const flipV = this.blankMask();

    for (let r = 1; r < GRID_SIZE - 1; r++) {
      for (let c = 1; c < GRID_SIZE - 1; c++) {
        if (getTile(sectors, r, c) !== TileType.INDESTRUCTIBLE_WALL) continue;
        if (preserve?.has(`${r},${c}`)) continue;
        // OWNER RULE (round 6 correction): sector border walls — the double
        // seam bands — are NEVER breachable. Only the INTERNAL composition of
        // a sector converts (sector-local rows/cols 1..18); the border ring
        // (local 0/19, which includes the global map edge) stays fully
        // indestructible.
        const lr = r % SECTOR_TILE_SIZE;
        const lc = c % SECTOR_TILE_SIZE;
        if (lr === 0 || lc === 0 || lr === SECTOR_TILE_SIZE - 1 || lc === SECTOR_TILE_SIZE - 1) {
          continue;
        }

        const n = this.wallLike(sectors, r - 1, c);
        const s = this.wallLike(sectors, r + 1, c);
        const e = this.wallLike(sectors, r, c + 1);
        const w = this.wallLike(sectors, r, c - 1);

        // 1-THICK straight-run middles only: exactly two OPPOSITE wall-like
        // cardinals. 2-thick interior bands are deliberately NOT converted
        // (round 6 iteration): a converted band creates 2×2 destructible
        // blocks whose partner-seam facings deadlock the run-consistency
        // repair against adjacent thin runs (the D-D flip class), and a
        // 2-deep breach reads worse than a clean 1-deep panel anyway.
        // Thicker structures (junctions, mass cores, 2×2 pillars) keep every
        // tile rigid via the opposite-pair requirement.
        if (n && s && !e && !w) {
          flipV[r * GRID_SIZE + c] = 1;
        } else if (e && w && !n && !s) {
          flipH[r * GRID_SIZE + c] = 1;
        }
      }
    }

    // Rhythm: mark flips per span (a lone cadence remainder stays rigid).
    const flips: Array<[number, number]> = [];
    let panels = 0;
    const collectSpan = (span: Array<[number, number]>): void => {
      if (span.length < MIN_SPAN) return;
      let inPanel = false;
      for (let i = 0; i < span.length; i++) {
        const loneRemainder = i === span.length - 1 && i % CADENCE === 0;
        const convert =
          span.length <= WHOLE_SPAN_MAX || (i % CADENCE < CADENCE_ON && !loneRemainder);
        if (!convert) {
          inPanel = false;
          continue;
        }
        flips.push(span[i]!);
        if (!inPanel) {
          panels++;
          inPanel = true;
        }
      }
    };

    // Horizontal spans walk columns within a fixed row; vertical spans walk
    // rows within a fixed column. Both masks index r*GRID_SIZE+c.
    const walkSpans = (mask: Uint8Array, axis: 'H' | 'V'): void => {
      for (let a = 0; a < GRID_SIZE; a++) {
        let b = 0;
        while (b < GRID_SIZE) {
          const idx = axis === 'H' ? a * GRID_SIZE + b : b * GRID_SIZE + a;
          if (mask[idx] === 0) {
            b++;
            continue;
          }
          const span: Array<[number, number]> = [];
          while (b < GRID_SIZE) {
            const j = axis === 'H' ? a * GRID_SIZE + b : b * GRID_SIZE + a;
            if (mask[j] === 0) break;
            span.push(axis === 'H' ? [a, b] : [b, a]);
            b++;
          }
          collectSpan(span);
        }
      }
    };
    walkSpans(flipH, 'H');
    walkSpans(flipV, 'V');

    for (const [r, c] of flips) setTile(sectors, r, c, TileType.DESTRUCTIBLE_WALL);
    return { converted: flips.length, panels };
  }

  /** Wall-like read through the composite accessor (OOB reads are not walls). */
  private wallLike(sectors: SectorData[][], r: number, c: number): boolean {
    return isWallLikeTile(getTile(sectors, r, c));
  }

  private blankMask(): Uint8Array {
    return new Uint8Array(GRID_SIZE * GRID_SIZE);
  }
}

/** Telemetry of one pass run (never stored on MapData — byte identity). */
export interface BreachPanelStats {
  /** INDESTRUCTIBLE_WALL tiles converted to DESTRUCTIBLE_WALL. */
  converted: number;
  /** Contiguous panels written (≥2 tiles each except cadence joins). */
  panels: number;
}

/** Spans shorter than this never convert (no 1-tile scatter). */
const MIN_SPAN = 2;
/** Spans up to this length convert whole (a clean centered breach). */
const WHOLE_SPAN_MAX = 4;
/** Cadence block: CADENCE_ON tiles on, the rest off, for spans > WHOLE_SPAN_MAX. */
const CADENCE = 4;
const CADENCE_ON = 2;

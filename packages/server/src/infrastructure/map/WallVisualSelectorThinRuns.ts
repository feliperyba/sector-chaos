/**
 * WallVisualSelectorThinRuns — thin-wall MIRROR facing (map-polish round 5e).
 *
 * A 1-thick wall run with floor on BOTH sides (a 2-opposite-open mask) has no
 * floor side to present its bar toward — `classifyWall` resolves that symmetry
 * with a fixed global tie-break (N over S, E over W), so EVERY vertical thin
 * run faces E and every horizontal one faces N. On a symmetric structure that
 * handedness is visibly wrong: the beacon keep's WEST and EAST runs both faced
 * E (west bar inside the plaza, east bar outside — duplicated, not mirrored,
 * the owner-visible "disconnected walls" defect), and the run-consistency
 * repair then rotated the NW corner to band-connect with the west run's
 * inside-facing strip, re-introducing the pinwheel corner ticket 23 fixed.
 *
 * The general rule this module derives: **a thin straight follows the ARM SIDE
 * of the corner its run terminates into.** Ticket 23 orients every non-dangling
 * outer corner's elbow ON the quadrant between its two open cardinals; the
 * corner's arm that continues along the run axis hugs the tile edge on the
 * elbow's side of that axis. Facing the run the same way puts its strip on the
 * same edge as the corner's arm — the bands connect WITHOUT the repair pass
 * having to rotate the corner — and mirrored structures get mirrored facings
 * for free (a keep's west run follows the NW corner's west arm, the east run
 * the NE corner's east arm: both bars present outward, elbows cap the mass).
 *
 * Scope: BOTH materials. A mixed run (a breakable breach mid-wall) must not
 * flip strip side at the material boundary — the rule is geometric (which
 * edge the corner's arm hugs), not material. Runs with no corner end
 * (free-standing bars, the PORTAL_PAIR piers capped by endcaps) keep the
 * classifier tie-break — the endcap axis convention (vertical → face E)
 * agrees with it. The ticket-13 facing MODES ('open'/'run'/'partner' for
 * 1-open cells) are untouched; the pinned D5 T-stem residual sweep is
 * re-measured against this rule as part of the round-5e landing.
 *
 * Determinism contract (ADR 0035): a pure function of `(grid, orientations)` —
 * fixed walk order (N before S, W before E), fixed preference when both ends
 * are corners, no RNG, no wall-clock, no positional inputs.
 */

import { TileType } from '@sector-battle/shared';
import {
  DIRS,
  DIR_OFFSETS,
  openCardinalsOf,
  OPPOSITE,
  type Dir,
} from './WallVisualSelectorFacing.js';

/** Face = the open cardinal; rotation clockwise (the classifier convention). */
const STRAIGHT_ROTATION: Record<Dir, 0 | 90 | 180 | 270> = {
  N: 0,
  E: 90,
  S: 180,
  W: 270,
};

type Quadrant = 'NE' | 'SE' | 'SW' | 'NW';

/** The quadrant lying between two adjacent open cardinals (corner elbow). */
function betweenQuadrant(a: Dir, b: Dir): Quadrant {
  const set = new Set<Dir>([a, b]);
  if (set.has('N') && set.has('E')) return 'NE';
  if (set.has('S') && set.has('E')) return 'SE';
  if (set.has('S') && set.has('W')) return 'SW';
  return 'NW'; // N + W
}

/** Whether `open` is exactly the given opposite pair (an axis-aligned thin run). */
function isOppositePair(open: readonly Dir[], a: Dir, b: Dir): boolean {
  return open.length === 2 && open.includes(a) && open.includes(b);
}

/**
 * The run-end cell one walk-direction away, or null. Steps over same-axis thin
 * straights; the first wall-like cell whose open cardinals differ from the
 * run's own opposite pair is the end cell (corner / endcap / junction / mass).
 * Off-grid or floor before any such cell → null (no corner end this way).
 */
function walkRunEnd(
  grid: TileType[][],
  orientations: (number | null)[][],
  row: number,
  col: number,
  dir: Dir,
  vertical: boolean,
): [number, number] | null {
  const [dr, dc] = DIR_OFFSETS[dir];
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < grid.length && c >= 0 && c < grid[r]!.length) {
    const tile = grid[r]![c]!;
    const mask = orientations[r]![c]!;
    if (tile === undefined || mask === null || mask === undefined) return null;
    const open = openCardinalsOf(mask);
    const sameAxis = vertical ? isOppositePair(open, 'E', 'W') : isOppositePair(open, 'N', 'S');
    if (!sameAxis) return [r, c];
    r += dr;
    c += dc;
  }
  return null;
}

/**
 * Mirror facing for a 2-opposite-open INDESTRUCTIBLE straight whose run
 * terminates (either end, N/W checked first) in a 2-ADJACENT-open corner:
 * the rotation that puts this tile's strip on the same edge as the corner's
 * arm along the run axis. `null` when no run end is such a corner — the caller
 * keeps the classifier's tie-break facing.
 *
 * ROUND 6 — BODY-CONTOUR ends: a run end that is a 1-open WALL BODY (the
 * filled 2-thick face / mass edge of the structure the run belongs to) now
 * also yields a facing: the run's straights adopt the body's OPEN side as
 * their strip side, so a breach panel carved into a wall body keeps the
 * body's contour (mixed-material autotiling — without this, the panel's
 * straights fell back to the N-over-S tie-break and their strip faced the
 * OPPOSITE side of the run: the owner-visible "destructible walls not
 * following the autotiling when matched with indestructible walls"). The
 * body's open cardinal must be one of the run's own open cardinals (a body
 * facing along the run axis is not a contour for it); 0-open buried ends
 * yield nothing.
 *
 * `open` is the cell's own two opposite open cardinals (E+W → vertical run,
 * N+S → horizontal run).
 */
export function thinRunCornerFacing(
  grid: TileType[][],
  orientations: (number | null)[][],
  row: number,
  col: number,
  open: readonly Dir[],
): 0 | 90 | 180 | 270 | null {
  const vertical = isOppositePair(open, 'E', 'W');
  const walkDirs: readonly [Dir, Dir] = vertical ? ['N', 'S'] : ['W', 'E'];
  for (const dir of walkDirs) {
    const end = walkRunEnd(grid, orientations, row, col, dir, vertical);
    if (!end) continue;
    const [er, ec] = end;
    const endOpen = openCardinalsOf(orientations[er]![ec]!);
    // A corner topology: exactly two ADJACENT open cardinals (the floor
    // wrapping the elbow). 1/3-open ends (endcaps, T-stems) and opposite
    // pairs (a crossing thin run) are not corners — try the body branch /
    // the other end.
    if (endOpen.length === 2 && OPPOSITE[endOpen[0]!] !== endOpen[1]) {
      const elbow = betweenQuadrant(endOpen[0]!, endOpen[1]!);
      if (vertical) {
        // The corner's arm continuing this run hugs the W edge when the elbow
        // sits on the west half (NW/SW), else the E edge.
        return STRAIGHT_ROTATION[elbow === 'NW' || elbow === 'SW' ? 'W' : 'E'];
      }
      return STRAIGHT_ROTATION[elbow === 'NW' || elbow === 'NE' ? 'N' : 'S'];
    }
    // A 1-open INDESTRUCTIBLE wall BODY (three cardinal walls, one face): its
    // open side is the structure's contour — the run keeps its strip on that
    // side. INDESTRUCTIBLE: a filled mass face presents to its lone open
    // cardinal and NEVER rotates (ticket 27 — stable evidence). A 1-open
    // DESTRUCTIBLE end is an unfilled partner-seam cell: when its single
    // perpendicular wall is another DESTRUCTIBLE tile, the repair pass
    // settles the pair with their strips MEETING on that seam — so the
    // harvestable contour is the PARTNER side (the opposite of the open
    // side). A destructible end whose perpendicular wall is indestructible
    // yields nothing (the unfilled axis compromise is ambiguous pre-repair —
    // stale-state hazard, leave it to the classifier/repair).
    // MID-RUN GUARD (ticket-27 render truth): when the same thin run RESUMES
    // one step past the body (a same-axis thin straight beyond it), the body
    // is a backed junction inside the run and the run keeps its own facing
    // (the demo-ring convention — the junction alone presents to its floor
    // pocket); only a TERMINAL body (the run stops at the wall — the
    // breach panel against a wall end) yields the contour.
    if (endOpen.length === 1) {
      let contour: Dir | null = null;
      if (grid[er]![ec] === TileType.INDESTRUCTIBLE_WALL) {
        if (open.includes(endOpen[0]!)) contour = endOpen[0]!;
      } else {
        // Destructible partner-seam: the end's wall side PERPENDICULAR to the
        // run axis (the stub the end tile hugs — its strips-meet-on-the-seam
        // partner; the run tiles are open on those sides, the END is not).
        const perpDirs: readonly [Dir, Dir] = vertical ? ['E', 'W'] : ['N', 'S'];
        for (const d of perpDirs) {
          const [pr, pc] = [er + DIR_OFFSETS[d][0], ec + DIR_OFFSETS[d][1]];
          if (grid[pr]?.[pc] === TileType.DESTRUCTIBLE_WALL) {
            contour = d;
            break;
          }
        }
      }
      if (contour !== null) {
        const [odr, odc] = DIR_OFFSETS[dir];
        const br = er + odr;
        const bc = ec + odc;
        if (br >= 0 && br < grid.length && bc >= 0 && bc < grid[br]!.length) {
          const beyondMask = orientations[br]![bc];
          if (beyondMask !== null && beyondMask !== undefined) {
            const beyondOpen = openCardinalsOf(beyondMask);
            const beyondSameAxis = vertical
              ? isOppositePair(beyondOpen, 'E', 'W')
              : isOppositePair(beyondOpen, 'N', 'S');
            if (beyondSameAxis) continue; // the run resumes — mid-run junction
          }
        }
        return STRAIGHT_ROTATION[contour];
      }
    }
  }
  return null;
}

/**
 * The classifier's fixed tie-break facing for a 2-opposite-open straight
 * (N over S, E over W) — the fallback facing of a thin run with no corner
 * end, mirrored here so the endcap rule below can adopt the SAME effective
 * facing its run's straights resolved to.
 */
function tieBreakFacing(open: readonly Dir[]): 0 | 90 | 180 | 270 {
  return STRAIGHT_ROTATION[open.includes('N') ? 'N' : 'E'];
}

/**
 * Facing for a 3-open ENDCAP (round 5e): when the capped neighbour along the
 * single wall cardinal is a 2-opposite-open thin straight, the endcap adopts
 * that straight's effective facing (mirror-corner facing when present, else
 * the same tie-break) — so the pier's bar continues its own run's bar line
 * instead of the axis-rule default (both vertical piers facing E: the last
 * un-mirrored pair of a symmetric structure). `null` when the capped
 * neighbour is not a thin straight (mass edge / junction / off-grid): the
 * classifier's endcap axis rule stands.
 */
export function endcapRunFacing(
  grid: TileType[][],
  orientations: (number | null)[][],
  row: number,
  col: number,
  open: readonly Dir[],
): 0 | 90 | 180 | 270 | null {
  const wallDir = DIRS.find((d) => !open.includes(d));
  if (!wallDir) return null;
  const [dr, dc] = DIR_OFFSETS[wallDir];
  const nr = row + dr;
  const nc = col + dc;
  if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[nr]!.length) return null;
  const nMask = orientations[nr]![nc]!;
  if (nMask === null || nMask === undefined) return null;
  const nOpen = openCardinalsOf(nMask);
  if (nOpen.length !== 2 || OPPOSITE[nOpen[0]!] !== nOpen[1]) return null;
  return thinRunCornerFacing(grid, orientations, nr, nc, nOpen) ?? tieBreakFacing(nOpen);
}

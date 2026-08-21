/**
 * WallVisualSelectorCorners — corner ORIENTATION ground truth + the
 * corner-dangling re-role (map-polish round-2 ticket 20; re-derived from the
 * art geometry by ticket 23).
 *
 * ── THE ORIENTATION INVARIANT (ticket 23, binding) ───────────────────────────
 *
 * Every wall frame in this kit is SUB-TILE art with its authored collider on
 * the solid part (`tiled/env.tsx`), and the demo author's placement
 * (`tiled/demo_map.tmx`, decoded from the authored flip bits — see the
 * fidelity test) fixes ONE semantic for orienting them:
 *
 *   THE SOLID BAND LIES ON THE FLOOR-FACING SIDE. The transparent remainder
 *   of the tile points into / behind the wall mass (or off-map). The demo
 *   border ring proves it for both primitives: top-row `wall` cells are
 *   authored rot180 (band on the SOUTH edge, the interior floor side; bottom
 *   row rot0, left column rot90, right column rot270), and the four ring
 *   corners are `inner_round` with the solid blob ON the interior floor
 *   quadrant (e.g. top-left corner = rot180 = blob SE where the floor is).
 *
 * For the corner pieces that invariant becomes ONE rule, because at rotation
 * 0 (client bake: rotation degrees → radians, clockwise on the Y-down screen
 * — verified against `MapRenderer` and mirrored by `rotateShapeBy90s`):
 *
 *   - `wall_corner` / `wall_edge` carry their solid L along the N and W edges
 *     — the solid ELBOW is the NW quadrant;
 *   - `inner_round` carries its solid blob in the NW quadrant.
 *
 *   RULE: rotate so the NW-anchored solid feature (elbow / blob) lands ON the
 *   floor-side quadrant. `QUADRANT_ROTATION` below is that mapping, and it
 *   covers every corner class with a single table:
 *
 *   - CONVEX outer corner of a wall mass (floor wraps the two open
 *     cardinals): elbow ON the quadrant between them — the elbow caps the
 *     mass's outer corner, bands run along both floor-facing edges, and a 2×2
 *     block renders as a solid frame instead of a pinwheel of inward elbows
 *     (the owner-visible inversion this ticket fixes).
 *   - CONCAVE inner corner (all cardinals walled, floor in one diagonal
 *     pocket): blob/elbow ON the pocket quadrant — the cap fills the notch
 *     where the two bordering bands turn (exactly the demo corner).
 *   - CORNER-DANGLING hug (only wall attachment is diagonal): elbow ON the
 *     hugged quadrant so the solid corner merges with the diagonal neighbour.
 *
 * The classifier's own `OUTER_ROTATION` table is the INVERSE of this rule
 * (it places the elbow on the quadrant OPPOSITE the floor, i.e. inside the
 * mass). It predates round-2 and is demo-fidelity-pinned (the demo never
 * authors `wall_corner`), so the correction lives HERE, at the selector —
 * `orientedOuterCornerRotation` re-derives the rotation from the mask + art
 * geometry for every non-dangling outer-corner cell. Round-2's `HUG_ROTATION`
 * and art-axis diagonal rotation independently match this derivation and are
 * kept (now expressed through the same table).
 *
 * Determinism contract (ADR 0035): pure functions of the mask — fixed
 * preference order, no RNG, no wall-clock, no positional inputs.
 */

import { WALL_MASK_BITS, type WallTileChoice } from './WallMaskClassifier.js';

/** The four mask diagonals in the fixed corner-hug preference order. */
type Diag = 'NE' | 'SE' | 'SW' | 'NW';

const DIAG_ORDER: Diag[] = ['NE', 'SE', 'SW', 'NW'];

/**
 * The rotation that carries a frame's NW-anchored solid feature (the convex
 * L's elbow for `wall_corner`/`wall_edge`; the concave blob for
 * `inner_round`) ONTO quadrant `q`, clockwise (the client bake convention):
 * NW→0, NE→90, SE→180, SW→270. Identical to the classifier's `INNER_ROTATION`
 * (the demo-verified concave table) — one rule, one table.
 */
export const QUADRANT_ROTATION: Record<Diag, 0 | 90 | 180 | 270> = {
  NW: 0,
  NE: 90,
  SE: 180,
  SW: 270,
};

/**
 * Rotation that makes the convex L (`wall_corner`/`wall_edge`, arms N+W at
 * rotation 0) HUG the given quadrant — i.e. place its elbow there:
 * `QUADRANT_ROTATION` (ticket 23: the hug rule and the corner-orientation
 * rule are the same rule).
 */
const HUG_ROTATION: Record<Diag, 0 | 90 | 180 | 270> = QUADRANT_ROTATION;

/** The quadrants an L solidifies when hugging `d`: everything but its opposite. */
const HUG_COVERS: Record<Diag, Diag[]> = {
  NE: ['NE', 'SE', 'NW'],
  SE: ['SE', 'SW', 'NE'],
  SW: ['SW', 'NW', 'SE'],
  NW: ['NW', 'NE', 'SW'],
};

const DIAG_BIT: Record<Diag, number> = {
  NE: WALL_MASK_BITS.NE,
  SE: WALL_MASK_BITS.SE,
  SW: WALL_MASK_BITS.SW,
  NW: WALL_MASK_BITS.NW,
};

const CARDINAL_BITS = WALL_MASK_BITS.N | WALL_MASK_BITS.E | WALL_MASK_BITS.S | WALL_MASK_BITS.W;

/**
 * Art-axis rotation for a 45° run passing through a corner-dangling tile:
 * the diagonal frames band NE↔SW at rotation 0, so neighbours at NW+SE
 * need 90 (and neighbours at NE+SW need 0).
 */
function diagonalRunRotation(wallDiagonals: Diag[]): 0 | 90 {
  return wallDiagonals.includes('NW') ? 90 : 0;
}

/**
 * Ticket-23 orientation for a NON-dangling outer-corner cell: the convex L's
 * elbow ON the quadrant between the cell's two adjacent OPEN cardinals (the
 * floor wrapping the corner), per `QUADRANT_ROTATION`.
 *
 * Returns `null` when the mask is not a 2-adjacent-open topology (dangling
 * cells included — they have zero wall cardinals and keep their hug choice).
 * The caller applies this to every outer-corner choice whose cell still has
 * wall cardinals, whatever emitted it (`classifyWall`'s clean-corner path or
 * the destructible corner-reading `outerCornerChoice` re-role) — one
 * derivation site, no per-case overrides.
 */
export function orientedOuterCornerRotation(mask: number): 0 | 90 | 180 | 270 | null {
  const openCardinals: Array<'N' | 'E' | 'S' | 'W'> = [];
  if ((mask & WALL_MASK_BITS.N) === 0) openCardinals.push('N');
  if ((mask & WALL_MASK_BITS.E) === 0) openCardinals.push('E');
  if ((mask & WALL_MASK_BITS.S) === 0) openCardinals.push('S');
  if ((mask & WALL_MASK_BITS.W) === 0) openCardinals.push('W');
  if (openCardinals.length !== 2) return null;
  const [a, b] = openCardinals as ['N' | 'E' | 'S' | 'W', 'N' | 'E' | 'S' | 'W'];
  const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');
  if (opposite) return null;
  return QUADRANT_ROTATION[betweenDiagonal(a, b)];
}

/** The diagonal lying between two adjacent cardinals (e.g. N+E → NE). */
function betweenDiagonal(a: 'N' | 'E' | 'S' | 'W', b: 'N' | 'E' | 'S' | 'W'): Diag {
  const pair = new Set([a, b]);
  if (pair.has('N') && pair.has('E')) return 'NE';
  if (pair.has('S') && pair.has('E')) return 'SE';
  if (pair.has('S') && pair.has('W')) return 'SW';
  return 'NW'; // N + W
}

/**
 * The corner-dangling choice for `mask`, or `null` when the cell is NOT
 * corner-dangling (has a wall-like cardinal neighbour, or no wall-like
 * neighbour at all — a true lone pillar keeps its demo-authored `wall`
 * strip look).
 */
export function cornerDanglingChoice(mask: number): WallTileChoice | null {
  if ((mask & CARDINAL_BITS) !== 0) return null; // cardinally attached
  const wallDiagonals = DIAG_ORDER.filter((d) => (mask & DIAG_BIT[d]) !== 0);
  if (wallDiagonals.length === 0) return null; // true lone pillar

  // A 45° run: exactly the two opposite wall diagonals → diagonal-role art
  // rotated to the art axis (W1b/W1c). Three-or-more diagonal sets fall
  // through to the L-hug below — one L covers three quadrants, which is the
  // best single-piece coverage the strip kit offers.
  if (wallDiagonals.length === 2) {
    const opposite =
      (wallDiagonals.includes('NE') && wallDiagonals.includes('SW')) ||
      (wallDiagonals.includes('NW') && wallDiagonals.includes('SE'));
    if (opposite) {
      return {
        role: 'diagonal',
        rotation: diagonalRunRotation(wallDiagonals),
        flipH: false,
        flipV: false,
      };
    }
  }

  // Corner-hug L toward the quadrant covering the most wall diagonals.
  // Ties prefer the elbow ON a wall diagonal (the L's corner quadrant then
  // sits exactly on a neighbour), then the fixed NE→SE→SW→NW order.
  let hug = wallDiagonals[0]!;
  let bestCovered = -1;
  let bestOnDiagonal = false;
  for (const d of DIAG_ORDER) {
    const covered = HUG_COVERS[d].filter((q) => wallDiagonals.includes(q)).length;
    const onDiagonal = wallDiagonals.includes(d);
    if (covered > bestCovered || (covered === bestCovered && onDiagonal && !bestOnDiagonal)) {
      bestCovered = covered;
      bestOnDiagonal = onDiagonal;
      hug = d;
    }
  }
  return { role: 'outer_corner', rotation: HUG_ROTATION[hug], flipH: false, flipV: false };
}

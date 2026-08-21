/**
 * WallMaskClassifier — pure, deterministic 8-neighbour wall autotiling.
 *
 * Brains of the Seed Path wall fix (ADR 0023, PRD "Seed Map Floor & Wall
 * Autotiling"). Given an 8-bit wall/open neighbourhood mask it returns which
 * wall-sprite *role* to use plus the rotation/flip that orients that sprite's
 * face toward the open (floor) side — reproducing what the human author did by
 * hand in `tiled/demo_map.tmx`.
 *
 * This module is **purely additive and dependency-free**. Nothing imports it
 * yet; T3 wires it into `SeedMapAdapter` / `WallOrientationDetector`. The role
 * here only *names* the sprite bucket; the actual sprite lookup lives in T3.
 *
 * Conventions (all derived from the demo map + `env.tsx`, not guessed):
 *
 * - Base `wall` sprite (tile 39) draws its solid collider strip on the **North**
 *   edge, so at rotation 0 its face points North (open/floor is to the North).
 *   Rotation is clockwise: rot0=N, rot90=E, rot180=S, rot270=W.
 * - Base `inner_round` sprite (tile 16, concave corner) caps the **NW** quadrant
 *   at rotation 0 (its collider is the small top-left square), so its open/floor
 *   quadrant at rot0 is NW. Clockwise: rot0=NW, rot90=NE, rot180=SE, rot270=SW.
 * - Base `wall_corner` sprite (tile 40, convex L) hugs the N+W edges at rotation
 *   0, leaving the **SE** quadrant open, so its open/floor quadrant at rot0 is
 *   SE. Clockwise: rot0=SE, rot90=SW, rot180=NW, rot270=NE.
 *
 * The flip-bit → {rotation, flipH, flipV} mapping these conventions line up with
 * is `computeTileTransform` in `infrastructure/parsers/TmxParser.ts`. The
 * fidelity test mirrors that convention to decode the demo's authored GIDs.
 *
 * Off-map policy is the *caller's* concern: this function only sees 8 bits. The
 * demo border is the edge of the world, so the fidelity test feeds it with
 * off-map treated as wall-like, which makes every authored neighbourhood a pure
 * function of the local mask (zero conflicts).
 */

// ── bit order (the single source of truth for callers) ───────────────────────

/**
 * Mask bit order: N, NE, E, SE, S, SW, W, NW. A set bit means that neighbour is
 * **wall-like**; a clear bit means it is open (floor / walkable). Callers MUST
 * build the mask with these exact bit weights.
 */
export const WALL_MASK_BITS = {
  N: 1 << 0, // 1
  NE: 1 << 1, // 2
  E: 1 << 2, // 4
  SE: 1 << 3, // 8
  S: 1 << 4, // 16
  SW: 1 << 5, // 32
  W: 1 << 6, // 64
  NW: 1 << 7, // 128
} as const;

// ── public types ─────────────────────────────────────────────────────────────

export type WallRole =
  | 'straight'
  | 'outer_corner'
  | 'inner_corner'
  | 't_junction'
  | 'cross'
  | 'endcap'
  | 'isolated'
  | 'diagonal';

export interface WallTileChoice {
  /** Selects which sprite bucket (the T3 lookup resolves this to a GID). */
  role: WallRole;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

/**
 * Facing mode for masks with exactly ONE open cardinal (map-polish ticket 13).
 *
 * The classifier only sees 8 bits, so the CALLER (`selectWallVisuals`) decides
 * the topology-aware mode from the grid + neighbour masks; the historical
 * positional `%20` sector-border heuristic is deleted.
 *
 * - `'open'`    — face the open cardinal (the demo border-ring convention;
 *                 default so `classifyWall(mask)` alone reproduces the authored
 *                 demo tiles — the fidelity contract).
 * - `'run'`     — face along the wall-run axis (E+W walled → face N, else face
 *                 E) so a strip stays on ONE side through an abutment/junction
 *                 tile instead of flipping to its lone open side mid-run.
 * - `'partner'` — face the opposite of the open cardinal, i.e. toward the
 *                 paired tile of a 2-thick wall, so both strips meet on the
 *                 shared seam (the only representation that connects two
 *                 adjacent DESTRUCTIBLE walls, which can never be filled).
 */
export type OneOpenFaceMode = 'open' | 'run' | 'partner';

export interface ClassifyWallOptions {
  /** Facing for 1-open-cardinal masks (default `'open'`). */
  oneOpenFace?: OneOpenFaceMode;
}

// ── orientation tables (open-side facing, all clockwise) ──────────────────────

type Cardinal = 'N' | 'E' | 'S' | 'W';
type Quadrant = 'NE' | 'SE' | 'SW' | 'NW';

/** `wall` straight: face = the open cardinal. */
const STRAIGHT_ROTATION: Record<Cardinal, 0 | 90 | 180 | 270> = {
  N: 0,
  E: 90,
  S: 180,
  W: 270,
};

/** `inner_round` concave: open/floor quadrant (base NW at rot0). */
const INNER_ROTATION: Record<Quadrant, 0 | 90 | 180 | 270> = {
  NW: 0,
  NE: 90,
  SE: 180,
  SW: 270,
};

/** `wall_corner` convex: open/floor quadrant (base SE at rot0). */
const OUTER_ROTATION: Record<Quadrant, 0 | 90 | 180 | 270> = {
  SE: 0,
  SW: 90,
  NW: 180,
  NE: 270,
};

/** The two diagonals that flank each cardinal (its open-side corners). */
const FLANKS: Record<Cardinal, [Quadrant, Quadrant]> = {
  N: ['NE', 'NW'],
  E: ['NE', 'SE'],
  S: ['SE', 'SW'],
  W: ['NW', 'SW'],
};

const CARDINALS: Cardinal[] = ['N', 'E', 'S', 'W'];
const QUADRANTS: Quadrant[] = ['NE', 'SE', 'SW', 'NW'];

// ── classifier ────────────────────────────────────────────────────────────────

/**
 * Classify an 8-neighbour wall/open mask into a wall-sprite role + transform,
 * oriented toward the open (floor) side. Deterministic and total over all 256
 * masks; no randomness.
 *
 * Decision model (framed by *exposed faces* = open cardinal neighbours):
 *
 * - 4 exposed faces → `isolated` (lone pillar). Exception: two opposite
 *   diagonals walled with all cardinals open → `diagonal` (a 45° wall run).
 * - 3 exposed faces → `endcap`, facing away from the single wall connection.
 * - 2 opposite exposed faces → `straight` (thin wall; deterministic face).
 * - 2 adjacent exposed faces, both flanking diagonals open → `outer_corner`
 *   (convex). If a flank is walled (e.g. a perimeter door-jamb) it is a notch in
 *   a straight run → `straight`, facing the side whose flanks are open.
 * - 1 exposed face → `straight`, facing per `opts.oneOpenFace` (see
 *   `OneOpenFaceMode`; the default `'open'` faces the open cardinal — a
 *   world-edge border-ring tile or a T-stem that this tileset renders with the
 *   plain `wall` sprite).
 * - 0 exposed faces (all cardinals walled): an open diagonal is a concave pocket
 *   → `inner_corner` facing it. Two opposite open diagonals → `diagonal`. No
 *   open diagonal, or all four open (a thin-wall `+`), → `cross`.
 *
 * Convex vs concave is decided by the diagonal *between* the two wall arms: walled
 * between-diagonal ⇒ convex (`outer_corner`), open between-diagonal ⇒ concave
 * (`inner_corner`).
 *
 * Note on `t_junction`: this env tileset has no dedicated T sprite, so a T-stem
 * neighbourhood (floor on one cardinal, walls on three) is faithfully rendered
 * by the `wall` straight facing the open side — which is exactly what the demo
 * map does. The `t_junction` role remains in the union as part of the documented
 * contract, but `classifyWall` does not emit it for this tileset.
 */
export function classifyWall(mask: number, opts?: ClassifyWallOptions): WallTileChoice {
  const isWall = (dir: keyof typeof WALL_MASK_BITS): boolean => (mask & WALL_MASK_BITS[dir]) !== 0;
  const isOpen = (dir: keyof typeof WALL_MASK_BITS): boolean => !isWall(dir);

  const openCardinals = CARDINALS.filter(isOpen);
  const openDiagonals = QUADRANTS.filter(isOpen);
  const wallDiagonals = QUADRANTS.filter(isWall);
  const exposed = openCardinals.length;

  // ── 4 exposed faces ──
  if (exposed === 4) {
    // A 45° wall run: the wall continues along one diagonal axis only.
    if (
      wallDiagonals.length === 2 &&
      ((wallDiagonals.includes('NE') && wallDiagonals.includes('SW')) ||
        (wallDiagonals.includes('NW') && wallDiagonals.includes('SE')))
    ) {
      return diagonal(wallDiagonals.includes('NW'));
    }
    return { role: 'isolated', rotation: 0, flipH: false, flipV: false };
  }

  // ── 3 exposed faces → endcap ──
  if (exposed === 3) {
    const wallCardinal = CARDINALS.find(isWall)!;
    // Endcap faces the SAME direction as straight segments in this wall run,
    // not opposite to the connection. A vertical wall (N/S connection) has
    // straight segments facing E (rot90); a horizontal wall (E/W connection)
    // has straight segments facing N (rot0). This keeps the wall strip
    // continuous through the endcap instead of breaking perpendicular.
    const isVertical = wallCardinal === 'N' || wallCardinal === 'S';
    return choice('endcap', isVertical ? 90 : 0);
  }

  // ── 2 exposed faces ──
  if (exposed === 2) {
    const [a, b] = openCardinals as [Cardinal, Cardinal];
    const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');

    if (opposite) {
      // Thin straight wall (floor on both opposite sides). Deterministic face:
      // prefer N over S, E over W.
      const face: Cardinal = openCardinals.includes('N') ? 'N' : 'E';
      return choice('straight', STRAIGHT_ROTATION[face]);
    }

    // Adjacent exposed faces. A clean convex corner needs floor to wrap fully:
    // both flanking diagonals of each open cardinal must be open.
    const aClean = FLANKS[a].every(isOpen);
    const bClean = FLANKS[b].every(isOpen);
    if (aClean && bClean) {
      return choice('outer_corner', OUTER_ROTATION[betweenQuadrant(a, b)]);
    }
    // Notch in a straight run (e.g. a perimeter door-jamb): face the side whose
    // flanking diagonals are open.
    const face: Cardinal = aClean ? a : bClean ? b : a;
    return choice('straight', STRAIGHT_ROTATION[face]);
  }

  // ── 1 exposed face → straight ──
  if (exposed === 1) {
    const open = openCardinals[0]!;
    const mode = opts?.oneOpenFace ?? 'open';
    if (mode === 'run') {
      // Junction/abutment tile INSIDE a wall structure (wall-mass edge,
      // T-stem, run tile with a stub attached): face along the run axis so
      // the strip connects with the run's straight segments and never flips
      // side mid-run. With 3 walled cardinals exactly one opposite pair is
      // complete, so this is total.
      if (isWall('E') && isWall('W')) return choice('straight', 0); // horizontal run → face N
      return choice('straight', 90); // vertical run → face E
    }
    if (mode === 'partner') {
      // One face of a 2-thick pair: face the paired tile so both strips sit
      // on the shared seam (connects even when neither tile can be filled).
      return choice('straight', STRAIGHT_ROTATION[opposite(open)]);
    }
    return choice('straight', STRAIGHT_ROTATION[open]);
  }

  // ── 0 exposed faces (all cardinals walled) ──
  if (openDiagonals.length === 0 || openDiagonals.length === 4) {
    // Fully buried, or a thin-wall '+' junction: no single open-facing corner.
    return { role: 'cross', rotation: 0, flipH: false, flipV: false };
  }
  if (openDiagonals.length === 2) {
    const oppDiagonal =
      (openDiagonals.includes('NE') && openDiagonals.includes('SW')) ||
      (openDiagonals.includes('NW') && openDiagonals.includes('SE'));
    if (oppDiagonal) {
      return diagonal(openDiagonals.includes('NW'));
    }
  }
  // One (or two adjacent / three) open diagonal pockets → concave inner corner,
  // facing the first open quadrant in NE, SE, SW, NW order (deterministic).
  return choice('inner_corner', INNER_ROTATION[openDiagonals[0]!]);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function choice(role: WallRole, rotation: 0 | 90 | 180 | 270): WallTileChoice {
  return { role, rotation, flipH: false, flipV: false };
}

/**
 * Convex-corner choice for a mask with walls on two ADJACENT cardinals,
 * IGNORING flank dirt (map-polish ticket 13, the destructible corner-reading).
 *
 * `classifyWall` demotes a dirty-flank 2-adjacent-open mask to a `straight`
 * (the demo-authored indestructible door-jamb reading). The DESTRUCTIBLE
 * material has no authored legacy: such a tile is geometrically a corner of
 * its cluster — walls on two adjacent cardinals — and the half-strip frame is
 * shape-incompatible with hugging both arms (the same mismatch class as the
 * `wall_curve` remap, D6). This helper returns the plain `outer_corner`
 * choice (open quadrant on the pocket diagonal, via the UNTOUCHED
 * `OUTER_ROTATION` table) so the selector can re-role those tiles; `null`
 * when the mask is not a 2-adjacent-open topology.
 */
export function outerCornerChoice(mask: number): WallTileChoice | null {
  const isWall = (dir: keyof typeof WALL_MASK_BITS): boolean => (mask & WALL_MASK_BITS[dir]) !== 0;
  const openCardinals = CARDINALS.filter((c) => !isWall(c));
  if (openCardinals.length !== 2) return null;
  const [a, b] = openCardinals as [Cardinal, Cardinal];
  const opposite = (a === 'N' && b === 'S') || (a === 'E' && b === 'W');
  if (opposite) return null;
  return choice('outer_corner', OUTER_ROTATION[betweenQuadrant(a, b)]);
}

/** The cardinal opposite `dir` (N↔S, E↔W). */
function opposite(dir: Cardinal): Cardinal {
  if (dir === 'N') return 'S';
  if (dir === 'S') return 'N';
  if (dir === 'E') return 'W';
  return 'E';
}

/** A diagonal run aligned NW–SE uses rotation 0; the NE–SW run uses rotation 90. */
function diagonal(isNwSe: boolean): WallTileChoice {
  return { role: 'diagonal', rotation: isNwSe ? 0 : 90, flipH: false, flipV: false };
}

/** The quadrant lying between two adjacent open cardinals. */
function betweenQuadrant(a: Cardinal, b: Cardinal): Quadrant {
  const set = new Set<Cardinal>([a, b]);
  if (set.has('N') && set.has('E')) return 'NE';
  if (set.has('S') && set.has('E')) return 'SE';
  if (set.has('S') && set.has('W')) return 'SW';
  return 'NW'; // N + W
}

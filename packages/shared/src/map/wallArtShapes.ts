/**
 * Art-shape ground truth for the wall autotiler (map-polish tickets 12–14).
 *
 * Per-sprite 8×8 solid/transparent coverage grids for every wall frame the
 * `map_border_walls` layer can emit. Measured from the shipped atlas art
 * (`packages/client-v3/public/assets/game.png` alpha coverage, downsampled to
 * 8×8) by the map-polish topic-F research probe; transcribed verbatim:
 *   '#' = solid   (alpha > 66%, value 1)
 *   '+' = partial (alpha > 15%, value 0.5 — still counts as a solid band)
 *   '.' = open    (transparent, value 0)
 *
 * These grids are the geometric ground truth that EVERY wall-continuity
 * consumer reasons against — the shared generation-side validator
 * (`validatorGates.validateWallComposition`, ticket 14), the production
 * run-consistency repair pass (`server/infrastructure/map/wallRunConsistency.ts`,
 * ticket 13) and the server test continuity audit helper (ticket 12): they
 * encode WHERE each wall sprite is actually opaque, which is what makes a
 * "gap" (two adjacent wall tiles whose touching edges share no solid band)
 * measurable in pure data. It lives in `shared` (ticket 14) so the
 * generation-side gate and the server-side selector share ONE ground truth.
 * Validated by the self-tests in the server `WallArtShapes.test.ts` + the
 * band-parity test in `WallVisualSelector.test.ts`.
 */

export type WallShapeGrid = number[][];

/** The 8×8 art coverage grids, keyed by the sprite's `imagePath`. */
export const WALL_ART_SHAPES: Record<string, string[]> = {
  wall: [
    '+######+',
    '########',
    '########',
    '........',
    '........',
    '........',
    '........',
    '........',
  ],
  wall_corner: [
    '+######+',
    '########',
    '########',
    '###.....',
    '###.....',
    '###.....',
    '###.....',
    '###.....',
  ],
  inner_round: [
    '+#++....',
    '##+.....',
    '++......',
    '........',
    '........',
    '........',
    '........',
    '........',
  ],
  wall_curve: [
    '....++#+',
    '..+#####',
    '.+######',
    '.####+..',
    '+###....',
    '+##+....',
    '###.....',
    '###.....',
  ],
  wall_edge: [
    '.++####+',
    '+#######',
    '+#######',
    '###.....',
    '###.....',
    '###.....',
    '###.....',
    '###.....',
  ],
  wall_diagonal: [
    '......+#',
    '.....+##',
    '....+###',
    '...+###+',
    '..+###+.',
    '.+###+..',
    '+###+...',
    '###+....',
  ],
  wall_damaged: [
    '+#######',
    '########',
    '+#######',
    '........',
    '........',
    '........',
    '........',
    '........',
  ],
};

/** Solid-partial threshold: a cell counts as solid when coverage ≥ 0.5. */
export const SOLID_THRESHOLD = 0.5;

/** Parse one sprite's 8×8 ASCII grid into numeric coverage values. */
export function shapeGrid(imagePath: string): WallShapeGrid {
  const rows = WALL_ART_SHAPES[imagePath];
  if (!rows) throw new Error(`no WALL_ART_SHAPES entry for "${imagePath}"`);
  return rows.map((row) => row.split('').map((ch) => (ch === '#' ? 1 : ch === '+' ? 0.5 : 0)));
}

/**
 * Rotate an 8×8 shape grid clockwise by `rotation` degrees (any multiple of
 * 90). Matches the client render convention (rotation deg → rad, clockwise),
 * so `shapeGrid(p).rotated` is exactly what the player sees on screen.
 */
export function rotateShapeBy90s(grid: WallShapeGrid, rotation: number): WallShapeGrid {
  let cur = grid;
  const iterations = Math.floor((((rotation % 360) + 360) % 360) / 90);
  for (let i = 0; i < iterations; i++) {
    const n = cur.length;
    const out: WallShapeGrid = Array.from({ length: n }, () => Array(n).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        out[x]![n - 1 - y] = cur[y]![x]!;
      }
    }
    cur = out;
  }
  return cur;
}

/** The sprite's shape grid AFTER applying its emitted rotation. */
export function orientedShape(imagePath: string, rotation: number): WallShapeGrid {
  return rotateShapeBy90s(shapeGrid(imagePath), rotation);
}

/**
 * The 8-cell coverage band along one outer edge of the oriented shape
 * (N = top row, S = bottom row, W = left column, E = right column).
 * Two adjacent wall tiles connect when their touching bands share at least
 * one index where BOTH are solid (≥ 0.5).
 */
export function edgeBand(
  imagePath: string,
  rotation: number,
  side: 'N' | 'E' | 'S' | 'W',
): number[] {
  const g = orientedShape(imagePath, rotation);
  if (side === 'N') return [...g[0]!];
  if (side === 'S') return [...g[g.length - 1]!];
  if (side === 'W') return g.map((row) => row[0]!);
  return g.map((row) => row[row.length - 1]!);
}

export interface EdgeSolidity {
  N: boolean;
  E: boolean;
  S: boolean;
  W: boolean;
}

/**
 * Whether each outer edge of the oriented shape carries a solid band
 * (≥ 50% solid coverage along the edge — the arm of an L, the strip of a
 * straight piece).
 */
export function solidEdges(imagePath: string, rotation: number): EdgeSolidity {
  const g = orientedShape(imagePath, rotation);
  const n = g.length;
  const rowSolid = (y: number): boolean => g[y]!.reduce((a, b) => a + b, 0) >= SOLID_THRESHOLD * n;
  const colSolid = (x: number): boolean => {
    let s = 0;
    for (let y = 0; y < n; y++) s += g[y]![x]!;
    return s >= SOLID_THRESHOLD * n;
  };
  return { N: rowSolid(0), E: colSolid(n - 1), S: rowSolid(n - 1), W: colSolid(0) };
}

export interface QuadrantSolidity {
  NE: boolean;
  SE: boolean;
  SW: boolean;
  NW: boolean;
}

/**
 * Whether each 4×4 quadrant of the oriented shape is solid. `threshold` is
 * the fraction of the 16 sub-cells that must be covered — the default 0.5
 * fits the big half-tile pieces (`wall`, `wall_corner`); use a lower
 * threshold (0.2) for the small `inner_round` quarter-round blob (~9% of the
 * full tile but concentrated in one quadrant).
 */
export function solidQuadrants(
  imagePath: string,
  rotation: number,
  threshold = SOLID_THRESHOLD,
): QuadrantSolidity {
  const g = orientedShape(imagePath, rotation);
  const half = g.length / 2;
  const quadrantCoverage = (y0: number, x0: number): boolean => {
    let s = 0;
    for (let y = y0; y < y0 + half; y++) {
      for (let x = x0; x < x0 + half; x++) s += g[y]![x]!;
    }
    return s >= threshold * half * half;
  };
  return {
    NE: quadrantCoverage(0, half),
    SE: quadrantCoverage(half, half),
    SW: quadrantCoverage(half, 0),
    NW: quadrantCoverage(0, 0),
  };
}

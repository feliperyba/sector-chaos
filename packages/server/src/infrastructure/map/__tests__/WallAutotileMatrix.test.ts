/**
 * Wall autotile matrix regression table (map-polish tickets 12 + 13).
 *
 * Hand-built small tile grids → the EXACT expected {sprite imagePath,
 * rotation, fill} per wall cell, asserted through the real pipeline
 * (`WallOrientationDetector.detect` → `selectWallVisuals` + `selectWallFill`).
 * This is the regression seam that would have caught the shipped wall-gap
 * defects: the demo-map fidelity test only ever covered a single 1-thick
 * border ring, so 2-thick seams, junctions and stubs shipped untested.
 *
 * Ticket 13 flipped the two CURRENT-defective matrices from ticket 12:
 *   - the 2-thick pair (D1) now faces partner-inward (strips meet on the
 *     center seam) with every cell filled;
 *   - the 4-way seam cross (D2) keeps its (correct) cap rotations and closes
 *     the transparent seam with the `wall_fill` layer.
 * New matrices pin the run-consistent junction facing (D3), the destructible
 * `inner_corner` → `wall_edge` remap (D6), the destructible corner-reading,
 * and the destructible mutual 2-thick seam.
 *
 * Ticket 20 adds the CORNER-DANGLING matrices (W1/W1b/W1c): diagonal-only
 * wall chains and diagonally-attached dangling cells now render
 * corner-hugging Ls (or the art-axis diagonal piece) instead of floating
 * strips — pinned for both materials — and every matrix must also pass the
 * corner-dangling coverage audit (`validateWallComposition`).
 *
 * Ticket 23 re-pins every CORNER rotation to the art-geometry orientation
 * model (`WallVisualSelectorCorners.QUADRANT_ROTATION`): the NW-anchored
 * solid feature (the L's elbow / `inner_round`'s blob) lands ON the
 * floor-side quadrant, so solid bands face the open floor. MASS corners
 * (fill-covered, repair-unconstrained) take the table rotation directly;
 * 1-THIN unfilled corners are additionally subject to the run-consistency
 * repair pass, which rotates them onto the arms' band contour (band
 * continuity is the measurable contract). Every flipped pin below carries
 * its decision tree in the note.
 *
 * Ticket 27 re-pins the 1-open STRAIGHT facings to the render truth
 * (pixel-verified demo decode — see `WallRenderTruth.test.ts`): every backed
 * INDESTRUCTIBLE 1-open cell presents its bar toward the lone open cardinal
 * (its floor) — the fill carries the seam behind it — while UNFILLED
 * destructible run cells keep the axis compromise (unfillable ⇒ run
 * connectivity is load-bearing; facing the pocket instead breaks the pinned
 * D5 T-stem bound, 53-seed sweep 31 → 43) and destructible pairs keep the
 * partner seam meeting.
 *
 * Every matrix also passes the FILL-AWARE continuity audit — the same gate
 * the seed sweep enforces (`WallContinuityGate.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import { TileType, validateWallComposition, type TileVisual } from '@sector-battle/shared';
import { WallOrientationDetector } from '../WallOrientationDetector.ts';
import {
  buildWallRoleSpriteMap,
  resolveWallFillSprite,
  selectWallFill,
  selectWallVisuals,
} from '../WallVisualSelector.ts';
import { auditWallLayerContinuity } from './helpers/wallContinuityAudit.ts';
import { loadEnvAtlas, loadEnvWallBuckets } from './helpers/wallTestAtlas.ts';

// ── real pipeline inputs (env atlas, trap-filtered wall bucket) ───────────────

const envAtlas = loadEnvAtlas();
const buckets = loadEnvWallBuckets();
const roleMaps = {
  indestructible: buildWallRoleSpriteMap(buckets.wall),
  destructible: buildWallRoleSpriteMap(buckets.destructibleWall),
};
const fillSprite = resolveWallFillSprite(envAtlas);
const detector = new WallOrientationDetector();

// ── matrix table ──────────────────────────────────────────────────────────────

interface ExpectedCell {
  imagePath: string;
  rotation: 0 | 90 | 180 | 270;
  /** Whether the `wall_fill` layer carries a cell here (default false). */
  fill?: boolean;
}

interface MatrixCase {
  name: string;
  /**
   * '#' = INDESTRUCTIBLE_WALL, 'D' = DESTRUCTIBLE_WALL, '.' = EMPTY.
   * Off-map reads as wall-like.
   */
  grid: string[];
  /** Complete per-wall-cell expectation table, keyed "row,col". */
  expected: Record<string, ExpectedCell>;
  note: string;
}

const e = (imagePath: string, rotation: 0 | 90 | 180 | 270, fill = false): ExpectedCell => ({
  imagePath,
  rotation,
  fill,
});

const MATRICES: MatrixCase[] = [
  {
    name: 'clean L-corner (1-thick horizontal arm meeting a vertical arm)',
    grid: ['.....', '.###.', '.#...', '.#...', '.....'],
    note: "Round 5e: the thin arms now FOLLOW the corner's arm sides — the bend cell (1,1) has open cardinals N+W → elbow NW → QUADRANT_ROTATION[NW]=0, its vertical arm hugs the W edge and its horizontal arm the N edge, so the vertical run faces W (rot270) and the horizontal run N (rot0). The provisional elbow rotation now band-connects with BOTH arms directly (vertical arm's W-edge strip overlaps the corner's S band cols 0-2) — the repair pass no longer needs to rotate the corner onto the arms' contour (the ticket-23 pinwheel rotation 90 was the strip-sides-disagreeing compromise).",
    expected: {
      '1,1': e('wall_corner', 0),
      '1,2': e('wall', 0),
      '1,3': e('wall', 0),
      '2,1': e('wall', 270),
      '3,1': e('wall', 270),
    },
  },
  {
    name: 'hollow 1-thick rectangle',
    grid: ['.......', '.#####.', '.#...#.', '.#####.', '.......'],
    note: 'Round 5e: all four corners keep their elbow-on-floor-quadrant rotations (NW→0, NE→90, SW→270, SE→180) and every arm follows its corners — top arm N (rot0), bottom arm S (rot180), left arm W (rot270), right arm E (rot90): a fully mirror-symmetric frame with every bar hugging the outside, all pairs band-connected without repair. (Ticket 23/13 had the repair pass rotating the west corners onto mismatched arm strips — corner 90/0 pins and the bottom arm facing N.)',
    expected: {
      '1,1': e('wall_corner', 0),
      '1,2': e('wall', 0),
      '1,3': e('wall', 0),
      '1,4': e('wall', 0),
      '1,5': e('wall_corner', 90),
      '2,1': e('wall', 270),
      '2,5': e('wall', 90),
      '3,1': e('wall_corner', 270),
      '3,2': e('wall', 180),
      '3,3': e('wall', 180),
      '3,4': e('wall', 180),
      '3,5': e('wall_corner', 180),
    },
  },
  {
    name: 'T-junction (stem renders plain `wall` — no dedicated T sprite)',
    grid: ['.....', '.###.', '..#..', '..#..', '.....'],
    note: 'D5: the T center (1 open cardinal, backed) is filled (the kit has no junction piece) and keeps its run-facing strip. Both materials of the old isInternal heuristic agreed here — behavior unchanged by the ticket-13 rules.',
    expected: {
      '1,1': e('wall', 0),
      '1,2': e('wall', 0, true),
      '1,3': e('wall', 0),
      '2,2': e('wall', 90),
      '3,2': e('wall', 90),
    },
  },
  {
    name: '1-tile stub protruding from a 1-thick bar (endcap)',
    grid: ['.....', '.###.', '..#..', '.....', '.....'],
    note: 'A single tile hanging off a wall face has one wall cardinal (N) → endcap aligned with the vertical run; the bar center is a filled backed junction.',
    expected: {
      '1,1': e('wall', 0),
      '1,2': e('wall', 0, true),
      '1,3': e('wall', 0),
      '2,2': e('wall', 90),
    },
  },
  {
    name: 'lone 1-tile pillar (isolated)',
    grid: ['.....', '.....', '..#..', '.....', '.....'],
    note: 'Floor on every side → isolated (D7 class: renders as a half-strip shard today; ticket 14 owns the composition rule). No fill — an isolated tile has no seam.',
    expected: {
      '2,2': e('wall', 0),
    },
  },
  {
    name: '2-thick pair — ticket 27: each face presents toward its own floor, fill closes the seam',
    grid: ['......', '..##..', '..##..', '..##..', '......'],
    note: "Ticket 13 pinned the middle straights facing their MUTUAL partner (bars meeting ON the center seam). Ticket 27 render truth (pixel-verified against the canonically-decoded demo border ring through the real client transform chain): the bar presents toward the FLOOR — the W tile (open W) → rot270 band W, the E tile (open E) → rot90 band E. The partner meeting-at-the-seam buried both bars inside the 2-thick body (the owner's 'side walls on the inner side of the tile' — constant on every sector side). Every cell still carries a wall_fill (2-thick-pair-face rule) and filled cells are repair-unconstrained (wallRunConsistency skips them), so the floor-facing provisional stands. Ticket 23 corners unchanged: (1,2) N+W → NW → 0; (1,3) N+E → NE → 90; (3,2) S+W → SW → 270; (3,3) S+E → SE → 180 — the four Ls render a solid frame around the block.",
    expected: {
      '1,2': e('wall_corner', 0, true),
      '1,3': e('wall_corner', 90, true),
      '2,2': e('wall', 270, true),
      '2,3': e('wall', 90, true),
      '3,2': e('wall_corner', 270, true),
      '3,3': e('wall_corner', 180, true),
    },
  },
  {
    name: '4-way seam cross — ticket 27: ring faces present toward their own floors',
    grid: ['######', '..##..', '..##..', '......'],
    note: "The map-border × sector-ring seam topology (probe sample seed1 cols 19|20 row 0). The cap rotations are CORRECT (verified by the ticket-12 corner-arm audit — each cap faces its own floor pocket) and are UNCHANGED. Ticket 27 re-pins the two vertical-ring face cells: (1,2) open W → rot270 (band W, its own floor side) and (1,3) open E → rot90 (band E) — each face presents toward its own floor per the demo-ring render truth; both are 2-thick-pair faces carrying wall_fill (fill closes the central seam; repair-unconstrained). Ticket 23 corners unchanged: (2,2) open S+W → SW → QUADRANT_ROTATION[SW]=270 and (2,3) open S+E → SE → 180 (elbow ON the block's outer corner).",
    expected: {
      '0,0': e('wall', 180),
      '0,1': e('wall', 180),
      '0,2': e('inner_round', 270, true),
      '0,3': e('inner_round', 180, true),
      '0,4': e('wall', 180),
      '0,5': e('wall', 180),
      '1,2': e('wall', 270, true),
      '1,3': e('wall', 90, true),
      '2,2': e('wall_corner', 270, true),
      '2,3': e('wall_corner', 180, true),
    },
  },
  {
    name: 'run-with-junction: backed junction presents to its floor pocket (ticket 27)',
    grid: ['........', '...#....', '.#####..', '........'],
    note: "The junction tile (walls N/E/W, lone open S) sits mid-run and is BACKED — 1-open cardinal + in-grid wall behind ⇒ wall_fill-covered (2-thick-pair-face rule; no T sprite — D5). Ticket 27 render truth: a fill-covered tile presents its bar toward the lone open cardinal (S, rot180) — the demo-ring convention — while the 1-THIN run members keep the deterministic 2-open facing (N, rot0). The historical axis rule (rot0) drew the junction's bar into the mass under the stub, leaving the floor side bare fill — the same 'inner side of the tile' defect class as the sector ring. The D3 thin-run guarantee is unchanged: adjacent 2-open straights still share one strip side, and the repair pass still enforces band continuity on unfilled pairs (the junction is skipped — filled cells connect by construction).",
    expected: {
      '1,3': e('wall', 90),
      '2,1': e('wall', 0),
      '2,2': e('wall', 0),
      '2,3': e('wall', 180, true),
      '2,4': e('wall', 0),
      '2,5': e('wall', 0),
    },
  },
  {
    name: 'breach panel against a wall body — panel keeps the body contour (round 6)',
    grid: ['........', '.##..#..', '###DD#..', '.....#..'],
    note: "Round 6 mixed-material autotiling: a destructible breach panel carved into a wall run whose west end is a 2-THICK BODY (1-open S, fill-covered, presenting S per ticket 27) and whose east end is a backed T. Before the round-6 body-contour rule the panel's straights fell back to the N-over-S tie-break (rot0) — strip on the OPPOSITE side of the run's contour, the owner-visible 'destructible walls not following the autotiling when matched with indestructible walls'. The thin-run walk now harvests a TERMINAL 1-open body's open side as the run contour (S → rot180), with the mid-run guard keeping ticket-27's backed-junction truth intact when the thin run resumes beyond the body (see the run-with-junction matrix above). The panel strips (wall_damaged@180) chain with the body strips (wall@180) on the shared bottom edge.",
    expected: {
      '1,1': e('wall', 0, true),
      '1,2': e('wall', 0, true),
      '1,5': e('wall', 90),
      '2,0': e('wall', 180),
      '2,1': e('wall', 180, true),
      '2,2': e('wall', 180, true),
      '2,3': e('wall_damaged', 180),
      '2,4': e('wall_damaged', 180),
      '2,5': e('wall', 90, true),
      '3,5': e('wall', 90),
    },
  },
  {
    name: 'destructible inner_corner pocket — FIXED (D6): wall_curve → wall_edge facing the pocket',
    grid: ['##.#', '#DD#', '#DD#', '####'],
    note: "The destructible tile at (1,1) has all four cardinals walled with a single floor pocket at NE. `wall_curve` (a thick diagonal) could never render a concave cap — the tile resolves to `wall_edge`. Ticket 23 orientation: INNER_ROTATION[NE]=90 directly, NO +180 counter-rotation — the L's elbow lands ON the NE pocket (arms N+E), capping the notch exactly like the demo's inner_round corners; the deleted +180 put the transparent quadrant toward the pocket and the solid arms into the mass. Unfilled but repair-clean: the elbow shares bands with both destructible neighbours.",
    expected: {
      '0,0': e('wall', 0),
      '0,1': e('wall', 90, true),
      '0,3': e('wall', 270),
      '1,0': e('wall', 0, true),
      '1,1': e('wall_edge', 90),
      '1,2': e('wall_damaged', 180),
      '1,3': e('inner_round', 0, true),
      '2,0': e('wall', 0, true),
      '2,1': e('wall_damaged', 0),
      '2,2': e('wall_damaged', 0),
      '2,3': e('wall', 0, true),
      '3,0': e('wall', 0),
      '3,1': e('wall', 0, true),
      '3,2': e('wall', 0, true),
      '3,3': e('wall', 0),
    },
  },
  {
    name: 'destructible dirty-flank bend — corner-reading: wall_edge hugs both arms',
    grid: ['.#..', '.#D.', '..D.', '....'],
    note: "A destructible tile with walls on two adjacent cardinals (S+W here) and a walled flank (NW) would class as a straight strip (the indestructible door-jamb reading) — shape-incompatible: one half-band cannot hug both arms. The ticket-13 corner-reading renders the convex L (`wall_edge`); ticket 23 orients it: open cardinals N+E → open quadrant NE → QUADRANT_ROTATION[NE]=90 (elbow ON the NE floor corner). Round 5e: the indestructible head (0,1) is a length-1 vertical thin run whose S end IS that corner — it follows the corner's vertical arm (hugging the W edge at rot270) instead of the global tie-break E, so the pair band-connects on cols 0-2 WITHOUT leaning on the fill-skipped repair pair (the pin-90 left a gap the (1,1) wall_fill had to mask).",
    expected: {
      '0,1': e('wall', 270),
      '1,1': e('wall', 270, true),
      '1,2': e('wall_edge', 90),
      '2,2': e('wall_damaged', 90),
    },
  },
  {
    name: 'destructible mutual 2-thick pair — strips meet on the seam, NO fill (destroyed walls must not leave baked fill)',
    grid: ['......', '..DD..', '..DD..', '..DD..', '......'],
    note: "Destructible walls can never be filled, so EVERY pair is repair-constrained — band continuity is the only connective representation (the middle strips face the shared seam: W tile → face E/rot90, E tile → face W/rot270). Ticket 23 + repair, top row: (1,2) provisional QUADRANT_ROTATION[NW]=0 fails the S pair ((2,2) wall_damaged@90 bands cols 5-7 on its N edge; wall_corner@0 reaches cols 0-2 only) → repaired to 90 (arms N+E): E edge meets (1,3)'s N band rows 0-2, S edge E-band cols 5-7 meets (2,2). (1,3): provisional QUADRANT_ROTATION[NE]=90 fails the S pair ((2,3)@270 bands cols 0-2) → repaired to 0 (arms N+W): W edge N-band rows 0-2 meets (1,2)'s E band, S edge W-band cols 0-2 meets (2,3). Bottom row (3,2)/(3,3): provisionals SW→270/SE→180 fail their N pairs → repaired to 90/0 (arms E+N / N+W) — same contour logic mirrored.",
    expected: {
      '1,2': e('wall_edge', 90),
      '1,3': e('wall_edge', 0),
      '2,2': e('wall_damaged', 90),
      '2,3': e('wall_damaged', 270),
      '3,2': e('wall_edge', 90),
      '3,3': e('wall_edge', 0),
    },
  },
  {
    name: 'diagonal D pair — FIXED (W1): corner-hug Ls merge at the shared corner',
    grid: ['.....', '..D..', '...D.', '.....', '.....'],
    note: 'Two destructible walls touching ONLY at the diagonal used to render as two floating strips connecting to nothing. Each now hugs its own corner (elbow ON the neighbour): the NW tile hugs SE (wall_edge@180, arms S+E), the SE tile hugs NW (wall_edge@0, arms N+W) — the two Ls overlap on the shared corner quadrant and read as one connected 2-tile cluster.',
    expected: {
      '1,2': e('wall_edge', 180),
      '2,3': e('wall_edge', 0),
    },
  },
  {
    name: '3-cell D staircase — FIXED (W1c/W1b): wall_curve diagonal on the art axis, hugging L caps',
    grid: ['.....', '.D...', '..D..', '...D.', '.....'],
    note: 'The staircase middle (walls at NW+SE only) keeps its diagonal role but now resolves to `wall_curve` (an existing DESTRUCTIBLE-typed thick diagonal) rotated to the ART axis: the frames band NE↔SW at rot0, so NW+SE neighbours need rot90 (the classifier table alone was 90° off). The ends hug their corner.',
    expected: {
      '1,1': e('wall_edge', 180),
      '2,2': e('wall_curve', 90),
      '3,3': e('wall_edge', 0),
    },
  },
  {
    name: 'diagonal # pair — FIXED (W1): wall_corner Ls merge at the shared corner',
    grid: ['.....', '..#..', '...#.', '.....', '.....'],
    note: 'The indestructible twin of the diagonal-pair matrix: each pillar hugs its own corner (wall_corner@180 / @0) instead of two unrelated N-strips. True lone pillars (no wall neighbour at all) keep the demo `wall` strip — see the lone-pillar matrix.',
    expected: {
      '1,2': e('wall_corner', 180),
      '2,3': e('wall_corner', 0),
    },
  },
  {
    name: '3-cell # staircase — FIXED (W1b): wall_diagonal rotated to the art axis',
    grid: ['.....', '.#...', '..#..', '...#.', '.....'],
    note: 'The # staircase middle keeps wall_diagonal but rotated 90° from the classifier table: the art bands NE↔SW at rot0, so NW+SE neighbours need rot90 (W1b — the table was derived from the exposed-0 pocket case where the sets are opposite). Ends hug their corner with wall_corner.',
    expected: {
      '1,1': e('wall_corner', 180),
      '2,2': e('wall_diagonal', 90),
      '3,3': e('wall_corner', 0),
    },
  },
  {
    name: 'D dangling diagonally off an indestructible mass — FIXED (W1): hugs the mass corner',
    grid: ['......', '......', '..D...', '...##.', '...##.', '......'],
    note: "A breakable tucked at the diagonal corner of a 2×2 indestructible mass: its only wall attachment is the SE diagonal, so it hugs SE (wall_edge@180 — QUADRANT_ROTATION[SE], unchanged from round-2: the hug rule IS the ticket-23 rule) and visually merges with the mass. Ticket 23 re-pins the three MASS corners (all fill-covered → repair-unconstrained → table rotation directly): (3,4) open N+E → NE → 90; (4,3) open S+W → SW → 270; (4,4) open S+E → SE → 180 — elbows ON the mass's outer corners (old pins 270/90/0 bent them inward). The NW mass tile stays a filled straight.",
    expected: {
      '2,2': e('wall_edge', 180),
      '3,3': e('wall', 0, true),
      '3,4': e('wall_corner', 90, true),
      '4,3': e('wall_corner', 270, true),
      '4,4': e('wall_corner', 180, true),
    },
  },
];

// ── runner ────────────────────────────────────────────────────────────────────

function parseGrid(grid: string[]): TileType[][] {
  return grid.map((row) =>
    row
      .split('')
      .map((ch) =>
        ch === '#'
          ? TileType.INDESTRUCTIBLE_WALL
          : ch === 'D'
            ? TileType.DESTRUCTIBLE_WALL
            : TileType.EMPTY,
      ),
  );
}

function buildMatrix(m: MatrixCase): {
  cells: (TileVisual | null)[][];
  fillCells: (TileVisual | null)[][];
  wallCells: string[];
  tileGrid: TileType[][];
} {
  const tileGrid = parseGrid(m.grid);
  const masks = detector.detect(tileGrid);
  const fillCells = selectWallFill(tileGrid, masks, fillSprite);
  const cells = selectWallVisuals(tileGrid, masks, roleMaps, { fillCells });
  const wallCells: string[] = [];
  for (let r = 0; r < tileGrid.length; r++) {
    for (let c = 0; c < tileGrid[r]!.length; c++) {
      const t = tileGrid[r]![c]!;
      if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL) {
        wallCells.push(`${r},${c}`);
      }
    }
  }
  return { cells, fillCells, wallCells, tileGrid };
}

const imagePathById = new Map(envAtlas.sprites.map((s) => [s.id, s.imagePath]));

describe.each(MATRICES)('matrix: $name', (m) => {
  const { cells, fillCells, wallCells, tileGrid } = buildMatrix(m);

  it('matches the complete hand-built expectation table for every wall cell', () => {
    // Table completeness: every wall cell is asserted, nothing extra.
    expect(Object.keys(m.expected).sort()).toEqual([...wallCells].sort());

    for (const key of wallCells) {
      const [row, col] = key.split(',').map(Number) as [number, number];
      const cell = cells[row]![col]!;
      const want = m.expected[key]!;
      expect(cell, `cell (${row},${col}) must have a visual`).not.toBeNull();
      expect(imagePathById.get(cell.spriteId), `cell (${row},${col}) sprite`).toBe(want.imagePath);
      expect(cell.rotation, `cell (${row},${col}) rotation`).toBe(want.rotation);
      expect(cell.flipH).toBe(false);
      expect(cell.flipV).toBe(false);
      // Fill placement is part of the pinned contract.
      expect(fillCells[row]![col] !== null, `cell (${row},${col}) wall_fill presence`).toBe(
        want.fill,
      );
    }
  });

  it('emits null for every non-wall cell in BOTH layers', () => {
    for (let r = 0; r < m.grid.length; r++) {
      for (let c = 0; c < m.grid[r]!.length; c++) {
        if (m.grid[r]![c] === '.') {
          expect(cells[r]![c], `non-wall cell (${r},${c})`).toBeNull();
          expect(fillCells[r]![c], `non-wall cell (${r},${c}) fill`).toBeNull();
        }
      }
    }
  });

  it('passes the fill-aware continuity audit with ZERO violations', () => {
    const audit = auditWallLayerContinuity(cells, envAtlas.sprites, { fillCells });
    expect(audit.violations).toEqual([]);
  });

  it('passes the corner-dangling coverage audit with ZERO violations (ticket 20)', () => {
    const audit = validateWallComposition(tileGrid, cells, {
      fillCells,
      atlasSprites: envAtlas.sprites,
    });
    expect(audit.cornerViolations).toEqual([]);
  });
});

// ── run-consistency: adjacent run tiles never face opposite sides ─────────────

describe('run-consistency (ticket 13, D3)', () => {
  it('every horizontally adjacent straight pair in the hollow rectangle shares its strip side', () => {
    const m = MATRICES.find((x) => x.name.startsWith('hollow'))!;
    const { cells } = buildMatrix(m);
    const isStraight = (row: number, col: number) => {
      const cell = cells[row]![col];
      return cell != null && imagePathById.get(cell.spriteId) === 'wall';
    };
    for (let r = 1; r <= 3; r++) {
      for (let c = 1; c <= 4; c++) {
        if (!isStraight(r, c) || !isStraight(r, c + 1)) continue; // corners/endcaps excluded
        expect(cells[r]![c]!.rotation, `(${r},${c})-(${r},${c + 1}) straight-run side flip`).toBe(
          cells[r]![c + 1]!.rotation,
        );
      }
    }
  });

  it('the run-with-junction matrix: thin-run members share their strip side; the BACKED junction presents to its floor', () => {
    const m = MATRICES.find((x) => x.name.startsWith('run-with-junction'))!;
    const { cells, fillCells } = buildMatrix(m);
    // Ticket 27: the D3 guarantee is a THIN-run property — adjacent 1-thin
    // straight members (2-open, unfilled) never face opposite sides.
    expect(cells[2]![1]!.rotation).toBe(cells[2]![2]!.rotation);
    expect(cells[2]![4]!.rotation).toBe(cells[2]![5]!.rotation);
    expect(cells[2]![2]!.rotation).toBe(cells[2]![4]!.rotation);
    // The junction is a BACKED (fill-covered) mass cell: its bar presents to
    // the lone open cardinal S (rot180 — the floor side), NOT along the thin
    // run's contour; the fill closes the seam behind it, and fill-covered
    // cells are exempt from the repair pass by construction.
    const junction = cells[2]![3]!;
    expect(fillCells[2]![3]).not.toBeNull();
    expect(junction.rotation).toBe(180);
  });
});

/**
 * Thin-run MIRROR facing regression (map-polish round 5e).
 *
 * The owner-visible defect: the beacon keep's WEST and EAST wall runs both
 * rendered their bar on their EAST edge (the 2-opposite-open tie-break faces
 * every vertical thin run E) — duplicated, not mirrored, "disconnected"; and
 * the run-consistency repair then rotated the NW corner onto the west run's
 * inside-facing strip, re-introducing the pinwheel corner ticket 23 fixed.
 *
 * The fix under test (`WallVisualSelectorThinRuns`): a thin straight follows
 * the ARM SIDE of the corner its run terminates into (west run ← NW corner's
 * west arm, east run ← NE corner's east arm: both bars present outward,
 * mirrored), and an endcap capping a thin run adopts that run's effective
 * facing (both gate piers previously faced E by the axis rule). A thin run
 * with NO corner end (free-standing bar) keeps the classifier tie-break —
 * pinned here as the no-corner guard.
 *
 * The keep matrix is additionally asserted by PIXEL MIRROR: the composited
 * wall-art coverage of the keep's 13 tiles, mirrored about the structure's
 * vertical axis, must be identical (binary solidity, the same art ground
 * truth the continuity audit uses). That is exactly what the player sees.
 */

import { describe, it, expect } from 'vitest';
import { TileType, orientedShape, type TileVisual } from '@sector-battle/shared';
import { WallOrientationDetector } from '../WallOrientationDetector.ts';
import {
  buildWallRoleSpriteMap,
  resolveWallFillSprite,
  selectWallFill,
  selectWallVisuals,
} from '../WallVisualSelector.ts';
import { auditWallLayerContinuity } from './helpers/wallContinuityAudit.ts';
import { loadEnvAtlas, loadEnvWallBuckets } from './helpers/wallTestAtlas.ts';

const envAtlas = loadEnvAtlas();
const buckets = loadEnvWallBuckets();
const roleMaps = {
  indestructible: buildWallRoleSpriteMap(buckets.wall),
  destructible: buildWallRoleSpriteMap(buckets.destructibleWall),
};
const fillSprite = resolveWallFillSprite(envAtlas);
const detector = new WallOrientationDetector();
const imagePathById = new Map(envAtlas.sprites.map((s) => [s.id, s.imagePath]));

interface Built {
  cells: (TileVisual | null)[][];
  fillCells: (TileVisual | null)[][];
  tileGrid: TileType[][];
}

/** '#' = INDESTRUCTIBLE_WALL, '.' = EMPTY → the real selection pipeline. */
function build(grid: string[]): Built {
  const tileGrid = grid.map((row) =>
    row.split('').map((ch) => (ch === '#' ? TileType.INDESTRUCTIBLE_WALL : TileType.EMPTY)),
  );
  const orientations = detector.detect(tileGrid);
  const fillCells = selectWallFill(tileGrid, orientations, fillSprite);
  const cells = selectWallVisuals(tileGrid, orientations, roleMaps, { fillCells });
  return { cells, fillCells, tileGrid };
}

function expectCell(
  b: Built,
  row: number,
  col: number,
  imagePath: string,
  rotation: 0 | 90 | 180 | 270,
): void {
  const cell = b.cells[row]![col]!;
  expect(cell, `cell (${row},${col}) must have a visual`).not.toBeNull();
  expect(imagePathById.get(cell.spriteId), `cell (${row},${col}) sprite`).toBe(imagePath);
  expect(cell.rotation, `cell (${row},${col}) rotation`).toBe(rotation);
}

// ── the beacon keep (the owner's screenshot structure) ───────────────────────

/** The 13-tile keep footprint, anchor (4,4), 2-tile floor margin. */
const KEEP_GRID = [
  '.........',
  '.........',
  '..#####..',
  '..#...#..',
  '..#...#..',
  '..#...#..',
  '..#...#..',
  '.........',
  '.........',
];

describe('beacon keep thin-run mirror facing (round 5e)', () => {
  const b = build(KEEP_GRID);

  it('WEST run (corners included) presents its bar OUTWARD (rot 270)', () => {
    expectCell(b, 3, 2, 'wall', 270);
    expectCell(b, 4, 2, 'wall', 270);
    expectCell(b, 5, 2, 'wall', 270);
    expectCell(b, 6, 2, 'wall', 270); // gate pier (endcap) follows its run
  });

  it('EAST run (corners included) presents its bar OUTWARD (rot 90) — MIRRORED', () => {
    expectCell(b, 3, 6, 'wall', 90);
    expectCell(b, 4, 6, 'wall', 90);
    expectCell(b, 5, 6, 'wall', 90);
    expectCell(b, 6, 6, 'wall', 90); // gate pier (endcap) follows its run
  });

  it('NORTH run presents its bar OUTWARD (rot 0)', () => {
    expectCell(b, 2, 3, 'wall', 0);
    expectCell(b, 2, 4, 'wall', 0);
    expectCell(b, 2, 5, 'wall', 0);
  });

  it('corners keep the ticket-23 elbow-on-floor-quadrant orientation (NOT repair-rotated)', () => {
    expectCell(b, 2, 2, 'wall_corner', 0); // NW elbow
    expectCell(b, 2, 6, 'wall_corner', 90); // NE elbow
  });

  it('composited keep art is pixel-mirror symmetric about its vertical axis', () => {
    const keepTiles = [
      [2, 2],
      [2, 3],
      [2, 4],
      [2, 5],
      [2, 6],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 2],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6],
    ] as const;
    // 7×7 tile box centered on the keep (cols 1..7, axis = col 4).
    const size = 7 * 8;
    const comp = Array.from({ length: size }, () => Array(size).fill(0));
    for (const [r, c] of keepTiles) {
      const cell = b.cells[r]![c]!;
      const shape = orientedShape(imagePathById.get(cell.spriteId)!, cell.rotation);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) comp[(r - 1) * 8 + y]![(c - 1) * 8 + x]! = shape[y]![x]!;
    }
    const axis = 4 * 8 + 4 - 8; // col-4 tile center within the box
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const mx = 2 * axis - 1 - x;
        if (mx < 0 || mx >= size) continue;
        expect(comp[y]![x]! >= 0.5, `mirror asymmetry at px (${x},${y}) vs (${mx},${y})`).toBe(
          comp[y]![mx]! >= 0.5,
        );
      }
    }
  });

  it('passes the fill-aware continuity audit with ZERO violations', () => {
    const audit = auditWallLayerContinuity(b.cells, envAtlas.sprites, {
      fillCells: b.fillCells,
    });
    expect(audit.violations).toEqual([]);
  });
});

// ── the no-corner guard: free-standing thin runs keep the tie-break ─────────

describe('thin runs without corner ends keep the classifier tie-break', () => {
  it('a lone vertical bar faces E (rot 90) endcaps included — the demo-authored handedness', () => {
    const b = build(['.....', '.....', '..#..', '..#..', '..#..', '.....', '.....']);
    expectCell(b, 2, 2, 'wall', 90);
    expectCell(b, 3, 2, 'wall', 90);
    expectCell(b, 4, 2, 'wall', 90);
  });

  it('a lone horizontal bar faces N (rot 0) endcaps included', () => {
    const b = build(['.....', '.....', '.....', '..###..', '.....', '.....', '.....']);
    expectCell(b, 3, 2, 'wall', 0);
    expectCell(b, 3, 3, 'wall', 0);
    expectCell(b, 3, 4, 'wall', 0);
  });
});

// ── the general rule: an L of thin runs follows its corner's arms ────────────

describe('L-shaped thin wall follows the corner arms', () => {
  it('vertical arm faces W, horizontal arm faces N (NW elbow)', () => {
    const b = build(['.....', '.....', '.##..', '.#...', '.#...', '.....', '.....']);
    expectCell(b, 2, 1, 'wall_corner', 0); // elbow NW
    expectCell(b, 2, 2, 'wall', 0); // horizontal arm → N
    expectCell(b, 3, 1, 'wall', 270); // vertical arm → W
    expectCell(b, 4, 1, 'wall', 270);
  });

  it('SE-elbow L: vertical arm faces E, horizontal arm faces S', () => {
    const b = build(['.......', '...#...', '...#...', '.###...', '.......', '.......', '.......']);
    expectCell(b, 3, 3, 'wall_corner', 180); // elbow SE (walls N+W, floor S+E)
    expectCell(b, 3, 2, 'wall', 180); // horizontal arm → S
    expectCell(b, 3, 1, 'wall', 180); // endcap follows its run's facing
    expectCell(b, 2, 3, 'wall', 90); // vertical arm → E
    expectCell(b, 1, 3, 'wall', 90);
  });
});

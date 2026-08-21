/**
 * wallRunConsistency — the deterministic run-consistency repair pass
 * (map-polish ticket 13, defect class D3: mid-run strip side-flips).
 *
 * After `selectWallVisuals` assigns each wall cell its provisional facing
 * (straight convention / endcap axis / topology-derived one-open modes /
 * destructible corner-reading), this pass walks the grid and rotates any
 * UNFILLED wall cell whose strip does not share a solid band with an adjacent
 * wall tile, so adjacent run tiles never face opposite sides. Band overlap is
 * measured against the same art-shape ground truth as the continuity audit
 * (`wallArtShapes.ts` — identical `edgeBand` + threshold), which makes
 * "connected" mean exactly what the audit gate measures.
 *
 * A filled side (the opaque `wall_fill` under-layer) is connected by
 * construction, so only unfilled pairs — destructible walls (never fillable:
 * a destroyed wall must not leave baked fill behind), crates, and thin 1-thick
 * indestructible runs — are constrained. (Round 6 note: mixed-material strip
 * contour is enforced SELECTOR-side — the thin-run body-contour rule in
 * `WallVisualSelectorThinRuns` — not here; constraining unfilled tiles
 * against filled partners' strips here BLOCKS repair rotations the exemption
 * allows and deadlocks D-cluster settling.)
 *
 * Determinism contract (ADR 0035): row-major scan order, candidate rotations
 * tried in a fixed `[current, 0, 90, 180, 270]` order, at most 4 sweeps — a
 * pure function of `(grid, visuals, roleSpriteMaps, fillCells)`. No RNG, no
 * wall-clock, no positional inputs. The pass only accepts a rotation that
 * satisfies ALL of a cell's constrained pairs at once, so it never makes a
 * pair worse; cells with no satisfying rotation (pure-destructible junction
 * clusters the strip kit cannot represent — the accepted D5 art-coverage
 * class) keep their provisional facing.
 *
 * Ticket 23 agreement note: this pass is the THIN-vs-THICK corner arbiter
 * under the corrected corner orientation. A clean outer-corner cell of a
 * wall MASS is `wall_fill`-covered → unconstrained → keeps its
 * elbow-on-the-open-quadrant rotation (solid frame around the mass). A
 * 1-THICK corner (no fill) is constrained against both arms, so if the
 * provisional orientation does not share a band with the arms' strips, the
 * pass rotates it onto the arms' band contour — the same art-shape ground
 * truth (`edgeBand`), so "agrees with the model" is by construction.
 */

import { TileType, type TileSpriteDef, type TileVisual } from '@sector-battle/shared';
import { isWallLikeTile } from './WallOrientationDetector.js';
import type { WallRoleSpriteMaps } from './WallVisualSelector.js';
import { edgeBand, SOLID_THRESHOLD } from '@sector-battle/shared';

type Dir = 'N' | 'E' | 'S' | 'W';

const DIR_OFFSETS: Record<Dir, [number, number]> = {
  N: [-1, 0],
  E: [0, 1],
  S: [1, 0],
  W: [0, -1],
};

const DIRS: Dir[] = ['N', 'E', 'S', 'W'];

const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Tile types the `wall_fill` layer can NEVER cover (by construction). */
function neverFilled(tile: TileType): boolean {
  return tile === TileType.DESTRUCTIBLE_WALL || tile === TileType.INDESTRUCTIBLE_CRATE;
}

/** Mutates `visuals` in place into a run-consistent assignment (see header). */
export function repairRunConsistency(
  grid: TileType[][],
  visuals: (TileVisual | null)[][],
  roleSpriteMaps: WallRoleSpriteMaps,
  fillCells: (TileVisual | null)[][] | undefined,
): void {
  // Frame lookup: spriteId → def, from the two role maps (every wall-layer
  // cell's spriteId comes from one of them).
  const defById = new Map<number, TileSpriteDef>();
  for (const map of [roleSpriteMaps.indestructible, roleSpriteMaps.destructible]) {
    for (const def of map.values()) defById.set(def.id, def);
  }

  // Band cache: `${imagePath}@${rotation}` → the four edge bands. Mirrors the
  // audit's edgeBand exactly (same art-shape ground truth, same threshold).
  const bandCache = new Map<string, { N: number[]; E: number[]; S: number[]; W: number[] }>();
  const bandsOf = (path: string, rotation: number) => {
    const key = `${path}@${rotation}`;
    let bands = bandCache.get(key);
    if (!bands) {
      bands = {
        N: edgeBand(path, rotation, 'N'),
        E: edgeBand(path, rotation, 'E'),
        S: edgeBand(path, rotation, 'S'),
        W: edgeBand(path, rotation, 'W'),
      };
      bandCache.set(key, bands);
    }
    return bands;
  };

  /** All constrained neighbours of (row,col): [dir, nRow, nCol], dir = the side they sit on. */
  const constrainedNeighbours = (row: number, col: number): Array<[Dir, number, number]> => {
    const out: Array<[Dir, number, number]> = [];
    const tile = grid[row]![col]!;
    for (const dir of DIRS) {
      const [dr, dc] = DIR_OFFSETS[dir];
      const nRow = row + dr;
      const nCol = col + dc;
      if (nRow < 0 || nRow >= grid.length || nCol < 0 || nCol >= grid[nRow]!.length) continue;
      const nTile = grid[nRow]![nCol]!;
      if (!isWallLikeTile(nTile)) continue;
      // A filled side (either side) is connected by construction — the opaque
      // fill under the strips provides the shared band.
      if (fillCells) {
        if (fillCells[row]?.[col] || fillCells[nRow]?.[nCol]) continue;
      } else if (!neverFilled(tile) && !neverFilled(nTile)) {
        // No fill data: only constrain pairs that can never be fill-covered.
        continue;
      }
      out.push([dir, nRow, nCol]);
    }
    return out;
  };

  const satisfiesAll = (
    row: number,
    col: number,
    rotation: number,
    neighbours: Array<[Dir, number, number]>,
  ): boolean => {
    const myPath = defById.get(visuals[row]![col]!.spriteId)?.imagePath;
    if (!myPath) return true;
    for (const [dir, nRow, nCol] of neighbours) {
      const neighbour = visuals[nRow]![nCol];
      if (!neighbour) continue;
      const nPath = defById.get(neighbour.spriteId)?.imagePath;
      if (!nPath) continue;
      // dir = where the neighbour sits relative to me; the shared edge is MY
      // side in that direction against THEIR opposite side.
      const mySide = dir as 'N' | 'E' | 'S' | 'W';
      const theirSide = OPPOSITE[mySide];
      const a = bandsOf(myPath, rotation)[mySide];
      const b = bandsOf(nPath, neighbour.rotation)[theirSide];
      if (!a.some((v, i) => v >= SOLID_THRESHOLD && b[i]! >= SOLID_THRESHOLD)) return false;
    }
    return true;
  };

  for (let sweep = 0; sweep < 4; sweep++) {
    let changed = false;
    for (let row = 0; row < grid.length; row++) {
      for (let col = 0; col < grid[row]!.length; col++) {
        const cell = visuals[row]![col];
        if (!cell) continue;
        if (fillCells?.[row]?.[col]) continue; // filled cells connect by construction
        const neighbours = constrainedNeighbours(row, col);
        if (neighbours.length === 0) continue;
        if (satisfiesAll(row, col, cell.rotation, neighbours)) continue;
        for (const candidate of [0, 90, 180, 270] as const) {
          if (candidate === cell.rotation) continue; // already known to fail
          if (satisfiesAll(row, col, candidate, neighbours)) {
            cell.rotation = candidate;
            changed = true;
            break;
          }
        }
      }
    }
    if (!changed) break;
  }
}

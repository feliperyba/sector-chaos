import { TileType, isWallLikeTile } from '@sector-battle/shared';
import { logger } from '@sector-battle/shared';
import { WALL_MASK_BITS } from './WallMaskClassifier.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * A tile is "wall-like" if it blocks movement (not EMPTY, not a trap/chest entity).
 *
 * Canonical home is `shared/map/gridUtils.ts` since map-polish ticket 14 (the
 * shared generation-side wall-composition validator needs the exact same
 * predicate); re-exported here so `WallVisualSelector` and the detector keep
 * applying one wall-likeness definition — the mask and the topology
 * derivation can never disagree.
 */
export { isWallLikeTile };

// ── detector ─────────────────────────────────────────────────────────────────

export class WallOrientationDetector {
  /**
   * Compute the 8-neighbour wall/open mask for every wall tile in the grid.
   *
   * Returns a parallel grid of `number | null`: `null` for non-wall cells, and
   * for wall cells an 8-bit mask built with the T2 `WALL_MASK_BITS` weights
   * (`N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128`). A set bit means that
   * neighbour is wall-like; a clear bit means it is open (floor / walkable). The
   * raw mask is returned so that `classifyWall` (T2) owns all interpretation.
   *
   * Off-map neighbours are treated as **wall-like** (set bit). In the real grid
   * the outermost ring is INDESTRUCTIBLE_WALL, so the world ends in wall: at the
   * outer map corners this makes the only open neighbour an interior diagonal,
   * which `classifyWall` reads as a concave `inner_corner` (matching the demo),
   * not a convex `outer_corner`.
   */
  detect(grid: TileType[][]): (number | null)[][] {
    const height = grid.length;
    if (height === 0) return [];

    const result: (number | null)[][] = [];

    for (let row = 0; row < height; row++) {
      const width = grid[row]!.length;
      const rowResult: (number | null)[] = [];

      for (let col = 0; col < width; col++) {
        const tile = grid[row]![col]!;

        if (!isWallLikeTile(tile)) {
          rowResult.push(null);
          continue;
        }

        // Off-map reads as wall-like so the world ends in wall (border ring).
        const at = (r: number, c: number): boolean =>
          r < 0 || r >= height || c < 0 || c >= width ? true : isWallLikeTile(grid[r]![c]!);

        let mask = 0;
        if (at(row - 1, col)) mask |= WALL_MASK_BITS.N;
        if (at(row - 1, col + 1)) mask |= WALL_MASK_BITS.NE;
        if (at(row, col + 1)) mask |= WALL_MASK_BITS.E;
        if (at(row + 1, col + 1)) mask |= WALL_MASK_BITS.SE;
        if (at(row + 1, col)) mask |= WALL_MASK_BITS.S;
        if (at(row + 1, col - 1)) mask |= WALL_MASK_BITS.SW;
        if (at(row, col - 1)) mask |= WALL_MASK_BITS.W;
        if (at(row - 1, col - 1)) mask |= WALL_MASK_BITS.NW;

        rowResult.push(mask);
      }

      result.push(rowResult);
    }

    logger.debug(`Orientation detection complete: ${height} rows`);
    return result;
  }
}

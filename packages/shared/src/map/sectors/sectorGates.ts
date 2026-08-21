import { TileType } from '../../enums/TileType.js';
import type { SectorData } from '../types.js';
import { SECTOR_TILE_SIZE } from '../constants.js';

/**
 * Sector-level structural gate measures (map-redesign ticket 08 / DEC-007).
 *
 * The probabilistic sub-block pass and the horizontal-mirror transform both
 * mutate a sector's tile grid AFTER the base skeleton builder has run, so both
 * need a cheap, PURE (RNG-free) way to re-verify the validator-relevant
 * invariants locally, per sector:
 *
 * - `emptyComponents` — the number of 4-connected EMPTY regions in the sector
 *   interior. The map validator's flood-fill gate tolerates 80% reachability;
 *   locally we hold the stricter "never SPLIT the walkable region" line: a
 *   block/mirror is reverted when the component count grows (the mirror check
 *   holds it exactly equal — a horizontal flip is a grid automorphism).
 * - `spawnEligible` — interior EMPTY tile count, mirroring
 *   `validatorGates.countSpawnEligible` (which mirrors
 *   SpawnPointFinder.collectCandidates). Sub-blocks may not starve a sector
 *   below `MIN_SPAWNS_PER_SECTOR`.
 * - `loneWalls` — interior INDESTRUCTIBLE_WALL tiles with zero wall
 *   (INDESTRUCTIBLE_WALL / DESTRUCTIBLE_WALL) 8-neighbours, the sector-local
 *   form of validator gate 4. `clear` operations can orphan a wall, so the
 *   block pass reverts any block that increases the count.
 * - `sightlineProfile` — a canonical signature of the open runs per row and
 *   per column (sorted). Used by the mirror gate to re-verify sightlines are
 *   preserved by the transform (the ticket's "sightlines re-verified
 *   post-transform" criterion — provably invariant under a horizontal flip,
 *   and verified, not assumed).
 */

/**
 * Measure every gate quantity for one sector. Pure function of the tiles.
 *
 * @param sector - the sector to measure
 * @returns the four gate measures
 */
export function measureSectorGates(sector: SectorData): SectorGateMeasures {
  const tiles = sector.tiles;
  const size = SECTOR_TILE_SIZE;
  const last = size - 1;
  return {
    emptyComponents: countEmptyComponents(tiles),
    spawnEligible: countInteriorEmpty(tiles),
    loneWalls: countLoneWalls(tiles, last),
    sightlineProfile: sightlineProfile(tiles, size),
  };
}

/** The measured gate quantities for one sector (see module docs). */
export interface SectorGateMeasures {
  /** Number of 4-connected EMPTY regions in the interior. */
  emptyComponents: number;
  /** Interior EMPTY tiles (spawn-eligible pool). */
  spawnEligible: number;
  /** Interior isolated INDESTRUCTIBLE_WALL stubs (validator gate 4, local form). */
  loneWalls: number;
  /** Canonical sightline signature (sorted per-row/per-column max open runs). */
  sightlineProfile: string;
}

/** Count 4-connected components of EMPTY tiles across the whole grid. */
function countEmptyComponents(tiles: Uint8Array[]): number {
  const size = tiles.length;
  const visited = new Uint8Array(size * size);
  let components = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (tiles[r]![c]! !== TileType.EMPTY || visited[r * size + c]!) continue;
      components++;
      // BFS flood this component.
      const queue: number[] = [r * size + c];
      visited[r * size + c] = 1;
      let head = 0;
      while (head < queue.length) {
        const idx = queue[head++]!;
        const cr = (idx / size) | 0;
        const cc = idx % size;
        if (cr > 0 && tiles[cr - 1]![cc]! === TileType.EMPTY && !visited[idx - size]!) {
          visited[idx - size] = 1;
          queue.push(idx - size);
        }
        if (cr < size - 1 && tiles[cr + 1]![cc]! === TileType.EMPTY && !visited[idx + size]!) {
          visited[idx + size] = 1;
          queue.push(idx + size);
        }
        if (cc > 0 && tiles[cr]![cc - 1]! === TileType.EMPTY && !visited[idx - 1]!) {
          visited[idx - 1] = 1;
          queue.push(idx - 1);
        }
        if (cc < size - 1 && tiles[cr]![cc + 1]! === TileType.EMPTY && !visited[idx + 1]!) {
          visited[idx + 1] = 1;
          queue.push(idx + 1);
        }
      }
    }
  }
  return components;
}

/** Count EMPTY tiles in the interior ring (rows/cols 1..size-2). */
function countInteriorEmpty(tiles: Uint8Array[]): number {
  const last = tiles.length - 2;
  let count = 0;
  for (let r = 1; r <= last; r++) {
    for (let c = 1; c <= last; c++) {
      if (tiles[r]![c]! === TileType.EMPTY) count++;
    }
  }
  return count;
}

/** Count interior INDESTRUCTIBLE_WALL tiles with zero wall 8-neighbours. */
function countLoneWalls(tiles: Uint8Array[], last: number): number {
  let lone = 0;
  for (let r = 1; r < last; r++) {
    for (let c = 1; c < last; c++) {
      if (tiles[r]![c]! !== TileType.INDESTRUCTIBLE_WALL) continue;
      if (countWallNeighbours8(tiles, r, c, last) === 0) lone++;
    }
  }
  return lone;
}

function countWallNeighbours8(tiles: Uint8Array[], r: number, c: number, last: number): number {
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr > last + 1 || nc < 0 || nc > last + 1) continue;
      const v = tiles[nr]![nc]!;
      if (v === TileType.INDESTRUCTIBLE_WALL || v === TileType.DESTRUCTIBLE_WALL) count++;
    }
  }
  return count;
}

/**
 * Canonical sightline signature: for every row the length of the longest
 * consecutive EMPTY run, likewise for every column, each list sorted then
 * joined. Two grids that are horizontal mirrors of each other produce the
 * IDENTICAL signature (runs are preserved under reversal), which is exactly
 * what the mirror gate asserts.
 */
function sightlineProfile(tiles: Uint8Array[], size: number): string {
  const rowRuns: number[] = [];
  const colRuns: number[] = [];
  for (let r = 0; r < size; r++) {
    let best = 0;
    let run = 0;
    for (let c = 0; c < size; c++) {
      if (tiles[r]![c]! === TileType.EMPTY) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    rowRuns.push(best);
  }
  for (let c = 0; c < size; c++) {
    let best = 0;
    let run = 0;
    for (let r = 0; r < size; r++) {
      if (tiles[r]![c]! === TileType.EMPTY) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    colRuns.push(best);
  }
  const sortNum = (a: number[]) => a.sort((x, y) => x - y).join(',');
  return `r${sortNum(rowRuns)}|c${sortNum(colRuns)}`;
}

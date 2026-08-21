import { TileType } from '../enums/TileType.js';
import type { SectorData } from './types.js';
import { SECTOR_TILE_SIZE } from './constants.js';

export function isEmptyTile(tile: number): boolean {
  return tile === TileType.EMPTY;
}

export function isTraversable(tile: number): boolean {
  return tile !== TileType.INDESTRUCTIBLE_WALL && tile !== TileType.INDESTRUCTIBLE_CRATE;
}

/**
 * Whether a tile participates in the WALL system: it blocks movement AND
 * renders through the wall autotiler (masks, wall visuals, fills). DESTRUCTIBLE
 * crates/barrels are NOT wall-like (they render as destructible objects); the
 * indestructible crate is a solid block and reads as wall.
 *
 * Canonical predicate (map-polish ticket 14) — the server's
 * `WallOrientationDetector` re-exports it so grid masks, the wall-visual
 * selector and this package's wall-composition validator all apply ONE
 * definition of "wall".
 */
export function isWallLikeTile(tile: number): boolean {
  return (
    tile === TileType.INDESTRUCTIBLE_WALL ||
    tile === TileType.DESTRUCTIBLE_WALL ||
    tile === TileType.INDESTRUCTIBLE_CRATE
  );
}

/**
 * The run-join guard (map-polish round 8): would stamping `tile` at (r, c)
 * create a junction the wall pipeline cannot render continuously?
 *
 * Art ground truth: 2 wall cardinals is always representable (opposite pair
 * = straight run, adjacent pair = corner — both have strip/corner frames).
 * THREE or more wall cardinals spanning both axes is a T/plus junction, and
 * the junction path breaks continuity in practice two ways: the
 * destructible straight has one-sided strip art (no junction frame exists —
 * the run-consistency repair provably cannot settle the cell: the two run
 * arms demand one strip side, the stem the opposite), and the indestructible
 * T-stand-in convention can flip a neighbouring thin run's facing. This is
 * the WallContinuityGate D-class — seed 1 hit it twice in the v16 map (a
 * barricade bar stamped over a skeleton lone-D; a keep wall stamped flush
 * against a thin skeleton D-run's side).
 *
 * The guard is therefore shape-scoped, not touch-scoped:
 *  - a DESTRUCTIBLE candidate whose post-stamp wall cardinals (own-stamp
 *    cells + foreign wall-like tiles) reach 3+ is rejected — the candidate
 *    itself would be the unrenderable junction;
 *  - an INDESTRUCTIBLE candidate that would push a FOREIGN destructible
 *    neighbour from 2 wall cardinals to 3+ is rejected — the neighbour
 *    becomes the junction (own-stamp neighbours are exact walls; only
 *    foreign DESTRUCTIBLE neighbours are protected — full-block I walls
 *    render through the fill/stand-in paths).
 * Rejected candidates conflict-clip away like every other paint conflict (a
 * clipped run reads as a ruin breach). Pure function of the grid; zero RNG.
 *
 * @param tiles the sector tile grid (pre-stamp state)
 * @param r candidate row (sector-local)
 * @param c candidate col (sector-local)
 * @param tile the material the stamp would write at (r, c)
 * @param own the caller's own accumulating stamp cells (`"r,c"` keys)
 */
export function createsUnrenderableJunction(
  tiles: Uint8Array[],
  r: number,
  c: number,
  tile: number,
  own?: ReadonlySet<string>,
): boolean {
  const CARDINALS: Array<[number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const isOwn = (nr: number, nc: number): boolean => own?.has(`${nr},${nc}`) ?? false;
  const isWallAt = (nr: number, nc: number): boolean => {
    if (isOwn(nr, nc)) return true;
    return isWallLikeTile(tiles[nr]?.[nc] ?? -1);
  };
  const wallCardinalCount = (nr: number, nc: number): number => {
    let n = 0;
    for (const [dr, dc] of CARDINALS) if (isWallAt(nr + dr, nc + dc)) n++;
    return n;
  };

  if (tile === TileType.DESTRUCTIBLE_WALL) {
    return wallCardinalCount(r, c) >= 3;
  }
  for (const [dr, dc] of CARDINALS) {
    const nr = r + dr;
    const nc = c + dc;
    if (isOwn(nr, nc)) continue;
    if (tiles[nr]?.[nc] !== TileType.DESTRUCTIBLE_WALL) continue;
    if (wallCardinalCount(nr, nc) >= 2) return true; // + this stamp = 3+
  }
  return false;
}

export function buildCompositeGrid(sectors: SectorData[][]): Uint8Array[] {
  const gridSize = sectors.length * SECTOR_TILE_SIZE;
  const grid: Uint8Array[] = [];
  for (let sRow = 0; sRow < sectors.length; sRow++) {
    for (let tRow = 0; tRow < SECTOR_TILE_SIZE; tRow++) {
      const row = new Uint8Array(gridSize);
      for (let sCol = 0; sCol < sectors[0]!.length; sCol++) {
        row.set(sectors[sRow]![sCol]!.tiles[tRow]!, sCol * SECTOR_TILE_SIZE);
      }
      grid.push(row);
    }
  }
  return grid;
}

export interface GridBfsOptions {
  grid: Uint8Array[];
  startR: number;
  startC: number;
  passable: (tile: number) => boolean;
  earlyStop?: (r: number, c: number) => boolean;
}

export interface GridBfsResult {
  visited: Uint8Array;
  count: number;
  stopped: boolean;
  stopR: number;
  stopC: number;
}

export function gridBfs(options: GridBfsOptions): GridBfsResult {
  const { grid, startR, startC, passable, earlyStop } = options;
  const height = grid.length;
  const width = grid[0]!.length;
  const visited = new Uint8Array(height * width);
  const queue: number[] = [startR * width + startC];
  visited[startR * width + startC] = 1;
  let head = 0;
  let count = 1;
  const dirs = [-1, 0, 1, 0, 0, -1, 0, 1];

  while (head < queue.length) {
    const idx = queue[head++]!;
    const r = (idx / width) | 0;
    const c = idx % width;

    if (earlyStop?.(r, c)) {
      return { visited, count, stopped: true, stopR: r, stopC: c };
    }

    for (let d = 0; d < 8; d += 2) {
      const nr = r + dirs[d]!;
      const nc = c + dirs[d + 1]!;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const nIdx = nr * width + nc;
      if (visited[nIdx]) continue;
      if (!passable(grid[nr]![nc]!)) continue;
      visited[nIdx] = 1;
      count++;
      queue.push(nIdx);
    }
  }

  return { visited, count, stopped: false, stopR: -1, stopC: -1 };
}

export function findFirstPassable(
  grid: Uint8Array[],
  passable: (tile: number) => boolean,
): { r: number; c: number } | null {
  const height = grid.length;
  if (height === 0) return null;
  const width = grid[0]!.length;
  if (width === 0) return null;

  const centerR = height >> 1;
  const centerC = width >> 1;
  const maxRadius = Math.max(centerR, centerC, height - 1 - centerR, width - 1 - centerC);

  for (let radius = 0; radius <= maxRadius; radius++) {
    const rMin = centerR - radius;
    const rMax = centerR + radius;
    const cMin = centerC - radius;
    const cMax = centerC + radius;

    if (rMin >= 0 && rMin < height) {
      const cStart = Math.max(0, cMin);
      const cEnd = Math.min(width - 1, cMax);
      for (let c = cStart; c <= cEnd; c++) {
        if (passable(grid[rMin]![c]!)) return { r: rMin, c };
      }
    }

    if (rMax !== rMin && rMax >= 0 && rMax < height) {
      const cStart = Math.max(0, cMin);
      const cEnd = Math.min(width - 1, cMax);
      for (let c = cStart; c <= cEnd; c++) {
        if (passable(grid[rMax]![c]!)) return { r: rMax, c };
      }
    }

    if (cMin >= 0 && cMin < width) {
      const rStart = Math.max(0, rMin + 1);
      const rEnd = Math.min(height - 1, rMax - 1);
      for (let r = rStart; r <= rEnd; r++) {
        if (passable(grid[r]![cMin]!)) return { r, c: cMin };
      }
    }

    if (cMax !== cMin && cMax >= 0 && cMax < width) {
      const rStart = Math.max(0, rMin + 1);
      const rEnd = Math.min(height - 1, rMax - 1);
      for (let r = rStart; r <= rEnd; r++) {
        if (passable(grid[r]![cMax]!)) return { r, c: cMax };
      }
    }
  }

  return null;
}

export function getSectorRing(row: number, col: number, gridSize: number): 'outer' | 'center' {
  if (row < 0 || row >= gridSize || col < 0 || col >= gridSize) {
    throw new Error(`Invalid sector coordinates: row=${row}, col=${col} for grid size ${gridSize}`);
  }
  const last = gridSize - 1;
  if (row === 0 || row === last || col === 0 || col === last) return 'outer';
  return 'center';
}

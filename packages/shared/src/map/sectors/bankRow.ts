import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { ResourceRichSkeleton } from './resourceRichSkeletons.js';

/**
 * Bank Row — the ticket-08 RESOURCE_RICH skeleton (DEC-007.3: "three framed
 * caches in a row"). Three 2×2 vault interiors sit in a row along the sector
 * spine (cols 3–4, 8–9, 13–14 for a horizontal row; rows transposed for a
 * vertical one), each framed by a one-tile BREAKABLE vault wall with a
 * guaranteed EMPTY entrance gap on its north OR south side (rng) — the gap
 * always opens onto the open field rows, never onto a neighbouring vault's
 * frame, so every cache interior stays EMPTY-connected by construction. The
 * two 2-wide streets between the vaults (cols 6–7 and 11–12) are the bank
 * row's boulevard: open contested ground between three reward pockets.
 *
 * RESOURCE_RICH family invariants (ADR 0027 / GDD §5.2.4): framing is always
 * BREAKABLE (DESTRUCTIBLE_WALL — cache interiors stay loot-eligible and
 * players crack the cover open to reach the loot); cache cells stay connected
 * (the entrance gaps); no lone indestructible stubs (everything structural
 * here is breakable). Per-instance variety: row orientation, spine jitter,
 * gap sides, street dressing.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton with its three cache cells + landmark anchor
 */
export function buildBankRow(rng: SeededRNG): ResourceRichSkeleton {
  const tiles = blankBordered();
  const vertical = rng.nextInt(0, 1) === 0;
  // Spine jitter: the row band shifts (top interior row 8..10) so two
  // instances differ.
  const rM = 8 + rng.nextInt(0, 2);

  const cacheCols = [3, 8, 13];
  for (const c0 of cacheCols) {
    // Frame ring around the 2×2 interior (rows rM..rM+1, cols c0..c0+1).
    for (let d = -1; d <= 2; d++) {
      putIfEmpty(tiles, rM - 1, c0 + d, TileType.DESTRUCTIBLE_WALL);
      putIfEmpty(tiles, rM + 2, c0 + d, TileType.DESTRUCTIBLE_WALL);
      putIfEmpty(tiles, rM + d, c0 - 1, TileType.DESTRUCTIBLE_WALL);
      putIfEmpty(tiles, rM + d, c0 + 2, TileType.DESTRUCTIBLE_WALL);
    }
    // Entrance gap: N or S side (rng), at one of the two interior columns —
    // always onto the open field, never the street between vaults.
    const gapCol = c0 + rng.nextInt(0, 1);
    const gapRow = rng.nextInt(0, 1) === 0 ? rM - 1 : rM + 2;
    tiles[gapRow]![gapCol] = TileType.EMPTY;
  }

  // The three cache cells (the middle vault's centre doubles as the
  // hero-landmark anchor).
  const spots = [
    { x: 4, y: rM },
    { x: 9, y: rM },
    { x: 14, y: rM },
  ];
  if (!vertical) {
    return { tiles, landmarkAnchor: { x: 9, y: rM }, lootSpots: spots };
  }
  // Vertical variant: transpose the whole authored horizontal layout (caches
  // at rows 3–4, 8–9, 13–14; streets at rows 6–7 and 11–12).
  return {
    tiles: transpose(tiles),
    landmarkAnchor: { x: rM, y: 9 },
    lootSpots: spots.map((s) => ({ x: s.y, y: s.x })),
  };
}

/** Transpose a square grid (rows ↔ columns). */
function transpose(tiles: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let r = 0; r < tiles.length; r++) {
    out[r] = new Uint8Array(tiles.length);
    for (let c = 0; c < tiles.length; c++) out[r]![c] = tiles[c]![r]!;
  }
  return out;
}

/**
 * Set a cell only when it is currently EMPTY and inside the interior.
 *
 * @param tiles - the grid being built
 * @param r - the target row
 * @param c - the target column
 * @param t - the tile type to write
 */
function putIfEmpty(tiles: Uint8Array[], r: number, c: number, t: TileType): void {
  if (r > 0 && r < 19 && c > 0 && c < 19 && tiles[r]![c] === TileType.EMPTY) {
    tiles[r]![c] = t;
  }
}

/** Allocate a 20×20 grid filled with EMPTY and framed with the border ring. */
function blankBordered(): Uint8Array[] {
  const tiles: Uint8Array[] = [];
  for (let row = 0; row < 20; row++) {
    tiles[row] = new Uint8Array(20);
    tiles[row]!.fill(TileType.EMPTY);
  }
  for (let i = 0; i < 20; i++) {
    tiles[0]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[19]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![0] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![19] = TileType.INDESTRUCTIBLE_WALL;
  }
  return tiles;
}

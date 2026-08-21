import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SkeletonResult } from './gridArenaSkeletons.js';

/**
 * Plaza Crossroads — the ticket-08 GRID_ARENA skeleton (DEC-007.3: "open
 * center + corner rooms"). A wide open plaza at the sector heart where two
 * crossing lanes (rows 9–10 and cols 9–10, kept fully clear) meet, framed by
 * four corner rooms: 6×6 quadrant blocks whose inner-facing L-shaped
 * INDESTRUCTIBLE walls (with 2-wide rng gaps) separate each room from the
 * plaza, plus a fixed 2×2 pillar in each room's outer corner. The outer sides
 * of every room are wall-free, so rooms always open onto the ring corridor at
 * rows/cols 1/18 — a room can never seal (connectivity by construction).
 *
 * GRID_ARENA family invariants (GDD §5.2.1 / ADR 0027): persistent
 * INDESTRUCTIBLE_WALL skeleton (the L walls + pillars survive the whole
 * match), breakable cover fill, guaranteed open pockets for spawns/loot (the
 * plaza + lanes + ring corridor). Per-instance variety: gap positions, one
 * room skipped ~25%, plaza-edge crate dice.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton (tiles + loot spots + landmark anchor)
 */
export function buildPlazaCrossroads(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();

  // The four corner rooms (quadrant top-left origins). Room spans rows/cols
  // r0..r0+5 with r0 ∈ {2, 12} — lanes at rows/cols 9–10 stay clear between
  // them, shoulders at rows/cols 8 and 11 keep the plaza breathing room.
  const skipRoom = rng.nextInt(0, 3);
  for (let q = 0; q < 4; q++) {
    const r0 = q < 2 ? 2 : 12;
    const c0 = q % 2 === 0 ? 2 : 12;
    // ~25% of instances omit one room — the plaza opens onto that corner.
    if (q === skipRoom && rng.nextInt(0, 3) === 0) continue;
    buildCornerRoom(tiles, rng, r0, c0, q);
  }

  // Loot spots: the crossroads crossing (primary pocket, doubles as the hero
  // landmark anchor) + one loot-eligible cell inside each room (authored away
  // from the L walls and the outer-corner pillar — see buildCornerRoom).
  return {
    tiles,
    landmarkAnchor: { x: 10, y: 10 },
    lootSpots: [
      { x: 10, y: 10 },
      { x: 5, y: 2 },
      { x: 14, y: 2 },
      { x: 5, y: 14 },
      { x: 14, y: 14 },
    ],
  };
}

/**
 * Build one corner room. Inner-facing edges (toward the sector center) get an
 * INDESTRUCTIBLE_WALL run with a 2-wide rng gap; the outer-corner 2×2 pillar
 * is fixed (rooms vary through the gaps, the skip and the crate dice instead,
 * so the authored loot cells stay predictable).
 *
 * @param tiles - the grid being built
 * @param rng - the per-sector RNG stream (two gap positions per room)
 * @param r0 - the room's top row (2 or 12)
 * @param c0 - the room's left column (2 or 12)
 * @param q - quadrant index (0=NW, 1=NE, 2=SW, 3=SE)
 */
function buildCornerRoom(
  tiles: Uint8Array[],
  rng: SeededRNG,
  r0: number,
  c0: number,
  q: number,
): void {
  const far = r0 + 5;
  const farC = c0 + 5;
  // Inner-facing row run (row 7 for top rooms, row 12 for bottom rooms).
  const rowGap = rng.nextInt(0, 4);
  for (let c = c0; c <= farC; c++) {
    if (c === c0 + rowGap || c === c0 + rowGap + 1) continue;
    tiles[q < 2 ? far : r0]![c] = TileType.INDESTRUCTIBLE_WALL;
  }
  // Inner-facing column run (col 7 for west rooms, col 12 for east rooms).
  const colGap = rng.nextInt(0, 4);
  for (let r = r0; r <= far; r++) {
    if (r === r0 + colGap || r === r0 + colGap + 1) continue;
    tiles[r]![q % 2 === 0 ? farC : c0] = TileType.INDESTRUCTIBLE_WALL;
  }
  // Fixed 2×2 pillar at the room's OUTER corner (never adjacent to the loot
  // cell authored for this room).
  const pr = q < 2 ? r0 + 1 : far - 2;
  const pc = q % 2 === 0 ? c0 + 1 : farC - 2;
  for (let dr = 0; dr < 2; dr++) {
    for (let dc = 0; dc < 2; dc++) {
      tiles[pr + dr]![pc + dc] = TileType.INDESTRUCTIBLE_WALL;
    }
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

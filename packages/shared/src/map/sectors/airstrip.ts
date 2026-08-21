import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SkeletonResult } from './gridArenaSkeletons.js';

/**
 * Airstrip — the ticket-08 OPEN_ARENA skeleton (DEC-007.3: "long clear lane +
 * hangar clusters"). One 4-tile-wide clear lane spans the whole field (rows
 * 8–11 for a horizontal strip, cols 8–11 for vertical), kept totally open —
 * the longest uninterrupted dash/chase corridor of any OpenArena skeleton
 * (the type's Gameplay Purpose, GDD §5.2.2). The margins on both sides host
 * 2 hangar clusters each: 4×3 indestructible bar pairs (the roof and floor
 * of an open hangar) with seeded crate racks between the bars, mouths facing
 * the lane. Per-instance variety: strip orientation, hangar slot picks,
 * crate dice.
 *
 * Family invariants: cover never hugs the border (everything stays inside
 * rows/cols 2..17); the lane stays fully clear (carved LAST, structurally);
 * hangar bars are 4-long connected indestructible runs (never lone stubs); a
 * large central region stays open.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton (tiles + loot spots + landmark anchor)
 */
export function buildAirstrip(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  const vertical = rng.nextInt(0, 1) === 0;

  if (vertical) {
    // Vertical strip (cols 8..11 clear): hangars in the west/east margins at
    // staggered row slots.
    for (const r0 of pickTwo(rng, [3, 8, 13])) buildHangar(tiles, rng, r0, 2, true);
    for (const r0 of pickTwo(rng, [5, 10, 14])) buildHangar(tiles, rng, r0, 15, true);
  } else {
    // Horizontal strip (rows 8..11 clear): hangars in the north/south margins
    // at staggered column slots.
    for (const c0 of pickTwo(rng, [3, 8, 13])) buildHangar(tiles, rng, 2, c0, false);
    for (const c0 of pickTwo(rng, [5, 10, 14])) buildHangar(tiles, rng, 15, c0, false);
  }

  // The lane is carved LAST and unconditionally: whatever the hangar slots
  // drew, the strip (rows/cols 8..11 across the full field) ends up fully
  // EMPTY — the clear-lane read is structural, never dice-dependent.
  for (let a = 2; a <= 17; a++) {
    for (let lane = 8; lane <= 11; lane++) {
      if (vertical) tiles[a]![lane] = TileType.EMPTY;
      else tiles[lane]![a] = TileType.EMPTY;
    }
  }

  // Loot spots: three exposed grabs down the strip (the airstrip's signature
  // risk/reward — loot ON the open lane) at the quarter points; the strip
  // midpoint doubles as the hero-landmark anchor.
  return {
    tiles,
    landmarkAnchor: { x: 10, y: 10 },
    lootSpots: vertical
      ? [
          { x: 10, y: 10 },
          { x: 9, y: 5 },
          { x: 10, y: 14 },
        ]
      : [
          { x: 10, y: 10 },
          { x: 5, y: 9 },
          { x: 14, y: 10 },
        ],
  };
}

/**
 * Pick 2 distinct slots from a 3-slot candidate set (order irrelevant).
 *
 * @param rng - the per-sector RNG stream
 * @param slots - the candidate slots
 * @returns the two chosen slots
 */
function pickTwo(rng: SeededRNG, slots: readonly [number, number, number]): number[] {
  const skip = rng.nextInt(0, 2);
  return slots.filter((_, i) => i !== skip);
}

/**
 * Build one hangar cluster: two 4-long INDESTRUCTIBLE_WALL bars (the hangar's
 * roof and floor, 3 cells apart) with a seeded crate rack between them. The
 * ends stay open, so the hangar reads as an open shed facing the lane — cover
 * to fight around, never a sealed box.
 *
 * @param tiles - the grid being built
 * @param rng - the per-sector RNG stream (crate dice)
 * @param r0 - the hangar's anchor row (top bar for horizontal hangars)
 * @param c0 - the hangar's anchor column (left bar for vertical hangars)
 * @param vertical - whether the bars run vertically (vertical-strip hangars)
 */
function buildHangar(
  tiles: Uint8Array[],
  rng: SeededRNG,
  r0: number,
  c0: number,
  vertical: boolean,
): void {
  for (let d = 0; d < 4; d++) {
    if (vertical) {
      tiles[r0 + d]![c0] = TileType.INDESTRUCTIBLE_WALL;
      tiles[r0 + d]![c0 + 2] = TileType.INDESTRUCTIBLE_WALL;
    } else {
      tiles[r0]![c0 + d] = TileType.INDESTRUCTIBLE_WALL;
      tiles[r0 + 2]![c0 + d] = TileType.INDESTRUCTIBLE_WALL;
    }
  }
  // Seeded crate rack between the bars (hangar stores).
  if (rng.nextInt(0, 2) > 0) {
    if (vertical) tiles[r0 + 1]![c0 + 1] = TileType.DESTRUCTIBLE_CRATE;
    else tiles[r0 + 1]![c0 + 1] = TileType.DESTRUCTIBLE_CRATE;
  }
  if (rng.nextInt(0, 2) > 0) {
    if (vertical) tiles[r0 + 2]![c0 + 1] = TileType.DESTRUCTIBLE_CRATE;
    else tiles[r0 + 1]![c0 + 2] = TileType.DESTRUCTIBLE_CRATE;
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

import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { MazeSkeletonResult } from './mazeSkeletons.js';
import {
  LO,
  HI,
  solidGrid,
  carveRect,
  openToTarget,
  convertSeparatorsToBreakable,
  placeBreakableShortcuts,
} from './mazeCarve.js';
import { connectEmptyRegion } from './mazeConnectivity.js';

/**
 * Sewer Grid — the ticket-08 MAZE skeleton (DEC-007.3: "corridor lattice +
 * chambers"). A regular lattice of 1-wide branch corridors (one every ~4
 * tiles, each line jittered ±1 so the grid is NOT mirror-symmetric per the
 * maze family rules) crossed by one 2-wide horizontal main and one 2-wide
 * vertical main (the trunk sewers), with 3×3 open chambers sunk at three of
 * the intersections (the cisterns). Reading the lattice is orientation-easy,
 * but the jittered lines + smashable separator walls keep the ambush read.
 *
 * Maze family invariants (ADR 0027 / GDD §5.2.3): asymmetric, mixed-width
 * (2-wide mains + 1-wide branches), looped (the lattice is inherently
 * loop-rich — no dead-end pockets), seeded breakable shortcuts, one
 * connected EMPTY region (connectEmptyRegion is a guaranteed no-op safety
 * net here), open junction pockets for spawns/loot (the chambers + lattice
 * crossings).
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton (tiles + landmark anchor at the central cistern)
 */
export function buildSewerGrid(rng: SeededRNG): MazeSkeletonResult {
  const tiles = solidGrid();

  // Jittered lattice line positions (±1 per line): 4 horizontal + 4 vertical
  // branch lines, clamped to the interior band so none touches the border.
  const clamp = (v: number) => Math.max(LO + 1, Math.min(HI - 1, v));
  const hLines = [4, 8, 12, 16].map((base) => clamp(base + rng.nextInt(-1, 1)));
  const vLines = [4, 8, 12, 16].map((base) => clamp(base + rng.nextInt(-1, 1)));
  const mainH = rng.nextInt(0, 3); // which horizontal line is the 2-wide trunk
  const mainV = rng.nextInt(0, 3); // which vertical line is the 2-wide trunk

  // Carve the lattice. Horizontal lines run the full interior width; the
  // trunk line carves a second adjacent row (2-wide main).
  for (let i = 0; i < hLines.length; i++) {
    const r = hLines[i]!;
    carveRect(tiles, r, LO + 1, r, HI - 1);
    if (i === mainH)
      carveRect(tiles, Math.min(r + 1, HI - 1), LO + 1, Math.min(r + 1, HI - 1), HI - 1);
  }
  for (let i = 0; i < vLines.length; i++) {
    const c = vLines[i]!;
    carveRect(tiles, LO + 1, c, HI - 1, c);
    if (i === mainV)
      carveRect(tiles, LO + 1, Math.min(c + 1, HI - 1), HI - 1, Math.min(c + 1, HI - 1));
  }

  // Chambers (the cisterns): a guaranteed central one (the landmark anchor
  // site) + two more at rng intersections.
  const centralH = mainH < 2 ? 1 : 2; // trunk-side inner intersection row
  const centralV = mainV < 2 ? 1 : 2;
  const chambers: Array<{ r: number; c: number }> = [
    { r: hLines[centralH]!, c: vLines[centralV]! },
  ];
  const others = [
    [0, 0],
    [0, 3],
    [3, 0],
    [3, 3],
  ] as const;
  const order = rng.shuffle([...others]);
  for (let k = 0; k < 2; k++) {
    const [hi, vi] = order[k]!;
    chambers.push({ r: hLines[hi]!, c: vLines[vi]! });
  }
  let anchor = { x: chambers[0]!.c, y: chambers[0]!.r };
  for (const chamber of chambers) {
    // 3×3 open room centered on the intersection.
    carveRect(tiles, chamber.r - 1, chamber.c - 1, chamber.r + 1, chamber.c + 1);
  }

  // Lighten the solid blocks between lines a little (the sewer read stays
  // denser than the other maze skeletons; the validator's 35% open floor is
  // the hard bound), then make a share of the remaining separators breakable
  // and seed the smashable shortcuts (flanking through walls).
  openToTarget(tiles, rng, 0.58);
  convertSeparatorsToBreakable(tiles, rng, 0.35);
  connectEmptyRegion(tiles);
  placeBreakableShortcuts(tiles, rng, rng.nextInt(5, 7));

  // The anchor stays inside the central cistern after every pass: re-snap to
  // the nearest EMPTY tile of the chamber (deterministic ring search).
  if (tiles[anchor.y]![anchor.x] !== TileType.EMPTY) {
    anchor = nearestEmpty(tiles, anchor);
  }
  return { tiles, landmarkAnchor: anchor };
}

/**
 * Deterministic nearest-EMPTY search (expanding Chebyshev rings, row-major).
 *
 * @param tiles - the carved grid
 * @param from - the start cell
 * @returns the nearest EMPTY interior cell
 */
function nearestEmpty(
  tiles: Uint8Array[],
  from: { x: number; y: number },
): { x: number; y: number } {
  for (let ring = 1; ring < 20; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const r = from.y + dy;
        const c = from.x + dx;
        if (r < LO || r > HI || c < LO || c > HI) continue;
        if (tiles[r]![c] === TileType.EMPTY) return { x: c, y: r };
      }
    }
  }
  return from;
}

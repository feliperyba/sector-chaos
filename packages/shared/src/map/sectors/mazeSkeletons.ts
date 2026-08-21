import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { MazeSubVariant } from './subVariants.js';
import { cacheFrame, radialSpokes } from '../patterns/CoverPatterns.js';
import {
  LO,
  HI,
  solidGrid,
  carveRect,
  carveCorridor,
  carveDfsLattice,
  carveLoops,
  thickenArteries,
  openToTarget,
  convertSeparatorsToBreakable,
  placeBreakableShortcuts,
} from './mazeCarve.js';
import { buildSewerGrid } from './sewerGrid.js';
import { connectEmptyRegion } from './mazeConnectivity.js';

/**
 * Result of a Maze skeleton builder (map-redesign ticket 04): the tile grid
 * plus the skeleton's hero-landmark anchor site (the open hub / chamber
 * centre / centre pocket — the signature structure the landmark sits ON).
 * Pure authored coordinates: building it consumes NO RNG, so the tile streams
 * stay byte-identical. The landmark pass (`landmarks.ts`) owns final placement
 * + validation.
 */
export interface MazeSkeletonResult {
  tiles: Uint8Array[];
  landmarkAnchor: { x: number; y: number };
}

/**
 * Maze skeleton builders (T6). Each builder lays a 20×20 tile grid for one Maze
 * sub-variant under the new family rules (ADR 0027, GDD §5.2.3): ASYMMETRIC (no
 * mirror), MIXED-WIDTH (2-wide arteries + 1-wide branches), LOOPED (few
 * dead-ends), with seeded BREAKABLE `wall_secret` (DESTRUCTIBLE_WALL) shortcuts
 * that open meaningful alternate routes when smashed. This replaces the old
 * 4-fold mirrored, all-width-1, all-indestructible carve, which was repetitive,
 * unfair for the 96px melee hitbox, and the worst case for 63-bot LOS /
 * pathfinding (ADR 0024). Every builder is a PURE function of its
 * {@link SeededRNG} so two instances differ and the same seed reproduces them
 * byte-identically. The shared carve primitives live in {@link file mazeCarve.ts}.
 *
 * Shared invariants:
 * - The outer ring (row/col 0 and 19) stays INDESTRUCTIBLE_WALL (sectors are
 *   joined by the corridor system, unchanged).
 * - The interior is carved out of solid INDESTRUCTIBLE_WALL: corridors are
 *   EMPTY, the surviving structure is INDESTRUCTIBLE_WALL, and a seeded subset of
 *   the structure becomes DESTRUCTIBLE_WALL shortcuts.
 * - The EMPTY region is forced into ONE connected component (DESTRUCTIBLE walls
 *   block the EMPTY flood, so loops are EMPTY corridors, not just breakable) and
 *   each builder leaves open junction pockets so spawns and loot fit (T1 gates).
 * - `openToTarget` is the PERF FLOOR: every variant ends up with fewer
 *   indestructible walls and fewer 1-wide corridors than the old mirrored maze.
 */

/**
 * Loose Labyrinth — asymmetric weave of 2-wide arteries + 1-wide branches, heavy
 * loops, scattered breakable shortcuts. A randomized DFS from a non-central start
 * gives the 1-wide branches; arteries are thickened in; a heavy loop pass keeps
 * dead-ends rare; a small open hub guarantees loot/spawn pockets.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid + hub-centre landmark anchor
 */
export function buildLooseLabyrinth(rng: SeededRNG): MazeSkeletonResult {
  const tiles = solidGrid();
  // Non-central, jittered DFS start → no mirror symmetry.
  const startR = rng.nextInt(0, 1) === 0 ? 3 : HI - 2;
  const startC = rng.nextInt(0, 1) === 0 ? 3 : HI - 2;
  carveDfsLattice(tiles, rng, startR | 1, startC | 1);
  // A jittered open hub (3×3) for guaranteed loot/spawn pockets, placed
  // off-center so the layout stays asymmetric.
  const hubR = rng.nextInt(5, 11);
  const hubC = rng.nextInt(5, 11);
  carveRect(tiles, hubR, hubC, hubR + 2, hubC + 2);
  thickenArteries(tiles, rng, 0.3);
  // Heavy loop pass → few dead-ends; openToTarget guarantees the maze ends up
  // LIGHTER than the old mirrored one (≥66% EMPTY vs the old ~70%, but with
  // 2-wide arteries so far fewer 1-wide runs).
  carveLoops(tiles, rng, 0.4);
  openToTarget(tiles, rng, 0.66);
  connectEmptyRegion(tiles);
  placeBreakableShortcuts(tiles, rng, rng.nextInt(5, 8));
  return { tiles, landmarkAnchor: { x: hubC + 1, y: hubR + 1 } };
}

/**
 * Chambers & Halls — multi-doorway chambers (ambush pockets) linked by 2-wide
 * halls; breakable shortcuts between adjacent chambers. Chambers are jittered
 * rectangles (asymmetric); halls are 2-wide arteries chaining their centres into
 * a connected loop; the inter-chamber walls are thinned and partly made breakable.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid + first-chamber-centre landmark anchor
 */
export function buildChambersAndHalls(rng: SeededRNG): MazeSkeletonResult {
  const tiles = solidGrid();
  const count = rng.nextInt(4, 5);
  const centres: [number, number][] = [];
  // Jittered chamber anchors spread across the interior (asymmetric placement).
  const anchors: ReadonlyArray<readonly [number, number]> = [
    [4, 4],
    [4, 12],
    [12, 4],
    [12, 12],
    [8, 8],
  ];
  const order = rng.shuffle([...anchors]);
  for (let i = 0; i < count; i++) {
    const [baseR, baseC] = order[i]!;
    const r = baseR + rng.nextInt(-1, 1);
    const c = baseC + rng.nextInt(-1, 1);
    // Generous 3–4 cell chambers: big ambush pockets that read clearly and host
    // loot (cells not adjacent to indestructible walls).
    const h = rng.nextInt(3, 4);
    const w = rng.nextInt(3, 4);
    carveRect(tiles, r, c, r + h, c + w);
    centres.push([r + (h >> 1), c + (w >> 1)]);
  }
  // Chain chamber centres with 2-wide halls (spanning route), plus one extra
  // hall for a loop so the hall network is not a pure tree.
  for (let i = 1; i < centres.length; i++) {
    carveCorridor(tiles, centres[i - 1]![0], centres[i - 1]![1], centres[i]![0], centres[i]![1], 2);
  }
  if (centres.length >= 3) {
    const first = centres[0]!;
    const last = centres[centres.length - 1]!;
    carveCorridor(tiles, first[0], first[1], last[0], last[1], 2);
  }
  // Open the dense wall field between chambers so the sector is LIGHTER than the
  // old mirrored maze; the chambers + 2-wide halls keep 1-wide runs near zero.
  carveLoops(tiles, rng, 0.3);
  openToTarget(tiles, rng, 0.68);
  // Thin the remaining inter-chamber walls to breakable so the indestructible
  // count drops below the old mirrored maze (breakable walls are not perf-capped)
  // and chambers gain smashable approaches.
  convertSeparatorsToBreakable(tiles, rng, 0.35);
  // Cache frames at the chamber centres (2 open sides) for smashable
  // loot-pocket framing. Placed before connectEmptyRegion so any pocket it
  // seals is re-bridged.
  for (const [r, c] of centres) {
    cacheFrame(tiles, rng, {
      centerR: r,
      centerC: c,
      openSides: 2,
      tileType: TileType.DESTRUCTIBLE_WALL,
    });
  }
  connectEmptyRegion(tiles);
  // Breakable shortcuts between adjacent chambers (the flank-through-the-wall
  // read). The fallback in placeBreakableShortcuts guarantees placement even when
  // the halls leave no perfect one-tile gate.
  placeBreakableShortcuts(tiles, rng, rng.nextInt(4, 6));
  const anchorCentre = centres[0] ?? [HI >> 1, HI >> 1];
  return { tiles, landmarkAnchor: { x: anchorCentre[1], y: anchorCentre[0] } };
}

/**
 * Breakable Warren — a denser weave where breakable shortcuts are the PRIMARY
 * flanking mechanic. A connected EMPTY backbone (DFS + a hub) keeps spawns/loot
 * feasible; a LARGE share of the surviving separator walls become
 * DESTRUCTIBLE_WALL, so flanking is mostly via smashing. Indestructible density
 * stays below the old mirrored maze because the gates are breakable, not solid.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid + hub-centre landmark anchor
 */
export function buildBreakableWarren(rng: SeededRNG): MazeSkeletonResult {
  const tiles = solidGrid();
  const startR = rng.nextInt(0, 1) === 0 ? 3 : HI - 2;
  const startC = rng.nextInt(0, 1) === 0 ? 3 : HI - 2;
  carveDfsLattice(tiles, rng, startR | 1, startC | 1);
  // A 3×3 open hub guarantees the loot/spawn pocket (loot-eligible cells).
  const hubR = rng.nextInt(6, 9);
  const hubC = rng.nextInt(6, 9);
  carveRect(tiles, hubR, hubC, hubR + 2, hubC + 2);
  thickenArteries(tiles, rng, 0.4);
  // A modest EMPTY loop pass keeps the weave denser than Loose Labyrinth while
  // still ending LIGHTER than the old mirrored maze; the rest of the flanking
  // comes from breakable gates, not EMPTY corridors.
  carveLoops(tiles, rng, 0.18);
  openToTarget(tiles, rng, 0.63);
  connectEmptyRegion(tiles);
  // The signature: bulk-convert most remaining separator walls to breakable so
  // smashing is the PRIMARY way to flank — this also drops the indestructible
  // count below the old mirrored maze (breakable walls are not perf-capped).
  convertSeparatorsToBreakable(tiles, rng, 0.55);
  placeBreakableShortcuts(tiles, rng, rng.nextInt(4, 6));
  return { tiles, landmarkAnchor: { x: hubC + 1, y: hubR + 1 } };
}

/**
 * Concentric Spiral — ring corridors + radial cross-cuts forming rotating chase
 * loops. 2-wide square EMPTY rings at jittered insets (one segment per ring is
 * dropped so the rings are NOT mirror-symmetric); radial spokes join the rings
 * into chase loops; ring separators are thinned and partly made breakable.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid + centre-pocket landmark anchor
 */
export function buildConcentricSpiral(rng: SeededRNG): MazeSkeletonResult {
  const tiles = solidGrid();
  // Jitter the ring frame off the exact centre so the rings are NOT mirror
  // symmetric: the inset on each side differs, and one ring segment per ring is
  // dropped to break the four-fold read.
  const padT = rng.nextInt(1, 2);
  const padL = rng.nextInt(1, 2);
  const insets = [0, 3, 6];
  for (const k of insets) {
    const top = LO + padT + k;
    const left = LO + padL + k;
    const bottom = HI - 1 - k;
    const right = HI - 1 - k;
    if (bottom - top < 3 || right - left < 3) continue;
    // 2-wide ring corridors (thick arteries → fair for melee, cheap for LOS).
    const drop = rng.nextInt(0, 3); // which side to leave open (asymmetry)
    if (drop !== 0) carveRect(tiles, top, left, top + 1, right); // top edge
    if (drop !== 1) carveRect(tiles, bottom - 1, left, bottom, right); // bottom
    if (drop !== 2) carveRect(tiles, top, left, bottom, left + 1); // left edge
    if (drop !== 3) carveRect(tiles, top, right - 1, bottom, right); // right edge
  }
  // Open centre pocket (loot/spawn) — jittered off the exact middle.
  const cr = 9 + rng.nextInt(-1, 1);
  const cc = 9 + rng.nextInt(-1, 1);
  carveRect(tiles, cr - 1, cc - 1, cr + 1, cc + 1);
  // Radial cross-cuts: spokes joining the rings at jittered offsets so openings
  // on each side do not line up (breaks mirror symmetry) and rings rotate into
  // chase loops.
  const spokeCols = [3 + rng.nextInt(0, 2), 11 + rng.nextInt(0, 2)];
  const spokeRows = [3 + rng.nextInt(0, 2), 11 + rng.nextInt(0, 2)];
  for (const c of spokeCols) carveCorridor(tiles, LO, c, cr, c, 1);
  for (const r of spokeRows) carveCorridor(tiles, r, LO, r, cc, 1);
  // Trim the 1-wide separators between rings so the sector stays LIGHTER than the
  // old mirrored maze and dead-ends are rare.
  carveLoops(tiles, rng, 0.25);
  openToTarget(tiles, rng, 0.68);
  // Make a share of the ring separators breakable so indestructible density
  // drops below the old mirrored maze and rings can be cut across by smashing.
  convertSeparatorsToBreakable(tiles, rng, 0.35);
  // Radial spokes from the centre so the chase loops have smashable duck-in
  // cover converging on the middle (deterministic authored angles + step —
  // ticket 28 keeps them). Placed before connectEmptyRegion so any ring it
  // seals is re-bridged.
  radialSpokes(tiles, rng, {
    centerR: cr,
    centerC: cc,
    angles: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
    step: 3,
    maxLength: 7,
    tileType: TileType.DESTRUCTIBLE_WALL,
  });
  connectEmptyRegion(tiles);
  // Ring-to-ring breakable shortcuts (smash to cut across rings mid-chase).
  placeBreakableShortcuts(tiles, rng, rng.nextInt(6, 9));
  return { tiles, landmarkAnchor: { x: cc, y: cr } };
}

/** Dispatch table mapping each Maze sub-variant id to its builder. */
export const MAZE_SKELETON_BUILDERS: Record<
  MazeSubVariant,
  (rng: SeededRNG) => MazeSkeletonResult
> = {
  'Loose Labyrinth': buildLooseLabyrinth,
  'Chambers & Halls': buildChambersAndHalls,
  'Breakable Warren': buildBreakableWarren,
  'Concentric Spiral': buildConcentricSpiral,
  'Sewer Grid': buildSewerGrid,
};

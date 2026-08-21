import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { GridArenaSubVariant } from './subVariants.js';
import { buildPlazaCrossroads } from './plazaCrossroads.js';

/**
 * GridArena skeleton builders (T4). Each builder lays a 20×20 tile grid for one
 * GridArena sub-variant: a PERSISTENT INDESTRUCTIBLE_WALL pillar skeleton plus
 * authored breakable DESTRUCTIBLE_WALL / DESTRUCTIBLE_CRATE cover. Every builder
 * is a pure function of its {@link SeededRNG} so two instances differ and the
 * same seed reproduces them exactly. EntityPlacer later tops up crate density
 * and places loot in the open pockets each skeleton intentionally leaves clear
 * of indestructible walls (see CONTEXT.md → Skeleton / Sub-variant).
 *
 * Map-polish ticket 28: the per-cell RNG scatter fill passes (latticeFill /
 * edgeTrace / staggeredRows / diagonalPairs) were REMOVED — interiors are
 * composed of authored parametric structure only, with the deterministic
 * PrefabPlacementPass carrying the open-space cover via authored compositions.
 *
 * Shared invariants (close-quarters melee brawl — GDD §5.2.1, ADR 0027):
 * - The outer ring (row/col 0 and 19) is INDESTRUCTIBLE_WALL.
 * - The indestructible skeleton survives the whole match — the arena can never
 *   be flattened to an open box.
 * - Each skeleton leaves enough EMPTY pockets NOT cardinally adjacent to an
 *   indestructible wall for spawns, chests, barrels and loot (T1 gates).
 */

/** The 20×20 sector side length these skeletons assume. */
const SIZE = 20;
/** First interior index (just inside the border ring). */
const LO = 1;
/** Last interior index (just inside the border ring). */
const HI = SIZE - 2;

/**
 * Result of a skeleton builder: the tile grid plus structural loot-pocket
 * hints. `lootSpots` are `{x: col, y: row}` grid coordinates within the sector
 * where EntityPlacer should preferentially place high-value loot (chests,
 * weapons). Each spot is a cell the builder knows is EMPTY and structurally
 * significant (central plaza, inter-block gap, inner sanctum).
 *
 * `landmarkAnchor` (map-redesign ticket 04 / DEC-002) is the skeleton's
 * hero-landmark anchor site — the signature gameplay structure the sector's
 * landmark sits ON (central plaza / inner sanctum). Pure authored coordinates:
 * building it consumes NO RNG, so the tile streams stay byte-identical. The
 * landmark pass (`landmarks.ts`) owns final placement + validation.
 */
export interface SkeletonResult {
  tiles: Uint8Array[];
  lootSpots: { x: number; y: number }[];
  /** Hero-landmark anchor site (tile coords `{x: col, y: row}`). */
  landmarkAnchor: { x: number; y: number };
}

/**
 * Allocate a 20×20 grid filled with EMPTY and frame it with the indestructible
 * border ring (rows/cols 0 and 19).
 *
 * @returns a freshly bordered 20×20 tile grid
 */
function blankBordered(): Uint8Array[] {
  const tiles: Uint8Array[] = [];
  for (let row = 0; row < SIZE; row++) {
    tiles[row] = new Uint8Array(SIZE);
    tiles[row]!.fill(TileType.EMPTY);
  }
  for (let i = 0; i < SIZE; i++) {
    tiles[0]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[HI + 1]![i] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![0] = TileType.INDESTRUCTIBLE_WALL;
    tiles[i]![HI + 1] = TileType.INDESTRUCTIBLE_WALL;
  }
  return tiles;
}

/** Whether a coordinate is a paintable interior cell (inside the border ring). */
function isInterior(r: number, c: number): boolean {
  return r >= LO && r <= HI && c >= LO && c <= HI;
}

/**
 * Set an interior cell, leaving the border ring untouched.
 *
 * @param tiles - the grid being built
 * @param r - the target row
 * @param c - the target column
 * @param t - the tile type to write
 */
function put(tiles: Uint8Array[], r: number, c: number, t: TileType): void {
  if (isInterior(r, c)) tiles[r]![c] = t;
}

/** Cardinal offsets used when skirting a pillar. */
const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

/**
 * Lay an indestructible pillar plus a breakable DESTRUCTIBLE_WALL skirt on one
 * open side. The skirt is a wall (not a crate) on purpose: the lone-wall gate
 * (T1) counts only INDESTRUCTIBLE_WALL / DESTRUCTIBLE_WALL neighbours, so a wall
 * skirt keeps the pillar from counting as an isolated stub while still reading
 * as smashable cover.
 *
 * @param tiles - the grid being built
 * @param r - the pillar row
 * @param c - the pillar column
 * @param rng - the per-sector RNG stream (chooses the skirt direction)
 */
function pillarWithSkirt(tiles: Uint8Array[], r: number, c: number, rng: SeededRNG): void {
  put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
  const order = rng.shuffle([...CARDINALS]);
  for (const [dr, dc] of order) {
    if (isInterior(r + dr, c + dc) && tiles[r + dr]![c + dc] === TileType.EMPTY) {
      put(tiles, r + dr, c + dc, TileType.DESTRUCTIBLE_WALL);
      return;
    }
  }
}

/**
 * Pick a breakable cover tile, weighted toward crates (the crate-yard read).
 *
 * @param rng - the per-sector RNG stream
 * @returns DESTRUCTIBLE_CRATE most of the time, occasionally DESTRUCTIBLE_WALL
 */
function breakable(rng: SeededRNG): TileType {
  return rng.nextInt(0, 3) === 0 ? TileType.DESTRUCTIBLE_WALL : TileType.DESTRUCTIBLE_CRATE;
}

/**
 * Classic Lattice — a regular grid of 2×2 INDESTRUCTIBLE_WALL blocks at a
 * step-4 lattice, with a clear central plaza for spawns/loot. Each block is 4
 * connected wall tiles, so the autotiler renders proper wall_corner pieces on
 * all four tiles (solid square-pillar read). 2-tile gaps between blocks form
 * consistent melee lanes. Per-instance variety comes from plaza jitter and a
 * ~15% block-skip rate (different seeds omit different blocks).
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton (tiles + loot spots)
 */
export function buildClassicLattice(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();

  // Central plaza: a guaranteed open pocket (jittered per instance) for
  // spawns/loot. Clears any 2×2 block that falls inside.
  const jitterR = rng.nextInt(-1, 1);
  const jitterC = rng.nextInt(-1, 1);
  const plazaLo = 8;
  const plazaHi = 11;
  const inPlaza = (r: number, c: number): boolean =>
    r >= plazaLo + jitterR &&
    r <= plazaHi + jitterR &&
    c >= plazaLo + jitterC &&
    c <= plazaHi + jitterC;

  // 2×2 indestructible blocks at a step-4 lattice: origins {2, 6, 10, 14}.
  // All blocks are INDESTRUCTIBLE_WALL (persistent skeleton, GDD §5.2.1);
  // breakable cover comes from the prefab pass + EntityPlacer (ticket 28).
  const origins = [2, 6, 10, 14];
  for (const br of origins) {
    for (const bc of origins) {
      if (inPlaza(br, bc) || inPlaza(br + 1, bc) || inPlaza(br, bc + 1) || inPlaza(br + 1, bc + 1))
        continue;
      if (rng.nextInt(0, 6) === 0) continue; // ~15% skip: per-instance variety
      put(tiles, br, bc, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, br, bc + 1, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, br + 1, bc, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, br + 1, bc + 1, TileType.INDESTRUCTIBLE_WALL);
    }
  }

  // Loot spots: plaza center (primary pocket) + cardinal gap positions between
  // blocks (secondary). These are structurally EMPTY cells in the 2-tile gaps.
  const pcR = Math.floor((plazaLo + plazaHi) / 2) + jitterR;
  const pcC = Math.floor((plazaLo + plazaHi) / 2) + jitterC;
  return {
    tiles,
    // Hero-landmark anchor: the central plaza (the sector's signature open
    // gameplay pocket).
    landmarkAnchor: { x: pcC, y: pcR },
    lootSpots: [
      { x: pcC, y: pcR },
      { x: 4, y: pcR },
      { x: 13, y: pcR },
      { x: pcC, y: 4 },
      { x: pcC, y: 13 },
    ],
  };
}

/**
 * Ring Fortress — concentric indestructible rings with staggered gaps and an
 * inner sanctum cell (a chokepoint/chest pocket). Lanes lead inward through the
 * gaps; the rings are persistent so the fortress never collapses.
 *
 * Map-redesign ticket 06 (DEC-004.3): the loot spots are DERIVED from the
 * inner ring's actual gap-phase roll (pure arithmetic on the phase the ring
 * loop already drew — zero extra RNG) and explicitly cleared to EMPTY, so
 * loot is never sealed behind a ring wall segment and the sanctum fight is
 * always worth entering (user story 24). The sanctum center doubles as the
 * hero-landmark anchor (DEC-004.3) — the clear makes the authored anchor a
 * valid EMPTY site.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid
 */
export function buildRingFortress(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  // Two concentric square rings at insets 4 and 7, each with staggered gaps.
  let innerPhase = 0;
  for (const inset of [4, 7]) {
    const lo = inset;
    const hi = SIZE - 1 - inset;
    // Per-ring gap phase so the two rings do not align their openings.
    const phase = rng.nextInt(0, 3);
    if (inset === 7) innerPhase = phase;
    for (let c = lo; c <= hi; c++) {
      if ((c + phase) % 4 === 0) continue; // staggered gap
      put(tiles, lo, c, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, hi, c, TileType.INDESTRUCTIBLE_WALL);
    }
    for (let r = lo + 1; r < hi; r++) {
      if ((r + phase + 2) % 4 === 0) continue; // staggered gap, offset axis
      put(tiles, r, lo, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, r, hi, TileType.INDESTRUCTIBLE_WALL);
    }
    // Breakable cover clustered just outside each ring so the rings are not bare
    // and approaches have smashable cover. Clusters (2 adjacent tiles) read as
    // deliberate cover, not scattered single dots. The wider step compensates
    // for the doubled cluster size so density stays comparable.
    for (let c = lo; c <= hi; c += rng.nextInt(3, 4)) {
      if (lo - 1 >= LO) breakableCluster(tiles, lo - 1, c, rng);
      if (hi + 1 <= HI) breakableCluster(tiles, hi + 1, c, rng);
    }
  }
  // Inner sanctum: a small indestructible nub framing the center pocket, kept
  // off the exact center so the middle stays an open chest/chokepoint cell. The
  // skirt de-lones the nub and adds a smashable wall on its approach.
  pillarWithSkirt(tiles, 9, 9, rng);
  breakableCluster(tiles, 10, 10, rng);

  // ── Gap-derived loot spots (ticket 06 / DEC-004.3) ─────────────────────────
  // Re-derive the inner ring's ACTUAL openings from the phase roll, then place
  // each spot just inside a real gap so it can never sit on (or behind) a ring
  // wall segment. Top/bottom walls share gap columns; left/right share rows.
  const gapCols = [7, 8, 9, 10, 11, 12].filter((c) => (c + innerPhase) % 4 === 0);
  const gapRows = [8, 9, 10, 11].filter((r) => (r + innerPhase + 2) % 4 === 0);
  // Interior gap columns only (8–11): a corner-adjacent gap column (7 or 12)
  // opens onto the side-wall lines, not into the sanctum.
  const innerGapCols = gapCols.filter((c) => c >= 8 && c <= 11);
  const northSpot = { x: innerGapCols[0]!, y: 8 };
  const eastSpot = { x: 11, y: gapRows[gapRows.length - 1]! };
  const sanctum = { x: 10, y: 10 };
  // Explicit clear AFTER every cover pass: the spots are guaranteed-EMPTY
  // cells whatever the cover draws (pillar skirts, clusters, edge trace).
  put(tiles, sanctum.y, sanctum.x, TileType.EMPTY);
  put(tiles, northSpot.y, northSpot.x, TileType.EMPTY);
  put(tiles, eastSpot.y, eastSpot.x, TileType.EMPTY);
  return {
    tiles,
    // Hero-landmark anchor: the inner sanctum pocket (the chokepoint/chest
    // cell at the fortress heart) — DEC-004.3's "sanctum becomes that
    // skeleton's hero-landmark anchor site". The explicit clear above keeps
    // the authored anchor a valid EMPTY site in the final grid.
    landmarkAnchor: sanctum,
    lootSpots: [sanctum, northSpot, eastSpot],
  };
}

/**
 * Broken Grid — jittered 2×2 INDESTRUCTIBLE_WALL blocks at a coarse step-4
 * lattice, deliberately WITHOUT mirror symmetry. Each block's origin is offset
 * ±1 from the nominal lattice, and ~20% of blocks become L-shapes (3 tiles,
 * missing one corner) for additional structural variety. The result is an
 * asymmetric cluster of solid pillars with irregular lanes between them.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton (tiles + loot spots)
 */
export function buildBrokenGrid(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  const lootSpots: { x: number; y: number }[] = [];
  // Coarse lattice origins, each jittered ±1 so lanes stagger and no axis
  // mirrors.
  for (let baseR = 3; baseR <= HI - 2; baseR += 4) {
    for (let baseC = 3; baseC <= HI - 2; baseC += 4) {
      const br = clampInterior(baseR + rng.nextInt(-1, 1));
      const bc = clampInterior(baseC + rng.nextInt(-1, 1));
      // Skip if the block area already has tiles (collision from jitter).
      if (tiles[br]![bc] !== TileType.EMPTY) continue;
      if (rng.nextInt(0, 5) === 0) continue; // ~17% skip for variety

      // ~20% of blocks become L-shapes (3 tiles, missing one corner) for
      // asymmetric cover; the rest are full 2×2 blocks.
      const missingCorner = rng.nextInt(0, 4); // 0-3 = skip that corner; 4 = full block
      const corners: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ];
      for (let i = 0; i < corners.length; i++) {
        if (i === missingCorner) continue;
        const [dr, dc] = corners[i]!;
        put(tiles, br + dr, bc + dc, TileType.INDESTRUCTIBLE_WALL);
      }

      // Record a loot spot in the gap diagonally adjacent to the block.
      const gapR = br + (br <= SIZE / 2 ? 3 : -1);
      const gapC = bc + (bc <= SIZE / 2 ? 3 : -1);
      if (isInterior(gapR, gapC)) lootSpots.push({ x: gapC, y: gapR });
    }
  }

  // Ensure at least the center is a loot spot.
  lootSpots.push({ x: 10, y: 10 });
  return {
    tiles,
    // Hero-landmark anchor: the sector center pocket among the broken blocks.
    landmarkAnchor: { x: 10, y: 10 },
    lootSpots,
  };
}

/**
 * Lane Corridors — 2–3 parallel indestructible cover walls forming lanes, with
 * breakable cross-cuts that let players swap lanes by smashing through. Lane
 * orientation (rows vs cols) is chosen from the RNG.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid
 */
export function buildLaneCorridors(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  const vertical = rng.nextInt(0, 1) === 0;
  // 2–3 lane dividers, picked per instance from a candidate set, so the lane
  // count and positions vary between instances.
  const candidates = [4, 6, 9, 11, 14, 16];
  const laneCount = rng.nextInt(2, 3);
  const lanes = rng
    .shuffle([...candidates])
    .slice(0, laneCount)
    .sort((a, b) => a - b);

  for (const lane of lanes) {
    // Two RNG-chosen open doorways per divider (so lanes are crossable), plus a
    // couple of RNG-placed breakable cross-cuts ("smash to flank").
    const doorA = rng.nextInt(LO + 2, HI - 3);
    const doorB = rng.nextInt(LO + 2, HI - 3);
    const cutA = rng.nextInt(LO + 1, HI - 1);
    const cutB = rng.nextInt(LO + 1, HI - 1);
    for (let i = LO; i <= HI; i++) {
      const r = vertical ? i : lane;
      const c = vertical ? lane : i;
      if (i === doorA || i === doorA + 1 || i === doorB || i === doorB + 1) {
        continue; // open doorway
      }
      if (i === cutA || i === cutB) {
        put(tiles, r, c, breakable(rng)); // breakable cross-cut
        continue;
      }
      put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
    }
  }

  // Loot spots: midpoints between lane dividers (natural chokepoints/pockets).
  const lootSpots: { x: number; y: number }[] = [];
  for (let i = 0; i < lanes.length - 1; i++) {
    const mid = Math.floor((lanes[i]! + lanes[i + 1]!) / 2);
    lootSpots.push(
      vertical ? { x: mid, y: Math.floor(SIZE / 2) } : { x: Math.floor(SIZE / 2), y: mid },
    );
  }
  lootSpots.push({ x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) });
  return {
    tiles,
    // Hero-landmark anchor: the central lane crossing (the sector's signature
    // chokepoint between lane dividers).
    landmarkAnchor: { x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) },
    lootSpots,
  };
}

/** Clamp a coordinate into the interior range [LO, HI]. */
function clampInterior(v: number): number {
  return Math.max(LO, Math.min(HI, v));
}

/**
 * Place a breakable cover tile only if the target is an interior EMPTY cell.
 *
 * @param tiles - the grid being built
 * @param r - the target row
 * @param c - the target column
 * @param rng - the per-sector RNG stream
 */
function maybeBreakable(tiles: Uint8Array[], r: number, c: number, rng: SeededRNG): void {
  if (isInterior(r, c) && tiles[r]![c] === TileType.EMPTY) {
    put(tiles, r, c, breakable(rng));
  }
}

/**
 * Place a small 2-tile breakable cover cluster starting at (r, c), extending one
 * tile along a random cardinal axis. Both tiles gain a cardinal wall neighbour
 * from their partner so the autotiler renders connected bar/corner art instead
 * of scattered single-tile objects (crate/tree reads). Falls back to a single
 * tile when the extension cell is occupied or out of bounds.
 *
 * @param tiles - the grid being built
 * @param r - the anchor row
 * @param c - the anchor column
 * @param rng - the per-sector RNG stream
 */
function breakableCluster(tiles: Uint8Array[], r: number, c: number, rng: SeededRNG): void {
  if (!isInterior(r, c) || tiles[r]![c] !== TileType.EMPTY) return;
  put(tiles, r, c, breakable(rng));
  const [dr, dc] = CARDINALS[rng.nextInt(0, CARDINALS.length - 1)]!;
  maybeBreakable(tiles, r + dr, c + dc, rng);
}

/** Dispatch table mapping each GridArena sub-variant id to its builder. */
export const GRID_ARENA_SKELETON_BUILDERS: Record<
  GridArenaSubVariant,
  (rng: SeededRNG) => SkeletonResult
> = {
  'Classic Lattice': buildClassicLattice,
  'Ring Fortress': buildRingFortress,
  'Broken Grid': buildBrokenGrid,
  'Lane Corridors': buildLaneCorridors,
  'Plaza Crossroads': buildPlazaCrossroads,
};

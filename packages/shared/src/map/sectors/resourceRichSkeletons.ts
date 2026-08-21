import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { ResourceRichSubVariant } from './subVariants.js';
import { buildBankRow } from './bankRow.js';

/**
 * ResourceRich skeleton builders (T7). Each builder lays a 20×20 tile grid for
 * one ResourceRich sub-variant and returns the intended LOOT CACHE cells so the
 * loot (chests + guaranteed weapon spawns) lands INSIDE the cover structure each
 * skeleton frames, not scattered (CONTEXT.md → Skeleton; ADR 0027, GDD §5.2.4).
 *
 * Map-polish ticket 28: the per-cell RNG scatter fill passes (edgeTrace /
 * diagonalPairs / staggeredRows) were REMOVED — caches are framed by the
 * authored vault rings / pockets / shelves / bank frames only, with the
 * deterministic PrefabPlacementPass composing the space between them.
 *
 * ResourceRich's Gameplay Purpose is the loot-rush hot zone: high reward, exposed
 * and contested, with COVER THAT FRAMES LOOT. This replaces the old artifact of
 * 5–8 lone INDESTRUCTIBLE "stub" walls in an open box (the isolated-stub T1
 * flagged). Every builder is a PURE function of its {@link SeededRNG} so two
 * instances differ and the same seed reproduces them byte-identically.
 *
 * FRAMING IS ALWAYS BREAKABLE. EntityPlacer excludes EMPTY tiles cardinally
 * adjacent to an INDESTRUCTIBLE_WALL, so framing a cache with indestructible
 * walls would make the cache's own cells ineligible for chests/weapons (the
 * loot-framing would silently fail). Cover here is DESTRUCTIBLE_WALL /
 * DESTRUCTIBLE_CRATE: the cache interior stays loot-eligible, and players crack
 * the cover open to reach it. We never place lone indestructible stubs.
 *
 * CACHE CELLS STAY CONNECTED. DESTRUCTIBLE walls block the EMPTY-connectivity
 * flood (only EMPTY counts as reachable), so a cache fully sealed by a breakable
 * ring would be a disconnected EMPTY pocket. Treasure Vault leaves an EMPTY
 * entrance gap in its ring; the other skeletons use open pockets/aisles that are
 * never fully enclosed. Cache cells are reported in tile coords as
 * `{ x: col, y: row }`, matching {@link SectorData.lootSpots}; they are always
 * interior, EMPTY, ≥2 tiles off the border ring (so never cardinally adjacent to
 * an indestructible wall), and never sealed off.
 */

/** The 20×20 sector side length these skeletons assume. */
const SIZE = 20;
/** Last interior index (just inside the border ring), used to frame the ring. */
const HI = SIZE - 2;
/**
 * First cache index — cache cells must stay ≥2 tiles off the 0 edge so they are
 * never cardinally adjacent to the indestructible border ring (EntityPlacer would
 * otherwise reject them). Mirrored by {@link CACHE_HI} on the far edge.
 */
const CACHE_LO = 2;
/** Last cache index — cache cells must stay ≥2 tiles off the 19 edge. */
const CACHE_HI = SIZE - 3;

/** A loot cache cell in tile coords, matching {@link SectorData.lootSpots}. */
export interface CacheCell {
  /** Column (tile x). */
  x: number;
  /** Row (tile y). */
  y: number;
}

/** A built ResourceRich skeleton: its tile grid plus its intended cache cells. */
export interface ResourceRichSkeleton {
  /** The 20×20 tile grid. */
  tiles: Uint8Array[];
  /** Cache cells (tile coords) loot should prefer. Always interior, EMPTY. */
  lootSpots: CacheCell[];
  /**
   * Hero-landmark anchor site (map-redesign ticket 04 / DEC-002): the
   * signature loot structure (vault-chamber centre / first marked cache /
   * picking-aisle midpoint). Pure authored coordinates — NO RNG consumed.
   */
  landmarkAnchor: CacheCell;
}

/** Cardinal offsets used when framing a cache with breakable cover. */
const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

/**
 * Allocate a 20×20 grid filled with EMPTY and frame it with the indestructible
 * border ring (rows/cols 0 and 19). The border is unchanged by ResourceRich:
 * sectors are joined by the corridor system as for every other type.
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

/** Whether a coordinate is a valid cache cell (≥2 tiles off the border ring). */
function isCacheCell(r: number, c: number): boolean {
  return r >= CACHE_LO && r <= CACHE_HI && c >= CACHE_LO && c <= CACHE_HI;
}

/**
 * Pick a breakable cover tile. Biased toward DESTRUCTIBLE_WALL so framing counts
 * toward the lone-wall gate (which counts walls, not crates) and reliably frames
 * caches as smashable cover; crates add the warehouse/depot read.
 *
 * @param rng - the per-sector RNG stream (chooses wall vs crate)
 * @returns a DESTRUCTIBLE_WALL most of the time, otherwise a DESTRUCTIBLE_CRATE
 */
function breakable(rng: SeededRNG): TileType {
  return rng.nextInt(0, 2) === 0 ? TileType.DESTRUCTIBLE_CRATE : TileType.DESTRUCTIBLE_WALL;
}

/**
 * Set an interior cell only when it is currently EMPTY (never overwrite the
 * border ring or already-placed cover).
 *
 * @param tiles - the grid being built
 * @param r - the target row
 * @param c - the target column
 * @param t - the tile type to write
 */
function putIfEmpty(tiles: Uint8Array[], r: number, c: number, t: TileType): void {
  if (r > 0 && r <= HI && c > 0 && c <= HI && tiles[r]![c] === TileType.EMPTY) {
    tiles[r]![c] = t;
  }
}

/**
 * Frame a single cache cell with breakable cover on its still-EMPTY cardinal
 * sides, optionally leaving one side open (the entrance gap) so the cache stays
 * EMPTY-connected to the rest of the sector.
 *
 * @param tiles - the grid being built
 * @param r - the cache cell row
 * @param c - the cache cell column
 * @param rng - the per-sector RNG stream (chooses cover type + which side to open)
 * @param openSides - how many cardinal sides to leave open (0 fully rings it)
 */
function frameCacheCell(
  tiles: Uint8Array[],
  r: number,
  c: number,
  rng: SeededRNG,
  openSides: number,
): void {
  const order = rng.shuffle([...CARDINALS]);
  for (let i = 0; i < order.length; i++) {
    if (i < openSides) continue; // leave this side open (entrance)
    const [dr, dc] = order[i]!;
    putIfEmpty(tiles, r + dr, c + dc, breakable(rng));
  }
}

/**
 * Treasure Vault — a central high-value cache framed by a ring of BREAKABLE vault
 * walls everyone converges to crack open. The ring is one tile of breakable cover
 * around a small open core, with a guaranteed EMPTY entrance gap so the core stays
 * connected (a fully sealed core would be a disconnected EMPTY pocket the T1
 * connectivity gate rejects). The core's cells are the cache.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton with its central cache cells
 */
export function buildTreasureVault(rng: SeededRNG): ResourceRichSkeleton {
  const tiles = blankBordered();
  // A 5×5 open vault chamber centred (jittered) on the interior. The interior
  // stays EMPTY (an open chamber), wrapped by a one-tile breakable ring with a
  // guaranteed entrance gap so it never seals into a disconnected EMPTY pocket.
  const cr = 9 + rng.nextInt(-1, 1);
  const cc = 9 + rng.nextInt(-1, 1);
  const lo = -2;
  const hi = 2;

  // Breakable vault ring one tile outside the 5×5 chamber.
  for (let d = lo - 1; d <= hi + 1; d++) {
    putIfEmpty(tiles, cr + lo - 1, cc + d, breakable(rng));
    putIfEmpty(tiles, cr + hi + 1, cc + d, breakable(rng));
    putIfEmpty(tiles, cr + d, cc + lo - 1, breakable(rng));
    putIfEmpty(tiles, cr + d, cc + hi + 1, breakable(rng));
  }

  // Guaranteed EMPTY entrance gap on one ring side so the chamber stays connected
  // to the main EMPTY region (the T1 connectivity gate needs an EMPTY path in).
  const side = rng.nextInt(0, 3);
  const off = rng.nextInt(lo, hi); // which ring tile along that side to open
  if (side === 0) tiles[cr + lo - 1]![cc + off] = TileType.EMPTY;
  else if (side === 1) tiles[cr + hi + 1]![cc + off] = TileType.EMPTY;
  else if (side === 2) tiles[cr + off]![cc + lo - 1] = TileType.EMPTY;
  else tiles[cr + off]![cc + hi + 1] = TileType.EMPTY;

  // Cache cells: the chamber centre + the four mid-edge cells, all ≥2 tiles apart
  // (Manhattan), so EntityPlacer's min-spacing accepts every one — the vault then
  // holds all 3 chests AND the guaranteed weapon spawns, not just one.
  const core: CacheCell[] = [
    { x: cc, y: cr },
    { x: cc, y: cr + lo },
    { x: cc, y: cr + hi },
    { x: cc + lo, y: cr },
    { x: cc + hi, y: cr },
  ].filter((cell) => isCacheCell(cell.y, cell.x));
  return {
    tiles,
    // Hero-landmark anchor: the vault-chamber centre (the core cache).
    landmarkAnchor: core[0] ?? { x: cc, y: cr },
    lootSpots: core,
  };
}

/**
 * Loot Bazaar — loot distributed across many small breakable cover pockets so
 * fights happen simultaneously with no single chokepoint. Each pocket is one open
 * cache cell partly framed by breakable cover (1–2 open sides), spread across the
 * interior on a jittered grid.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton with its scattered pocket cache cells
 */
export function buildLootBazaar(rng: SeededRNG): ResourceRichSkeleton {
  const tiles = blankBordered();
  const lootSpots: CacheCell[] = [];
  // Anchor pockets on a coarse grid, jittered per instance; keep them ≥2 apart so
  // their cover does not merge into a wall and each reads as a distinct stall.
  const anchors: ReadonlyArray<readonly [number, number]> = [
    [4, 4],
    [4, 9],
    [4, 14],
    [9, 4],
    [9, 14],
    [14, 4],
    [14, 9],
    [14, 14],
  ];
  const order = rng.shuffle([...anchors]);
  const count = rng.nextInt(5, 6);
  for (let i = 0; i < count; i++) {
    const r = order[i]![0] + rng.nextInt(-1, 1);
    const c = order[i]![1] + rng.nextInt(-1, 1);
    if (!isCacheCell(r, c) || tiles[r]![c] !== TileType.EMPTY) continue;
    // Frame each pocket with breakable cover, leaving 2 open sides so the bazaar
    // stays fully connected and no pocket is sealed.
    frameCacheCell(tiles, r, c, rng, 2);
    lootSpots.push({ x: c, y: r });
  }
  return {
    tiles,
    // Hero-landmark anchor: the first bazaar pocket (a signature stall).
    landmarkAnchor: lootSpots[0] ?? { x: 9, y: 9 },
    lootSpots,
  };
}

/**
 * Exposed Cache — minimal cover, loot in the open on marked spots for maximum
 * grab risk. A few cache cells sit in clear sightlines with only a single thin
 * breakable cover tile nearby; the rest of the sector stays wide open.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton with its open cache cells
 */
export function buildExposedCache(rng: SeededRNG): ResourceRichSkeleton {
  const tiles = blankBordered();
  const lootSpots: CacheCell[] = [];
  // 3–4 marked spots spread across the interior (different regions) so the loot
  // is exposed from many angles; only ONE thin breakable cover tile per spot.
  const slots: ReadonlyArray<readonly [number, number]> = [
    [4, 4],
    [4, 14],
    [14, 4],
    [14, 14],
    [9, 9],
  ];
  const order = rng.shuffle([...slots]);
  const count = rng.nextInt(3, 4);
  for (let i = 0; i < count; i++) {
    const r = order[i]![0] + rng.nextInt(-1, 1);
    const c = order[i]![1] + rng.nextInt(-1, 1);
    if (!isCacheCell(r, c) || tiles[r]![c] !== TileType.EMPTY) continue;
    // A single breakable cover tile on one side: a token sliver of cover, so the
    // grab is almost fully exposed (the sub-variant's signature).
    frameCacheCell(tiles, r, c, rng, 3);
    lootSpots.push({ x: c, y: r });
  }
  return {
    tiles,
    // Hero-landmark anchor: the first exposed marked spot.
    landmarkAnchor: lootSpots[0] ?? { x: 9, y: 9 },
    lootSpots,
  };
}

/**
 * Supply Depot — loot along rows of crates/barrels (warehouse aisles) with cover
 * lanes. 2–3 breakable cover rows form aisles; the cache cells sit in the EMPTY
 * lanes between them, so loot reads as stacked along the shelves. Each row leaves
 * gaps so the aisles stay connected.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton with its aisle cache cells
 */
export function buildSupplyDepot(rng: SeededRNG): ResourceRichSkeleton {
  const tiles = blankBordered();
  const lootSpots: CacheCell[] = [];
  const vertical = rng.nextInt(0, 1) === 0;
  // 2–3 shelf rows from a candidate set, leaving open lanes between them. Each
  // shelf is breakable cover with RNG gaps so lanes stay crossable & connected.
  const candidates = [4, 7, 10, 13, 16];
  const shelfCount = rng.nextInt(2, 3);
  const shelves = rng
    .shuffle([...candidates])
    .slice(0, shelfCount)
    .sort((a, b) => a - b);

  for (const shelf of shelves) {
    const gapA = rng.nextInt(CACHE_LO + 1, CACHE_HI - 1);
    const gapB = rng.nextInt(CACHE_LO + 1, CACHE_HI - 1);
    for (let i = CACHE_LO; i <= CACHE_HI; i++) {
      if (i === gapA || i === gapB) continue; // open lane crossing
      const r = vertical ? i : shelf;
      const c = vertical ? shelf : i;
      putIfEmpty(tiles, r, c, breakable(rng));
    }
  }

  // Cache cells run down the open lane beside the first shelf (the picking aisle),
  // spaced so they survive EntityPlacer's min-spacing and stay loot-eligible.
  const aisle = shelves[0]! + 1 <= CACHE_HI ? shelves[0]! + 1 : shelves[0]! - 1;
  for (let i = CACHE_LO + 1; i <= CACHE_HI - 1; i += 3) {
    const r = vertical ? i : aisle;
    const c = vertical ? aisle : i;
    if (isCacheCell(r, c) && tiles[r]![c] === TileType.EMPTY) {
      lootSpots.push({ x: c, y: r });
    }
  }
  return {
    tiles,
    // Hero-landmark anchor: the midpoint of the picking aisle (the spine the
    // loot stacks along).
    landmarkAnchor: lootSpots[Math.floor(lootSpots.length / 2)] ?? { x: 9, y: 9 },
    lootSpots,
  };
}

/** Dispatch table mapping each ResourceRich sub-variant id to its builder. */
export const RESOURCE_RICH_SKELETON_BUILDERS: Record<
  ResourceRichSubVariant,
  (rng: SeededRNG) => ResourceRichSkeleton
> = {
  'Treasure Vault': buildTreasureVault,
  'Loot Bazaar': buildLootBazaar,
  'Exposed Cache': buildExposedCache,
  'Supply Depot': buildSupplyDepot,
  'Bank Row': buildBankRow,
};

import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { OpenArenaSubVariant } from './subVariants.js';
import type { SkeletonResult } from './gridArenaSkeletons.js';
import { radialSpokes } from '../patterns/CoverPatterns.js';

/**
 * OpenArena skeleton builders (T5). Each builder lays a 20×20 tile grid for one
 * OpenArena sub-variant: a LOW-density, dash-friendly arrangement of sparse
 * structural cover around a large clear center (OpenArena's Gameplay Purpose is
 * spacing, dashing & the chase — GDD §5.2.2, ADR 0027). Every builder is a pure
 * function of its {@link SeededRNG} so two instances differ and the same seed
 * reproduces them exactly. EntityPlacer later tops up crate density (~10%) and
 * loot in the wide-open pockets each skeleton leaves clear.
 *
 * Map-polish ticket 28: the per-cell RNG scatter fill passes (latticeFill /
 * edgeTrace / staggeredRows / diagonalPairs) were REMOVED — the sparse dash
 * fields keep only their authored bastions/monuments/clusters/spurs, with the
 * deterministic PrefabPlacementPass composing the open space between them.
 *
 * Shared invariants:
 * - The outer ring (row/col 0 and 19) is INDESTRUCTIBLE_WALL.
 * - Cover NEVER hugs the border: all placed cover stays within the "field"
 *   rows/cols {@link FIELD_LO}..{@link FIELD_HI} (≥2 tiles off the 0/19 edges),
 *   fixing the §5.2.2 border-hugging bug.
 * - A large central region stays open so the dash/chase read holds.
 * - Indestructible nubs are de-loned with a breakable skirt so no skeleton trips
 *   the lone-wall gate (T1) with single-tile indestructible stubs.
 */

/** The 20×20 sector side length these skeletons assume. */
const SIZE = 20;
/** Last interior index (just inside the border ring), used to frame the ring. */
const HI = SIZE - 2;
/** First field index — cover must stay ≥2 tiles off the 0 edge (§5.2.2). */
const FIELD_LO = 2;
/** Last field index — cover must stay ≥2 tiles off the 19 edge (§5.2.2). */
const FIELD_HI = SIZE - 3;

/** Cardinal offsets used when skirting a nub. */
const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];

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

/** Whether a coordinate is inside the cover field (≥2 tiles off the border). */
function inField(r: number, c: number): boolean {
  return r >= FIELD_LO && r <= FIELD_HI && c >= FIELD_LO && c <= FIELD_HI;
}

/**
 * Set a field cell, no-op when the target is outside the cover field. This is the
 * single guard that keeps every OpenArena skeleton off the border ring.
 *
 * @param tiles - the grid being built
 * @param r - the target row
 * @param c - the target column
 * @param t - the tile type to write
 */
function put(tiles: Uint8Array[], r: number, c: number, t: TileType): void {
  if (inField(r, c)) tiles[r]![c] = t;
}

/**
 * Place a breakable cover tile only if the target is an in-field EMPTY cell.
 * Cover is biased toward DESTRUCTIBLE_WALL so it counts toward the lone-wall
 * gate (which counts walls, not crates) and reliably de-lones nearby nubs.
 *
 * @param tiles - the grid being built
 * @param r - the target row
 * @param c - the target column
 * @param rng - the per-sector RNG stream (chooses wall vs crate)
 */
function maybeBreakable(tiles: Uint8Array[], r: number, c: number, rng: SeededRNG): void {
  if (inField(r, c) && tiles[r]![c] === TileType.EMPTY) {
    const t = rng.nextInt(0, 2) === 0 ? TileType.DESTRUCTIBLE_CRATE : TileType.DESTRUCTIBLE_WALL;
    put(tiles, r, c, t);
  }
}

/**
 * Place a small 2-tile breakable cover cluster (horizontal or vertical pair)
 * starting at (r, c). Both tiles gain a cardinal wall neighbour from their
 * partner so the autotiler renders connected bar/corner art instead of
 * scattered single-tile objects. Falls back to a single when the extension cell
 * is occupied or out of the field.
 *
 * @param tiles - the grid being built
 * @param r - the anchor row
 * @param c - the anchor column
 * @param rng - the per-sector RNG stream
 */
function maybeBreakablePair(tiles: Uint8Array[], r: number, c: number, rng: SeededRNG): void {
  maybeBreakable(tiles, r, c, rng);
  const horizontal = rng.nextInt(0, 1) === 0;
  maybeBreakable(tiles, horizontal ? r : r + 1, horizontal ? c + 1 : c, rng);
}

/**
 * Lay an indestructible nub plus a breakable DESTRUCTIBLE_WALL skirt on one open
 * side. The wall skirt (not a crate) is what de-lones the nub: the lone-wall
 * gate (T1) counts only INDESTRUCTIBLE_WALL / DESTRUCTIBLE_WALL neighbours, so a
 * lone single-tile indestructible cover always gets a wall neighbour here.
 *
 * @param tiles - the grid being built
 * @param r - the nub row
 * @param c - the nub column
 * @param rng - the per-sector RNG stream (chooses the skirt direction)
 */
function nubWithSkirt(tiles: Uint8Array[], r: number, c: number, rng: SeededRNG): void {
  if (!inField(r, c)) return;
  put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
  const order = rng.shuffle([...CARDINALS]);
  for (const [dr, dc] of order) {
    if (inField(r + dr, c + dc) && tiles[r + dr]![c + dc] === TileType.EMPTY) {
      put(tiles, r + dr, c + dc, TileType.DESTRUCTIBLE_WALL);
      return;
    }
  }
}

/**
 * Corner Bastions — a few indestructible cover clusters anchored in the corner
 * margins (off, never on, the border) with varied size/offset, leaving the whole
 * central plaza wide open. The refined version of the original corner-cluster
 * idea: clusters are jittered per instance and kept inside the field, so they
 * never hug the border (§5.2.2 fix).
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid
 */
export function buildCornerBastions(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  // Four corner anchor regions inside the field. Each bastion is a small 2×2 or
  // L-shaped indestructible block, jittered ±1 within its corner margin so two
  // instances differ; 2–3 of the 4 corners are used.
  const corners: ReadonlyArray<readonly [number, number]> = [
    [FIELD_LO, FIELD_LO],
    [FIELD_LO, FIELD_HI - 1],
    [FIELD_HI - 1, FIELD_LO],
    [FIELD_HI - 1, FIELD_HI - 1],
  ];
  const order = rng.shuffle([...corners]);
  const count = rng.nextInt(2, 3);
  for (let i = 0; i < count; i++) {
    const [baseR, baseC] = order[i]!;
    const r0 = baseR + rng.nextInt(0, 1);
    const c0 = baseC + rng.nextInt(0, 1);
    // Indestructible 2×2 core (a connected block — every tile has wall
    // neighbours, so none is ever a lone stub).
    put(tiles, r0, c0, TileType.INDESTRUCTIBLE_WALL);
    put(tiles, r0, c0 + 1, TileType.INDESTRUCTIBLE_WALL);
    put(tiles, r0 + 1, c0, TileType.INDESTRUCTIBLE_WALL);
    put(tiles, r0 + 1, c0 + 1, TileType.INDESTRUCTIBLE_WALL);
    // A short breakable tail toward midfield (smashable approach cover) so the
    // bastion reads as cover, not a sealed box, and varies per instance.
    const towardR = r0 < SIZE / 2 ? r0 + 2 : r0 - 1;
    const towardC = c0 < SIZE / 2 ? c0 + 2 : c0 - 1;
    maybeBreakable(tiles, towardR, c0, rng);
    maybeBreakable(tiles, r0, towardC, rng);
  }
  return {
    tiles,
    // Hero-landmark anchor: the open central plaza framed by the corner
    // bastions (the sector's signature contest space).
    landmarkAnchor: { x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) },
    lootSpots: [
      { x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) },
      { x: FIELD_LO + 3, y: FIELD_LO + 3 },
      { x: FIELD_HI - 3, y: FIELD_HI - 3 },
    ],
  };
}

/**
 * Central Monument — one bold central landmark structure (plus/cross, small
 * hollow ring, or pillar cluster) to circle and juke around; the rest of the
 * arena stays wide open. The landmark shape is chosen per instance from the RNG.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid
 */
export function buildCentralMonument(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  const cr = Math.floor(SIZE / 2) + rng.nextInt(-1, 0); // center, jittered
  const cc = Math.floor(SIZE / 2) + rng.nextInt(-1, 0);
  const shape = rng.nextInt(0, 2);

  if (shape === 0) {
    // Plus / cross: a 3-long indestructible bar each way through the center.
    for (let d = -1; d <= 1; d++) {
      put(tiles, cr + d, cc, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, cr, cc + d, TileType.INDESTRUCTIBLE_WALL);
    }
    // Breakable tips extend the arms so they read as cover lanes, not a wall.
    maybeBreakable(tiles, cr - 2, cc, rng);
    maybeBreakable(tiles, cr + 2, cc, rng);
    maybeBreakable(tiles, cr, cc - 2, rng);
    maybeBreakable(tiles, cr, cc + 2, rng);
  } else if (shape === 1) {
    // Solid 2×2 indestructible block: a bold central landmark to circle around.
    // A SOLID core (not a hollow ring) is used on purpose — a hollow interior
    // would be an EMPTY pocket fully sealed by indestructible walls, trapping any
    // spawn placed inside it (the connectivity gate would then fail). Every tile
    // of the block has wall neighbours, so none is ever a lone stub.
    for (let r = cr; r <= cr + 1; r++) {
      for (let c = cc; c <= cc + 1; c++) {
        put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
      }
    }
    // Breakable cover framing the block on a couple of sides (smashable approach
    // cover) so the monument reads as cover, not a bare box, and varies per
    // instance.
    maybeBreakable(tiles, cr - 1, cc, rng);
    maybeBreakable(tiles, cr + 2, cc + 1, rng);
    maybeBreakable(tiles, cr, cc - 1, rng);
    maybeBreakable(tiles, cr + 1, cc + 2, rng);
  } else {
    // Pillar cluster: four indestructible pillars on a WIDE diamond (radius 2),
    // each de-loned with a breakable skirt so the cluster reads as a monument to
    // juke between. The radius-2 spread is deliberate — a radius-1 diamond would
    // cardinally enclose its center EMPTY cell with four indestructible pillars,
    // sealing any spawn placed there (the connectivity gate would then fail). At
    // radius 2 the center and all gaps stay open and connected.
    nubWithSkirt(tiles, cr - 2, cc, rng);
    nubWithSkirt(tiles, cr + 2, cc, rng);
    nubWithSkirt(tiles, cr, cc - 2, rng);
    nubWithSkirt(tiles, cr, cc + 2, rng);
  }

  // Radial spokes frame the monument with deterministic sightline convergences
  // (authored angles + step — no per-cell dice; ticket 28 keeps them).
  radialSpokes(tiles, rng, {
    centerR: cr,
    centerC: cc,
    angles: [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2],
    step: 3,
    maxLength: 7,
    tileType: TileType.DESTRUCTIBLE_CRATE,
  });
  return {
    tiles,
    // Hero-landmark anchor: the plaza tile flanking the monument on its east
    // side — ON the signature structure (the monument), never on its walls.
    landmarkAnchor: { x: cc + 3, y: cr },
    lootSpots: [
      { x: cc + 3, y: cr },
      { x: cc - 3, y: cr },
      { x: cc, y: cr + 3 },
      { x: cc, y: cr - 3 },
    ],
  };
}

/**
 * Scatter Cover — 3–4 sparse connected cover clusters (2×2 blocks or 3-tile
 * bars) spread across the field in different quadrants, keeping the arena
 * maximally dash-friendly (the widest gaps of the four sub-variants). Each
 * cluster is a connected wall structure (≥2 wall neighbours per tile) so the
 * autotiler renders proper bar/corner art — no scattered coffin objects.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built skeleton (tiles + loot spots)
 */
export function buildScatterCover(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  const lootSpots: { x: number; y: number }[] = [];

  const slots: ReadonlyArray<readonly [number, number]> = [
    [FIELD_LO + 1, FIELD_LO + 1],
    [FIELD_LO + 1, FIELD_HI - 2],
    [FIELD_HI - 2, FIELD_LO + 1],
    [FIELD_HI - 2, FIELD_HI - 2],
    [Math.floor(SIZE / 2), FIELD_LO + 1],
    [Math.floor(SIZE / 2), FIELD_HI - 2],
  ];
  const order = rng.shuffle([...slots]);
  const count = rng.nextInt(3, 4);

  for (let i = 0; i < count; i++) {
    const [baseR, baseC] = order[i]!;
    const r = baseR + rng.nextInt(-1, 1);
    const c = baseC + rng.nextInt(-1, 1);
    if (!inField(r, c) || tiles[r]![c] !== TileType.EMPTY) continue;

    // Connected cluster: either a 2×2 block or a 3-tile bar. Both produce
    // structures where every tile has ≥2 wall cardinal neighbours → autotiler
    // renders proper bar/corner art instead of scattered coffin objects.
    if (rng.nextInt(0, 1) === 0) {
      // 2×2 indestructible block
      put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, r, c + 1, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, r + 1, c, TileType.INDESTRUCTIBLE_WALL);
      put(tiles, r + 1, c + 1, TileType.INDESTRUCTIBLE_WALL);
    } else {
      // 3-tile bar (horizontal or vertical)
      const horizontal = rng.nextInt(0, 1) === 0;
      if (horizontal) {
        put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
        put(tiles, r, c + 1, TileType.INDESTRUCTIBLE_WALL);
        put(tiles, r, c + 2, TileType.INDESTRUCTIBLE_WALL);
      } else {
        put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
        put(tiles, r + 1, c, TileType.INDESTRUCTIBLE_WALL);
        put(tiles, r + 2, c, TileType.INDESTRUCTIBLE_WALL);
      }
    }

    // Loot spot between this cluster and the sector center
    lootSpots.push({
      x: c + (c < SIZE / 2 ? 3 : -1),
      y: r + (r < SIZE / 2 ? 3 : -1),
    });
  }

  // A couple of small breakable cover clusters (2 adjacent tiles) that break
  // sightlines without adding indestructible footprint. Clusters read as
  // deliberate cover rather than scattered single objects.
  const extras = rng.nextInt(2, 3);
  for (let i = 0; i < extras; i++) {
    const r = rng.nextInt(FIELD_LO, FIELD_HI - 1);
    const c = rng.nextInt(FIELD_LO, FIELD_HI - 1);
    maybeBreakablePair(tiles, r, c, rng);
  }

  lootSpots.push({ x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) });
  return {
    tiles,
    // Hero-landmark anchor: the open center between the scatter clusters.
    landmarkAnchor: { x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) },
    lootSpots,
  };
}

/**
 * Diagonal Spurs — a couple of short diagonal indestructible wall spurs cutting
 * partial sightlines to create flank angles, placed off-center so the middle
 * stays open. Each spur is a contiguous diagonal run (every tile has a diagonal
 * wall neighbour, so it never trips the lone-wall gate) tipped with breakable
 * cover.
 *
 * @param rng - the per-sector RNG stream
 * @returns the built 20×20 tile grid
 */
export function buildDiagonalSpurs(rng: SeededRNG): SkeletonResult {
  const tiles = blankBordered();
  // Two spurs anchored in opposite off-center regions, each a 3-tile diagonal
  // run. Diagonal direction is chosen per spur so instances differ.
  const anchors: ReadonlyArray<readonly [number, number]> = [
    [FIELD_LO + 1, FIELD_LO + 1],
    [FIELD_HI - 3, FIELD_HI - 3],
    [FIELD_LO + 1, FIELD_HI - 3],
    [FIELD_HI - 3, FIELD_LO + 1],
  ];
  const order = rng.shuffle([...anchors]);
  const spurCount = rng.nextInt(1, 2);

  for (let i = 0; i < spurCount; i++) {
    const [ar, ac] = order[i]!;
    const dr = rng.nextInt(0, 1) === 0 ? 1 : -1;
    const dc = rng.nextInt(0, 1) === 0 ? 1 : -1;
    const len = rng.nextInt(3, 4);
    let r = ar;
    let c = ac;
    for (let s = 0; s < len; s++) {
      put(tiles, r, c, TileType.INDESTRUCTIBLE_WALL);
      // Anchor each diagonal cell to its predecessor with an orthogonal wall so
      // the run is contiguous (no diagonal-only loner) and reads as a spur.
      if (s > 0) put(tiles, r, c - dc, TileType.INDESTRUCTIBLE_WALL);
      r += dr;
      c += dc;
    }
    // Breakable tips at both ends (smashable flank cover).
    maybeBreakable(tiles, ar - dr, ac - dc, rng);
    maybeBreakable(tiles, r, c, rng);
  }

  return {
    tiles,
    // Hero-landmark anchor: the open midfield the spurs cut sightlines across.
    landmarkAnchor: { x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) },
    lootSpots: [
      { x: Math.floor(SIZE / 2), y: Math.floor(SIZE / 2) },
      { x: FIELD_LO + 4, y: FIELD_HI - 4 },
      { x: FIELD_HI - 4, y: FIELD_LO + 4 },
    ],
  };
}

import { buildAirstrip } from './airstrip.js';

/** Dispatch table mapping each OpenArena sub-variant id to its builder. */
export const OPEN_ARENA_SKELETON_BUILDERS: Record<
  OpenArenaSubVariant,
  (rng: SeededRNG) => SkeletonResult
> = {
  'Corner Bastions': buildCornerBastions,
  'Central Monument': buildCentralMonument,
  'Scatter Cover': buildScatterCover,
  'Diagonal Spurs': buildDiagonalSpurs,
  Airstrip: buildAirstrip,
};

/**
 * Map-redesign ticket 05 / DEC-005 — lighting-hierarchy placement tests.
 *
 * Covers the hierarchy passes end-to-end at the `LightPlacer.place` seam
 * (synthetic grids with tiers + landmarks + connections + chests) and the
 * pure helpers in `LightPlacerHierarchy`:
 *   - POI glow: ONE warm pool per sector's primary chest cluster (never per
 *     chest; glints stay), deterministic placement, accent-slot conservation.
 *   - Sconce routes: doorway sconce count preserved + position biased onto
 *     the gateway→landmark travel line; capped route-mid sconces line dark
 *     road stretches only.
 *   - Dark pockets: the dark-gap fill is REMOVED in COLD sectors and its
 *     threshold raised elsewhere via the per-tier data table.
 *   - Determinism: same seed ⇒ byte-identical placements.
 */
import { describe, it, expect } from 'vitest';
import {
  BEACON_INTENSITY_MAX,
  BEACON_INTENSITY_MIN,
  BEACON_RADIUS,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  SectorType,
  SectorLootTier,
  TileType,
  type ChestPlacement,
  type DestructiblePlacement,
  type LandmarkAssignment,
  type MapData,
  type SectorConnection,
} from '@sector-battle/shared';
import { LightPlacer } from '../LightPlacer.js';
import {
  DOORWAY_FALLBACK_REACH,
  DOORWAY_PAIR_BAND_END_OFFSET,
  POI_GLOW_CLUSTER_CHEBYSHEV,
  POI_GLOW_LIGHT,
  ROUTE_ADJACENCY_CHEBYSHEV,
  ROUTE_SCONCE_MIN_GAP,
  SECTOR_TIER_LIGHT_PARAMS,
} from '../lightHierarchyConfig.js';
import {
  collectSectorRouteLines,
  orderFillCandidatesRouteFirst,
  routeSamplePoints,
} from '../LightPlacerHierarchy.js';
import {
  doorwayBandEndLadder,
  doorwayPairGeometry,
  firstPlaceableDoorwayPair,
  firstPlaceableDoorwaySoloTiles,
} from '../LightPlacerDoorway.js';
import { isDarkGap, LIGHT_MIN_SPACING } from '../LightPlacerClassifiers.js';

/** The standard synthetic-map builder options for the hierarchy tests. */
interface HierarchyMapOptions {
  /** Sector types along the single row. */
  sectorTypes: SectorType[];
  seed: number;
  /** Effective-tier grid rows (same shape as sectors); defaults to WARM. */
  tiers?: SectorLootTier[][];
  /** Hero landmark anchor per sector (LOCAL tile coords), or omit for none. */
  heroAnchors?: Array<{ x: number; y: number } | undefined>;
  /** Chests (GLOBAL tile coords). */
  chests?: Array<{ gridX: number; gridY: number }>;
  /** Sector-pair connections (indices into the sector row). */
  connections?: Array<{ a: number; b: number }>;
  /** Extra interior wall tiles (global coords) — cover blocks near routes. */
  extraWalls?: Array<{ x: number; y: number }>;
}

/**
 * Build a synthetic 1×N-sector composite grid + MapData with REALISTIC
 * sector geometry: INDESTRUCTIBLE_WALL map border, INDESTRUCTIBLE_WALL
 * sector-border columns, and a 3-tile aperture (rows 8–10) carved on every
 * connected sector boundary (the SectorConnector doorway shape the placer's
 * doorway sconce expects). Tier/landmark/chest data wired for the hierarchy
 * passes. The occupied set is the non-EMPTY grid tiles.
 */
function makeHierarchyMap(opts: HierarchyMapOptions): {
  grid: TileType[][];
  mapData: MapData;
  occupied: Set<string>;
  chests: ChestPlacement[];
} {
  const sectorCount = opts.sectorTypes.length;
  const width = sectorCount * SECTOR_TILE_SIZE;
  const height = SECTOR_TILE_SIZE;
  const grid: TileType[][] = [];
  for (let r = 0; r < height; r++) {
    grid.push(new Array<TileType>(width).fill(TileType.EMPTY));
  }
  for (let c = 0; c < width; c++) {
    grid[0]![c] = TileType.INDESTRUCTIBLE_WALL;
    grid[height - 1]![c] = TileType.INDESTRUCTIBLE_WALL;
  }
  for (let r = 0; r < height; r++) {
    grid[r]![0] = TileType.INDESTRUCTIBLE_WALL;
    grid[r]![width - 1] = TileType.INDESTRUCTIBLE_WALL;
  }
  // Sector border columns with 3-tile apertures at rows 8-10 for every
  // REQUESTED connection; unconnected borders stay solid (no doorway).
  const connected = new Set<number>();
  for (const conn of opts.connections ?? []) connected.add(conn.b);
  for (const b of connected) {
    const borderCol = b * SECTOR_TILE_SIZE;
    for (let r = 1; r < height - 1; r++) {
      if (r >= 8 && r <= 10) continue; // the 3-tile aperture
      grid[r]![borderCol] = TileType.INDESTRUCTIBLE_WALL;
    }
  }
  for (const wall of opts.extraWalls ?? []) {
    grid[wall.y]![wall.x] = TileType.INDESTRUCTIBLE_WALL;
  }

  const sectors = opts.sectorTypes.map((type, s) => ({
    type,
    subVariant: 'DEFAULT' as never,
    tiles: Array.from({ length: SECTOR_TILE_SIZE }, (_, r) =>
      Uint8Array.from(
        Array.from({ length: SECTOR_TILE_SIZE }, (_, c) => grid[r]![s * SECTOR_TILE_SIZE + c]!),
      ),
    ),
    elevation: null,
    lootSpots: [],
    landmarkAnchor: { x: 10, y: 10 },
    mirrored: false,
    subBlockMask: 0,
    bounds: {
      x: s * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
      y: 0,
      width: SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
      height: SECTOR_TILE_SIZE * TILE_PIXEL_SIZE,
    },
    theme: 'default' as const,
  }));

  const tiers = opts.tiers ?? [opts.sectorTypes.map(() => 'WARM' as SectorLootTier)];
  const connections: SectorConnection[] = (opts.connections ?? []).map(({ a, b }) => {
    // Vertical aperture on the shared border between sector a (left) and b.
    const borderX = b * SECTOR_TILE_SIZE * TILE_PIXEL_SIZE;
    const y0 = 8 * TILE_PIXEL_SIZE;
    const y1 = 11 * TILE_PIXEL_SIZE; // 3-tile aperture
    return {
      sectorA: { row: 0, col: a },
      sectorB: { row: 0, col: b },
      width: 3 as const,
      positionA: { x: borderX, y: y0 },
      positionB: { x: borderX, y: y1 },
    };
  });

  let landmarks: LandmarkAssignment | undefined;
  if (opts.heroAnchors) {
    landmarks = {
      heroes: [
        opts.heroAnchors.map((anchor, s) => ({
          compositionId: `comp-${s}`,
          rarity: 'common' as const,
          tileX: s * SECTOR_TILE_SIZE + (anchor?.x ?? 10),
          tileY: anchor?.y ?? 10,
          beacon: {
            color: [1.0, 0.83, 0.4] as const,
            intensity: BEACON_INTENSITY_MAX,
            radius: BEACON_RADIUS,
          },
        })),
      ],
      minors: [],
    };
  }

  const chests: ChestPlacement[] = (opts.chests ?? []).map((c) => ({
    gridX: c.gridX,
    gridY: c.gridY,
    textureKey: 'chest',
    rotation: 0,
    flipH: false,
    flipV: false,
  }));

  const mapData: MapData = {
    seed: opts.seed,
    sectors: [sectors],
    connections,
    spawnPoints: [],
    exits: [],
    lootPlacements: [],
    entityPlacements: [],
    trapPlacements: [],
    weather: [],
    globalBounds: { width: width * TILE_PIXEL_SIZE, height: height * TILE_PIXEL_SIZE },
    corridorTiles: new Set<string>(),
    sectorTiers: tiers,
    hotSector: { row: -1, col: -1 },
    poiNames: [],
    macroPoiNames: { highway: null, compound: null, barrierRidge: null, openCommons: null },
    designation: '',
    landmarks: landmarks ?? { heroes: [], minors: [] },
    fortress: null,
    sectorTypes: [],
    identity: { fields: [], gateways: [] },
  };

  const occupied = new Set<string>();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r]![c] !== TileType.EMPTY) occupied.add(`${r},${c}`);
    }
  }
  return { grid, mapData, occupied, chests };
}

/** Run the placer over a synthetic hierarchy map. */
function placeHierarchyMap(opts: HierarchyMapOptions) {
  const { grid, mapData, occupied, chests } = makeHierarchyMap(opts);
  const destructibles: DestructiblePlacement[] = [];
  return new LightPlacer().place(grid, mapData, occupied, destructibles, opts.seed, chests);
}

/** The POI glow pool signature (a brazier carrying the authored pool overrides). */
function isPoiPool(lp: { kind: string; intensity?: number; radius?: number }): boolean {
  return (
    lp.kind === 'brazier' &&
    lp.intensity === POI_GLOW_LIGHT.intensity &&
    lp.radius === POI_GLOW_LIGHT.radius
  );
}

const CHEB = (ax: number, ay: number, bx: number, by: number) =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// ─── POI glow (DEC-005 #2) ────────────────────────────────────────────────────

describe('LightHierarchy — POI glow (one warm pool per cluster, not per chest)', () => {
  it('a 4-chest cluster yields exactly ONE pool; the pool sits by the hoard', () => {
    // 4 chests within Chebyshev 3 in sector 0 (tiles 4..7, row 4) — one hoard.
    const placements = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA],
      seed: 101,
      chests: [
        { gridX: 4, gridY: 4 },
        { gridX: 5, gridY: 4 },
        { gridX: 6, gridY: 5 },
        { gridX: 7, gridY: 5 },
      ],
    });
    const pools = placements.filter(isPoiPool);
    expect(pools).toHaveLength(1);
    const pool = pools[0]!;
    // The pool's fixture tile is within Chebyshev 2 of a cluster chest (the
    // hoard motivates the fixture — `findPoiGlowTile`).
    const chests = [
      { gridX: 4, gridY: 4 },
      { gridX: 5, gridY: 4 },
      { gridX: 6, gridY: 5 },
      { gridX: 7, gridY: 5 },
    ];
    expect(chests.some((c) => CHEB(c.gridX, c.gridY, pool.gridX, pool.gridY) <= 2)).toBe(true);
    // The pool carries the authored warm tune (wide, soft, below the sconce
    // flames and far below the beacon band — the hierarchy value order).
    expect(pool.intensity).toBe(POI_GLOW_LIGHT.intensity);
    expect(pool.intensity!).toBeLessThan(2.1); // below brazier stock intensity
    expect(pool.intensity!).toBeLessThan(BEACON_INTENSITY_MIN); // below the beacon band floor (2.45)
    expect(pool.color).toEqual(POI_GLOW_LIGHT.color);
    expect(pool.pulse).toBe(false); // a reward pool is steady
  });

  it('two clusters in DIFFERENT sectors yield one pool each (pooled per cluster)', () => {
    const placements = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA, SectorType.GRID_ARENA],
      seed: 102,
      chests: [
        { gridX: 4, gridY: 4 },
        { gridX: 5, gridY: 4 },
        { gridX: 26, gridY: 14 },
        { gridX: 27, gridY: 14 },
      ],
    });
    const pools = placements.filter(isPoiPool);
    expect(pools).toHaveLength(2);
    const inSector0 = pools.filter((p) => p.gridX < SECTOR_TILE_SIZE);
    const inSector1 = pools.filter((p) => p.gridX >= SECTOR_TILE_SIZE);
    expect(inSector0).toHaveLength(1);
    expect(inSector1).toHaveLength(1);
  });

  it('two clusters in the SAME sector yield ONE pool (accent-slot conservation)', () => {
    // Cluster A (3 chests) around (4,4); cluster B (2 chests) around (15,15)
    // — both in sector 0. The per-sector accent slot goes to the LARGEST
    // cluster (A) — the same-or-lower total budget discipline.
    const placements = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA],
      seed: 103,
      chests: [
        { gridX: 4, gridY: 4 },
        { gridX: 5, gridY: 4 },
        { gridX: 5, gridY: 5 },
        { gridX: 15, gridY: 15 },
        { gridX: 16, gridY: 15 },
      ],
    });
    const pools = placements.filter(isPoiPool);
    expect(pools).toHaveLength(1);
    // The primary (largest) cluster won the accent slot.
    expect(CHEB(pools[0]!.gridX, pools[0]!.gridY, 5, 4)).toBeLessThanOrEqual(
      POI_GLOW_CLUSTER_CHEBYSHEV,
    );
  });

  it('a LONE chest yields NO pool (the chest keeps only its glint)', () => {
    const placements = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA],
      seed: 104,
      chests: [{ gridX: 10, gridY: 10 }],
    });
    expect(placements.filter(isPoiPool)).toHaveLength(0);
  });

  it('a cluster sector spends its accent on the pool instead of a crystal (≤1 accent/sector)', () => {
    // GRID_ARENA has no wall nooks on the open synthetic grid → without the
    // pool the sector gets NO accent; with the hoard it gets exactly the pool.
    // Enclosed-crystal sectors: prove the XOR with a GRID_ARENA map whose
    // interior carries a wall block (a nook) + a hoard — accent count is 1.
    const { grid, mapData, occupied, chests } = makeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA],
      seed: 105,
      chests: [
        { gridX: 4, gridY: 4 },
        { gridX: 5, gridY: 4 },
      ],
    });
    // Carve a small wall block at (14..16, 14..16) — creates deep nooks
    // (floor tiles with ≥4 wall neighbours) for a crystal candidate.
    for (let r = 14; r <= 16; r++) {
      for (let c = 14; c <= 16; c++) {
        grid[r]![c] = TileType.INDESTRUCTIBLE_WALL;
        occupied.add(`${r},${c}`);
      }
    }
    mapData.sectors[0]![0]!.tiles = Array.from({ length: SECTOR_TILE_SIZE }, (_, r) =>
      Uint8Array.from(Array.from({ length: SECTOR_TILE_SIZE }, (_, c) => grid[r]![c]!)),
    );
    const placements = new LightPlacer().place(grid, mapData, occupied, [], 105, chests);
    const accents = placements.filter((p) => isPoiPool(p) || p.kind === 'biome-glow');
    expect(accents).toHaveLength(1); // the pool — the crystal did NOT also fire
    expect(isPoiPool(accents[0]!)).toBe(true);
  });
});

// ─── Sconce routes (DEC-005 #3) ───────────────────────────────────────────────

describe('LightHierarchy — sconce routes (gateway→landmark travel lines)', () => {
  it('doorway sconces come in symmetric PAIRS (two per connection, map-polish ticket 10)', () => {
    // 2 connections ⇒ 2 sconces per aperture = 4 sconces near the thresholds;
    // the count is per-BAND-END now, and route bias no longer moves sconces
    // within a threshold box (the pair is pure geometry).
    const withNoLandmarks = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA, SectorType.GRID_ARENA, SectorType.GRID_ARENA],
      seed: 201,
      connections: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
    });
    const withLandmarks = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA, SectorType.GRID_ARENA, SectorType.GRID_ARENA],
      seed: 201,
      heroAnchors: [
        { x: 10, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 10 },
      ],
      connections: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
    });
    const doorwaySconces = (placements: typeof withNoLandmarks) =>
      placements.filter((p) => !isPoiPool(p) && CHEB(p.gridX, p.gridY, 20, 9) <= 2).length +
      placements.filter((p) => !isPoiPool(p) && CHEB(p.gridX, p.gridY, 40, 9) <= 2).length;
    // TWO sconces per aperture (one at each band end), landmarks or not — the
    // doorway layer is pure geometry, independent of the travel lines.
    expect(doorwaySconces(withNoLandmarks)).toBe(4);
    expect(doorwaySconces(withLandmarks)).toBe(4);
  });

  it('route-mid sconces line the dark stretch of the travel line (gap-gated)', () => {
    // 1×2 map; sector (0,1) is HOT with its hero anchor at global (35,10).
    // The travel line (20,9)→(35,10) has sample points at (25,9)/(30,10);
    // only samples ≥ROUTE_SCONCE_MIN_GAP from every light may fire. A cover
    // wall row at y=12 under the route gives the sconce a wall to mount on.
    const baseOpts: HierarchyMapOptions = {
      sectorTypes: [SectorType.GRID_ARENA, SectorType.GRID_ARENA],
      seed: 202,
      tiers: [[SectorLootTier.COLD, SectorLootTier.HOT]],
      heroAnchors: [
        { x: 5, y: 10 },
        { x: 15, y: 10 },
      ],
      connections: [{ a: 0, b: 1 }],
      extraWalls: [
        { x: 29, y: 12 },
        { x: 30, y: 12 },
        { x: 31, y: 12 },
      ],
    };
    const placements = placeHierarchyMap(baseOpts);
    const lines = collectSectorRouteLines(makeHierarchyMap(baseOpts).mapData);
    const hotLines = lines.get('0,1')!;
    expect(hotLines).toHaveLength(1);
    // Route sconces in the HOT sector: sconces within the route-adjacency
    // band of the line, beyond the doorway threshold box.
    const routeSconces = placements.filter((p) => {
      if (isPoiPool(p)) return false;
      if (Math.floor(p.gridX / SECTOR_TILE_SIZE) !== 1) return false;
      if (CHEB(p.gridX, p.gridY, 20, 9) <= 2) return false; // the doorway sconce
      return hotLines.some(
        (line) =>
          pointToSegmentCheb(p.gridX, p.gridY, line.fromX, line.fromY, line.toX, line.toY) <=
          ROUTE_ADJACENCY_CHEBYSHEV,
      );
    });
    // The long dark stretch mid-road got lined (≥1), within the per-tier cap.
    expect(routeSconces.length).toBeGreaterThanOrEqual(1);
    expect(routeSconces.length).toBeLessThanOrEqual(SECTOR_TIER_LIGHT_PARAMS.HOT.routeSconceCap);
    // And every route sconce honored the dark-stretch gate at placement time:
    // (verified by construction — re-derive the nearest-light distance minus
    // itself; simpler: the sconce is ≥ cadence−search tiles down the line).
    for (const sconce of routeSconces) {
      expect(Math.abs(sconce.gridX - 20) + Math.abs(sconce.gridY - 9)).toBeGreaterThanOrEqual(
        ROUTE_SCONCE_MIN_GAP - 2,
      );
    }
  });

  it('routeSamplePoints skips the gateway end and stops before the landmark', () => {
    const points = routeSamplePoints({ fromX: 0, fromY: 10, toX: 19, toY: 10 });
    // Cadence 5 over 19 steps → samples at 5, 10, 15 (never 0, never the end).
    expect(points.map((p) => p.gridX)).toEqual([5, 10, 15]);
    expect(points.every((p) => p.gridY === 10)).toBe(true);
  });

  it('doorwayPairGeometry derives the band-end pair from the connection record (H + V, real SectorConnector shape)', () => {
    // H connection (0,0)-(0,1) — the exact record SectorConnector emits:
    // positionA is the band's FIRST tile (local row 9) on A's border column.
    const h = doorwayPairGeometry({
      sectorA: { row: 0, col: 0 },
      sectorB: { row: 0, col: 1 },
      width: 3,
      positionA: { x: 19 * TILE_PIXEL_SIZE, y: 9 * TILE_PIXEL_SIZE },
      positionB: { x: 20 * TILE_PIXEL_SIZE, y: 9 * TILE_PIXEL_SIZE },
    });
    expect(h.openingAxis).toBe('row');
    expect(h.bandEnds).toEqual([
      { gridX: 19, gridY: 9 },
      { gridX: 19, gridY: 11 },
    ]);
    expect(h.axisCenter).toBe(10); // the gatewayMidpoint centerline row
    expect(h.travelInward).toEqual({ dRow: 0, dCol: -1 }); // into sector A

    // V connection (2,3)-(3,3): positionA = local col 9 on A's border row.
    const v = doorwayPairGeometry({
      sectorA: { row: 2, col: 3 },
      sectorB: { row: 3, col: 3 },
      width: 3,
      positionA: { x: 69 * TILE_PIXEL_SIZE, y: 59 * TILE_PIXEL_SIZE },
      positionB: { x: 69 * TILE_PIXEL_SIZE, y: 60 * TILE_PIXEL_SIZE },
    });
    expect(v.openingAxis).toBe('col');
    expect(v.bandEnds).toEqual([
      { gridX: 69, gridY: 59 },
      { gridX: 71, gridY: 59 },
    ]);
    expect(v.axisCenter).toBe(70);
    expect(v.travelInward).toEqual({ dRow: -1, dCol: 0 }); // into sector A
  });

  it('doorwayBandEndLadder is the documented deterministic rung order (band end → outward → travel-inward)', () => {
    const h = doorwayPairGeometry({
      sectorA: { row: 0, col: 0 },
      sectorB: { row: 0, col: 1 },
      width: 3,
      positionA: { x: 19 * TILE_PIXEL_SIZE, y: 9 * TILE_PIXEL_SIZE },
      positionB: { x: 20 * TILE_PIXEL_SIZE, y: 9 * TILE_PIXEL_SIZE },
    });
    // Band end 0 (local row 9): outward = up (row 8); inward = west (col 18).
    expect(doorwayBandEndLadder(h, 0)).toEqual([
      { gridX: 19, gridY: 9 },
      { gridX: 19, gridY: 9 - DOORWAY_FALLBACK_REACH },
      { gridX: 19 - DOORWAY_FALLBACK_REACH, gridY: 9 },
    ]);
    // Band end 1 (local row 11): outward = down (row 12); inward = west.
    expect(doorwayBandEndLadder(h, 1)).toEqual([
      { gridX: 19, gridY: 11 },
      { gridX: 19, gridY: 11 + DOORWAY_FALLBACK_REACH },
      { gridX: 19 - DOORWAY_FALLBACK_REACH, gridY: 11 },
    ]);
    // Every rung keeps the pair's internal spacing ≥ LIGHT_MIN_SPACING from
    // the sibling band end (the pair itself is exactly 2 apart — the band's
    // opening-axis span; fallbacks only move AWAY from the sibling).
    for (const index of [0, 1] as const) {
      const sibling = h.bandEnds[index === 0 ? 1 : 0];
      for (const rung of doorwayBandEndLadder(h, index)) {
        const dist = Math.abs(rung.gridY - sibling.gridY) + Math.abs(rung.gridX - sibling.gridX);
        expect(dist).toBeGreaterThanOrEqual(LIGHT_MIN_SPACING);
      }
    }
  });

  it('a blocked band end steps the PAIR together: both members take the travel-inward rung', () => {
    // The synthetic hierarchy map carves the aperture at rows 8-10 on the
    // border column; band ends derive to rows 8 and 10 on col 20 (b=1).
    // Wall the LOWER band end (8,20): rung 0 is a wall and rung 1 (7,20) is
    // the pre-existing border wall, so no rung fits member 0 until rung 2 —
    // and the pair steps TOGETHER (ticket-10 addendum): BOTH sconces take
    // the travel-inward rung ((8,19) and (10,19)), keeping the pair
    // mirror-symmetric about axis row 9 even though the UPPER band end
    // (20,10) was itself placeable — the sibling steps with its partner.
    const placements = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA, SectorType.GRID_ARENA],
      seed: 203,
      connections: [{ a: 0, b: 1 }],
      extraWalls: [{ x: 20, y: 8 }],
    });
    const sconces = placements.filter(
      (p) => !isPoiPool(p) && p.kind !== 'campfire' && p.kind !== 'biome-glow',
    );
    const nearAperture = sconces.filter((p) => CHEB(p.gridX, p.gridY, 20, 9) <= 2);
    expect(nearAperture).toHaveLength(2);
    const lower = nearAperture.find((p) => p.gridY <= 8);
    const upper = nearAperture.find((p) => p.gridY >= 10);
    expect(lower).toMatchObject({ gridX: 19, gridY: 8 }); // rung 2 (travel-inward)
    expect(upper).toMatchObject({ gridX: 19, gridY: 10 }); // SAME rung 2 — stepped together
    // The coordinated pair still holds the ≥ LIGHT_MIN_SPACING discipline
    // (rung 2 keeps the band-end opening-axis coords: Manhattan exactly 2).
    expect(Math.abs(lower!.gridX - upper!.gridX) + Math.abs(lower!.gridY - upper!.gridY)).toBe(
      LIGHT_MIN_SPACING,
    );
  });

  it('no common rung leaves exactly one sibling sconce (asymmetric aperture, no scatter)', () => {
    // Block every rung of the lower band end: (8,20) rung 0 walled, (7,20)
    // rung 1 is the border wall already, (8,19) rung 2 walled too — no rung
    // fits BOTH members (the upper member's rungs are free, but a rung is
    // void when the sibling cannot take it too), so the aperture degrades to
    // the sibling-only survivor: the first member that can hold a solo rung
    // (the upper band end, unblocked). No 5×5 search ever relocates the
    // sconce somewhere unmotivated.
    const placements = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA, SectorType.GRID_ARENA],
      seed: 204,
      connections: [{ a: 0, b: 1 }],
      extraWalls: [
        { x: 20, y: 8 },
        { x: 19, y: 8 },
      ],
    });
    const sconces = placements.filter(
      (p) => !isPoiPool(p) && p.kind !== 'campfire' && p.kind !== 'biome-glow',
    );
    const nearAperture = sconces.filter((p) => CHEB(p.gridX, p.gridY, 20, 9) <= 2);
    expect(nearAperture).toHaveLength(1);
    expect(nearAperture[0]).toMatchObject({ gridX: 20, gridY: 10 });
  });

  it('firstPlaceableDoorwayPair steps BOTH members together (outward rung live, mirror kept, never mixed)', () => {
    // 20×20 bordered grid. Real H geometry: positionA at tile (10,9) ⇒ band
    // ends (10,9)/(10,11), axis row 10; the ladders are
    //   member 0: (10,9) → (10,8) [outward] → (9,9) [travel-inward]
    //   member 1: (10,11) → (10,12) [outward] → (9,11) [travel-inward]
    const grid: TileType[][] = [];
    for (let r = 0; r < 20; r++) grid.push(new Array<TileType>(20).fill(TileType.EMPTY));
    for (let c = 0; c < 20; c++) {
      grid[0]![c] = TileType.INDESTRUCTIBLE_WALL;
      grid[19]![c] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let r = 0; r < 20; r++) {
      grid[r]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[r]![19] = TileType.INDESTRUCTIBLE_WALL;
    }
    const geometry = doorwayPairGeometry({
      sectorA: { row: 0, col: 0 },
      sectorB: { row: 0, col: 1 },
      width: 3,
      positionA: { x: 10 * TILE_PIXEL_SIZE, y: 9 * TILE_PIXEL_SIZE },
      positionB: { x: 11 * TILE_PIXEL_SIZE, y: 9 * TILE_PIXEL_SIZE },
    });
    const ladders = [doorwayBandEndLadder(geometry, 0), doorwayBandEndLadder(geometry, 1)] as const;
    expect(ladders[0]).toEqual([
      { gridX: 10, gridY: 9 },
      { gridX: 10, gridY: 8 },
      { gridX: 9, gridY: 9 },
    ]);
    // Rung 0 fits both members (the threshold motivates the sconce — NO wall
    // neighbour required) → the band-end pair, as-is.
    expect(firstPlaceableDoorwayPair(grid, new Set(), new Set(), [], ladders)).toEqual({
      tiles: [
        { gridX: 10, gridY: 9 },
        { gridX: 10, gridY: 11 },
      ],
    });
    // A chest on member 0's band end (the seeds 1/42 aperture (39,49)
    // pattern — `occupied` key `${gridY},${gridX}`): rung 0 is void for the
    // pair → BOTH members step OUTWARD together: (10,8) and (10,12), both at
    // axis distance 2, opposite sides — mirror-symmetric (the addendum's
    // coordinated-outward pair; member 1 leaves its placeable band end).
    const chestOnBandEnd = new Set(['9,10']);
    const outward = firstPlaceableDoorwayPair(grid, chestOnBandEnd, new Set(), [], ladders);
    expect(outward).toEqual({
      tiles: [
        { gridX: 10, gridY: 8 },
        { gridX: 10, gridY: 12 },
      ],
    });
    // Member 1's outward rung blocked too (an exit prop on (10,12) — the
    // 0xdeadbeef aperture pattern): the pair cannot take rung 1 together →
    // BOTH advance to rung 2 (travel-inward). NEVER mixed stepping: member 0
    // does not keep its free outward tile while member 1 steps inward.
    const outwardBlocked = new Set(['9,10', '12,10']);
    expect(firstPlaceableDoorwayPair(grid, outwardBlocked, new Set(), [], ladders)).toEqual({
      tiles: [
        { gridX: 9, gridY: 9 },
        { gridX: 9, gridY: 11 },
      ],
    });
    // Every rung of member 1 blocked, every free tile for member 0 sits on a
    // DIFFERENT rung → NO common rung: the pair is undefined and the solo
    // fallback keeps member 0's band end (rung 0) — the sibling-only single
    // light, audited `doorwayAsymmetric` (the 0xdeadbeef exit-blocked mouth).
    const soloForMember0 = new Set(['11,10', '12,10', '11,9']);
    expect(firstPlaceableDoorwayPair(grid, soloForMember0, new Set(), [], ladders)).toBeUndefined();
    expect(firstPlaceableDoorwaySoloTiles(grid, soloForMember0, new Set(), [], ladders)).toEqual([
      { gridX: 10, gridY: 9 },
    ]);
    // No common rung but BOTH members hold a solo rung (member 0 only
    // travel-inward, member 1 only its band end — member 1's outward rung
    // blocked so rung 1 fits neither... the seeds 1/42 mixed mouths): the
    // solo fallback places BOTH, a mirror-preserving mixed pair (both at
    // axis distance 1, opposite sides).
    const mixedSolo = new Set(['9,10', '12,10', '11,9']);
    expect(firstPlaceableDoorwayPair(grid, mixedSolo, new Set(), [], ladders)).toBeUndefined();
    expect(firstPlaceableDoorwaySoloTiles(grid, mixedSolo, new Set(), [], ladders)).toEqual([
      { gridX: 9, gridY: 9 },
      { gridX: 10, gridY: 11 },
    ]);
    // A fully blocked mouth (every rung of both members claimed): nothing is
    // placed at all — no pair, no survivors — the aperture stays unlit and
    // audited asymmetric.
    const fullyBlocked = new Set(['9,10', '8,10', '9,9', '11,10', '12,10', '11,9']);
    expect(firstPlaceableDoorwayPair(grid, fullyBlocked, new Set(), [], ladders)).toBeUndefined();
    expect(firstPlaceableDoorwaySoloTiles(grid, fullyBlocked, new Set(), [], ladders)).toEqual([]);
    // Spacing participates in placeability: a light Manhattan 1 from member
    // 0's band end voids rung 0, and one Manhattan 1 from member 1's outward
    // tile voids rung 1 → the pair takes rung 2 together.
    const spacingBlocked = [
      { gridX: 11, gridY: 9, kind: 'torch', rotation: 0, flipH: false, flipV: false },
      { gridX: 10, gridY: 13, kind: 'torch', rotation: 0, flipH: false, flipV: false },
    ] as const;
    expect(firstPlaceableDoorwayPair(grid, new Set(), new Set(), spacingBlocked, ladders)).toEqual({
      tiles: [
        { gridX: 9, gridY: 9 },
        { gridX: 9, gridY: 11 },
      ],
    });
  });

  it('fill candidates are offered route-adjacent first (stable partition)', () => {
    const candidates = [
      { gridX: 30, gridY: 10 }, // far from the line
      { gridX: 10, gridY: 10 }, // ON the line (0,10)→(19,10)
      { gridX: 31, gridY: 11 },
    ];
    const lines = new Map([['0,0', [{ fromX: 0, fromY: 10, toX: 19, toY: 10 }]]]);
    const ordered = orderFillCandidatesRouteFirst(candidates, lines);
    expect(ordered[0]).toMatchObject({ gridX: 10, gridY: 10 }); // route-adjacent first
    expect(
      ordered
        .slice(1)
        .map((c) => c.gridX)
        .sort(),
    ).toEqual([30, 31]);
  });
});

// ─── Dark pockets (DEC-005 #4) ────────────────────────────────────────────────

describe('LightHierarchy — dark pockets (per-tier fill removal + raised thresholds)', () => {
  it('the per-tier table encodes the DEC-005 parameters (data-side tuning)', () => {
    // COLD: the fill pass is REMOVED entirely.
    expect(SECTOR_TIER_LIGHT_PARAMS.COLD.darkGapFillEnabled).toBe(false);
    // Elsewhere the threshold is RAISED above the legacy 14.
    expect(SECTOR_TIER_LIGHT_PARAMS.HOT.darkGapFillEnabled).toBe(true);
    expect(SECTOR_TIER_LIGHT_PARAMS.HOT.fillGapSpacing).toBeGreaterThan(14);
    expect(SECTOR_TIER_LIGHT_PARAMS.WARM.darkGapFillEnabled).toBe(true);
    expect(SECTOR_TIER_LIGHT_PARAMS.WARM.fillGapSpacing).toBeGreaterThan(
      SECTOR_TIER_LIGHT_PARAMS.HOT.fillGapSpacing,
    );
    // The mood gradient: HOT (brightest) gets the most route lining.
    expect(SECTOR_TIER_LIGHT_PARAMS.HOT.routeSconceCap).toBeGreaterThanOrEqual(
      SECTOR_TIER_LIGHT_PARAMS.WARM.routeSconceCap,
    );
  });

  it('isDarkGap honors the per-tier threshold parameter', () => {
    const placed = [
      { gridX: 0, gridY: 0, kind: 'torch' as const, rotation: 0, flipH: false, flipV: false },
    ];
    // A tile 15 away: a gap at the legacy 14, no longer a gap at WARM 18.
    expect(isDarkGap(0, 15, placed, 14)).toBe(true);
    expect(isDarkGap(0, 15, placed, 18)).toBe(false);
  });

  it('COLD sectors receive ZERO dark-gap fill sconces (identical grid, same seed)', () => {
    // Two identical synthetic maps — one all-COLD, one all-WARM tiers, same
    // seed. With no landmarks/chests/connections, the only sconce source is
    // the dark-gap fill along the border walls (the corner nooks may still
    // earn a signature crystal — that is the accent anchor, not fill).
    const isFillSconce = (p: { kind: string }) => p.kind !== 'campfire' && p.kind !== 'biome-glow';
    const warmRun = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA],
      seed: 301,
      tiers: [[SectorLootTier.WARM]],
    });
    const coldRun = placeHierarchyMap({
      sectorTypes: [SectorType.GRID_ARENA],
      seed: 301,
      tiers: [[SectorLootTier.COLD]],
    });
    expect(warmRun.filter(isFillSconce).length).toBeGreaterThan(0); // fill fired in WARM
    expect(coldRun.filter(isFillSconce)).toHaveLength(0); // REMOVED in COLD
  });

  it('same seed ⇒ byte-identical placements (determinism contract, ADR 0035)', () => {
    const opts: HierarchyMapOptions = {
      sectorTypes: [SectorType.GRID_ARENA, SectorType.MAZE, SectorType.RESOURCE_RICH],
      seed: 302,
      tiers: [[SectorLootTier.HOT, SectorLootTier.WARM, SectorLootTier.COLD]],
      heroAnchors: [
        { x: 5, y: 5 },
        { x: 10, y: 12 },
        { x: 15, y: 8 },
      ],
      chests: [
        { gridX: 3, gridY: 3 },
        { gridX: 4, gridY: 3 },
        { gridX: 44, gridY: 16 },
        { gridX: 45, gridY: 16 },
      ],
      connections: [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
    };
    const a = placeHierarchyMap(opts);
    const b = placeHierarchyMap(opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });
});

/** Chebyshev distance from (x,y) to the segment — test-side mirror. */
function pointToSegmentCheb(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / lenSq));
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  return Math.max(Math.abs(x - px), Math.abs(y - py));
}

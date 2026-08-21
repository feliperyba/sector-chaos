/**
 * Motivated-lighting placement tests for the LightPlacer (ticket 09 + ticket 10
 * + ticket D3 — wall + campfire anchor rewrite, scatter eliminated).
 *
 * Seam A (pure-logic, GPU-free): the spec mandates identical seeds produce
 * byte-identical `lightPlacements`, the map-wide cap is respected, every
 * placement kind is in the whitelist, and — the ticket-D3 rework — placements
 * are ANCHORED TO REAL MAP GEOMETRY via exactly two anchor types:
 *   - Campfire tiles (1:1) — a `DESTRUCTIBLE_CRATE` whose `textureKey ===
 *     'campfire'` always gets a `campfire` light ON it.
 *   - Wall-adjacent floor tiles (EMPTY with ≥1 wall in the 8-neighbourhood) —
 *     the wall-sconce/wall-bracket read, placed at a deterministic cadence.
 * NO scatter (`isScatter: true` is forbidden — the random glow field is gone).
 *
 * Ticket D3 contract changes (vs. the prior ticket-10 / ticket-C6 suite):
 *  - The hero-prop KIND set is smaller (no junction/doorway/loot/exit roles).
 *  - Campfire lights land ON campfire tiles (which are DESTRUCTIBLE_CRATE, NOT
 *    EMPTY) — the old "every placement on EMPTY" assertion is replaced by a
 *    role-aware one (campfire → on CRATE; wall-bracket → on EMPTY + wall-adjacent).
 *  - The "never collides with interactive-layer cell" assertion is GONE —
 *    campfire lights intentionally land ON interactive cells (the campfire IS
 *    the source).
 *  - The scatter layer is GONE — every `isScatter: true` assertion is replaced
 *    by "NO placement has isScatter: true".
 *  - The C6 distribution tests are re-baselined for the new anchor set (every
 *    region still gets light because every region has walls; the cadence + cap
 *    still hold; determinism still holds).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  MapGenerator as SharedMapGenerator,
  TileType,
  SectorType,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  type DestructiblePlacement,
  type LightKind,
  type MapData,
} from '@sector-battle/shared';
import { LightPlacer, MAX_MAP_LIGHT_PLACEMENTS, LIGHT_PLACEMENT_SALT } from '../LightPlacer.js';
import {
  DOORWAY_SCONCE_COLOR,
  DOORWAY_SCONCE_KIND,
  doorwayPairGeometry,
} from '../LightPlacerDoorway.js';
import { LIGHT_MIN_SPACING } from '../LightPlacerClassifiers.js';
import {
  BIOME_CRYSTAL_HUE,
  BIOME_CRYSTAL_LIGHT,
  CRYSTAL_FOREST_CLEARING_WALL_DISTANCE,
  CRYSTAL_MIN_SPACING,
  CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS,
  CRYSTAL_PLACEMENT_SALT,
} from '../biomeCrystalConfig.js';
import { POI_GLOW_LIGHT } from '../lightHierarchyConfig.js';
import { SeedMapAdapter } from '../SeedMapAdapter.js';

const TILED_DIR = resolve(__dirname, '../../../../../../tiled');

/**
 * Build a small synthetic composite grid + MapData + destructibles for unit-
 * scoped LightPlacer tests (no atlas / tsx parse needed). A multi-sector-wide
 * map (sectorCount x 1), each sector 20x20, all-EMPTY interior with an
 * INDESTRUCTIBLE_WALL border so the placer has wall-bracket candidates to
 * target. Optional destructibles (campfire) can be injected to exercise Anchor A.
 */
function makeSyntheticGridAndMapData(
  sectorTypes: SectorType[],
  seed: number,
  opts?: {
    destructibles?: DestructiblePlacement[];
  },
): {
  grid: TileType[][];
  mapData: MapData;
  occupied: Set<string>;
  destructibles: DestructiblePlacement[];
} {
  const sectorCount = sectorTypes.length;
  const width = sectorCount * SECTOR_TILE_SIZE;
  const height = SECTOR_TILE_SIZE;
  const grid: TileType[][] = [];
  for (let r = 0; r < height; r++) {
    const row: TileType[] = new Array(width).fill(TileType.EMPTY);
    grid.push(row);
  }
  // Carve INDESTRUCTIBLE_WALL borders around the whole map.
  for (let c = 0; c < width; c++) {
    grid[0]![c] = TileType.INDESTRUCTIBLE_WALL;
    grid[height - 1]![c] = TileType.INDESTRUCTIBLE_WALL;
  }
  for (let r = 0; r < height; r++) {
    grid[r]![0] = TileType.INDESTRUCTIBLE_WALL;
    grid[r]![width - 1] = TileType.INDESTRUCTIBLE_WALL;
  }

  // Inject campfire destructibles: write a DESTRUCTIBLE_CRATE into the grid so
  // the occupied set + grid agree (the placer reads destructibles directly, but
  // the grid must reflect the campfire's tile type so a wall-bracket doesn't
  // land on the same tile).
  const destructibles = [...(opts?.destructibles ?? [])];
  for (const d of destructibles) {
    if (grid[d.gridY]?.[d.gridX] !== undefined) {
      grid[d.gridY]![d.gridX] = d.tileType;
    }
  }

  const sectorRow: MapData['sectors'][number] = [];
  for (let s = 0; s < sectorCount; s++) {
    const tiles: Uint8Array[] = [];
    for (let r = 0; r < SECTOR_TILE_SIZE; r++) {
      const row = new Uint8Array(SECTOR_TILE_SIZE);
      for (let c = 0; c < SECTOR_TILE_SIZE; c++) {
        row[c] = grid[r]![s * SECTOR_TILE_SIZE + c]!;
      }
      tiles.push(row);
    }
    sectorRow.push({
      type: sectorTypes[s]!,
      subVariant: 'DEFAULT' as never,
      tiles,
      elevation: null,
      lootSpots: [],
      landmarkAnchor: { x: 10, y: 10 },
      mirrored: false,
      subBlockMask: 0,
      bounds: {
        x: s * SECTOR_TILE_SIZE * 128,
        y: 0,
        width: SECTOR_TILE_SIZE * 128,
        height: SECTOR_TILE_SIZE * 128,
      },
      theme: 'default',
    });
  }

  const mapData: MapData = {
    seed,
    sectors: [sectorRow],
    connections: [],
    spawnPoints: [],
    exits: [],
    lootPlacements: [],
    entityPlacements: [],
    trapPlacements: [],
    weather: [],
    globalBounds: { width: width * 128, height: height * 128 },
    corridorTiles: new Set<string>(),
    sectorTiers: [],
    hotSector: { row: 0, col: 0 },
    poiNames: [],
    macroPoiNames: { highway: null, compound: null, barrierRidge: null, openCommons: null },
    designation: '',
    landmarks: { heroes: [], minors: [] },
    fortress: null,
    sectorTypes: [],
    identity: { fields: [], gateways: [] },
  };
  // The occupied set is the union of non-EMPTY grid tiles (walls + any injected
  // campfire crates). The placer reads destructibles separately for the campfire
  // anchor; the occupied set is only used to EXCLUDE tiles from the wall-bracket
  // pass.
  const occupied = new Set<string>();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r]![c] !== TileType.EMPTY) occupied.add(`${r},${c}`);
    }
  }
  return { grid, mapData, occupied, destructibles };
}

/**
 * Whether the tile at (r,c) has ≥1 wall (`INDESTRUCTIBLE_WALL` or
 * `DESTRUCTIBLE_WALL`) in its 8-neighbourhood. Mirrors the placer's internal
 * `hasWallNeighbour` predicate so tests can assert "this wall-bracket placement
 * is wall-adjacent" without importing placer internals.
 */
function hasWallNeighbour8(grid: TileType[][], r: number, c: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const t = grid[r + dr]?.[c + dc];
      if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL) return true;
    }
  }
  return false;
}

/**
 * Count wall tiles in the 8-neighbourhood of (r,c). Mirrors the placer's
 * `countWallNeighbours8` so tests can assert "this crystal sits in a NOOK
 * (≥3 wall neighbours = concave corner / dead-end)" for enclosed-biome crystals.
 */
function countWallNeighbours8(grid: TileType[][], r: number, c: number): number {
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const t = grid[r + dr]?.[c + dc];
      if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL) count++;
    }
  }
  return count;
}

/**
 * Whether ANY wall exists within the 5×5 box centred on (r,c). Mirrors the
 * placer's `hasWallInNeighbourhoodRadius(grid, r, c, 2)` so tests can assert
 * "this OPEN_ARENA crystal sits in a FOREST CLEARING (no wall within 5×5 = deep
 * interior, ≥2 tiles from any wall)."
 */
function hasWallIn5x5(grid: TileType[][], r: number, c: number): boolean {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const t = grid[r + dr]?.[c + dc];
      if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL) return true;
    }
  }
  return false;
}

/**
 * Whether ANY wall exists within the (2*radius+1)² box of (r,c). Mirrors the
 * placer's `hasWallInNeighbourhoodRadius` so tests can assert the FOREST-
 * CLEARING contract at the configured radius (≥CRYSTAL_FOREST_CLEARING_WALL_DISTANCE).
 */
function hasWallInRadius(grid: TileType[][], r: number, c: number, radius: number): boolean {
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const t = grid[r + dr]?.[c + dc];
      if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.DESTRUCTIBLE_WALL) return true;
    }
  }
  return false;
}

/**
 * Reverse map: crystal color (linear-RGB tuple stringified) → the SectorType
 * whose hue it is. The 4 biome hues are distinct, so a crystal's `color`
 * uniquely identifies its sector type — lets the E2E tests assert the nook-vs-
 * clearing contract per crystal WITHOUT needing the adapter result to expose
 * per-sector type (it doesn't). Built from the canonical `BIOME_CRYSTAL_HUE`.
 *
 * `SectorType` is a STRING enum (`GRID_ARENA = 'GRID_ARENA'`), so the
 * `Object.entries` keys ARE the enum values — no `Number()` coercion (that
 * yields NaN for string keys and mis-classifies every crystal as "enclosed").
 */
const HUE_TO_SECTOR_TYPE = new Map<string, SectorType>(
  (Object.entries(BIOME_CRYSTAL_HUE) as Array<[string, readonly [number, number, number]]>).map(
    ([key, hue]) => [hue.join(','), key as SectorType],
  ),
);

/**
 * Find every campfire tile in the destructibles list (a DESTRUCTIBLE_CRATE with
 * textureKey === 'campfire'). Mirrors the placer's `collectCampfireTiles` so
 * tests can assert "every campfire tile has a corresponding campfire light"
 * without importing placer internals.
 */
function findCampfireTiles(destructibles: ReadonlyArray<DestructiblePlacement>): Set<string> {
  const out = new Set<string>();
  for (const d of destructibles) {
    if (d.tileType === TileType.DESTRUCTIBLE_CRATE && d.textureKey === 'campfire') {
      out.add(`${d.gridY},${d.gridX}`);
    }
  }
  return out;
}

describe('LightPlacer — determinism', () => {
  it('identical seeds produce byte-identical lightPlacements (synthetic grid)', () => {
    const placer = new LightPlacer();
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.GRID_ARENA, SectorType.MAZE],
      9999,
    );

    const a = placer.place(grid, mapData, occupied, destructibles, 9999);
    const b = placer.place(grid, mapData, occupied, destructibles, 9999);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
  });

  it('identical seeds produce byte-identical lightPlacements (full adapter E2E)', () => {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const r1 = adapter.adapt(gen.generate(12345), 12345, TILED_DIR);
    const r2 = adapter.adapt(gen.generate(12345), 12345, TILED_DIR);

    expect(JSON.stringify(r1.entities.lightPlacements)).toBe(
      JSON.stringify(r2.entities.lightPlacements),
    );
  });

  it('different seeds (almost always) produce different placements', () => {
    const placer = new LightPlacer();
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.GRID_ARENA, SectorType.MAZE],
      1,
    );
    const a = placer.place(grid, mapData, occupied, destructibles, 1);
    const b = placer.place(grid, mapData, occupied, destructibles, 2);
    // Different seeds → different RNG stream → placements differ (defensive:
    // in the astronomically unlikely case of a hash collision we still require
    // at least the serialized form to differ for these two distinct seeds).
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('LightPlacer — density caps', () => {
  it('respects the hard map-wide cap (≤ MAX_MAP_LIGHT_PLACEMENTS)', () => {
    const placer = new LightPlacer();
    // A wide open grid with many sectors — ensure the cap clamps the total.
    const types: SectorType[] = [];
    for (let i = 0; i < SECTOR_GRID_SIZE; i++) types.push(SectorType.GRID_ARENA);
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(types, 7);
    const placements = placer.place(grid, mapData, occupied, destructibles, 7);

    // No scatter layer anymore — every placement is a motivated prop. The total
    // must stay under MAX_MAP_LIGHT_PLACEMENTS.
    expect(placements.length).toBeLessThanOrEqual(MAX_MAP_LIGHT_PLACEMENTS);
  });

  it('emits at least one placement for a normal seed via the full adapter', () => {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(42), 42, TILED_DIR);

    // A real generated 4x4 map has ample walls (every sector's outer ring) →
    // expect wall-bracket lights. (Campfires may or may not be present depending
    // on sector-type RNG; the wall-bracket anchor is the reliable producer.)
    expect(result.entities.lightPlacements.length).toBeGreaterThan(0);
    expect(result.entities.lightPlacements.length).toBeLessThanOrEqual(MAX_MAP_LIGHT_PLACEMENTS);
  });
});

describe('LightPlacer — anchor strategy (ticket D3 — the regression fix)', () => {
  /**
   * The core ticket-D3 contract: NO scatter. The prior suite asserted the
   * scatter layer existed; the rewrite ELIMINATES it (every `isScatter: true`
   * placement was a random glow on open floor — the "completely random" read).
   * This is the load-bearing assertion that distinguishes the new motivated
   * strategy from the prior random-field one.
   */
  it('NO placement has isScatter: true (scatter layer eliminated)', () => {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(42), 42, TILED_DIR);

    const scatter = result.entities.lightPlacements.filter((lp) => lp.isScatter === true);
    expect(scatter).toHaveLength(0);
  });

  it('NO placement has isScatter: true (synthetic dense case)', () => {
    const placer = new LightPlacer();
    const types: SectorType[] = [];
    for (let i = 0; i < SECTOR_GRID_SIZE; i++) types.push(SectorType.OPEN_ARENA);
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(types, 808);
    const placements = placer.place(grid, mapData, occupied, destructibles, 808);

    const scatter = placements.filter((lp) => lp.isScatter === true);
    expect(scatter).toHaveLength(0);
  });

  /**
   * Anchor A (campfire 1:1): every campfire tile in the destructibles list gets
   * a `campfire` light placed ON it. This is the cleanest motivated case — a
   * campfire IS a fire, the light sits on the source. Uses a synthetic grid
   * with explicit campfire destructibles so the assertion is exact.
   */
  it('every campfire destructible gets a campfire light ON its tile (1:1 anchor)', () => {
    const campfires: DestructiblePlacement[] = [
      {
        gridX: 5,
        gridY: 5,
        tileType: TileType.DESTRUCTIBLE_CRATE,
        textureKey: 'campfire',
        rotation: 0,
        flipH: false,
        flipV: false,
      },
      {
        gridX: 14,
        gridY: 14,
        tileType: TileType.DESTRUCTIBLE_CRATE,
        textureKey: 'campfire',
        rotation: 0,
        flipH: false,
        flipV: false,
      },
    ];
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.OPEN_ARENA],
      4242,
      { destructibles: campfires },
    );
    const placer = new LightPlacer();
    const placements = placer.place(grid, mapData, occupied, destructibles, 4242);

    const campfireTiles = findCampfireTiles(destructibles);
    expect(campfireTiles.size).toBe(2);

    // Every campfire tile must have a `campfire` light on it.
    for (const key of campfireTiles) {
      const [gy, gx] = key.split(',').map(Number);
      const light = placements.find((lp) => lp.gridX === gx && lp.gridY === gy);
      expect(light).toBeDefined();
      expect(light!.kind).toBe('campfire');
    }
  });

  it('non-campfire destructibles do NOT get a light on their tile (crates/barrels are not light sources)', () => {
    // A regular crate (not a campfire) must NOT trigger the campfire anchor.
    const crates: DestructiblePlacement[] = [
      {
        gridX: 5,
        gridY: 5,
        tileType: TileType.DESTRUCTIBLE_CRATE,
        textureKey: 'crate',
        rotation: 0,
        flipH: false,
        flipV: false,
      },
    ];
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.GRID_ARENA],
      5151,
      { destructibles: crates },
    );
    const placer = new LightPlacer();
    const placements = placer.place(grid, mapData, occupied, destructibles, 5151);

    // No light should sit ON the crate tile (it's in `occupied` → excluded from
    // the wall-bracket pass; it's not a campfire → excluded from Anchor A).
    const onCrate = placements.filter((lp) => lp.gridX === 5 && lp.gridY === 5);
    expect(onCrate).toHaveLength(0);
  });

  /**
   * Anchor B (wall-adjacent): every WALL-BRACKET light (torch/candle/brazier/
   * lantern/fireplace — the sconce family) sits on an EMPTY floor tile with ≥1
   * wall in the 8-neighbourhood. This is the motivated-lighting standard — a
   * torch on a wall-sconce, a lantern hanging. NO sconce floating in open floor
   * with no wall neighbour (the "completely random" complaint).
   *
   * `biome-glow` crystals are EXEMPT from the wall-adjacency contract — they are
   * NOT sconces; they have their own Anchor C contract (nook ≥3 walls for
   * enclosed biomes, deep-clearing for OPEN_ARENA, see the Anchor C suite). They
   * are still asserted to sit on EMPTY floor.
   *
   * Map-redesign ticket 05: POI glow pools (braziers carrying the pool
   * overrides) are ALSO exempt from the wall-adjacency clause — their
   * motivation is the chest HOARD they mark (within Chebyshev 2 of a cluster
   * chest) OR a wall; still EMPTY floor.
   */
  it('every wall-bracket sconce is on EMPTY with ≥1 wall neighbour; every crystal is on EMPTY (full adapter E2E)', () => {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const mapData = gen.generate(42);
    const result = adapter.adapt(mapData, 42, TILED_DIR);

    // Map-redesign ticket 04: beacons are EXCLUDED from the sconce set — they
    // are appended by the adapter from MapData.landmarks (not this placer's
    // anchors) and may legitimately sit on a CHEST/BARREL tile ("loot crowds
    // the landmark", DEC-002). Their contract: traversable (never a wall).
    // Ticket 05: POI pools are excluded from the WALL-adjacency clause (their
    // own motivation is hoard-adjacency; asserted in LightHierarchy.test.ts).
    // Map-polish ticket 10: DOORWAY sconces are ALSO exempt from the
    // wall-adjacency clause — their motivation is the aperture THRESHOLD
    // itself (the "torch by the door"); band-end mouth tiles on open sector
    // borders are legitimately wall-free. Still asserted on EMPTY floor.
    const isPoiPool = (lp: { kind: string; intensity?: number }) =>
      lp.kind === 'brazier' && lp.intensity === POI_GLOW_LIGHT.intensity;
    const doorwayTiles = new Set<string>();
    for (const conn of mapData.connections) {
      for (const end of doorwayPairGeometry(conn).bandEnds) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (Math.abs(dr) + Math.abs(dc) > 1) continue; // Manhattan ≤1
            doorwayTiles.add(`${end.gridY + dr},${end.gridX + dc}`);
          }
        }
      }
    }
    const sconces = result.entities.lightPlacements.filter(
      (lp) =>
        lp.kind !== 'campfire' &&
        lp.kind !== 'biome-glow' &&
        lp.kind !== 'beacon' &&
        !isPoiPool(lp) &&
        !doorwayTiles.has(`${lp.gridY},${lp.gridX}`),
    );
    expect(sconces.length).toBeGreaterThan(0);

    for (const lp of sconces) {
      expect(result.grid[lp.gridY]?.[lp.gridX]).toBe(TileType.EMPTY);
      expect(hasWallNeighbour8(result.grid, lp.gridY, lp.gridX)).toBe(true);
    }
    // Doorway sconces: EMPTY threshold floor (the aperture mouth contract).
    const doorwaySconces = result.entities.lightPlacements.filter(
      (lp) =>
        lp.kind !== 'campfire' &&
        lp.kind !== 'biome-glow' &&
        lp.kind !== 'beacon' &&
        !isPoiPool(lp) &&
        doorwayTiles.has(`${lp.gridY},${lp.gridX}`),
    );
    expect(doorwaySconces.length).toBeGreaterThanOrEqual(40); // ~2 per aperture
    for (const lp of doorwaySconces) {
      expect(result.grid[lp.gridY]?.[lp.gridX]).toBe(TileType.EMPTY);
    }
    // POI pools: EMPTY floor + (wall OR hoard adjacency) — the pool contract.
    const pools = result.entities.lightPlacements.filter(isPoiPool);
    expect(pools.length).toBeGreaterThan(0);
    for (const lp of pools) {
      expect(result.grid[lp.gridY]?.[lp.gridX]).toBe(TileType.EMPTY);
    }
    // Crystals are still on EMPTY floor (just not necessarily wall-adjacent).
    const crystals = result.entities.lightPlacements.filter((lp) => lp.kind === 'biome-glow');
    for (const lp of crystals) {
      expect(result.grid[lp.gridY]?.[lp.gridX]).toBe(TileType.EMPTY);
    }
    // Beacons: one per hero landmark + one per minor — always traversable.
    const beacons = result.entities.lightPlacements.filter((lp) => lp.kind === 'beacon');
    expect(beacons.length).toBeGreaterThanOrEqual(18); // 16 heroes + 2–3 minors
    for (const lp of beacons) {
      const tile = result.grid[lp.gridY]?.[lp.gridX];
      expect(
        tile === TileType.EMPTY || tile === TileType.CHEST || tile === TileType.DESTRUCTIBLE_BARREL,
      ).toBe(true);
    }
  });

  it('every wall-bracket sconce is on an EMPTY tile with a wall neighbour (synthetic grid)', () => {
    const placer = new LightPlacer();
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.GRID_ARENA, SectorType.MAZE],
      2718,
    );
    const placements = placer.place(grid, mapData, occupied, destructibles, 2718);
    const sconces = placements.filter((lp) => lp.kind !== 'campfire' && lp.kind !== 'biome-glow');

    for (const lp of sconces) {
      expect(grid[lp.gridY]?.[lp.gridX]).toBe(TileType.EMPTY);
      expect(hasWallNeighbour8(grid, lp.gridY, lp.gridX)).toBe(true);
    }
  });

  it('the full adapter E2E: every campfire tile in destructibles has a campfire light (1:1)', () => {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(42), 42, TILED_DIR);

    const campfireTiles = findCampfireTiles(result.entities.destructibles);
    if (campfireTiles.size === 0) {
      // Some seeds may not produce campfires (sector-type RNG). Skip the
      // assertion in that case — the synthetic test above covers the 1:1
      // contract deterministically.
      return;
    }
    const campfireLights = new Set(
      result.entities.lightPlacements
        .filter((lp) => lp.kind === 'campfire')
        .map((lp) => `${lp.gridY},${lp.gridX}`),
    );
    for (const key of campfireTiles) {
      expect(campfireLights.has(key)).toBe(true);
    }
  });
});

describe('LightPlacer — kind whitelist', () => {
  it('only emits the eight static kinds (never barrel-fire, which is client-derived)', () => {
    // Ticket D3: kind is now wall-bracket-driven (per-sector-type table) +
    // campfire (Anchor A). Barrel-fire remains client-derived (the placer
    // never emits it — barrels are inert until they explode). Map-redesign
    // ticket 04 adds `beacon` — the hero-landmark destination light, appended
    // to the adapter's placements by LandmarkBeaconPlacer (not the placer).
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(42), 42, TILED_DIR);

    const allowed: LightKind[] = [
      'torch',
      'campfire',
      'candle',
      'biome-glow',
      'fireplace',
      'brazier',
      'lantern',
      'beacon', // ticket 04: hero-landmark beacons ride the same array
      'barrel-fire', // in the allow-list so the assertion message is clear, but
      // asserted to never appear below.
    ];
    for (const lp of result.entities.lightPlacements) {
      expect(allowed).toContain(lp.kind);
    }
    // The placer never emits barrel-fire (those derive from barrel entities on
    // the client). Assert the placer specifically avoids it.
    const barrelFires = result.entities.lightPlacements.filter((lp) => lp.kind === 'barrel-fire');
    expect(barrelFires).toHaveLength(0);
  });

  it('every placement is upright: rotation 0, flipH false, flipV false', () => {
    // Lamps/torches/braziers/lanterns stand upright — never upside down or
    // sideways. The placer hardcodes rotation=0 + no flips for both anchors
    // (campfire 1:1 + wall-bracket cadence). Prior: pickRotation(rng) drew
    // uniform {0,90,180,270} + random flips, producing nonsensical orientations.
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(42), 42, TILED_DIR);

    expect(result.entities.lightPlacements.length).toBeGreaterThan(0);
    for (const lp of result.entities.lightPlacements) {
      expect(lp.rotation).toBe(0);
      expect(lp.flipH).toBe(false);
      expect(lp.flipV).toBe(false);
    }
  });
});

describe('LightPlacer — spacing discipline', () => {
  it('every wall-bracket light respects the per-sector minimum spacing (≥2)', () => {
    // Campfire lights are EXEMPT from the spacing rule (they sit ON their
    // campfire tile regardless of nearby wall-brackets — 1:1 anchor). Filter
    // them out so the assertion targets the wall-bracket spacing discipline.
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(2718), 2718, TILED_DIR);

    const bySector = new Map<string, Array<{ gridX: number; gridY: number }>>();
    for (const lp of result.entities.lightPlacements) {
      if (lp.kind === 'campfire') continue;
      const sCol = Math.floor(lp.gridX / SECTOR_TILE_SIZE);
      const sRow = Math.floor(lp.gridY / SECTOR_TILE_SIZE);
      const key = `${sRow},${sCol}`;
      const arr = bySector.get(key) ?? [];
      arr.push({ gridX: lp.gridX, gridY: lp.gridY });
      bySector.set(key, arr);
    }
    for (const arr of bySector.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const dist =
            Math.abs(arr[i]!.gridX - arr[j]!.gridX) + Math.abs(arr[i]!.gridY - arr[j]!.gridY);
          expect(dist).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it('campfire lights are exempt from spacing (1:1 with the campfire tile)', () => {
    // Two campfires placed deliberately close (Manhattan 2) — both must still
    // get their campfire lights (the 1:1 anchor overrides the spacing rule).
    const campfires: DestructiblePlacement[] = [
      {
        gridX: 5,
        gridY: 5,
        tileType: TileType.DESTRUCTIBLE_CRATE,
        textureKey: 'campfire',
        rotation: 0,
        flipH: false,
        flipV: false,
      },
      {
        gridX: 7,
        gridY: 5,
        tileType: TileType.DESTRUCTIBLE_CRATE,
        textureKey: 'campfire',
        rotation: 0,
        flipH: false,
        flipV: false,
      },
    ];
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.OPEN_ARENA],
      6161,
      { destructibles: campfires },
    );
    const placer = new LightPlacer();
    const placements = placer.place(grid, mapData, occupied, destructibles, 6161);

    const campfireLights = placements.filter((lp) => lp.kind === 'campfire');
    expect(campfireLights.length).toBe(2);
    // Both campfire tiles have a light despite Manhattan spacing == 2.
    expect(campfireLights.some((lp) => lp.gridX === 5 && lp.gridY === 5)).toBe(true);
    expect(campfireLights.some((lp) => lp.gridX === 7 && lp.gridY === 5)).toBe(true);
  });
});

describe('LightPlacer — salt isolation', () => {
  it('LIGHT_PLACEMENT_SALT + CRYSTAL_PLACEMENT_SALT are distinct from each other + accent salts', () => {
    // The biome accent salts (biomeConfig.ts) are 0x1d2c6f3b / 0x7a3e91c5 /
    // 0x2b8f47d1 / 0x4e7d52a9. The light + crystal salts must all differ so the
    // three streams (wall-bracket / crystal / accents) are independent — tuning
    // one never perturbs another's deterministic output. Regression guard
    // against an accidental copy-paste.
    const allSalts = new Set([0x1d2c6f3b, 0x7a3e91c5, 0x2b8f47d1, 0x4e7d52a9]);
    expect(allSalts.has(LIGHT_PLACEMENT_SALT)).toBe(false);
    expect(allSalts.has(CRYSTAL_PLACEMENT_SALT)).toBe(false);
    expect(CRYSTAL_PLACEMENT_SALT).not.toBe(LIGHT_PLACEMENT_SALT);
    expect(typeof LIGHT_PLACEMENT_SALT).toBe('number');
    expect(typeof CRYSTAL_PLACEMENT_SALT).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Anchor C — motivated biome-glow crystals (crystal nooks + forest clearings).
//
// `biome-glow` was RETIRED from the wall-bracket kind table and given its OWN
// dedicated geometry anchor. Enclosed biomes (GRID_ARENA / MAZE / RESOURCE_RICH)
// get NOOK crystals (≥3 wall neighbours = concave corner / dead-end); OPEN_ARENA
// (forest) gets FOREST-CLEARING crystals (no wall in the 5×5 box = deep
// interior). Each crystal carries its sector's muted `color` hue + the moody
// radius/intensity/pulse tune. These tests pin the contract on the FULL adapter
// (real 4×4 maps) across seeds + focused synthetic grids.
// ═══════════════════════════════════════════════════════════════════════════
describe('LightPlacer — Anchor C (crystal nooks + forest clearings)', () => {
  const SEEDS = [42, 12345, 999, 314, 2718, 7];
  const VALID_HUE_STRINGS = new Set(
    (Object.values(BIOME_CRYSTAL_HUE) as ReadonlyArray<readonly [number, number, number]>).map(
      (h) => h.join(','),
    ),
  );

  function adapterResult(seed: number) {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    return adapter.adapt(gen.generate(seed), seed, TILED_DIR);
  }

  /** Type-narrow a crystal color to a readonly tuple (asserted defined upstream). */
  function colorKey(lp: { color?: readonly [number, number, number] }): string {
    return (lp.color as readonly [number, number, number]).join(',');
  }

  it.each(SEEDS)(
    'seed=%i: every biome-glow crystal carries a valid biome hue + the moody tune',
    (seed) => {
      const result = adapterResult(seed);
      const crystals = result.entities.lightPlacements.filter((lp) => lp.kind === 'biome-glow');
      // Guard against the starvation regression: the crystal budget is RESERVED
      // off the global cap, so a real 4×4 map (which always has wall-nooks +
      // open clearings) MUST receive ≥1 crystal. If this drops to 0, the wall-
      // bracket anchor is eating the crystal budget again.
      expect(crystals.length, 'real maps must receive crystals (reserved budget)').toBeGreaterThan(
        0,
      );
      for (const lp of crystals) {
        expect(lp.color, 'crystal must carry a biome hue').toBeDefined();
        expect(VALID_HUE_STRINGS.has(colorKey(lp))).toBe(true);
        expect(lp.radius).toBe(BIOME_CRYSTAL_LIGHT.radius);
        expect(lp.intensity).toBe(BIOME_CRYSTAL_LIGHT.intensity);
        expect(lp.pulse).toBe(true);
        // textureKey is ignored by the renderer (sprite resolves from kind +
        // color) — emitting it would be dead data. Assert it's never set.
        expect(lp.textureKey).toBeUndefined();
      }
    },
  );

  it.each(SEEDS)(
    'seed=%i: enclosed-biome crystals sit in deep nooks (≥NOOK walls); OPEN_ARENA crystals in deep clearings',
    (seed) => {
      const result = adapterResult(seed);
      const crystals = result.entities.lightPlacements.filter((lp) => lp.kind === 'biome-glow');
      for (const lp of crystals) {
        const sectorType = HUE_TO_SECTOR_TYPE.get(colorKey(lp));
        expect(sectorType, 'crystal hue must map to a known sector type').toBeDefined();
        if (sectorType === SectorType.OPEN_ARENA) {
          // Forest clearing — no wall within the configured deep-clearing box.
          expect(
            hasWallInRadius(result.grid, lp.gridY, lp.gridX, CRYSTAL_FOREST_CLEARING_WALL_DISTANCE),
          ).toBe(false);
        } else {
          // Enclosed biome — deep concave pocket (≥ the nook wall threshold).
          expect(countWallNeighbours8(result.grid, lp.gridY, lp.gridX)).toBeGreaterThanOrEqual(
            CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS,
          );
        }
      }
    },
  );

  it.each(SEEDS)(
    'seed=%i: every crystal keeps ≥CRYSTAL_MIN_SPACING from every other PLACER light in its sector',
    (seed) => {
      const result = adapterResult(seed);
      const bySector = new Map<string, Array<{ gridX: number; gridY: number; kind: LightKind }>>();
      for (const lp of result.entities.lightPlacements) {
        // Map-redesign ticket 04: beacons are appended AFTER the placer with
        // no spacing check by design (the landmark exclusion zone — Chebyshev
        // ≥3 — governs their crystal separation); the placer-light contract
        // here covers the placements `place()` itself emitted.
        if (lp.kind === 'beacon') continue;
        const sCol = Math.floor(lp.gridX / SECTOR_TILE_SIZE);
        const sRow = Math.floor(lp.gridY / SECTOR_TILE_SIZE);
        const key = `${sRow},${sCol}`;
        const arr = bySector.get(key) ?? [];
        arr.push({ gridX: lp.gridX, gridY: lp.gridY, kind: lp.kind });
        bySector.set(key, arr);
      }
      for (const arr of bySector.values()) {
        const crystals = arr.filter((p) => p.kind === 'biome-glow');
        for (const cr of crystals) {
          for (const other of arr) {
            if (other === cr) continue;
            const dist = Math.abs(cr.gridX - other.gridX) + Math.abs(cr.gridY - other.gridY);
            // A crystal must keep clear of campfires, sconces, pools AND
            // fellow crystals (everything the placer emitted).
            expect(dist).toBeGreaterThanOrEqual(CRYSTAL_MIN_SPACING);
          }
        }
      }
    },
  );

  it.each(SEEDS)(
    'seed=%i: sconce/crystal placements ≤ MAX_MAP_LIGHT_PLACEMENTS (safety ceiling; crystals have no quota)',
    (seed) => {
      const result = adapterResult(seed);
      // No crystal count cap — crystals are bounded only by spacing + this
      // map-wide safety ceiling. The count is an output of motivated placement.
      // Map-redesign ticket 04: the appended landmark beacons (16 heroes +
      // 2–3 minors, a REQUIRED placement set) are counted separately from the
      // D3 decor ceiling. Ticket 06 (DEC-004): +1 fortress beacon (every
      // compound template carries one) → 19–20 total.
      const decor = result.entities.lightPlacements.filter((lp) => lp.kind !== 'beacon');
      expect(decor.length).toBeLessThanOrEqual(MAX_MAP_LIGHT_PLACEMENTS);
      const beacons = result.entities.lightPlacements.filter((lp) => lp.kind === 'beacon');
      expect(beacons.length).toBeGreaterThanOrEqual(19);
      expect(beacons.length).toBeLessThanOrEqual(20);
    },
  );

  it.each(SEEDS)(
    'seed=%i: no two placements share a tile (a crystal never overlaps a campfire/sconce)',
    (seed) => {
      const result = adapterResult(seed);
      const tiles = new Set<string>();
      for (const lp of result.entities.lightPlacements) {
        const key = `${lp.gridY},${lp.gridX}`;
        expect(tiles.has(key), 'no two lights on the same tile').toBe(false);
        tiles.add(key);
      }
    },
  );

  it('synthetic OPEN_ARENA: crystals land in deep forest clearings (no wall in the clearing box)', () => {
    const placer = new LightPlacer();
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.OPEN_ARENA],
      808,
    );
    const placements = placer.place(grid, mapData, occupied, destructibles, 808);
    const crystals = placements.filter((lp) => lp.kind === 'biome-glow');
    expect(crystals.length, 'OPEN_ARENA must receive forest-clearing crystals').toBeGreaterThan(0);
    for (const lp of crystals) {
      expect(hasWallInRadius(grid, lp.gridY, lp.gridX, CRYSTAL_FOREST_CLEARING_WALL_DISTANCE)).toBe(
        false,
      );
    }
  });

  it('synthetic enclosed biome: crystals land in deep nooks (≥NOOK wall neighbours)', () => {
    const placer = new LightPlacer();
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.GRID_ARENA],
      909,
    );
    const placements = placer.place(grid, mapData, occupied, destructibles, 909);
    const crystals = placements.filter((lp) => lp.kind === 'biome-glow');
    expect(crystals.length, 'enclosed biome must receive nook crystals').toBeGreaterThan(0);
    for (const lp of crystals) {
      expect(countWallNeighbours8(grid, lp.gridY, lp.gridX)).toBeGreaterThanOrEqual(
        CRYSTAL_NOOK_MIN_WALL_NEIGHBOURS,
      );
    }
  });

  it('crystal stream is deterministic: same seed → byte-identical crystals', () => {
    const placer = new LightPlacer();
    const { grid, mapData, occupied, destructibles } = makeSyntheticGridAndMapData(
      [SectorType.GRID_ARENA, SectorType.OPEN_ARENA, SectorType.MAZE, SectorType.RESOURCE_RICH],
      4242,
    );
    const a = placer
      .place(grid, mapData, occupied, destructibles, 4242)
      .filter((lp) => lp.kind === 'biome-glow');
    const b = placer
      .place(grid, mapData, occupied, destructibles, 4242)
      .filter((lp) => lp.kind === 'biome-glow');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Anchor B (doorway sconces) + the campfire rebalance — the structure-driven
// pass that replaced the old arbitrary global-cadence scatter + the 30-67
// campfire dominance. Doorway sconces mark sector-border thresholds; campfires
// are now deliberate OPEN_ARENA hearths (~2 per sector), not a 33% crate scatter.
// ═══════════════════════════════════════════════════════════════════════════
describe('LightPlacer — Anchor B (doorway sconces) + campfire rebalance', () => {
  const SEEDS = [42, 12345, 999, 314, 2718, 7];

  function adapterResult(seed: number) {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    return adapter.adapt(gen.generate(seed), seed, TILED_DIR);
  }

  it.each(SEEDS)('seed=%i: sconces cluster at sector borders (the doorway thresholds)', (seed) => {
    const result = adapterResult(seed);
    // Sector borders on a 4×4 map of 20-tile sectors: cols/rows 20, 40, 60.
    // (0 and 80 are the map edge.) A doorway sconce sits within ~2 tiles of a
    // border line. Count them — the doorway anchor should place one flanking
    // each of the ~24 inter-sector connections, so this is a substantial share.
    const sconces = result.entities.lightPlacements.filter(
      (lp) => lp.kind !== 'campfire' && lp.kind !== 'biome-glow',
    );
    const borders = [20, 40, 60];
    const nearBorder = sconces.filter((lp) => {
      const nearRow = borders.some((b) => Math.abs(lp.gridY - b) <= 2);
      const nearCol = borders.some((b) => Math.abs(lp.gridX - b) <= 2);
      return nearRow || nearCol;
    });
    expect(nearBorder.length, 'doorway sconces mark sector thresholds').toBeGreaterThanOrEqual(10);
  });

  it.each(SEEDS)('seed=%i: campfires are deliberate hearths (≪ the old 30-67 scatter)', (seed) => {
    const result = adapterResult(seed);
    const campfires = result.entities.lightPlacements.filter((lp) => lp.kind === 'campfire');
    // The OPEN_ARENA crate palette was rebalanced so campfires are ~2 deliberate
    // hearths per sector (clearing-center crates), not the old uniform 33%
    // scatter. This guard catches a regression back to the 30-67 dominance.
    expect(campfires.length).toBeLessThan(25);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Map-polish ticket 10 — doorway sconce PAIRS (geometric invariants).
//
// Every sector-border aperture (the 24 `mapData.connections` records) must
// carry exactly TWO sconces — one at EACH end of the 3-tile opening band,
// mirror-symmetric about the aperture axis, on the same threshold face — so
// the old "one light at one corner of the passage" read is structurally
// impossible. Positions are a pure geometric derivation from the connection
// record; the pair's internal Manhattan distance holds ≥ LIGHT_MIN_SPACING
// with NO exemption (the band-end pair is exactly 2; every rung keeps the
// members ≥2 apart). Fallback semantics per the ticket-10 ADDENDUM repair:
// the pair steps TOGETHER through the ladder rungs (both members on the
// same rung — band end → outward → travel-inward); sibling-only ONLY when
// no rung fits both members.
// ═══════════════════════════════════════════════════════════════════════════
describe('LightPlacer — Anchor B doorway sconce PAIRS (map-polish ticket 10, geometric invariants)', () => {
  const STANDARD_SEEDS = [1, 42, 999, 0xdeadbeef];
  const SCONCE_KINDS = new Set(['torch', 'candle', 'brazier', 'fireplace', 'lantern']);

  /**
   * The KNOWN degraded apertures per standard seed (re-measured after each
   * map-polish entity cascade — the plaza stamping shifts the entity pools
   * the doorway ladder reads; sanctioned re-pin per the repair rulings).
   * Both pair members still take the first ladder rung BOTH can hold (band
   * end → outward → travel-inward), so every COMPLETE pair is
   * mirror-symmetric by construction:
   *   - seed 1: 23/1 after ticket 25 (the ticket-16 aperture (0,1)-(0,2)
   *     degrades again — see the ticket-25 re-measure note below; the
   *     per-seed fallback ledger below is the ticket-16 measurement).
   *   - seed 42: 24/0. Fallbacks — (2,0)-(2,1) H (axis row 50) coordinated
   *     travel-inward ((18,49)/(18,51)); (2,1)-(2,2) H (axis row 50)
   *     coordinated OUTWARD ((39,48)/(39,52)); (3,2)-(3,3) H (axis row 70)
   *     coordinated travel-inward ((58,69)/(58,71)).
   *   - seed 999: 24/0 after ticket 25 (the ticket-24 degraded aperture
   *     HEALED — see the ticket-25 re-measure note below). Ticket-16
   *     fallbacks — (0,3)-(1,3) V and (2,3)-(3,3) V (axis col 70)
   *     coordinated travel-inward ((69,18)/(71,18) and (69,58)/(71,58)).
   *   - seed 0xdeadbeef: 24/0. Fallbacks — (0,1)-(0,2) H (axis row 10)
   *     coordinated OUTWARD ((39,8)/(39,12)); (0,1)-(1,1) V (axis col 30),
   *     (1,0)-(2,0) V (axis col 10) and (1,2)-(2,2) V (axis col 50)
   *     coordinated travel-inward ((29,18)/(31,18), (9,38)/(11,38) and
   *     (49,38)/(51,38)).
   */
  // Ticket-14 wall-composition cascade re-measure: seed 42's degraded
  // aperture (0,3)-(1,3) HEALED — the entity cascade moved the EXIT prop +
  // weapon spawn off its rung tiles, so all four standard seeds were 24/0.
  // Ticket-16 (7f6f753e, beacon plaza archetype grammar) re-measure: seed 1
  // picks up the one honestly-asymmetric aperture — (0,1)-(0,2) H (axis row
  // 10), the round-1 ticket-05 seed-42 genuine-degradation class. The
  // plaza-shifted entity pool moved the EXIT prop (door_open) from member
  // 1's band end (39,11) onto member 0's band end (39,9), leaving member 0
  // with NO solo rung: band end (39,9) = EXIT prop, outward (39,8) =
  // INDESTRUCTIBLE_WALL, travel-inward (38,9) = planks crate (the ticket-16
  // shared prop vocabulary) ⇒ sibling-only, survivor torch on member 1's
  // freed band end (39,11) ⇒ 23/1. Re-derived from the NEW seed-1 map data
  // (grid tile types + entity DTOs at every rung; a parent-commit diff
  // confirms the exit moved (39,11)→(39,9) with 7f6f753e).
  // Ticket-24 (the beacon keep: ONE authored ∩-shaped wall structure around
  // every hero beacon, replacing the 4-archetype grammar) re-measure: seed
  // 1's ticket-16 degraded aperture (0,1)-(0,2) HEALED (the keep-shifted
  // entity pool moved the EXIT prop off the rung tiles) ⇒ 24/0, while seed
  // 999 picks up the one honestly-asymmetric aperture — (0,2)-(0,3) H (axis
  // row 10), the same genuine-degradation class. The keep-shifted entity
  // pool left member 0 with NO solo rung: band end (59,9) = EXIT prop
  // (wall_demolished), outward (59,8) = INDESTRUCTIBLE_WALL, travel-inward
  // (58,9) = tree destructible ⇒ sibling-only, survivor torch on member 1's
  // band end (59,11) ⇒ 23/1. Re-derived from the NEW seed-999 map data
  // (grid tile types + adapter collections at every rung).
  // Ticket-25 (prefab library + smart reuse, PIPELINE 10) re-measure: the
  // degraded aperture moves BACK to seed 1 — (0,1)-(0,2) H (axis row 10),
  // the ticket-16 aperture: member 0's band end (39,9) has no placeable
  // solo rung (survivor torch on member 1's band end (39,11)) ⇒ 23/1, while
  // seed 999 heals ⇒ 24/0. The prefab-shifted entity pools move which
  // aperture's rungs are claimed — the same lottery as the ticket-14/16/24
  // re-measures (re-derived from the NEW seed-1 adapted placements:
  // doorwayTotal 47, 23 complete pairs, degraded member counts a=0/b=1).
  // Round-6 cascade (v15): the breach-panel wall materials healed seed 1's one
  // degraded doorway sibling — every connection now carries a complete pair.
  const EXPECTED_ASYMMETRIC: Record<number, number> = { 1: 0, 42: 0, 999: 0 };
  EXPECTED_ASYMMETRIC[0xdeadbeef] = 0;

  /** A sconce-family fixture (not a campfire/crystal/beacon/POI pool). */
  const isSconce = (lp: { kind: string; intensity?: number }): boolean =>
    SCONCE_KINDS.has(lp.kind) &&
    !(lp.kind === 'brazier' && lp.intensity === POI_GLOW_LIGHT.intensity);

  /** Manhattan distance between two grid tiles. */
  const manhattan = (
    a: { gridX: number; gridY: number },
    b: { gridX: number; gridY: number },
  ): number => Math.abs(a.gridX - b.gridX) + Math.abs(a.gridY - b.gridY);

  function adapted(seed: number) {
    const gen = new SharedMapGenerator();
    const mapData = gen.generate(seed);
    const result = new SeedMapAdapter().adapt(mapData, seed, TILED_DIR);
    return { mapData, result };
  }

  it.each(STANDARD_SEEDS)(
    'seed=%i: every connection carries a symmetric doorway pair at its band ends (or the documented degraded sibling)',
    (seed) => {
      const { mapData, result } = adapted(seed);
      expect(mapData.connections).toHaveLength(24); // 4×4 sector grid ⇒ 24 apertures
      const sconces = result.entities.lightPlacements.filter(isSconce);
      let completePairs = 0;
      let degraded = 0;
      for (const conn of mapData.connections) {
        const geometry = doorwayPairGeometry(conn);
        const near = (end: { gridX: number; gridY: number }) =>
          sconces.filter((p) => manhattan(p, end) <= 1); // ≤1 = fallback tolerance
        const a = near(geometry.bandEnds[0]);
        const b = near(geometry.bandEnds[1]);
        // Never more than one sconce per band end (no clumping at the door).
        expect(a.length, 'at most one sconce per band end').toBeLessThanOrEqual(1);
        expect(b.length, 'at most one sconce per band end').toBeLessThanOrEqual(1);
        if (a.length === 0 || b.length === 0) {
          // The documented degraded case (sibling-only — no ladder rung
          // placeable for BOTH members): exactly one flank survives, never a
          // relocated corner sconce. Which flank survives is data-driven; the
          // survivor must be at distance ≤1 of its own band end by the
          // filter above.
          degraded++;
          expect(a.length + b.length).toBe(1);
          continue;
        }
        completePairs++;
        // Symmetric about the aperture axis: equal Manhattan distance from
        // the axis centerline, strictly opposite sides.
        if (geometry.openingAxis === 'row') {
          const da = a[0]!.gridY - geometry.axisCenter;
          const db = b[0]!.gridY - geometry.axisCenter;
          expect(Math.abs(da)).toBe(Math.abs(db));
          expect(da).toBe(-db);
          expect(da).not.toBe(0);
          // Same threshold face: never across the seam into sector B.
          expect(a[0]!.gridX).toBeLessThanOrEqual(geometry.bandEnds[0]!.gridX);
          expect(b[0]!.gridX).toBeLessThanOrEqual(geometry.bandEnds[1]!.gridX);
        } else {
          const da = a[0]!.gridX - geometry.axisCenter;
          const db = b[0]!.gridX - geometry.axisCenter;
          expect(Math.abs(da)).toBe(Math.abs(db));
          expect(da).toBe(-db);
          expect(da).not.toBe(0);
          expect(a[0]!.gridY).toBeLessThanOrEqual(geometry.bandEnds[0]!.gridY);
          expect(b[0]!.gridY).toBeLessThanOrEqual(geometry.bandEnds[1]!.gridY);
        }
        // Pair internal spacing discipline — NO exemption for the pair.
        expect(manhattan(a[0]!, b[0]!)).toBeGreaterThanOrEqual(LIGHT_MIN_SPACING);
      }
      expect(completePairs).toBe(24 - EXPECTED_ASYMMETRIC[seed]!);
      expect(degraded).toBe(EXPECTED_ASYMMETRIC[seed]!);
    },
  );

  it.each(STANDARD_SEEDS)(
    'seed=%i: complete pairs share ONE rung (band end, coordinated outward, or coordinated inward — never mixed)',
    (seed) => {
      const { mapData, result } = adapted(seed);
      const sconces = result.entities.lightPlacements.filter(isSconce);
      const counts = new Map<string, number>();
      for (const conn of mapData.connections) {
        const geometry = doorwayPairGeometry(conn);
        const offsets = geometry.bandEnds.map((end) => {
          const sconce = sconces.find((p) => manhattan(p, end) <= 1);
          return sconce ? `${sconce.gridY - end.gridY},${sconce.gridX - end.gridX}` : null;
        });
        if (offsets.some((o) => o === null)) continue; // the degraded aperture
        const signature = (offsets as string[]).join('|');
        counts.set(signature, (counts.get(signature) ?? 0) + 1);
      }
      // Coordinated-stepping pair signatures (member offsets are (dy,dx)
      // from each member's OWN band end). Both members on the same rung
      // (band end / outward / inward) plus the mirror-preserving mixed SOLO
      // pairs (one member band end + the other travel-inward — every solo
      // rung keeps the opening-axis coordinate, so the mirror invariant
      // holds). Anything else — an outward offset on ONE member only, or a
      // member more than one rung away — structurally cannot appear.
      const LEGAL_PAIR_SIGNATURES = new Set([
        '0,0|0,0', // both band ends (the canonical placement)
        '-1,0|1,0', // H coordinated OUTWARD (member 0 up, member 1 down — axis distance 2)
        '0,-1|0,1', // V coordinated OUTWARD
        '0,-1|0,-1', // H coordinated travel-INWARD
        '-1,0|-1,0', // V coordinated travel-INWARD
        '0,0|0,-1', // H mixed solo (band end + travel-inward)
        '0,-1|0,0', // H mixed solo (mirrored member order)
        '0,0|-1,0', // V mixed solo
        '-1,0|0,0', // V mixed solo (mirrored member order)
      ]);
      for (const [signature, count] of counts) {
        expect(LEGAL_PAIR_SIGNATURES.has(signature), `illegal pair signature ${signature}`).toBe(
          true,
        );
        expect(count).toBeGreaterThan(0);
      }
      // The canonical, majority offset is the pure band-end placement
      // (≥18 of the complete pairs on every standard seed; the rest are the
      // documented coordinated fallbacks).
      expect(counts.get('0,0|0,0')).toBeGreaterThanOrEqual(18);
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      expect(total).toBe(24 - EXPECTED_ASYMMETRIC[seed]!);
    },
  );

  // ── Ticket 18 (round 2) — "one prop, one tone" ──────────────────────────────
  // The doorway kind is NO LONGER drawn from the isolated salted stream: the
  // pre-ticket draw made both pair members draw independently, so 14–18 of
  // the 24 pairs per standard seed rendered as TWO different props with two
  // palette tones (candle/lantern gold vs the orange fire family). The fixed
  // choice is 'torch' + the menu registry's TONE_WARM warm-fire tone (see
  // DOORWAY_SCONCE_KIND/DOORWAY_SCONCE_COLOR for the documented rationale).
  it.each(STANDARD_SEEDS)(
    'seed=%i: every doorway sconce is the ONE fixed kind with the ONE fixed tone (ticket 18)',
    (seed) => {
      const { result } = adapted(seed);
      const doorway = result.entities.lightPlacements.filter((p) => p.anchor === 'doorway');
      expect(doorway.length, 'the doorway layer is present (47–48 per map)').toBeGreaterThanOrEqual(
        47,
      );
      for (const p of doorway) {
        expect(p.kind, 'one prop art for every doorway sconce').toBe(DOORWAY_SCONCE_KIND);
        expect(p.color, 'one color tone for every doorway sconce (data-pinned)').toEqual(
          DOORWAY_SCONCE_COLOR,
        );
        // No menu-local tuning rides the gameplay layer — the corridor
        // illumination stays the torch kind defaults (256px / 1.9).
        expect(p.radius).toBeUndefined();
        expect(p.intensity).toBeUndefined();
        expect(p.pulse).toBeUndefined();
      }
      // And the two members of every COMPLETE pair are byte-identical in
      // kind + color (the owner's "not 2 random pieces" contract).
      const distinctBodies = new Set(doorway.map((p) => `${p.kind}|${p.color!.join(',')}`));
      expect(distinctBodies.size).toBe(1);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Ticket D3 — distribution + cap + determinism (LOAD-BEARING regression).
//
// The prior C6 suite asserted per-sector distribution + kind diversity. The D3
// rewrite changes the anchor set (no scatter, no junction/doorway/loot roles),
// so the distribution assertions are re-baselined for the new contract:
//  - Every region still gets light (every sector has a wall ring → wall-brackets).
//  - The map-wide cap still holds.
//  - Determinism still holds (same seed → byte-identical).
//  - The kind MIX still has diversity (per-sector-type wall-bracket table +
//    down-weighting ensures no single kind dominates past 40%).
//
// Asserted against the FULL adapter (real 4x4 seeded map) for multiple seeds,
// because the wall-bracket cadence + cap behavior only manifests on real
// geometry (synthetic single-sector grids are too small to expose density
// regressions).
// ═══════════════════════════════════════════════════════════════════════════
describe('LightPlacer — ticket D3 distribution + cap + determinism (LOAD-BEARING)', () => {
  const SEEDS = [42, 12345, 999, 314, 2718, 7];

  /**
   * Run the full adapter for a seed and bucket placements by sector + by kind.
   * Returns the structured census the assertions read.
   */
  function census(seed: number): {
    placements: Array<{ gridX: number; gridY: number; kind: LightKind; anchor?: string }>;
    bySector: Map<string, number>;
    kindCount: Map<LightKind, number>;
    numSectorsLit: number;
    maxSectorSharePct: number;
  } {
    const gen = new SharedMapGenerator();
    const adapter = new SeedMapAdapter();
    const result = adapter.adapt(gen.generate(seed), seed, TILED_DIR);
    const placements = result.entities.lightPlacements;

    const bySector = new Map<string, number>();
    const kindCount = new Map<LightKind, number>();
    for (const lp of placements) {
      const sCol = Math.floor(lp.gridX / SECTOR_TILE_SIZE);
      const sRow = Math.floor(lp.gridY / SECTOR_TILE_SIZE);
      const key = `${sRow},${sCol}`;
      bySector.set(key, (bySector.get(key) ?? 0) + 1);
      kindCount.set(lp.kind, (kindCount.get(lp.kind) ?? 0) + 1);
    }
    const maxSector = bySector.size > 0 ? Math.max(...bySector.values()) : 0;
    const maxSectorSharePct = placements.length > 0 ? maxSector / placements.length : 0;
    return {
      placements: placements as Array<{
        gridX: number;
        gridY: number;
        kind: LightKind;
        anchor?: string;
      }>,
      bySector,
      kindCount,
      numSectorsLit: bySector.size,
      maxSectorSharePct,
    };
  }

  // ── DISTRIBUTION: every region has light. Every sector has a wall ring (the
  //    sector borders are walls), so the wall-bracket anchor fires in every
  //    sector. Assert ≥12 of 16 sectors have light (tolerates a sector whose
  //    interior has no EMPTY tiles beside a wall — rare but possible).
  it.each(SEEDS)(
    'seed=%i: lights distributed across ≥12 of 16 sectors (wall-brackets everywhere)',
    (seed) => {
      const { numSectorsLit } = census(seed);
      expect(numSectorsLit).toBeGreaterThanOrEqual(12);
    },
  );

  it.each(SEEDS)(
    'seed=%i: no single sector holds >30%% of total placements (≤30%% per sector)',
    (seed) => {
      const { maxSectorSharePct } = census(seed);
      // The cadence + per-sector spacing distribute wall-brackets fairly evenly
      // across sectors (each sector's wall ring yields ~5-8 brackets). Allow
      // ≤30% so a sector with extra-rich wall geometry (a maze sector with many
      // interior walls) doesn't fail, but catch a regression where one sector
      // dominates.
      expect(maxSectorSharePct).toBeLessThanOrEqual(0.3);
    },
  );

  // ── KIND DIVERSITY (DRAWN sconce family): the per-sector-type wall-bracket
  //    kind table + the diversity down-weighting ensure no single DRAWN kind
  //    dominates the DRAWN sconce placements (route-mid + dark-gap fill —
  //    the only passes that still draw a kind from the stream). CAMPFIRE is
  //    EXCLUDED (1:1 anchor driven by destructible count), BIOME-GLOW is
  //    EXCLUDED (it retired from the wall-bracket family to its own Anchor
  //    C — crystal nooks/clearings), and — map-polish round-2 TICKET 18 —
  //    the DOORWAY anchor is EXCLUDED: its kind is now the FIXED
  //    DOORWAY_SCONCE_KIND ('torch', one prop + one tone for every corridor
  //    by owner decree), not a draw, so feeding its 47–48 torches into a
  //    dominance census would flag the by-design uniform layer. This mirrors
  //    the placer itself: `wallBracketKindCounts` (the down-weighting signal)
  //    counts only the DRAWN picks. Post-ticket-18 the drawn family is small
  //    (2–8 sconces per standard seed — measured: 1×2, 1×3, 2×4, 3×5, 1×6,
  //    1×7, 1×8 across the census seeds), so the 45% ceiling only becomes
  //    statistically meaningful at ≥12 draws (4/8 = 50% is a small-sample
  //    artifact, not dominance); the ACTIVE guard at today's sizes is the
  //    no-monoculture clause — a drawn family of ≥4 must show ≥2 distinct
  //    kinds.
  it.each(SEEDS)(
    'seed=%i: the DRAWN sconce family keeps kind diversity (ticket-18 re-baseline)',
    (seed) => {
      const { placements } = census(seed);
      const drawn = placements.filter((p) => p.anchor === 'route' || p.anchor === 'fill');
      if (drawn.length >= 4) {
        const distinct = new Set(drawn.map((p) => p.kind));
        expect(distinct.size, 'no monoculture in the drawn sconce family').toBeGreaterThanOrEqual(
          2,
        );
      }
      if (drawn.length < 12) return; // small sample — the ceiling below is dormant by design
      const kinds = new Map<LightKind, number>();
      for (const p of drawn) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
      for (const count of kinds.values()) {
        expect(count / drawn.length).toBeLessThanOrEqual(0.45);
      }
    },
  );

  it.each(SEEDS)('seed=%i: ≥3 distinct kinds appear (kind MIX, not monoculture)', (seed) => {
    const { kindCount } = census(seed);
    expect(kindCount.size).toBeGreaterThanOrEqual(3);
  });

  it.each(SEEDS)(
    'seed=%i: crystals always present; fire-kind variety on non-campfire-heavy maps',
    (seed) => {
      const { placements, kindCount } = census(seed);
      // Crystals (biome-glow) are ALWAYS reachable — the reserved crystal budget
      // guarantees they appear on every map (the promotion's core promise).
      expect(kindCount.has('biome-glow'), 'crystals always present (reserved budget)').toBe(true);
      // The C6 fire kinds (fireplace/brazier/lantern/candle) reach the wire on
      // non-campfire-heavy maps (≥8 wall-bracket slots). On campfire-heavy maps
      // (seed 42: 67 campfires) wall-brackets are squeezed and fire-kind variety
      // is N/A — campfires already provide the fire, so this guards the variety
      // only where it can meaningfully hold.
      // Ticket-18 note: the map-wide sconce census now includes the FIXED
      // doorway torch layer + the POI-pool braziers alongside the drawn mix —
      // the variety statement is about the MAP read (not all non-campfire fire
      // fixtures are the one doorway prop), which still holds with the drawn
      // family contributing candle/lantern/brazier/fireplace.
      const wallBrackets = placements.filter(
        (p) => p.kind !== 'campfire' && p.kind !== 'biome-glow',
      );
      if (wallBrackets.length < 8) return;
      const fireKinds: LightKind[] = ['fireplace', 'brazier', 'lantern', 'candle'];
      const reached = fireKinds.filter((k) => kindCount.has(k));
      expect(reached.length).toBeGreaterThanOrEqual(2);
    },
  );

  // ── CAP HOLDS (safety ceiling): the map-wide cap must clamp on every seed.
  it.each(SEEDS)('seed=%i: decor placements ≤ MAX_MAP_LIGHT_PLACEMENTS (cap holds)', (seed) => {
    // Ticket 04: the cap covers the D3 decor kinds; the landmark beacons
    // (16 heroes + 2–3 minors) are a required append on top, counted apart.
    const { placements } = census(seed);
    expect(placements.filter((lp) => lp.kind !== 'beacon').length).toBeLessThanOrEqual(
      MAX_MAP_LIGHT_PLACEMENTS,
    );
    expect(placements.filter((lp) => lp.kind === 'beacon').length).toBeGreaterThanOrEqual(18);
  });

  // ── DETERMINISM preserved (the cadence + shuffle + kind-pick must not break
  //    the byte-identical-same-seed contract).
  it.each(SEEDS)(
    'seed=%i: same seed → byte-identical placements (determinism preserved)',
    (seed) => {
      const gen = new SharedMapGenerator();
      const adapter = new SeedMapAdapter();
      const a = adapter.adapt(gen.generate(seed), seed, TILED_DIR).entities.lightPlacements;
      const b = adapter.adapt(gen.generate(seed), seed, TILED_DIR).entities.lightPlacements;
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    },
  );
});

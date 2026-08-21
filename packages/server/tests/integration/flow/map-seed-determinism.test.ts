import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer } from '../../helpers/test-server';
import {
  MapGenerator,
  TileType,
  SectorType,
  SectorLootTier,
  WeaponTier,
  buildCompositeGrid,
  getSectorRing,
  GRID,
  BEACON_INTENSITY_MAX,
  BEACON_RADIUS,
  CITADEL_BEACON_RADIUS,
} from '@sector-battle/shared';
import type { MapData } from '@sector-battle/shared';

// The SPAWN/PLACEMENT/GROUND_SPAWN constant objects were removed as dead code
// (commit 1717531) — they were never referenced by production code, only by
// this test. The values below mirror the CURRENT production behavior in
// EntityPlacer.placeGroundWeaponSpawns (3-4 weapons per sector, +2 for
// RESOURCE_RICH which the test exempts from the upper-bound check) and the
// placementUtils spacing / border-buffer constants. Inlined here so the test
// still pins the same map-quality contracts the original constants expressed.
const MAP_VALIDITY_MIN_REACHABLE = 0.8;
const SPAWN_POSITIONS_TOTAL = 64;
const ENTITY_MIN_SPACING = 2;
const ENTITY_BORDER_BUFFER = 1;
// Per EntityPlacer.placeGroundWeaponSpawns: count = rng.nextInt(3, 4). Same
// band for outer and center rings (the legacy GROUND_SPAWN split [1,2]/[1,2]
// predates the EntityPlacer rewrite and no longer reflects what the generator
// emits — RESOURCE_RICH gets +2 but is exempted from the upper bound below).
const GROUND_SPAWN_OUTER_COUNT: readonly [number, number] = [3, 4];
const GROUND_SPAWN_CENTER_COUNT: readonly [number, number] = [3, 4];

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server?.cleanup();
});

function floodFillEmptyTiles(grid: Uint8Array[]): { reachable: number; total: number } {
  const height = grid.length;
  const width = grid[0].length;
  let totalEmpty = 0;
  let startR = -1;
  let startC = -1;

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (grid[r][c] === TileType.EMPTY) {
        totalEmpty++;
        if (startR === -1) {
          startR = r;
          startC = c;
        }
      }
    }
  }

  if (startR === -1 || totalEmpty === 0) return { reachable: 0, total: 0 };

  const visited = new Set<number>();
  const queue: number[] = [startR * width + startC];
  visited.add(startR * width + startC);
  let reachableEmpty = 0;
  const dr = [0, 0, 1, -1];
  const dc = [1, -1, 0, 0];

  while (queue.length > 0) {
    const pos = queue.shift()!;
    const r = Math.floor(pos / width);
    const c = pos % width;

    if (grid[r][c] === TileType.EMPTY) reachableEmpty++;

    for (let d = 0; d < 4; d++) {
      const nr = r + dr[d];
      const nc = c + dc[d];
      if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
        const npos = nr * width + nc;
        if (!visited.has(npos)) {
          const tile = grid[nr][nc];
          if (tile !== TileType.INDESTRUCTIBLE_WALL && tile !== TileType.INDESTRUCTIBLE_CRATE) {
            visited.add(npos);
            queue.push(npos);
          }
        }
      }
    }
  }

  return { reachable: reachableEmpty, total: totalEmpty };
}

describe('Seed Determinism', () => {
  it('same seed produces identical map tile-for-tile', () => {
    const gen = new MapGenerator();
    const map1 = gen.generate(42);
    const map2 = gen.generate(42);
    const grid1 = buildCompositeGrid(map1.sectors);
    const grid2 = buildCompositeGrid(map2.sectors);

    for (let r = 0; r < GRID.ARENA_HEIGHT; r++) {
      for (let c = 0; c < GRID.ARENA_WIDTH; c++) {
        expect(grid1[r][c]).toBe(grid2[r][c]);
      }
    }
  });

  it('same seed produces stable chest and weapon tiers across runs (map-redesign #01)', () => {
    // Pipeline v3 (ticket 01): loot tiers are authored by generation and
    // consumed as-is by hydration. Two same-seed runs must produce identical
    // chest + ground-weapon tier assignments, tier fields included.
    const gen = new MapGenerator();
    const serializeTiers = (map: MapData) =>
      JSON.stringify({
        chests: map.lootPlacements
          .filter((l) => l.type === 'CHEST')
          .map(
            (l) =>
              `${l.sectorCoord.row},${l.sectorCoord.col}:${l.position.x},${l.position.y}:${l.tier}`,
          )
          .sort(),
        weapons: map.lootPlacements
          .filter((l) => l.type === 'WEAPON_SPAWN')
          .map(
            (l) =>
              `${l.sectorCoord.row},${l.sectorCoord.col}:${l.position.x},${l.position.y}:${l.tier}`,
          )
          .sort(),
      });

    const run1 = serializeTiers(gen.generate(42));
    const run2 = serializeTiers(gen.generate(42));

    expect(run1).toBe(run2);
    expect(JSON.parse(run1).chests.length).toBeGreaterThan(0);
    expect(JSON.parse(run1).weapons.length).toBeGreaterThan(0);
  });

  it('different seeds produce different maps', () => {
    const gen = new MapGenerator();
    const m42 = gen.generate(42);
    const m99 = gen.generate(99);
    const g42 = buildCompositeGrid(m42.sectors);
    const g99 = buildCompositeGrid(m99.sectors);

    let diffCount = 0;
    const total = GRID.ARENA_HEIGHT * GRID.ARENA_WIDTH;

    for (let r = 0; r < GRID.ARENA_HEIGHT; r++) {
      for (let c = 0; c < GRID.ARENA_WIDTH; c++) {
        if (g42[r][c] !== g99[r][c]) diffCount++;
      }
    }

    expect(diffCount / total).toBeGreaterThanOrEqual(0.1);
  });
});

describe('Map Validity', () => {
  let map: MapData;
  let grid: Uint8Array[];

  beforeAll(() => {
    const gen = new MapGenerator();
    map = gen.generate(42);
    grid = buildCompositeGrid(map.sectors);
  });

  it('flood-fill: ≥80% of tiles reachable', () => {
    const { reachable, total } = floodFillEmptyTiles(grid);
    expect(reachable / total).toBeGreaterThanOrEqual(MAP_VALIDITY_MIN_REACHABLE);
  });

  it('at least 64 spawn positions', () => {
    expect(map.spawnPoints.length).toBeGreaterThanOrEqual(SPAWN_POSITIONS_TOTAL);
  });
});

describe('Sector Type Diversity', () => {
  it('at least 1 GridArena and 1 OpenArena sector', () => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    const types = map.sectors.flat().map((s) => s.type);

    expect(types.filter((t) => t === SectorType.GRID_ARENA).length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === SectorType.OPEN_ARENA).length).toBeGreaterThanOrEqual(1);
  });
});

describe('Outermost Ring Integrity', () => {
  let grid: Uint8Array[];

  beforeAll(() => {
    const gen = new MapGenerator();
    const map = gen.generate(42);
    grid = buildCompositeGrid(map.sectors);
  });

  it('outermost ring all INDESTRUCTIBLE_WALL', () => {
    for (let c = 0; c < GRID.ARENA_WIDTH; c++) {
      expect(grid[0][c]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(grid[GRID.ARENA_HEIGHT - 1][c]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }

    for (let r = 0; r < GRID.ARENA_HEIGHT; r++) {
      expect(grid[r][0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(grid[r][GRID.ARENA_WIDTH - 1]).toBe(TileType.INDESTRUCTIBLE_WALL);
    }
  });
});

describe('Corridor Connectivity', () => {
  let map: MapData;
  let grid: Uint8Array[];

  beforeAll(() => {
    const gen = new MapGenerator();
    map = gen.generate(42);
    grid = buildCompositeGrid(map.sectors);
  });

  it('corridors connect adjacent sectors', () => {
    expect(map.connections.length).toBeGreaterThan(0);

    // R2 contract: 1–3 varied 3-wide openings per edge at deterministic
    // positions (not a single fixed center opening). Verify connectivity by
    // checking there EXISTS at least one interior row/col crossing where BOTH
    // sides of the boundary are EMPTY.
    for (const conn of map.connections) {
      const { sectorA, sectorB } = conn;
      const isHorizontal = sectorA.row === sectorB.row;
      const minCol = Math.min(sectorA.col, sectorB.col);
      const minRow = Math.min(sectorA.row, sectorB.row);

      if (isHorizontal) {
        const boundaryCol = (minCol + 1) * GRID.SECTOR_TILE_SIZE;
        const baseRow = sectorA.row * GRID.SECTOR_TILE_SIZE;
        let connected = false;
        for (let r = 1; r <= GRID.SECTOR_TILE_SIZE - 2; r++) {
          if (
            grid[baseRow + r][boundaryCol] === TileType.EMPTY &&
            grid[baseRow + r][boundaryCol - 1] === TileType.EMPTY
          ) {
            connected = true;
            break;
          }
        }
        expect(connected).toBe(true);
      } else {
        const boundaryRow = (minRow + 1) * GRID.SECTOR_TILE_SIZE;
        const baseCol = sectorA.col * GRID.SECTOR_TILE_SIZE;
        let connected = false;
        for (let c = 1; c <= GRID.SECTOR_TILE_SIZE - 2; c++) {
          if (
            grid[boundaryRow][baseCol + c] === TileType.EMPTY &&
            grid[boundaryRow - 1][baseCol + c] === TileType.EMPTY
          ) {
            connected = true;
            break;
          }
        }
        expect(connected).toBe(true);
      }
    }
  });

  it('corridor positions are within valid opening range', () => {
    // R2 contract: openings are at varied valid positions (local row/col in
    // [1, SECTOR_TILE_SIZE-2]), not necessarily at the fixed sector center.
    const sectorPixelSize = GRID.SECTOR_TILE_SIZE * GRID.TILE_SIZE;
    const tileSize = GRID.TILE_SIZE;

    for (const conn of map.connections) {
      const { sectorA, sectorB, positionA, positionB } = conn;
      const isHorizontal = sectorA.row === sectorB.row;

      if (isHorizontal) {
        const localRowA = (positionA.y - sectorA.row * sectorPixelSize) / tileSize;
        const localRowB = (positionB.y - sectorB.row * sectorPixelSize) / tileSize;
        expect(localRowA).toBeGreaterThanOrEqual(1);
        expect(localRowA).toBeLessThanOrEqual(GRID.SECTOR_TILE_SIZE - 2);
        expect(localRowB).toBeGreaterThanOrEqual(1);
        expect(localRowB).toBeLessThanOrEqual(GRID.SECTOR_TILE_SIZE - 2);
      } else {
        const localColA = (positionA.x - sectorA.col * sectorPixelSize) / tileSize;
        const localColB = (positionB.x - sectorB.col * sectorPixelSize) / tileSize;
        expect(localColA).toBeGreaterThanOrEqual(1);
        expect(localColA).toBeLessThanOrEqual(GRID.SECTOR_TILE_SIZE - 2);
        expect(localColB).toBeGreaterThanOrEqual(1);
        expect(localColB).toBeLessThanOrEqual(GRID.SECTOR_TILE_SIZE - 2);
      }
    }
  });
});

describe('Entity Placement Spacing', () => {
  let map: MapData;

  beforeAll(() => {
    const gen = new MapGenerator();
    map = gen.generate(42);
  });

  it('entities respect 2-tile Manhattan spacing', () => {
    const placements = map.entityPlacements;

    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        if (
          placements[i].sectorCoord.row !== placements[j].sectorCoord.row ||
          placements[i].sectorCoord.col !== placements[j].sectorCoord.col
        ) {
          continue;
        }

        const tileAx = Math.floor(placements[i].position.x / GRID.TILE_SIZE);
        const tileAy = Math.floor(placements[i].position.y / GRID.TILE_SIZE);
        const tileBx = Math.floor(placements[j].position.x / GRID.TILE_SIZE);
        const tileBy = Math.floor(placements[j].position.y / GRID.TILE_SIZE);
        const manhattan = Math.abs(tileAx - tileBx) + Math.abs(tileAy - tileBy);
        expect(manhattan).toBeGreaterThanOrEqual(ENTITY_MIN_SPACING);
      }
    }
  });

  it('entities respect border buffer', () => {
    for (const entity of map.entityPlacements) {
      const { row, col } = entity.sectorCoord;
      const worldTileX = Math.floor(entity.position.x / GRID.TILE_SIZE);
      const worldTileY = Math.floor(entity.position.y / GRID.TILE_SIZE);
      const localX = worldTileX - col * GRID.SECTOR_TILE_SIZE;
      const localY = worldTileY - row * GRID.SECTOR_TILE_SIZE;

      expect(localX).toBeGreaterThanOrEqual(ENTITY_BORDER_BUFFER);
      expect(localX).toBeLessThanOrEqual(GRID.SECTOR_TILE_SIZE - 1 - ENTITY_BORDER_BUFFER);
      expect(localY).toBeGreaterThanOrEqual(ENTITY_BORDER_BUFFER);
      expect(localY).toBeLessThanOrEqual(GRID.SECTOR_TILE_SIZE - 1 - ENTITY_BORDER_BUFFER);
    }
  });
});

describe('Ground Weapon Spawns', () => {
  let map: MapData;

  beforeAll(() => {
    const gen = new MapGenerator();
    map = gen.generate(42);
  });

  it('ground weapons spawn in correct sectors', () => {
    const weaponSpawns = map.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN');
    expect(weaponSpawns.length).toBeGreaterThan(0);

    for (let row = 0; row < GRID.SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < GRID.SECTOR_GRID_SIZE; col++) {
        const ring = getSectorRing(row, col, GRID.SECTOR_GRID_SIZE);
        const sectorWeapons = weaponSpawns.filter(
          (w) => w.sectorCoord.row === row && w.sectorCoord.col === col,
        );
        const sectorType = map.sectors[row][col].type;
        const isResourceRich = sectorType === SectorType.RESOURCE_RICH;

        if (ring === 'outer') {
          expect(sectorWeapons.length).toBeGreaterThanOrEqual(GROUND_SPAWN_OUTER_COUNT[0]);
          if (!isResourceRich) {
            expect(sectorWeapons.length).toBeLessThanOrEqual(GROUND_SPAWN_OUTER_COUNT[1]);
          }
        } else {
          expect(sectorWeapons.length).toBeGreaterThanOrEqual(GROUND_SPAWN_CENTER_COUNT[0]);
          if (!isResourceRich) {
            expect(sectorWeapons.length).toBeLessThanOrEqual(GROUND_SPAWN_CENTER_COUNT[1]);
          }
        }
      }
    }
  });

  it('ground weapon tier distribution', () => {
    const weaponSpawns = map.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN');

    // Map-redesign ticket 02: the sector's EFFECTIVE loot tier (base pyramid
    // + per-match hot upgrade) selects the ground-weapon table
    // (SECTOR_TIER_WEAPON_WEIGHTS). COLD sectors are Common-only; WARM never
    // rolls legendary; only HOT sectors (incl. the hot sector) can.
    const validTiers: ReadonlySet<WeaponTier> = new Set<WeaponTier>([
      WeaponTier.COMMON,
      WeaponTier.UNCOMMON,
      WeaponTier.RARE,
      WeaponTier.LEGENDARY,
    ]);
    const tierOf = (row: number, col: number): SectorLootTier =>
      map.hotSector.row === row && map.hotSector.col === col
        ? SectorLootTier.HOT
        : map.sectorTiers[row]![col]!;

    let coldSeen = 0;
    let hotSeen = 0;
    for (const spawn of weaponSpawns) {
      const tier = spawn.tier as WeaponTier;
      expect(validTiers.has(tier)).toBe(true);
      const sectorTier = tierOf(spawn.sectorCoord.row, spawn.sectorCoord.col);
      if (sectorTier === SectorLootTier.COLD) {
        coldSeen++;
        expect(tier).toBe(WeaponTier.COMMON);
      } else if (sectorTier === SectorLootTier.WARM) {
        expect(tier).not.toBe(WeaponTier.LEGENDARY);
      } else {
        hotSeen++;
      }
    }
    expect(coldSeen).toBeGreaterThan(0);
    expect(hotSeen).toBeGreaterThan(0);
  });

  it('MapData carries the loot-tier pyramid + per-match hot sector (ticket 02)', () => {
    // New identity fields ride MapData end-to-end: 4x4 grid of valid tiers,
    // hot sector is a non-central base-WARM sector, deterministic per seed.
    expect(map.sectorTiers).toHaveLength(GRID.SECTOR_GRID_SIZE);
    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (const row of map.sectorTiers) {
      expect(row).toHaveLength(GRID.SECTOR_GRID_SIZE);
      for (const tier of row) {
        expect(['HOT', 'WARM', 'COLD']).toContain(tier);
        if (tier === 'HOT') hot++;
        else if (tier === 'WARM') warm++;
        else cold++;
      }
    }
    expect(hot).toBeGreaterThanOrEqual(2);
    expect(hot).toBeLessThanOrEqual(3);
    expect(warm).toBeGreaterThanOrEqual(7);
    expect(warm).toBeLessThanOrEqual(9);
    expect(cold).toBeGreaterThanOrEqual(4);
    expect(cold).toBeLessThanOrEqual(6);

    expect(getSectorRing(map.hotSector.row, map.hotSector.col, GRID.SECTOR_GRID_SIZE)).toBe(
      'outer',
    );
    expect(map.sectorTiers[map.hotSector.row]![map.hotSector.col]).toBe('WARM');

    // Same seed (fresh generation) → identical tier identity fields.
    const regen = new MapGenerator().generate(42);
    expect(regen.sectorTiers).toEqual(map.sectorTiers);
    expect(regen.hotSector).toEqual(map.hotSector);
  });

  it('MapData carries POI names + map designation, stable across runs (ticket 03)', () => {
    // DEC-001/010: every sector + macro feature gets a unique display name,
    // the map gets a designation. All server-authored in shared generation —
    // the client renders only. Two same-seed runs must agree byte-for-byte.
    expect(map.poiNames).toHaveLength(GRID.SECTOR_GRID_SIZE);
    const allNames: string[] = [];
    for (const row of map.poiNames) {
      expect(row).toHaveLength(GRID.SECTOR_GRID_SIZE);
      for (const name of row) {
        expect(name.length).toBeGreaterThan(0);
        allNames.push(name);
      }
    }
    expect(new Set(allNames).size).toBe(allNames.length);

    // Macro names: highway + compound always named; flavor at most one.
    expect(map.macroPoiNames.highway).toMatch(/^The /);
    expect(map.macroPoiNames.compound).toMatch(/^The /);
    expect(map.macroPoiNames.barrierRidge === null || map.macroPoiNames.openCommons === null).toBe(
      true,
    );

    // Designation: SHAPE • FAMILY • short seed tag.
    expect(map.designation).toMatch(/^[A-Z]+ • [A-Z]+ • [0-9A-Z]{2,3}$/);

    const regen = new MapGenerator().generate(42);
    expect(regen.poiNames).toEqual(map.poiNames);
    expect(regen.macroPoiNames).toEqual(map.macroPoiNames);
    expect(regen.designation).toBe(map.designation);
  });

  it('MapData carries the fortress projection — variant, footprint, beacon; stable across runs (ticket 06)', () => {
    // DEC-004: every procedural map carries its fortress (compound/Citadel)
    // with a per-template beacon; the Citadel vault beacon is the strongest
    // static spec on the map (ceiling intensity, beyond-hero radius). Same
    // seed ⇒ byte-identical fortress + compound loot.
    const variants = new Set<string>();
    for (const seed of [1, 3, 42, 777, 999]) {
      const m = new MapGenerator().generate(seed);
      const f = m.fortress!;
      expect(f).not.toBeNull();
      variants.add(f.variant);
      expect(f.size).toBe(f.variant === 'CITADEL' ? 14 : 10);
      expect(f.beacon.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
      if (f.variant === 'CITADEL') {
        expect(f.beacon.intensity).toBe(BEACON_INTENSITY_MAX);
        expect(f.beacon.radius).toBe(CITADEL_BEACON_RADIUS);
        expect(f.beacon.radius).toBeGreaterThan(BEACON_RADIUS);
        expect(f.vault).not.toBeNull();
      } else {
        expect(f.beacon.radius).toBe(BEACON_RADIUS);
      }
      const regen = new MapGenerator().generate(seed);
      expect(JSON.stringify(regen.fortress)).toBe(JSON.stringify(m.fortress));
    }
    // Seed 3 rolls the Citadel on the fixed CITD stream (the rarity event).
    expect(variants.has('CITADEL')).toBe(true);
  });

  it('MapData carries the visual identity — sectorTypes + floor fields + gateways, stable across runs (ticket 07)', () => {
    // DEC-006: every sector's district identity is authored server-side —
    // the sector type grid (wall-tint key) + the identity assignment (2–3
    // floor tint fields per sector, jittered non-axis borders; one gateway
    // dressing record per corridor opening). Same seed ⇒ byte-identical.
    expect(map.sectorTypes).toHaveLength(GRID.SECTOR_GRID_SIZE);
    for (let row = 0; row < GRID.SECTOR_GRID_SIZE; row++) {
      expect(map.sectorTypes[row]).toHaveLength(GRID.SECTOR_GRID_SIZE);
      for (let col = 0; col < GRID.SECTOR_GRID_SIZE; col++) {
        // The type grid is a projection of the sectors themselves.
        expect(map.sectorTypes[row]![col]).toBe(map.sectors[row]![col]!.type);
      }
    }

    expect(map.identity.fields).toHaveLength(GRID.SECTOR_GRID_SIZE);
    for (const row of map.identity.fields) {
      expect(row).toHaveLength(GRID.SECTOR_GRID_SIZE);
      for (const fields of row) {
        expect(fields.length).toBeGreaterThanOrEqual(2);
        expect(fields.length).toBeLessThanOrEqual(3);
      }
    }
    expect(map.identity.gateways).toHaveLength(map.connections.length);

    // Same seed (fresh generation) → identical identity + weather (the
    // biased weather roll is deterministic: fiction+tier weights over the
    // same main-stream position).
    const regen = new MapGenerator().generate(42);
    expect(JSON.stringify(regen.identity)).toBe(JSON.stringify(map.identity));
    expect(JSON.stringify(regen.sectorTypes)).toBe(JSON.stringify(map.sectorTypes));
    expect(JSON.stringify(regen.weather)).toBe(JSON.stringify(map.weather));
  });

  it('MapData carries the landmark triad — named + landmarked + anchored, reachable (ticket 04)', () => {
    // DEC-002: every sector has exactly one hero landmark on its
    // skeleton-authored anchor; anchors land on reachable (not wall-sealed)
    // tiles; adjacent sectors never share a composition; 2–3 junction minors
    // keep clear of the heroes. Same-seed runs agree byte-for-byte.
    const landmarks = map.landmarks;
    expect(landmarks.heroes).toHaveLength(GRID.SECTOR_GRID_SIZE);
    const seenIds = new Set<string>();
    for (let row = 0; row < GRID.SECTOR_GRID_SIZE; row++) {
      expect(landmarks.heroes[row]).toHaveLength(GRID.SECTOR_GRID_SIZE);
      for (let col = 0; col < GRID.SECTOR_GRID_SIZE; col++) {
        const hero = landmarks.heroes[row]![col]!;
        expect(hero.compositionId.length).toBeGreaterThan(0);
        expect(hero.beacon.radius).toBeGreaterThanOrEqual(512);
        // Sector-adjacent uniqueness (orthogonal neighbors).
        if (col > 0) {
          expect(landmarks.heroes[row]![col - 1]!.compositionId).not.toBe(hero.compositionId);
        }
        if (row > 0) {
          expect(landmarks.heroes[row - 1]![col]!.compositionId).not.toBe(hero.compositionId);
        }
        // The POI triad: the sector is named AND landmarked AND anchored —
        // the noun aligns with the landmark family (spot-check via name
        // presence; the shared suite sweeps the alignment).
        expect(map.poiNames[row]![col]!.length).toBeGreaterThan(0);
        // Anchor inside its sector and TRAVERSABLE in the final grid (chosen
        // EMPTY pre-entity; a chest/barrel may claim it afterwards — "loot
        // crowds the landmark", DEC-002 — but never an indestructible wall).
        const sRow = Math.floor(hero.tileY / GRID.SECTOR_TILE_SIZE);
        const sCol = Math.floor(hero.tileX / GRID.SECTOR_TILE_SIZE);
        expect(sRow).toBe(row);
        expect(sCol).toBe(col);
        const anchorTile =
          map.sectors[sRow]![sCol]!.tiles[hero.tileY % GRID.SECTOR_TILE_SIZE]![
            hero.tileX % GRID.SECTOR_TILE_SIZE
          ];
        expect(anchorTile).not.toBe(TileType.INDESTRUCTIBLE_WALL);
        expect(anchorTile).not.toBe(TileType.INDESTRUCTIBLE_CRATE);
        seenIds.add(hero.compositionId);
      }
    }
    // Variety: more than one composition appears on this map.
    expect(seenIds.size).toBeGreaterThanOrEqual(4);

    // Minors: 2–3, each clear of every hero anchor.
    expect(landmarks.minors.length).toBeGreaterThanOrEqual(2);
    expect(landmarks.minors.length).toBeLessThanOrEqual(3);
    for (const minor of landmarks.minors) {
      for (const row of landmarks.heroes) {
        for (const hero of row) {
          const cheb = Math.max(
            Math.abs(hero.tileX - minor.tileX),
            Math.abs(hero.tileY - minor.tileY),
          );
          expect(cheb).toBeGreaterThanOrEqual(4);
        }
      }
    }

    // Same seed (fresh generation) → identical landmark assignment.
    const regen = new MapGenerator().generate(42);
    expect(regen.landmarks).toEqual(map.landmarks);
  });

  it('MapData carries the skeleton-variety projection — per-sector skeletons + mirror flags, stable across runs (ticket 08)', () => {
    // DEC-007: every sector records which skeleton (sub-variant) built it,
    // whether the seeded mirror flipped it, and which probabilistic
    // sub-blocks fired (subBlockMask) — the manifest's skeleton/mirror audit
    // surface. Mirrored sectors' lootSpots/landmarkAnchor are already
    // re-mapped in place. Same seed ⇒ byte-identical projection.
    let mirrored = 0;
    const variants = new Set<string>();
    for (let row = 0; row < GRID.SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < GRID.SECTOR_GRID_SIZE; col++) {
        const sector = map.sectors[row]![col]!;
        expect(sector.subVariant.length).toBeGreaterThan(0);
        expect(typeof sector.mirrored).toBe('boolean');
        expect(Number.isInteger(sector.subBlockMask)).toBe(true);
        if (sector.mirrored) mirrored++;
        variants.add(sector.subVariant);
      }
    }
    // Both mirror states appear across seeds (the die is ~50/50); a single
    // map just needs to be well-formed. This seed flips a healthy share.
    expect(mirrored).toBeGreaterThan(0);
    expect(mirrored).toBeLessThan(GRID.SECTOR_GRID_SIZE * GRID.SECTOR_GRID_SIZE);
    // The map draws more than one skeleton.
    expect(variants.size).toBeGreaterThanOrEqual(4);

    // Same seed (fresh generation) → identical skeleton/mirror/mask fields.
    const regen = new MapGenerator().generate(42);
    expect(
      JSON.stringify(
        regen.sectors.map((row) =>
          row.map((sector) => [sector.subVariant, sector.mirrored, sector.subBlockMask]),
        ),
      ),
    ).toBe(
      JSON.stringify(
        map.sectors.map((row) =>
          row.map((sector) => [sector.subVariant, sector.mirrored, sector.subBlockMask]),
        ),
      ),
    );
  });
});

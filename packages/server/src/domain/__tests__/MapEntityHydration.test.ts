/* eslint-disable max-lines -- comprehensive integration test covering all entity counts */
import { describe, it, expect } from 'vitest';
import { TileType, ChestRarity, TrapType, WeaponTier, SeededRNG } from '@sector-battle/shared';
import { MapEntityHydrator } from '../services/MapEntityHydrator.ts';
import type { MapResult } from '../services/MapGenerator.ts';
import type { GameConfig } from '@sector-battle/shared';
import { GameMatch } from '../aggregates/GameMatch.ts';
import { MapGenerator } from '../services/MapGenerator.ts';
import { createMatchServices, createMatchPools } from '../aggregates/createMatchServices.ts';

function createMockConfig(): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 3,
      dashDuration: 10,
      dashCooldown: 120,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 24,
      hitboxHeight: 24,
    },
    zone: {
      phases: [],
      totalDuration: 300000,
      transitionDuration: 30000,
      tickInterval: 60,
      warningTime: 5000,
    },
    match: {
      targetDuration: 180000,
      maxPlayers: 4,
      minPlayers: 2,
      countdownDuration: 5000,
      overtimeStart: 240000,
    },
    map: {
      tileWidth: 128,
      tileHeight: 128,
      arenaWidth: 80,
      arenaHeight: 80,
      sectorSize: 4,
      corridorWidth: 3,
      destructibleDensity: 0.25,
      chestDensity: 0.1,
      exitCount: 1,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 200,
      bounceFactor: 0.5,
      maxBounces: 3,
      friendlyFire: true,
    },
    network: {
      tickRate: 60,
      patchRate: 20,
      maxLatency: 200,
      inputBufferSize: 10,
      snapshotInterval: 3,
    },
  };
}

function createEmptyMapResult(w: number, h: number, overrides?: Partial<MapResult>): MapResult {
  const grid: TileType[][] = Array.from({ length: h }, () => Array(w).fill(TileType.EMPTY));
  for (let y = 0; y < h; y++) {
    grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
    grid[y]![w - 1] = TileType.INDESTRUCTIBLE_WALL;
  }
  for (let x = 0; x < w; x++) {
    grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
    grid[h - 1]![x] = TileType.INDESTRUCTIBLE_WALL;
  }
  return {
    grid,
    seed: 0,
    spawnPoints: [],
    chestPlacements: [],
    trapPlacements: [],
    weaponSpawnPlacements: [],
    ...overrides,
  };
}

describe('MapEntityHydration', () => {
  it('Hydration_chestEntityCreation: CHEST tile placement creates Chest entity with correct world position and tier', () => {
    const mapResult = createEmptyMapResult(20, 20, {
      chestPlacements: [{ gridX: 10, gridY: 15, tier: ChestRarity.EPIC }],
    });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests } = hydrator.hydrate(mapResult);

    expect(chests.length).toBe(1);
    const chest = chests[0]!;
    expect(chest.id).toBe('chest_15_10');
    expect(chest.position.x).toBe(10 * 128 + 64);
    expect(chest.position.y).toBe(15 * 128 + 64);
    // Single source of truth (DEC-003.1): the generator-authored tier is
    // consumed as-is — no hydrator re-roll.
    expect(chest.tier).toBe(ChestRarity.EPIC);
  });

  it('Hydration_chestEntityCreation: multiple chest placements create separate entities', () => {
    const mapResult = createEmptyMapResult(20, 20, {
      chestPlacements: [
        { gridX: 5, gridY: 5, tier: 0 },
        { gridX: 10, gridY: 10, tier: 0 },
        { gridX: 15, gridY: 15, tier: 0 },
      ],
    });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests } = hydrator.hydrate(mapResult);

    expect(chests.length).toBe(3);
    expect(new Set(chests.map((c) => c.id)).size).toBe(3);
  });

  it('Hydration_destructibleTypes: DESTRUCTIBLE_CRATE gets hp=2', () => {
    const grid: TileType[][] = Array.from({ length: 10 }, () => Array(10).fill(TileType.EMPTY));
    for (let y = 0; y < 10; y++) {
      grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[y]![9] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let x = 0; x < 10; x++) {
      grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
      grid[9]![x] = TileType.INDESTRUCTIBLE_WALL;
    }
    grid[5]![5] = TileType.DESTRUCTIBLE_CRATE;

    const mapResult = createEmptyMapResult(10, 10, { grid });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { destructibles } = hydrator.hydrate(mapResult);

    expect(destructibles.length).toBe(1);
    expect(destructibles[0]!.type).toBe('crate');
    expect(destructibles[0]!.hp).toBe(2);
    expect(destructibles[0]!.maxHp).toBe(2);
  });

  it('Hydration_destructibleTypes: DESTRUCTIBLE_BARREL gets hp=2', () => {
    const grid: TileType[][] = Array.from({ length: 10 }, () => Array(10).fill(TileType.EMPTY));
    for (let y = 0; y < 10; y++) {
      grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[y]![9] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let x = 0; x < 10; x++) {
      grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
      grid[9]![x] = TileType.INDESTRUCTIBLE_WALL;
    }
    grid[3]![4] = TileType.DESTRUCTIBLE_BARREL;

    const mapResult = createEmptyMapResult(10, 10, { grid });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { destructibles } = hydrator.hydrate(mapResult);

    expect(destructibles.length).toBe(1);
    expect(destructibles[0]!.type).toBe('barrel');
    expect(destructibles[0]!.hp).toBe(2);
    expect(destructibles[0]!.maxHp).toBe(2);
    // Juice-pass-1 ticket 05 (GDD §5.5): every spawned barrel starts
    // unprimed — only a surviving hit primes the fuse.
    expect(destructibles[0]!.primed).toBe(false);
    expect(destructibles[0]!.fuseExpiresAtTick).toBe(0);
  });

  it('Hydration_destructibleTypes: DESTRUCTIBLE_WALL gets hp=10', () => {
    const grid: TileType[][] = Array.from({ length: 10 }, () => Array(10).fill(TileType.EMPTY));
    for (let y = 0; y < 10; y++) {
      grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[y]![9] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let x = 0; x < 10; x++) {
      grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
      grid[9]![x] = TileType.INDESTRUCTIBLE_WALL;
    }
    grid[7]![2] = TileType.DESTRUCTIBLE_WALL;

    const mapResult = createEmptyMapResult(10, 10, { grid });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { destructibles } = hydrator.hydrate(mapResult);

    expect(destructibles.length).toBe(1);
    expect(destructibles[0]!.type).toBe('wall');
    expect(destructibles[0]!.hp).toBe(10);
    expect(destructibles[0]!.maxHp).toBe(10);
  });

  it('Hydration_destructibleTypes: mixed destructible types create correct entities', () => {
    const grid: TileType[][] = Array.from({ length: 10 }, () => Array(10).fill(TileType.EMPTY));
    for (let y = 0; y < 10; y++) {
      grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[y]![9] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let x = 0; x < 10; x++) {
      grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
      grid[9]![x] = TileType.INDESTRUCTIBLE_WALL;
    }
    grid[2]![2] = TileType.DESTRUCTIBLE_CRATE;
    grid[3]![3] = TileType.DESTRUCTIBLE_BARREL;
    grid[4]![4] = TileType.DESTRUCTIBLE_WALL;

    const mapResult = createEmptyMapResult(10, 10, { grid });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { destructibles } = hydrator.hydrate(mapResult);

    expect(destructibles.length).toBe(3);
    const byType = new Map(destructibles.map((d) => [d.type, d]));
    expect(byType.get('crate')!.hp).toBe(2);
    expect(byType.get('barrel')!.hp).toBe(2);
    expect(byType.get('wall')!.hp).toBe(10);
  });

  it('Hydration_trapEntities: trap placements create Trap entities', () => {
    const mapResult = createEmptyMapResult(20, 20, {
      trapPlacements: [
        { gridX: 5, gridY: 5 },
        { gridX: 10, gridY: 10 },
      ],
    });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { traps } = hydrator.hydrate(mapResult);

    expect(traps.length).toBe(2);
    for (const trap of traps) {
      expect(Object.values(TrapType)).toContain(trap.type);
    }
    expect(traps[0]!.position.x).toBe(5 * 128 + 64);
    expect(traps[0]!.position.y).toBe(5 * 128 + 64);
  });

  it('Hydration_weaponPickups: weapon spawn placements create WeaponPickup entities', () => {
    const mapResult = createEmptyMapResult(20, 20, {
      weaponSpawnPlacements: [
        { gridX: 8, gridY: 8, tier: WeaponTier.COMMON },
        { gridX: 12, gridY: 12, tier: WeaponTier.RARE },
      ],
    });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { weaponPickups } = hydrator.hydrate(mapResult);

    expect(weaponPickups.length).toBe(2);
    expect(weaponPickups[0]!.position.x).toBe(8 * 128 + 64);
    expect(weaponPickups[0]!.position.y).toBe(8 * 128 + 64);
    expect(weaponPickups[0]!.weapon.tier).toBe(WeaponTier.COMMON);
    expect(weaponPickups[1]!.weapon.tier).toBe(WeaponTier.RARE);
    expect(weaponPickups[0]!.spawnTick).toBe(0);
  });

  it('Hydration_edgeCase: chest at wall position is skipped', () => {
    const mapResult = createEmptyMapResult(10, 10, {
      chestPlacements: [{ gridX: 0, gridY: 0, tier: 0 }],
    });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests } = hydrator.hydrate(mapResult);

    expect(chests.length).toBe(0);
  });

  it('Hydration_edgeCase: zero chests generates empty collection', () => {
    const mapResult = createEmptyMapResult(10, 10);
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests } = hydrator.hydrate(mapResult);

    expect(chests.length).toBe(0);
  });

  it('Hydration_edgeCase: INDESTRUCTIBLE_CRATE tiles are skipped', () => {
    const grid: TileType[][] = Array.from({ length: 10 }, () => Array(10).fill(TileType.EMPTY));
    for (let y = 0; y < 10; y++) {
      grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[y]![9] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let x = 0; x < 10; x++) {
      grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
      grid[9]![x] = TileType.INDESTRUCTIBLE_WALL;
    }
    grid[5]![5] = TileType.INDESTRUCTIBLE_CRATE;

    const mapResult = createEmptyMapResult(10, 10, { grid });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { destructibles } = hydrator.hydrate(mapResult);

    expect(destructibles.length).toBe(0);
  });

  it('Hydration_edgeCase: entity ID collision resolved with counter suffix', () => {
    const mapResult = createEmptyMapResult(20, 20, {
      chestPlacements: [{ gridX: 5, gridY: 5, tier: 0 }],
      trapPlacements: [{ gridX: 5, gridY: 5 }],
    });
    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests, traps } = hydrator.hydrate(mapResult);

    expect(chests.length).toBe(1);
    expect(traps.length).toBe(1);
    const allIds = [chests[0]!.id, traps[0]!.id];
    expect(new Set(allIds).size).toBe(2);
  });

  it('Hydration_fullMap: generated 80x80 map entity counts are consistent', () => {
    const config = createMockConfig();
    const generator = new MapGenerator();
    const mapResult = generator.generate(42, config.map);

    let crateCount = 0;
    let barrelCount = 0;
    let wallCount = 0;
    // Hydrator consumes destructiblePlacements (CRATE/BARREL only); count from the same source
    for (const row of mapResult.grid) {
      for (const tile of row) {
        if (tile === TileType.DESTRUCTIBLE_CRATE) crateCount++;
        else if (tile === TileType.DESTRUCTIBLE_BARREL) barrelCount++;
        else if (tile === TileType.DESTRUCTIBLE_WALL) wallCount++;
      }
    }

    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests, destructibles, traps, weaponPickups } = hydrator.hydrate(mapResult);
    const result = hydrator.computeResult(chests, destructibles, traps, weaponPickups);

    expect(result.chestCount).toBe(mapResult.chestPlacements.length);
    expect(result.destructibleCounts.crate).toBe(crateCount);
    expect(result.destructibleCounts.barrel).toBe(barrelCount);
    expect(result.destructibleCounts.wall).toBe(wallCount);
    expect(result.trapCount).toBe(mapResult.trapPlacements.length);
    expect(result.weaponPickupCount).toBe(mapResult.weaponSpawnPlacements.length);
    expect(result.warnings).toBe(0);
  });

  it('Hydration_fullMap: all entity positions are at tile centers', () => {
    const config = createMockConfig();
    const generator = new MapGenerator();
    const mapResult = generator.generate(42, config.map);

    const hydrator = new MapEntityHydrator(mapResult, 128);
    const { chests, destructibles, traps, weaponPickups } = hydrator.hydrate(mapResult);

    const tileSize = 128;
    for (const c of chests) {
      expect(c.position.x % tileSize).toBe(tileSize / 2);
      expect(c.position.y % tileSize).toBe(tileSize / 2);
    }
    for (const d of destructibles) {
      expect(d.position.x % tileSize).toBe(tileSize / 2);
      expect(d.position.y % tileSize).toBe(tileSize / 2);
    }
    for (const t of traps) {
      expect(t.position.x % tileSize).toBe(tileSize / 2);
      expect(t.position.y % tileSize).toBe(tileSize / 2);
    }
    for (const wp of weaponPickups) {
      expect(wp.position.x % tileSize).toBe(tileSize / 2);
      expect(wp.position.y % tileSize).toBe(tileSize / 2);
    }
  });

  it('Hydration_gameMatch: GameMatch.hydrateEntities populates all collections', () => {
    const config = createMockConfig();
    const grid: TileType[][] = Array.from({ length: 10 }, () => Array(10).fill(TileType.EMPTY));
    for (let y = 0; y < 10; y++) {
      grid[y]![0] = TileType.INDESTRUCTIBLE_WALL;
      grid[y]![9] = TileType.INDESTRUCTIBLE_WALL;
    }
    for (let x = 0; x < 10; x++) {
      grid[0]![x] = TileType.INDESTRUCTIBLE_WALL;
      grid[9]![x] = TileType.INDESTRUCTIBLE_WALL;
    }
    grid[5]![5] = TileType.DESTRUCTIBLE_CRATE;
    grid[6]![6] = TileType.DESTRUCTIBLE_BARREL;
    grid[7]![7] = TileType.DESTRUCTIBLE_WALL;

    const mapResult: MapResult = {
      grid,
      seed: 0,
      spawnPoints: [{ x: 192, y: 192, sectorCoord: { row: 0, col: 0 }, priority: 0 }],
      chestPlacements: [{ gridX: 3, gridY: 3, tier: 0 }],
      trapPlacements: [{ gridX: 4, gridY: 4 }],
      weaponSpawnPlacements: [{ gridX: 5, gridY: 3, tier: WeaponTier.COMMON }],
    };

    const services = createMatchServices(config);
    const pools = createMatchPools();
    const lootRng = new SeededRNG(12345);
    const match = new GameMatch(
      'test-match',
      config,
      grid,
      mapResult.spawnPoints,
      services,
      pools,
      lootRng,
    );
    const result = match.hydrateEntities(mapResult);

    expect(result.chestCount).toBe(1);
    expect(result.destructibleCounts.crate).toBe(1);
    expect(result.destructibleCounts.barrel).toBe(1);
    expect(result.destructibleCounts.wall).toBe(1);
    expect(result.trapCount).toBe(1);
    expect(result.weaponPickupCount).toBe(1);
  });

  it('Hydration_determinism: same seed produces identical entity layout', () => {
    const config = createMockConfig();
    const generator = new MapGenerator();
    const mapResult = generator.generate(12345, config.map);

    const hydrator1 = new MapEntityHydrator(mapResult, 128, undefined, 12345);
    const result1 = hydrator1.hydrate(mapResult);

    const hydrator2 = new MapEntityHydrator(mapResult, 128, undefined, 12345);
    const result2 = hydrator2.hydrate(mapResult);

    const serialize = (c: {
      id: string;
      type?: unknown;
      tier?: unknown;
      position: { x: number; y: number };
    }) =>
      JSON.stringify({
        id: c.id,
        type: c.type ?? c.tier,
        x: c.position.x,
        y: c.position.y,
      });

    const serializeWeapon = (c: {
      id: string;
      weapon?: { tier: unknown } | null;
      position: { x: number; y: number };
    }) =>
      JSON.stringify({
        id: c.id,
        tier: c.weapon?.tier,
        x: c.position.x,
        y: c.position.y,
      });

    const chests1 = result1.chests.map(serialize).sort();
    const chests2 = result2.chests.map(serialize).sort();
    const traps1 = result1.traps.map(serialize).sort();
    const traps2 = result2.traps.map(serialize).sort();
    const weapons1 = result1.weaponPickups.map(serializeWeapon).sort();
    const weapons2 = result2.weaponPickups.map(serializeWeapon).sort();

    expect(chests1).toEqual(chests2);
    expect(traps1).toEqual(traps2);
    expect(weapons1).toEqual(weapons2);
  });

  it('Hydration_determinism: different map seeds produce different entity layouts', () => {
    const config = createMockConfig();
    const generator = new MapGenerator();
    const mapResult1 = generator.generate(11111, config.map);
    const mapResult2 = generator.generate(99999, config.map);

    const hydrator1 = new MapEntityHydrator(mapResult1, 128);
    const result1 = hydrator1.hydrate(mapResult1);

    const hydrator2 = new MapEntityHydrator(mapResult2, 128);
    const result2 = hydrator2.hydrate(mapResult2);

    const serialize = (c: {
      id: string;
      type?: unknown;
      tier?: unknown;
      position: { x: number; y: number };
    }) =>
      JSON.stringify({
        id: c.id,
        type: c.type ?? c.tier,
        x: c.position.x,
        y: c.position.y,
      });

    const serializeWeapon = (c: {
      id: string;
      weapon?: { tier: unknown } | null;
      position: { x: number; y: number };
    }) =>
      JSON.stringify({
        id: c.id,
        tier: c.weapon?.tier,
        x: c.position.x,
        y: c.position.y,
      });

    const all1 = [
      ...result1.chests.map(serialize),
      ...result1.traps.map(serialize),
      ...result1.weaponPickups.map(serializeWeapon),
    ].sort();

    const all2 = [
      ...result2.chests.map(serialize),
      ...result2.traps.map(serialize),
      ...result2.weaponPickups.map(serializeWeapon),
    ].sort();

    expect(all1).not.toEqual(all2);
  });

  it('Hydration_tierSourceOfTruth: hydrated chest tiers equal the generator-authored tiers', () => {
    const config = createMockConfig();
    const generator = new MapGenerator();
    const mapResult = generator.generate(42, config.map);

    const hydrator = new MapEntityHydrator(mapResult, 128, undefined, 42);
    const { chests } = hydrator.hydrate(mapResult);

    expect(chests.length).toBe(mapResult.chestPlacements.length);
    const authoredTierByPos = new Map<string, number>();
    for (const cp of mapResult.chestPlacements) {
      authoredTierByPos.set(`${cp.gridX},${cp.gridY}`, cp.tier);
    }
    // A chest placed as RARE by the generator hydrates as RARE — the authored
    // tier survives hydration untouched (no re-roll).
    for (const chest of chests) {
      const gridX = Math.floor(chest.position.x / 128);
      const gridY = Math.floor(chest.position.y / 128);
      expect(chest.tier).toBe(authoredTierByPos.get(`${gridX},${gridY}`));
    }
  });

  it('Hydration_secondRunByteIdentity: tier fields are seed-stable end-to-end through hydration', () => {
    const config = createMockConfig();
    const serializeChestTiers = (mapResult: MapResult) => {
      const hydrator = new MapEntityHydrator(mapResult, 128, undefined, 42);
      const { chests, weaponPickups } = hydrator.hydrate(mapResult);
      return JSON.stringify({
        chests: chests.map((c) => `${c.id}:${c.tier}:${c.position.x},${c.position.y}`).sort(),
        weapons: weaponPickups
          .map((w) => `${w.id}:${w.weapon.tier}:${w.position.x},${w.position.y}`)
          .sort(),
      });
    };

    // Two independent generate+hydrate runs from the same map seed must be
    // byte-identical, tier fields included (map-redesign ticket 01, pipeline v3).
    const run1 = serializeChestTiers(new MapGenerator().generate(42, config.map));
    const run2 = serializeChestTiers(new MapGenerator().generate(42, config.map));
    expect(run1).toBe(run2);
    expect(run1).toContain('"chests":');
    expect(run1).toContain('"weapons":');

    // A different hydration seed must NOT change hydrated tiers — the tier is
    // authored by generation, not rolled by the hydrator (the old double-roll
    // bug). Same map seed, different hydrator seeds, identical output.
    const mapA = new MapGenerator().generate(42, config.map);
    const mapB = new MapGenerator().generate(42, config.map);
    const hydratorA = new MapEntityHydrator(mapA, 128, undefined, 11111);
    const hydratorB = new MapEntityHydrator(mapB, 128, undefined, 99999);
    const tiersA = JSON.stringify(
      hydratorA
        .hydrate(mapA)
        .chests.map((c) => `${c.id}:${c.tier}`)
        .sort(),
    );
    const tiersB = JSON.stringify(
      hydratorB
        .hydrate(mapB)
        .chests.map((c) => `${c.id}:${c.tier}`)
        .sort(),
    );
    expect(tiersA).toBe(tiersB);
  });
});

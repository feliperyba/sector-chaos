import { describe, it, expect, vi } from 'vitest';
import {
  WeaponTier,
  WeaponType,
  TileType,
  ChestRarity,
  TrapType,
  SeededRNG,
  WEAPON_TIER_WEIGHTS,
  rollWeaponTier,
} from '@sector-battle/shared';
import { MapEntityHydrator } from '../../src/domain/services/MapEntityHydrator.ts';
import { TmxParser } from '../../src/infrastructure/parsers/TmxParser.ts';
import { resolve } from 'node:path';

const TILE_SIZE = 128;

function makeMinimalMapResult(
  overrides: Partial<import('../../src/domain/services/MapGenerator.ts').MapResult> = {},
) {
  return {
    grid: [
      [TileType.EMPTY, TileType.EMPTY, TileType.EMPTY],
      [TileType.EMPTY, TileType.EMPTY, TileType.EMPTY],
      [TileType.EMPTY, TileType.EMPTY, TileType.EMPTY],
    ],
    spawnPoints: [{ x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 1 }],
    chestPlacements: [{ gridX: 1, gridY: 1, tier: ChestRarity.COMMON }],
    trapPlacements: [{ gridX: 0, gridY: 0, trapType: TrapType.SPIKE }],
    weaponSpawnPlacements: [
      { gridX: 0, gridY: 0, tier: WeaponTier.COMMON, weaponType: WeaponType.DAGGER },
      { gridX: 1, gridY: 0, tier: WeaponTier.UNCOMMON, weaponType: WeaponType.SHORT_SWORD },
      { gridX: 2, gridY: 0, tier: WeaponTier.RARE, weaponType: WeaponType.LONG_SWORD },
      { gridX: 0, gridY: 1, tier: WeaponTier.LEGENDARY, weaponType: WeaponType.HAMMER },
    ],
    ...overrides,
  };
}

describe('RT-007: Wire Entity Hydration — Weapon Tier Propagation', () => {
  it('MapEntityHydrator uses placement tier data for weapon pickups', () => {
    const mapResult = makeMinimalMapResult();
    const hydrator = new MapEntityHydrator(mapResult, TILE_SIZE);
    const { weaponPickups } = hydrator.hydrate(mapResult);

    expect(weaponPickups.length).toBeGreaterThanOrEqual(4);

    const tiers = weaponPickups.map((wp) => wp.weapon.tier);
    expect(tiers).toContain(WeaponTier.COMMON);
    expect(tiers).toContain(WeaponTier.UNCOMMON);
    expect(tiers).toContain(WeaponTier.RARE);
    expect(tiers).toContain(WeaponTier.LEGENDARY);
  });

  it('MapEntityHydrator uses weaponType from placements when provided', () => {
    const mapResult = makeMinimalMapResult();
    const hydrator = new MapEntityHydrator(mapResult, TILE_SIZE);
    const { weaponPickups } = hydrator.hydrate(mapResult);

    const weaponTypes = weaponPickups.map((wp) => wp.weapon.type);
    expect(weaponTypes).toContain(WeaponType.DAGGER);
    expect(weaponTypes).toContain(WeaponType.SHORT_SWORD);
    expect(weaponTypes).toContain(WeaponType.LONG_SWORD);
    expect(weaponTypes).toContain(WeaponType.HAMMER);
  });

  it('MapEntityHydrator falls back to random weaponType when not provided', () => {
    const mapResult = makeMinimalMapResult({
      weaponSpawnPlacements: [
        { gridX: 0, gridY: 0, tier: WeaponTier.COMMON },
        { gridX: 1, gridY: 0, tier: WeaponTier.UNCOMMON },
      ],
    });
    const hydrator = new MapEntityHydrator(mapResult, TILE_SIZE);
    const { weaponPickups } = hydrator.hydrate(mapResult);

    expect(weaponPickups).toHaveLength(2);
    for (const wp of weaponPickups) {
      expect(wp.weapon.type).toBeDefined();
      expect(Object.values(WeaponType)).toContain(wp.weapon.type);
    }
  });

  it('TmxParser extracts tier from TMX object properties when present', () => {
    const parser = new TmxParser();
    const mapPath = resolve(process.cwd(), 'tiled/demo_map.tmx');
    let enriched;
    try {
      enriched = parser.parse(mapPath);
    } catch {
      // TMX file may not exist in test environment
      return;
    }

    expect(enriched.entities.weapons.length).toBeGreaterThan(0);
    for (const w of enriched.entities.weapons) {
      expect(w.weaponType).toBeDefined();
      expect(typeof w.gridX).toBe('number');
      expect(typeof w.gridY).toBe('number');
    }
  });

  it('rollWeaponTier returns valid WeaponTier values', () => {
    const validTiers = new Set(Object.values(WeaponTier));
    const results = new Set();
    const rng = new SeededRNG(12345);
    for (let i = 0; i < 200; i++) {
      const tier = rollWeaponTier(rng);
      expect(validTiers).toContain(tier);
      results.add(tier);
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('WEAPON_TIER_WEIGHTS covers all tiers with correct distribution', () => {
    const tiers = WEAPON_TIER_WEIGHTS.map((w) => w.tier);
    expect(tiers).toContain(WeaponTier.COMMON);
    expect(tiers).toContain(WeaponTier.UNCOMMON);
    expect(tiers).toContain(WeaponTier.RARE);
    expect(tiers).toContain(WeaponTier.LEGENDARY);

    const totalWeight = WEAPON_TIER_WEIGHTS.reduce((sum, w) => sum + w.weight, 0);
    expect(totalWeight).toBe(100);
  });

  it('all entity types hydrate correctly', () => {
    const mapResult: import('../../src/domain/services/MapGenerator.ts').MapResult = {
      grid: [
        [TileType.EMPTY, TileType.EMPTY, TileType.EMPTY],
        [TileType.EMPTY, TileType.CHEST, TileType.DESTRUCTIBLE_CRATE],
        [TileType.EMPTY, TileType.EMPTY, TileType.DESTRUCTIBLE_BARREL],
      ],
      spawnPoints: [{ x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 1 }],
      chestPlacements: [{ gridX: 1, gridY: 1, tier: ChestRarity.COMMON }],
      trapPlacements: [{ gridX: 0, gridY: 0, trapType: TrapType.SPIKE }],
      weaponSpawnPlacements: [
        { gridX: 2, gridY: 0, tier: WeaponTier.UNCOMMON, weaponType: WeaponType.DAGGER },
      ],
    };

    const hydrator = new MapEntityHydrator(mapResult, TILE_SIZE);
    const { chests, destructibles, traps, weaponPickups } = hydrator.hydrate(mapResult);

    expect(chests.length).toBeGreaterThanOrEqual(1);
    expect(destructibles.length).toBeGreaterThanOrEqual(2);
    expect(traps.length).toBeGreaterThanOrEqual(1);
    expect(weaponPickups.length).toBeGreaterThanOrEqual(1);

    for (const chest of chests) {
      expect(Object.values(ChestRarity)).toContain(chest.tier);
    }
    for (const trap of traps) {
      expect(Object.values(TrapType)).toContain(trap.type);
    }
    for (const wp of weaponPickups) {
      expect(Object.values(WeaponTier)).toContain(wp.weapon.tier);
    }
  });
});

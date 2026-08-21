import { describe, it, expect } from 'vitest';
import { SeededRNG } from '../../src/map/rng/SeededRNG.js';
import { getSectorRing } from '../../src/map/gridUtils.js';
import { SECTOR_TIER_WEAPON_WEIGHTS, RING_TIER_WEIGHTS } from '../../src/constants/loot-weights.js';
import { WeaponTier } from '../../src/enums/WeaponTier.js';
import { ChestRarity } from '../../src/enums/ChestRarity.js';
import { MapGenerator } from '../../src/map/MapGenerator.js';
import { effectiveSectorTier } from '../../src/map/lootTiers.js';
import { SectorLootTier } from '../../src/map/types.js';

describe('SectorRing Classification', () => {
  it('classifies exactly 12 outer and 4 center sectors in 4x4 grid', () => {
    let outer = 0;
    let center = 0;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const ring = getSectorRing(row, col, 4);
        if (ring === 'outer') outer++;
        else center++;
      }
    }
    expect(outer).toBe(12);
    expect(center).toBe(4);
  });

  it('throws for invalid coordinates', () => {
    expect(() => getSectorRing(-1, 0, 4)).toThrow();
    expect(() => getSectorRing(0, 4, 4)).toThrow();
    expect(() => getSectorRing(4, 0, 4)).toThrow();
  });

  it('classifies corner sectors as outer', () => {
    expect(getSectorRing(0, 0, 4)).toBe('outer');
    expect(getSectorRing(0, 3, 4)).toBe('outer');
    expect(getSectorRing(3, 0, 4)).toBe('outer');
    expect(getSectorRing(3, 3, 4)).toBe('outer');
  });

  it('classifies center sectors correctly', () => {
    expect(getSectorRing(1, 1, 4)).toBe('center');
    expect(getSectorRing(1, 2, 4)).toBe('center');
    expect(getSectorRing(2, 1, 4)).toBe('center');
    expect(getSectorRing(2, 2, 4)).toBe('center');
  });
});

describe('WeaponSpawn tier tables (map-redesign ticket 02)', () => {
  it('COLD-sector weapon spawns are Common tier only', () => {
    const generator = new MapGenerator();

    for (let seed = 0; seed < 20; seed++) {
      const mapData = generator.generate(seed);
      const weaponSpawns = mapData.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN');

      for (const ws of weaponSpawns) {
        const tier = effectiveSectorTier(
          { tiers: mapData.sectorTiers, hotSector: mapData.hotSector },
          ws.sectorCoord.row,
          ws.sectorCoord.col,
        );
        if (tier === SectorLootTier.COLD) {
          // GDD §5.6.1 (amended by ticket 02) / SECTOR_TIER_WEAPON_WEIGHTS.COLD:
          // the cold outer band is the cheap-landing sector — Common only.
          expect(ws.tier).toBe(WeaponTier.COMMON);
        }
      }
    }
    // 20-seed generation sweep — explicit timeout (machine-load flake class
    // documented in ticket 06; the ticket-10 fairness pass adds generation cost).
  }, 20_000);

  it('WARM-sector weapon spawns never roll legendary', () => {
    const generator = new MapGenerator();

    for (let seed = 0; seed < 20; seed++) {
      const mapData = generator.generate(seed);
      const weaponSpawns = mapData.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN');

      for (const ws of weaponSpawns) {
        const tier = effectiveSectorTier(
          { tiers: mapData.sectorTiers, hotSector: mapData.hotSector },
          ws.sectorCoord.row,
          ws.sectorCoord.col,
        );
        if (tier === SectorLootTier.WARM) {
          expect(ws.tier).not.toBe(WeaponTier.LEGENDARY);
        }
      }
    }
  });

  it('legendary weapon spawns only appear in HOT sectors', () => {
    const generator = new MapGenerator();
    let legendarySeen = false;

    for (let seed = 0; seed < 30; seed++) {
      const mapData = generator.generate(seed);
      const weaponSpawns = mapData.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN');

      for (const ws of weaponSpawns) {
        if (ws.tier !== WeaponTier.LEGENDARY) continue;
        legendarySeen = true;
        const tier = effectiveSectorTier(
          { tiers: mapData.sectorTiers, hotSector: mapData.hotSector },
          ws.sectorCoord.row,
          ws.sectorCoord.col,
        );
        expect(tier).toBe(SectorLootTier.HOT);
      }
    }
    // Across 30 maps the HOT table (3% legendary, 3-6 HOT sectors x 3-6
    // spawns each) must have produced at least one legendary.
    expect(legendarySeen).toBe(true);
  });

  it('total legendary loot placements stay within the ~10/map cap', () => {
    const generator = new MapGenerator();

    for (let seed = 0; seed < 30; seed++) {
      const mapData = generator.generate(seed);
      const legendaries = mapData.lootPlacements.filter(
        (l) => l.tier === WeaponTier.LEGENDARY || l.tier === ChestRarity.LEGENDARY,
      );
      expect(legendaries.length).toBeLessThanOrEqual(10);
    }
  });
});

describe('WeaponSpawn Count Range', () => {
  it('total ground weapon spawns across map is consistent', async () => {
    const generator = new MapGenerator();

    let minTotal = Infinity;
    let maxTotal = -Infinity;

    for (let seed = 0; seed < 10; seed++) {
      const mapData = generator.generate(seed);
      const weaponSpawns = mapData.lootPlacements.filter((l) => l.type === 'WEAPON_SPAWN');
      const count = weaponSpawns.length;

      minTotal = Math.min(minTotal, count);
      maxTotal = Math.max(maxTotal, count);
    }

    expect(minTotal).toBeGreaterThanOrEqual(16);
    expect(maxTotal).toBeLessThanOrEqual(70);
  });
});

describe('Per-tier weapon weight tables', () => {
  it('COLD table always rolls Common', () => {
    const rng = new SeededRNG(123);
    for (let i = 0; i < 1000; i++) {
      expect(rng.weightedPick(SECTOR_TIER_WEAPON_WEIGHTS.COLD)).toBe('common');
    }
  });

  it('HOT table can roll all four tiers (GDD center split)', () => {
    const rng = new SeededRNG(456);
    const tiers = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tiers.add(rng.weightedPick(SECTOR_TIER_WEAPON_WEIGHTS.HOT));
    }
    expect(tiers.has('common')).toBe(true);
    expect(tiers.has('uncommon')).toBe(true);
    expect(tiers.has('rare')).toBe(true);
    expect(tiers.has('legendary')).toBe(true);
  });

  it('WARM table rolls Common/Uncommon/Rare but never legendary', () => {
    const rng = new SeededRNG(789);
    const tiers = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tiers.add(rng.weightedPick(SECTOR_TIER_WEAPON_WEIGHTS.WARM));
    }
    expect(tiers.has('legendary')).toBe(false);
    expect(tiers.has('common')).toBe(true);
    expect(tiers.has('uncommon')).toBe(true);
    expect(tiers.has('rare')).toBe(true);
  });

  it('legacy ring tables remain exported for the demo-map fallback path', () => {
    expect(RING_TIER_WEIGHTS.outer).toHaveLength(1);
    expect(RING_TIER_WEIGHTS.center).toHaveLength(4);
  });
});

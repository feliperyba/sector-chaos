import { describe, it, expect } from 'vitest';
import { LootService } from '../../../src/domain/services/LootService.ts';
import { SeededRNG, ChestRarity, WeaponTier, PowerUpType } from '@sector-battle/shared';
import { CRATE_LOOT, CHEST_LOOT_TABLES } from '@sector-battle/shared';

describe('LootService', () => {
  describe('static constants', () => {
    it('has max legendary of 10', () => {
      expect(LootService.MAX_LEGENDARY).toBe(10);
    });
  });

  describe('shared loot constants (used by LootService)', () => {
    it('crate loot has correct drop chance and weapon split', () => {
      expect(CRATE_LOOT.DROP_CHANCE).toBe(0.6);
      expect(CRATE_LOOT.WEAPON_SPLIT).toBe(0.7);
    });

    it('crate weapon tier weights favor common and sum to 100', () => {
      const weights = CRATE_LOOT.WEAPON_TIER_WEIGHTS;
      const sum = weights.reduce((acc, w) => acc + w.weight, 0);
      expect(sum).toBe(100);
      expect(weights[0]!.item).toBe(WeaponTier.COMMON);
      expect(weights[0]!.weight).toBeGreaterThan(weights[1]!.weight);
      expect(weights[1]!.weight).toBeGreaterThan(weights[2]!.weight);
      expect(weights[2]!.weight).toBeGreaterThan(weights[3]!.weight);
    });

    it('crate powerup weights are equal across all types', () => {
      const weights = CRATE_LOOT.POWERUP_WEIGHTS;
      expect(weights).toHaveLength(3);
      expect(weights[0]!.weight).toBe(weights[1]!.weight);
      expect(weights[1]!.weight).toBe(weights[2]!.weight);
    });

    it('chest loot tables exist for all rarities', () => {
      expect(CHEST_LOOT_TABLES[ChestRarity.COMMON]).toBeDefined();
      expect(CHEST_LOOT_TABLES[ChestRarity.RARE]).toBeDefined();
      expect(CHEST_LOOT_TABLES[ChestRarity.EPIC]).toBeDefined();
      expect(CHEST_LOOT_TABLES[ChestRarity.LEGENDARY]).toBeDefined();
    });
  });

  describe('crate loot', () => {
    it('has ~60% drop rate over 10000 samples', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      let drops = 0;
      const iterations = 10000;
      for (let i = 0; i < iterations; i++) {
        const result = service.rollCrateLoot(rng);
        if (result !== null) drops++;
      }
      const rate = drops / iterations;
      expect(rate).toBeGreaterThan(0.57);
      expect(rate).toBeLessThan(0.63);
    });

    it('splits ~70% weapon / ~30% powerup', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      let weapons = 0;
      let powerups = 0;
      for (let i = 0; i < 10000; i++) {
        const result = service.rollCrateLoot(rng);
        if (result === null) continue;
        if (result.kind === 'weapon') weapons++;
        else powerups++;
      }
      const total = weapons + powerups;
      expect(weapons / total).toBeGreaterThan(0.65);
      expect(weapons / total).toBeLessThan(0.75);
    });

    it('distributes weapon tiers correctly', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      const counts: Record<string, number> = {};
      for (let i = 0; i < 10000; i++) {
        const result = service.rollCrateLoot(rng);
        if (result === null || result.kind !== 'weapon') continue;
        counts[result.tier] = (counts[result.tier] ?? 0) + 1;
      }
      expect(counts[WeaponTier.COMMON]).toBeGreaterThan(counts[WeaponTier.UNCOMMON]);
      expect(counts[WeaponTier.UNCOMMON]).toBeGreaterThan(counts[WeaponTier.RARE]);
      expect(counts[WeaponTier.RARE]).toBeGreaterThan(counts[WeaponTier.LEGENDARY]);
    });

    it('distributes powerup types roughly equally', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      const counts: Record<string, number> = {};
      for (let i = 0; i < 10000; i++) {
        const result = service.rollCrateLoot(rng);
        if (result === null || result.kind !== 'powerup') continue;
        counts[result.powerUpType] = (counts[result.powerUpType] ?? 0) + 1;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
      for (const key of ['health_pack', 'barrier', 'speed_boost']) {
        expect(counts[key] / total).toBeGreaterThan(0.25);
        expect(counts[key] / total).toBeLessThan(0.42);
      }
    });

    it('returns null when drop chance fails', () => {
      const service = new LootService();
      let callCount = 0;
      const mockRng = {
        nextFloat: () => {
          callCount++;
          if (callCount === 1) return 0.7;
          return 0;
        },
        nextUint32: () => 0,
        nextInt: () => 0,
        shuffle: <T>(arr: T[]) => arr,
        weightedPick: <T>(items: { item: T; weight: number }[]) => items[0]!.item,
        fork: function () {
          return mockRng;
        },
        clone: function () {
          return mockRng;
        },
      } as unknown as SeededRNG;
      const result = service.rollCrateLoot(mockRng);
      expect(result).toBeNull();
    });

    it('returns weapon when drop and weapon split succeed', () => {
      const service = new LootService();
      let callCount = 0;
      const mockRng = {
        nextFloat: () => {
          callCount++;
          if (callCount === 1) return 0.1;
          if (callCount === 2) return 0.1;
          return 0;
        },
        nextUint32: () => 0,
        nextInt: () => 0,
        shuffle: <T>(arr: T[]) => arr,
        weightedPick: <T>(items: { item: T; weight: number }[]) => items[0]!.item,
        fork: function () {
          return mockRng;
        },
        clone: function () {
          return mockRng;
        },
      } as unknown as SeededRNG;
      const result = service.rollCrateLoot(mockRng);
      expect(result).not.toBeNull();
      if (result !== null && result.kind === 'weapon') {
        expect(result.tier).toBe(WeaponTier.COMMON);
      }
    });

    it('returns powerup when drop succeeds and weapon split fails', () => {
      const service = new LootService();
      let callCount = 0;
      const mockRng = {
        nextFloat: () => {
          callCount++;
          if (callCount === 1) return 0.1;
          if (callCount === 2) return 0.8;
          return 0;
        },
        nextUint32: () => 0,
        nextInt: () => 0,
        shuffle: <T>(arr: T[]) => arr,
        weightedPick: <T>(items: { item: T; weight: number }[]) => items[0]!.item,
        fork: function () {
          return mockRng;
        },
        clone: function () {
          return mockRng;
        },
      } as unknown as SeededRNG;
      const result = service.rollCrateLoot(mockRng);
      expect(result).not.toBeNull();
      if (result !== null && result.kind === 'powerup') {
        expect(result.powerUpType).toBe('health_pack');
      }
    });
  });

  describe('rollChestLoot', () => {
    it('distributes common chest weapon tiers correctly', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      const counts: Record<string, number> = {};
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const result = service.rollChestLoot(ChestRarity.COMMON, rng);
        if (result.kind === 'weapon') {
          counts[result.tier] = (counts[result.tier] ?? 0) + 1;
        }
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(counts[WeaponTier.COMMON] / total).toBeGreaterThan(0.77);
      expect(counts[WeaponTier.COMMON] / total).toBeLessThan(0.83);
      expect(counts[WeaponTier.UNCOMMON] / total).toBeGreaterThan(0.12);
      expect(counts[WeaponTier.UNCOMMON] / total).toBeLessThan(0.18);
      expect(counts[WeaponTier.RARE] / total).toBeGreaterThan(0.01);
      expect(counts[WeaponTier.RARE] / total).toBeLessThan(0.07);
      expect(counts[WeaponTier.LEGENDARY] / total).toBeLessThan(0.04);
    });

    it('splits ~70% weapon / ~30% powerup', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      let weapons = 0;
      let powerups = 0;

      for (let i = 0; i < 10000; i++) {
        const result = service.rollChestLoot(ChestRarity.COMMON, rng);
        if (result.kind === 'weapon') weapons++;
        else powerups++;
      }

      const total = weapons + powerups;
      expect(weapons / total).toBeGreaterThan(0.67);
      expect(weapons / total).toBeLessThan(0.73);
      expect(powerups / total).toBeGreaterThan(0.27);
      expect(powerups / total).toBeLessThan(0.33);
    });

    it('distributes powerup types correctly', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      const counts: Record<number, number> = {};

      for (let i = 0; i < 10000; i++) {
        const result = service.rollChestLoot(ChestRarity.COMMON, rng);
        if (result.kind === 'powerup') {
          counts[result.powerUpType] = (counts[result.powerUpType] ?? 0) + 1;
        }
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(counts[PowerUpType.HEALTH_PACK] / total).toBeGreaterThan(0.47);
      expect(counts[PowerUpType.HEALTH_PACK] / total).toBeLessThan(0.53);
      expect(counts[PowerUpType.BARRIER] / total).toBeGreaterThan(0.22);
      expect(counts[PowerUpType.BARRIER] / total).toBeLessThan(0.28);
      expect(counts[PowerUpType.SPEED_BOOST] / total).toBeGreaterThan(0.22);
      expect(counts[PowerUpType.SPEED_BOOST] / total).toBeLessThan(0.28);
    });

    it('distributes legendary chest tiers correctly', () => {
      const service = new LootService();
      const rng = new SeededRNG(42);
      const counts: Record<string, number> = {};

      for (let i = 0; i < 10000; i++) {
        const result = service.rollChestLoot(ChestRarity.LEGENDARY, rng);
        if (result.kind === 'weapon') {
          counts[result.tier] = (counts[result.tier] ?? 0) + 1;
        }
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const rarePlusLegendary =
        (counts[WeaponTier.RARE] ?? 0) + (counts[WeaponTier.LEGENDARY] ?? 0);
      expect(rarePlusLegendary / total).toBeGreaterThan(0.67);
      expect(counts[WeaponTier.COMMON] / total).toBeLessThan(0.13);
    });

    it('returns powerup when weapon chance fails', () => {
      const service = new LootService();
      const mockRng = {
        nextFloat: () => 0.8,
        nextUint32: () => 0,
        nextInt: () => 0,
        shuffle: <T>(arr: T[]) => arr,
        weightedPick: <T>(items: { item: T; weight: number }[]) => items[0]!.item,
        fork: function () {
          return mockRng;
        },
        clone: function () {
          return mockRng;
        },
      } as unknown as SeededRNG;
      const result = service.rollChestLoot(ChestRarity.COMMON, mockRng);
      expect(result.kind).toBe('powerup');
      if (result.kind === 'powerup') {
        expect(result.powerUpType).toBe(PowerUpType.HEALTH_PACK);
      }
    });

    it('returns common weapon fallback when all weights are zero', () => {
      const service = new LootService();
      const mockRng = {
        nextFloat: () => 0.1,
        nextUint32: () => 0,
        nextInt: () => 0,
        shuffle: <T>(arr: T[]) => arr,
        weightedPick: <T>(items: { item: T; weight: number }[]) => items[0]!.item,
        fork: function () {
          return mockRng;
        },
        clone: function () {
          return mockRng;
        },
      } as unknown as SeededRNG;

      const originalTable = CHEST_LOOT_TABLES[ChestRarity.COMMON];
      const zeroedTable = originalTable.map((e) => ({ item: e.item, weight: 0 }));
      (CHEST_LOOT_TABLES as Record<number, { item: WeaponTier; weight: number }[]>)[
        ChestRarity.COMMON
      ] = zeroedTable;

      const result = service.rollChestLoot(ChestRarity.COMMON, mockRng);
      expect(result.kind).toBe('weapon');
      if (result.kind === 'weapon') {
        expect(result.tier).toBe(WeaponTier.COMMON);
      }

      (CHEST_LOOT_TABLES as Record<number, { item: WeaponTier; weight: number }[]>)[
        ChestRarity.COMMON
      ] = originalTable;
    });
  });
});

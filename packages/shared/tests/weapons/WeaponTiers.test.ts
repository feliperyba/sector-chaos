import { describe, it, expect } from 'vitest';
import { DURABILITY_BY_TIER, FISTS_INFINITE_DURABILITY } from '../../src/weapons/Weapon.js';
import { weaponRegistry } from '../../src/weapons/WeaponRegistry.js';
import { WeaponType } from '../../src/enums/WeaponType.js';
import { WeaponTier } from '../../src/enums/WeaponTier.js';

describe('DURABILITY_BY_TIER', () => {
  it.each([
    [WeaponTier.COMMON, 8],
    [WeaponTier.UNCOMMON, 10],
    [WeaponTier.RARE, 15],
    [WeaponTier.LEGENDARY, 20],
  ] as [WeaponTier, number][])('%s has durability %i', (tier, dur) => {
    expect(DURABILITY_BY_TIER[tier]).toBe(dur);
  });

  it('durability strictly increases from COMMON to LEGENDARY', () => {
    const values = [
      DURABILITY_BY_TIER[WeaponTier.COMMON],
      DURABILITY_BY_TIER[WeaponTier.UNCOMMON],
      DURABILITY_BY_TIER[WeaponTier.RARE],
      DURABILITY_BY_TIER[WeaponTier.LEGENDARY],
    ];
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });
});

describe('FISTS_INFINITE_DURABILITY', () => {
  it('equals -1', () => {
    expect(FISTS_INFINITE_DURABILITY).toBe(-1);
  });
});

describe('WeaponTier ordering', () => {
  it('all four tiers are defined', () => {
    expect(Object.keys(DURABILITY_BY_TIER)).toHaveLength(4);
  });
});

describe('Tier consistency', () => {
  const allTypes = Object.values(WeaponType).filter((v): v is WeaponType => typeof v === 'number');

  it.each(allTypes.map((t) => [WeaponType[t], t] as [string, WeaponType]))(
    '%s baseStats.tier matches def.tier',
    (_, type) => {
      const def = weaponRegistry.getDefinition(type);
      expect(def.baseStats.tier).toBe(def.tier);
    },
  );
});

describe('Weight tier correlation', () => {
  const allTypes = Object.values(WeaponType).filter((v): v is WeaponType => typeof v === 'number');

  it('higher damage weapons have higher weight tiers', () => {
    const weapons = allTypes
      .filter((t) => t !== WeaponType.FISTS)
      .map((type) => {
        const def = weaponRegistry.getDefinition(type);
        return { type, damage: def.baseStats.damage, weightTier: def.baseStats.weightTier };
      });

    const byWeightTier = new Map<number, number[]>();
    for (const w of weapons) {
      const arr = byWeightTier.get(w.weightTier) ?? [];
      arr.push(w.damage);
      byWeightTier.set(w.weightTier, arr);
    }

    const avgDamage = (damages: number[]) =>
      damages.reduce((sum, d) => sum + d, 0) / damages.length;

    const sorted = [...byWeightTier.entries()]
      .sort(([a], [b]) => a - b)
      .map(([_, damages]) => avgDamage(damages));

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBeGreaterThan(sorted[i - 1]);
    }
  });
});

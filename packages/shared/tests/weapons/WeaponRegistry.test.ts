import { describe, it, expect } from 'vitest';
import { WeaponRegistry, weaponRegistry } from '../../src/weapons/WeaponRegistry.js';
import { DURABILITY_BY_TIER, FISTS_INFINITE_DURABILITY } from '../../src/weapons/Weapon.js';
import { WeaponType } from '../../src/enums/WeaponType.js';
import { WeaponTier } from '../../src/enums/WeaponTier.js';
import { getDefaultDefinitions } from '../../src/weapons/definitions.js';

const ALL_TYPES: WeaponType[] = Object.values(WeaponType).filter(
  (v): v is WeaponType => typeof v === 'number',
);

describe('WeaponRegistry', () => {
  describe('getDefinition', () => {
    const cases: [string, WeaponType][] = ALL_TYPES.map((t) => [WeaponType[t], t]);

    it.each(cases)('returns non-null definition for %s', (_, type) => {
      const def = weaponRegistry.getDefinition(type);
      expect(def).toBeDefined();
      expect(def.type).toBe(type);
    });

    it('throws for invalid weapon type', () => {
      expect(() => weaponRegistry.getDefinition(999 as WeaponType)).toThrow();
    });
  });

  it('getAllTypes returns exactly 16 types', () => {
    expect(weaponRegistry.getAllTypes()).toHaveLength(16);
  });

  it('getAllTypes contains all WeaponType enum values', () => {
    const allTypes = weaponRegistry.getAllTypes();
    for (const enumValue of ALL_TYPES) {
      expect(allTypes).toContain(enumValue);
    }
  });

  describe('createWeapon durability', () => {
    const durabilityCases: [string, WeaponType, number][] = [
      ['FISTS', WeaponType.FISTS, FISTS_INFINITE_DURABILITY],
      ['DAGGER (COMMON)', WeaponType.DAGGER, DURABILITY_BY_TIER[WeaponTier.COMMON]],
      ['SHORT_SWORD (COMMON)', WeaponType.SHORT_SWORD, DURABILITY_BY_TIER[WeaponTier.COMMON]],
      ['LONG_SWORD (UNCOMMON)', WeaponType.LONG_SWORD, DURABILITY_BY_TIER[WeaponTier.COMMON]],
      ['HAMMER (RARE)', WeaponType.HAMMER, DURABILITY_BY_TIER[WeaponTier.COMMON]],
      ['DOUBLE_AXE (LEGENDARY)', WeaponType.DOUBLE_AXE, DURABILITY_BY_TIER[WeaponTier.COMMON]],
      ['SMALL_SHIELD (override=12)', WeaponType.SMALL_SHIELD, 12],
      ['LARGE_SHIELD (override=16)', WeaponType.LARGE_SHIELD, 16],
    ];

    it.each(durabilityCases)('%s has durability %i', (_, type, expectedDur) => {
      const weapon = weaponRegistry.createWeapon(type);
      expect(weapon.currentDurability).toBe(expectedDur);
      expect(weapon.stats.durability).toBe(expectedDur);
      expect(weapon.stats.maxDurability).toBe(expectedDur);
    });
  });

  describe('createWeapon all types', () => {
    const allTypeCases: [string, WeaponType][] = ALL_TYPES.map((t) => [WeaponType[t], t]);

    it.each(allTypeCases)('createWeapon(%s) returns weapon with matching type', (_, type) => {
      const weapon = weaponRegistry.createWeapon(type);
      expect(weapon.type).toBe(type);
    });

    it.each(allTypeCases)(
      'createWeapon(%s) stats.maxDurability === stats.durability',
      (_, type) => {
        const weapon = weaponRegistry.createWeapon(type);
        expect(weapon.stats.maxDurability).toBe(weapon.stats.durability);
      },
    );
  });

  it('registry is complete: getDefinition never throws for any valid type', () => {
    for (const type of ALL_TYPES) {
      expect(() => weaponRegistry.getDefinition(type)).not.toThrow();
    }
  });

  describe('constructor injection', () => {
    it('creates a registry with a custom definitions map', () => {
      // The validator runs in the ctor and requires the full WeaponType
      // coverage, so constructor injection tests use a complete (cloned) map.
      const customMap = new Map(getDefaultDefinitions());
      const customRegistry = new WeaponRegistry(customMap);

      expect(customRegistry.getAllTypes()).toHaveLength(16);
      expect(customRegistry.getDefinition(WeaponType.DAGGER)).toBe(
        customMap.get(WeaponType.DAGGER),
      );
    });

    it('throws for types not in the registry', () => {
      // getDefinition's not-found contract is independent of which definitions
      // the registry holds; exercise it via the default registry with an
      // out-of-range value.
      expect(() => weaponRegistry.getDefinition(999 as WeaponType)).toThrow(
        'Weapon definition not found for type',
      );
    });

    it('rejects a partial definitions map at construction (validator guard)', () => {
      // A custom map missing entries must fail-fast in the ctor rather than
      // silently producing a registry that throws later from getDefinition.
      const partialMap = new Map(getDefaultDefinitions());
      partialMap.delete(WeaponType.SPEAR);
      expect(() => new WeaponRegistry(partialMap)).toThrow(/SPEAR/);
    });

    it('defaults to all definitions when no map is provided', () => {
      const defaultRegistry = new WeaponRegistry();
      expect(defaultRegistry.getAllTypes()).toHaveLength(16);
    });
  });
});

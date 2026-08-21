import { describe, it, expect } from 'vitest';
import { WeaponType } from '../../enums/WeaponType.js';
import { AttackType } from '../../enums/AttackType.js';
import { getDefaultDefinitions } from '../definitions.js';
import { validateWeaponDefinitions } from '../validateWeaponDefinitions.js';
import { ALL_WEAPON_TYPES } from '../WeaponRegistry.js';

/**
 * Characterization tests for {@link validateWeaponDefinitions}. These pin the
 * triad-agreement and per-AttackType invariants the Weapon subsystem relies on
 * at runtime. See ticket #22.
 */
describe('validateWeaponDefinitions', () => {
  it('default definitions are valid', () => {
    expect(() => validateWeaponDefinitions(getDefaultDefinitions(), ALL_WEAPON_TYPES)).not.toThrow();
  });

  it('throws when a WeaponType entry is missing from the map', () => {
    const defs = getDefaultDefinitions();
    const mutated = new Map(defs);
    mutated.delete(WeaponType.HAMMER);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/HAMMER/);
  });

  it('throws when an ARC definition is missing arcAngle', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.DAGGER)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      [
        WeaponType.DAGGER,
        { ...baseDef, baseStats: { ...baseDef.baseStats, arcAngle: undefined } },
      ],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/arcAngle/);
  });

  it('throws when a RANGED definition is missing projectileSpeed', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.SHORT_BOW)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      [
        WeaponType.SHORT_BOW,
        { ...baseDef, baseStats: { ...baseDef.baseStats, projectileSpeed: undefined } },
      ],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/projectileSpeed/);
  });

  it('throws when a SHIELD definition is missing blockReduction', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.SMALL_SHIELD)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      [
        WeaponType.SMALL_SHIELD,
        { ...baseDef, baseStats: { ...baseDef.baseStats, blockReduction: undefined } },
      ],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/blockReduction/);
  });

  it('throws on negative damage', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.DAGGER)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      [
        WeaponType.DAGGER,
        { ...baseDef, baseStats: { ...baseDef.baseStats, damage: -5 } },
      ],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/damage/);
  });

  it('throws on zero cooldown', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.DAGGER)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      [
        WeaponType.DAGGER,
        { ...baseDef, baseStats: { ...baseDef.baseStats, cooldown: 0 } },
      ],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/cooldown/);
  });

  it('throws when FISTS has canThrow true', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.FISTS)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      [WeaponType.FISTS, { ...baseDef, canThrow: true }],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/FISTS/);
  });

  it('throws when the map key does not match def.type', () => {
    const baseDef = getDefaultDefinitions().get(WeaponType.DAGGER)!;
    const mutated = new Map<WeaponType, typeof baseDef>([
      // DAGGER definition stored under the HAMMER key
      [WeaponType.HAMMER, { ...baseDef, type: WeaponType.DAGGER }],
    ]);
    expect(() => validateWeaponDefinitions(mutated, ALL_WEAPON_TYPES)).toThrow(/HAMMER/);
  });

  it('throws when allSpawnableTypes includes FISTS', () => {
    const defs = getDefaultDefinitions();
    const driftTypes = [...ALL_WEAPON_TYPES, WeaponType.FISTS];
    expect(() => validateWeaponDefinitions(defs, driftTypes)).toThrow(/FISTS/);
  });
});

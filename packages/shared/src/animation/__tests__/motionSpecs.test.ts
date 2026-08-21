import { describe, it, expect } from 'vitest';
import { WeaponType } from '../../enums/WeaponType.js';
import { AttackType } from '../../enums/AttackType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import {
  WEAPON_MOTIONS,
  THROWN_MOTION,
  getAttackCategory,
  getAttackCategoryForAttack,
  getMotionSpec,
} from '../poses/index.js';
import { maxTipRadius } from '../poses/solveBladeLength.js';
import { getCooldownTicks } from '../AnimTiming.js';

const ALL_WEAPONS = Object.values(WeaponType).filter((v): v is WeaponType => typeof v === 'number');

/** Weapons whose strike segment IS the damage hitbox (melee swept). */
const SWEPT_WEAPONS = new Set<WeaponType>([
  WeaponType.FISTS,
  WeaponType.DAGGER,
  WeaponType.SHORT_SWORD,
  WeaponType.LONG_SWORD,
  WeaponType.HAMMER,
  WeaponType.LARGE_AXE,
  WeaponType.BLADED_AXE,
  WeaponType.DOUBLE_AXE,
  WeaponType.SPEAR,
  WeaponType.POLEARM,
  WeaponType.STAFF,
  WeaponType.THROWING_AXE,
]);

function meleeRange(type: WeaponType): number {
  const def = weaponRegistry.getDefinition(type);
  return def.meleeStats ? def.meleeStats.range : def.baseStats.range;
}

describe('WEAPON_MOTIONS registry', () => {
  it('covers all 16 weapon types', () => {
    expect(ALL_WEAPONS).toHaveLength(16);
    for (const type of ALL_WEAPONS) {
      expect(WEAPON_MOTIONS[type], `missing motion spec for ${WeaponType[type]}`).toBeDefined();
    }
  });

  it('keyframes are normalized: first=0, last=1, sorted by progress', () => {
    for (const type of ALL_WEAPONS) {
      const spec = WEAPON_MOTIONS[type];
      for (const phase of [spec.windup, spec.strike, spec.recover]) {
        const kfs = phase.keyframes;
        expect(kfs.length).toBeGreaterThanOrEqual(2);
        expect(kfs[0]!.progress).toBe(0);
        expect(kfs[kfs.length - 1]!.progress).toBe(1);
        for (let i = 1; i < kfs.length; i++) {
          expect(kfs[i]!.progress).toBeGreaterThan(kfs[i - 1]!.progress);
        }
      }
    }
  });

  it('strikeTicks fit inside the cooldown window', () => {
    for (const type of ALL_WEAPONS) {
      const spec = WEAPON_MOTIONS[type];
      expect(spec.strike.ticks, WeaponType[type]).toBeGreaterThan(0);
      expect(spec.strike.ticks, WeaponType[type]).toBeLessThanOrEqual(getCooldownTicks(type));
    }
  });

  it('active window is valid', () => {
    for (const type of ALL_WEAPONS) {
      const { activeFrom, activeTo } = WEAPON_MOTIONS[type].strike;
      expect(activeFrom).toBeGreaterThanOrEqual(0);
      expect(activeTo).toBeLessThanOrEqual(1);
      expect(activeFrom).toBeLessThanOrEqual(activeTo);
    }
  });

  it('apex tip reaches gameplay melee range; hands keep a full swing arc (swept weapons)', () => {
    // Contract after the arc-swing fix: the strike apex TIP must reach at least
    // `range` (lower bound only — the sweep handler caps damage at range, so a
    // visual overshoot is harmless and expected for long-bladed weapons whose
    // hands now swing their full authored arc instead of collapsing). The hand
    // apex radius must stay at or above the authored idle swing so the weapon
    // reads as swinging outward, not "in front of the face".
    for (const type of ALL_WEAPONS) {
      if (!SWEPT_WEAPONS.has(type)) continue;
      const spec = WEAPON_MOTIONS[type];
      const def = weaponRegistry.getDefinition(type);
      const apex = maxTipRadius(
        spec.strike.keyframes,
        spec.strike.easing,
        spec.strategy,
        def.visual.handOffset,
        spec.bladeLength,
      );
      const range = meleeRange(type);
      expect(apex, `${WeaponType[type]} apex ${apex.toFixed(1)} vs range ${range}`).toBeGreaterThan(
        range * 0.92,
      );
    }
  });

  it('weight classes are in range', () => {
    for (const type of ALL_WEAPONS) {
      expect([0, 1, 2, 3]).toContain(WEAPON_MOTIONS[type].weightClass);
    }
  });
});

describe('category mapping', () => {
  it('maps weapons to legacy categories', () => {
    expect(getAttackCategory(WeaponType.FISTS)).toBe('fists');
    expect(getAttackCategory(WeaponType.LONG_SWORD)).toBe('arc');
    expect(getAttackCategory(WeaponType.SPEAR)).toBe('line');
    expect(getAttackCategory(WeaponType.SHORT_BOW)).toBe('ranged');
    expect(getAttackCategory(WeaponType.SMALL_SHIELD)).toBe('shield');
    expect(getAttackCategory(WeaponType.THROWING_AXE)).toBe('thrown');
    expect(getAttackCategory(-1)).toBe('fists');
  });

  it('thrown attacks always use the thrown motion', () => {
    expect(getAttackCategoryForAttack(WeaponType.LONG_SWORD, AttackType.THROWN)).toBe('thrown');
    expect(getMotionSpec(WeaponType.LONG_SWORD, AttackType.THROWN)).toBe(THROWN_MOTION);
    expect(getAttackCategoryForAttack(WeaponType.THROWING_AXE, AttackType.ARC)).toBe('arc');
    expect(getMotionSpec(WeaponType.LONG_SWORD, AttackType.ARC)).toBe(
      WEAPON_MOTIONS[WeaponType.LONG_SWORD],
    );
  });
});

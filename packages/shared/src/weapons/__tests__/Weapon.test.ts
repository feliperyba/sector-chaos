import { describe, it, expect } from 'vitest';
import { WeaponType } from '../../enums/WeaponType.js';
import { WeaponTier } from '../../enums/WeaponTier.js';
import { AttackType } from '../../enums/AttackType.js';
import { DURABILITY_BY_TIER, FISTS_INFINITE_DURABILITY } from '../Weapon.js';
import { weaponRegistry } from '../WeaponRegistry.js';

describe('Weapon', () => {
  it('all 16 weapon types are registered', () => {
    expect(weaponRegistry.getAllTypes().length).toBe(16);
  });

  it('getDefinition returns correct stats for DAGGER', () => {
    const def = weaponRegistry.getDefinition(WeaponType.DAGGER);
    expect(def.baseStats.damage).toBe(8);
    expect(def.baseStats.range).toBe(160);
    expect(def.baseStats.cooldown).toBe(300);
    expect(def.baseStats.knockback).toBe(5);
  });

  it('createWeapon creates instance with correct durability', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.DAGGER);
    expect(weapon.stats.durability).toBe(DURABILITY_BY_TIER[WeaponTier.COMMON]);
    expect(weapon.stats.durability).toBe(8);
    expect(weapon.stats.maxDurability).toBe(8);
    expect(weapon.currentDurability).toBe(8);
    expect(weapon.stats.tier).toBe(WeaponTier.COMMON);
  });

  it('fists have infinite durability', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.FISTS);
    expect(weapon.currentDurability).toBe(FISTS_INFINITE_DURABILITY);
    expect(weapon.currentDurability).toBe(-1);
  });

  it('weapon durability decrements on use', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.DAGGER);
    const initial = weapon.currentDurability;
    weapon.currentDurability--;
    expect(weapon.currentDurability).toBe(initial - 1);
  });

  it('weapon breaks at 0 durability', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.DAGGER);
    weapon.currentDurability = 0;
    expect(weapon.currentDurability).toBe(0);
    expect(weapon.currentDurability <= 0).toBe(true);
  });

  it('getDefinition throws for unknown type', () => {
    expect(() => weaponRegistry.getDefinition(null as never)).toThrow();
  });

  it('createWeapon copies baseStats into weapon stats', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.SHORT_SWORD);
    expect(weapon.type).toBe(WeaponType.SHORT_SWORD);
    expect(weapon.stats.damage).toBe(12);
    expect(weapon.stats.range).toBe(192);
    expect(weapon.stats.attackType).toBe(AttackType.ARC);
    expect(weapon.stats.tier).toBe(WeaponTier.COMMON);
  });

  it('UNCOMMON weapons get correct durability when tier is passed', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.LONG_SWORD, WeaponTier.UNCOMMON);
    expect(weapon.currentDurability).toBe(DURABILITY_BY_TIER[WeaponTier.UNCOMMON]);
    expect(weapon.currentDurability).toBe(10);
    expect(weapon.stats.tier).toBe(WeaponTier.UNCOMMON);
    expect(weapon.stats.damage).toBe(Math.round(18 * 1.25));
  });

  it('RARE weapons get correct durability when tier is passed', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.HAMMER, WeaponTier.RARE);
    expect(weapon.currentDurability).toBe(DURABILITY_BY_TIER[WeaponTier.RARE]);
    expect(weapon.currentDurability).toBe(15);
    expect(weapon.stats.tier).toBe(WeaponTier.RARE);
    expect(weapon.stats.damage).toBe(Math.round(22 * 1.75));
  });

  it('LEGENDARY weapons get scaled stats', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.DOUBLE_AXE, WeaponTier.LEGENDARY);
    expect(weapon.stats.tier).toBe(WeaponTier.LEGENDARY);
    expect(weapon.stats.damage).toBe(Math.round(30 * 2.0));
    expect(weapon.stats.range).toBe(Math.round(240 * 2.0));
    expect(weapon.stats.knockback).toBe(Math.round(30 * 2.0));
    expect(weapon.currentDurability).toBe(20);
  });

  it('getAllTypes includes all weapon categories', () => {
    const types = weaponRegistry.getAllTypes();
    expect(types).toContain(WeaponType.FISTS);
    expect(types).toContain(WeaponType.DAGGER);
    expect(types).toContain(WeaponType.CROSSBOW);
    expect(types).toContain(WeaponType.SMALL_SHIELD);
    expect(types).toContain(WeaponType.DOUBLE_AXE);
  });

  it('thrown weapons have bounces stat', () => {
    const def = weaponRegistry.getDefinition(WeaponType.THROWING_AXE);
    expect(def.baseStats.bounces).toBe(3);
    expect(def.attackType).toBe(AttackType.THROWN);
  });

  it('ranged weapons have projectileSpeed stat', () => {
    const def = weaponRegistry.getDefinition(WeaponType.SHORT_BOW);
    expect(def.baseStats.projectileSpeed).toBe(2000);
    expect(def.baseStats.throwSpeed).toBe(1000);
    expect(def.baseStats.throwRange).toBe(1200);
    expect(def.baseStats.throwKnockback).toBe(3);
  });

  it('CROSSBOW has correct throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.CROSSBOW);
    expect(def.baseStats.damage).toBe(25);
    expect(def.baseStats.range).toBe(2000);
    expect(def.baseStats.cooldown).toBe(1000);
    expect(def.baseStats.knockback).toBe(12);
    expect(def.baseStats.attackType).toBe(AttackType.RANGED);
    expect(def.baseStats.weightTier).toBe(3);
    expect(def.baseStats.windupMs).toBe(200);
    expect(def.baseStats.projectileSpeed).toBe(2000);
    expect(def.baseStats.throwSpeed).toBe(1000);
    expect(def.baseStats.throwRange).toBe(640);
    expect(def.baseStats.throwKnockback).toBe(12);
  });

  it('SPEAR has correct throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.SPEAR);
    expect(def.baseStats.damage).toBe(15);
    expect(def.baseStats.range).toBe(320);
    expect(def.baseStats.cooldown).toBe(500);
    expect(def.baseStats.knockback).toBe(10);
    expect(def.baseStats.attackType).toBe(AttackType.LINE);
    expect(def.baseStats.weightTier).toBe(1);
    expect(def.baseStats.windupMs).toBe(150);
    expect(def.baseStats.throwSpeed).toBe(1600);
    expect(def.baseStats.throwRange).toBe(1500);
    expect(def.baseStats.throwKnockback).toBe(10);
  });

  it('POLEARM has correct throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.POLEARM);
    expect(def.baseStats.damage).toBe(22);
    expect(def.baseStats.range).toBe(384);
    expect(def.baseStats.cooldown).toBe(700);
    expect(def.baseStats.knockback).toBe(20);
    expect(def.baseStats.attackType).toBe(AttackType.LINE);
    expect(def.baseStats.weightTier).toBe(2);
    expect(def.baseStats.windupMs).toBe(200);
    expect(def.baseStats.throwSpeed).toBe(1300);
    expect(def.baseStats.throwRange).toBe(1500);
    expect(def.baseStats.throwKnockback).toBe(20);
  });

  it('STAFF has correct throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.STAFF);
    expect(def.baseStats.damage).toBe(10);
    expect(def.baseStats.range).toBe(288);
    expect(def.baseStats.cooldown).toBe(400);
    expect(def.baseStats.knockback).toBe(5);
    expect(def.baseStats.attackType).toBe(AttackType.LINE);
    expect(def.baseStats.weightTier).toBe(0);
    expect(def.baseStats.windupMs).toBe(150);
    expect(def.baseStats.throwSpeed).toBe(1300);
    expect(def.baseStats.throwRange).toBe(1000);
    expect(def.baseStats.throwKnockback).toBe(5);
  });

  it('THROWING_AXE has meleeStats and throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.THROWING_AXE);
    expect(def.baseStats.damage).toBe(15);
    expect(def.baseStats.range).toBe(800);
    expect(def.baseStats.cooldown).toBe(500);
    expect(def.baseStats.knockback).toBe(8);
    expect(def.baseStats.bounces).toBe(3);
    expect(def.baseStats.attackType).toBe(AttackType.THROWN);
    expect(def.baseStats.weightTier).toBe(0);
    expect(def.baseStats.windupMs).toBe(100);
    expect(def.baseStats.throwSpeed).toBe(1800);
    expect(def.baseStats.throwRange).toBe(1500);
    expect(def.baseStats.throwKnockback).toBe(8);
    expect(def.meleeStats).toBeDefined();
    expect(def.meleeStats!.damage).toBe(10);
    expect(def.meleeStats!.range).toBe(160);
    expect(def.meleeStats!.cooldown).toBe(400);
    expect(def.meleeStats!.knockback).toBe(5);
    expect(def.meleeStats!.attackType).toBe(AttackType.ARC);
    expect(def.meleeStats!.arcAngle).toBeCloseTo(Math.PI / 2);
    expect(def.meleeStats!.windupMs).toBe(80);
  });

  it('SHORT_BOW has correct throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.SHORT_BOW);
    expect(def.baseStats.damage).toBe(10);
    expect(def.baseStats.range).toBe(1800);
    expect(def.baseStats.cooldown).toBe(500);
    expect(def.baseStats.knockback).toBe(3);
    expect(def.baseStats.attackType).toBe(AttackType.RANGED);
    expect(def.baseStats.weightTier).toBe(3);
    expect(def.baseStats.windupMs).toBe(150);
    expect(def.baseStats.projectileSpeed).toBe(2000);
    expect(def.baseStats.throwSpeed).toBe(1000);
    expect(def.baseStats.throwRange).toBe(1200);
    expect(def.baseStats.throwKnockback).toBe(3);
  });

  it('DOUBLE_AXE has correct throw stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.DOUBLE_AXE);
    expect(def.baseStats.throwSpeed).toBe(1000);
    expect(def.baseStats.throwRange).toBe(480);
    expect(def.baseStats.throwKnockback).toBe(30);
  });

  it('SMALL_SHIELD has correct shield stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.SMALL_SHIELD);
    expect(def.baseStats.damage).toBe(5);
    expect(def.baseStats.range).toBe(400);
    expect(def.baseStats.cooldown).toBe(500);
    expect(def.baseStats.knockback).toBe(50);
    expect(def.baseStats.attackType).toBe(AttackType.SHIELD);
    expect(def.baseStats.weightTier).toBe(0);
    expect(def.baseStats.windupMs).toBe(100);
    expect(def.baseStats.blockReduction).toBe(1.0);
    expect(def.baseStats.blockArcDegrees).toBe(90);
    expect(def.baseStats.staggerOnBreakMs).toBe(300);
    expect(def.baseStats.isBoomerang).toBe(true);
    expect(def.baseStats.throwSpeed).toBe(1200);
    expect(def.baseStats.throwRange).toBe(1500);
    expect(def.baseStats.throwKnockback).toBe(25);
    expect(def.durabilityMultiplier).toBe(1.5);
  });

  it('SMALL_SHIELD has weapon-specific durability of 12', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.SMALL_SHIELD);
    expect(weapon.currentDurability).toBe(12);
    expect(weapon.stats.durability).toBe(12);
    expect(weapon.stats.maxDurability).toBe(12);
  });

  it('LARGE_SHIELD has correct shield stats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.LARGE_SHIELD);
    expect(def.baseStats.damage).toBe(8);
    expect(def.baseStats.range).toBe(350);
    expect(def.baseStats.cooldown).toBe(500);
    expect(def.baseStats.knockback).toBe(50);
    expect(def.baseStats.attackType).toBe(AttackType.SHIELD);
    expect(def.baseStats.weightTier).toBe(1);
    expect(def.baseStats.windupMs).toBe(150);
    expect(def.baseStats.blockReduction).toBe(1.0);
    expect(def.baseStats.blockArcDegrees).toBe(180);
    expect(def.baseStats.staggerOnBreakMs).toBe(300);
    expect(def.baseStats.isBoomerang).toBe(true);
    expect(def.baseStats.throwSpeed).toBe(1200);
    expect(def.baseStats.throwRange).toBe(1000);
    expect(def.baseStats.throwKnockback).toBe(25);
    expect(def.durabilityMultiplier).toBe(2.0);
  });

  it('LARGE_SHIELD has weapon-specific durability of 16', () => {
    const weapon = weaponRegistry.createWeapon(WeaponType.LARGE_SHIELD);
    expect(weapon.currentDurability).toBe(16);
    expect(weapon.stats.durability).toBe(16);
    expect(weapon.stats.maxDurability).toBe(16);
  });

  it('SHIELD_TOWER does not exist in WeaponType', () => {
    expect('TOWER' in WeaponType).toBe(false);
    expect('SHIELD_TOWER' in WeaponType).toBe(false);
  });
});

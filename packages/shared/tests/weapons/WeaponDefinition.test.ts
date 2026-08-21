import { describe, it, expect, beforeAll } from 'vitest';
import { weaponRegistry } from '../../src/weapons/WeaponRegistry.js';
import type { WeaponDefinition } from '../../src/weapons/Weapon.js';
import { WeaponType } from '../../src/enums/WeaponType.js';
import { AttackType } from '../../src/enums/AttackType.js';
import { WeaponTier } from '../../src/enums/WeaponTier.js';

interface WeaponSpec {
  type: WeaponType;
  name: string;
  attackType: AttackType;
  damage: number;
  range: number;
  cooldown: number;
  knockback: number;
  weightTier: number;
  windupMs: number;
  tier: WeaponTier | null;
  canThrow: boolean;
  arcAngle?: number;
  bounces?: number;
  projectileSpeed?: number;
  blockReduction?: number;
  blockArcDegrees?: number;
  staggerOnBreakMs?: number;
  isBoomerang?: boolean;
}

const SPECS: WeaponSpec[] = [
  {
    type: WeaponType.FISTS,
    name: 'Fists',
    attackType: AttackType.ARC,
    damage: 5,
    range: 128,
    cooldown: 400,
    knockback: 0,
    weightTier: 0,
    windupMs: 50,
    tier: null,
    canThrow: false,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.DAGGER,
    name: 'Dagger',
    attackType: AttackType.ARC,
    damage: 8,
    range: 160,
    cooldown: 300,
    knockback: 5,
    weightTier: 0,
    windupMs: 100,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.SHORT_SWORD,
    name: 'Short Sword',
    attackType: AttackType.ARC,
    damage: 12,
    range: 192,
    cooldown: 450,
    knockback: 8,
    weightTier: 1,
    windupMs: 150,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.LONG_SWORD,
    name: 'Long Sword',
    attackType: AttackType.ARC,
    damage: 18,
    range: 224,
    cooldown: 600,
    knockback: 15,
    weightTier: 2,
    windupMs: 200,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.HAMMER,
    name: 'Hammer',
    attackType: AttackType.ARC,
    damage: 22,
    range: 192,
    cooldown: 800,
    knockback: 25,
    weightTier: 3,
    windupMs: 200,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.LARGE_AXE,
    name: 'Large Axe',
    attackType: AttackType.ARC,
    damage: 20,
    range: 208,
    cooldown: 700,
    knockback: 20,
    weightTier: 2,
    windupMs: 200,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.BLADED_AXE,
    name: 'Bladed Axe',
    attackType: AttackType.ARC,
    damage: 25,
    range: 224,
    cooldown: 750,
    knockback: 22,
    weightTier: 2,
    windupMs: 200,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.DOUBLE_AXE,
    name: 'Double Axe',
    attackType: AttackType.ARC,
    damage: 30,
    range: 240,
    cooldown: 850,
    knockback: 30,
    weightTier: 3,
    windupMs: 200,
    tier: null,
    canThrow: true,
    arcAngle: Math.PI / 2,
  },
  {
    type: WeaponType.SPEAR,
    name: 'Spear',
    attackType: AttackType.LINE,
    damage: 15,
    range: 320,
    cooldown: 500,
    knockback: 10,
    weightTier: 1,
    windupMs: 150,
    tier: null,
    canThrow: true,
  },
  {
    type: WeaponType.POLEARM,
    name: 'Polearm',
    attackType: AttackType.LINE,
    damage: 22,
    range: 384,
    cooldown: 700,
    knockback: 20,
    weightTier: 2,
    windupMs: 200,
    tier: null,
    canThrow: true,
  },
  {
    type: WeaponType.STAFF,
    name: 'Staff',
    attackType: AttackType.LINE,
    damage: 10,
    range: 288,
    cooldown: 400,
    knockback: 5,
    weightTier: 0,
    windupMs: 150,
    tier: null,
    canThrow: true,
  },
  {
    type: WeaponType.THROWING_AXE,
    name: 'Throwing Axe',
    attackType: AttackType.THROWN,
    damage: 15,
    range: 800,
    cooldown: 500,
    knockback: 8,
    weightTier: 0,
    windupMs: 100,
    tier: null,
    canThrow: true,
    bounces: 3,
  },
  {
    type: WeaponType.SHORT_BOW,
    name: 'Short Bow',
    attackType: AttackType.RANGED,
    damage: 10,
    range: 1800,
    cooldown: 500,
    knockback: 3,
    weightTier: 3,
    windupMs: 150,
    tier: null,
    canThrow: true,
    projectileSpeed: 2000,
  },
  {
    type: WeaponType.CROSSBOW,
    name: 'Crossbow',
    attackType: AttackType.RANGED,
    damage: 25,
    range: 2000,
    cooldown: 1000,
    knockback: 12,
    weightTier: 3,
    windupMs: 200,
    tier: null,
    canThrow: true,
    projectileSpeed: 2000,
  },
  {
    type: WeaponType.SMALL_SHIELD,
    name: 'Small Shield',
    attackType: AttackType.SHIELD,
    damage: 5,
    range: 400,
    cooldown: 500,
    knockback: 50,
    weightTier: 0,
    windupMs: 100,
    tier: null,
    canThrow: true,
    blockReduction: 1.0,
    blockArcDegrees: 90,
    staggerOnBreakMs: 300,
    isBoomerang: true,
  },
  {
    type: WeaponType.LARGE_SHIELD,
    name: 'Large Shield',
    attackType: AttackType.SHIELD,
    damage: 8,
    range: 350,
    cooldown: 500,
    knockback: 50,
    weightTier: 1,
    windupMs: 150,
    tier: null,
    canThrow: true,
    blockReduction: 1.0,
    blockArcDegrees: 180,
    staggerOnBreakMs: 300,
    isBoomerang: true,
  },
];

describe.each(SPECS)('Weapon: $name', (spec) => {
  let def: WeaponDefinition;

  beforeAll(() => {
    def = weaponRegistry.getDefinition(spec.type);
  });

  it('has correct name', () => {
    expect(def.name).toBe(spec.name);
  });

  it('has correct attackType and tier', () => {
    expect(def.attackType).toBe(spec.attackType);
    expect(def.baseStats.attackType).toBe(spec.attackType);
    expect(def.tier).toBe(spec.tier);
    expect(def.baseStats.tier).toBe(spec.tier);
  });

  it('has correct combat stats', () => {
    expect(def.baseStats.damage).toBe(spec.damage);
    expect(def.baseStats.range).toBe(spec.range);
    expect(def.baseStats.cooldown).toBe(spec.cooldown);
    expect(def.baseStats.knockback).toBe(spec.knockback);
    expect(def.baseStats.weightTier).toBe(spec.weightTier);
    expect(def.baseStats.windupMs).toBe(spec.windupMs);
    expect(def.canThrow).toBe(spec.canThrow);
  });

  it('has positive cooldown, range, damage, and windupMs', () => {
    expect(def.baseStats.cooldown).toBeGreaterThan(0);
    expect(def.baseStats.range).toBeGreaterThan(0);
    expect(def.baseStats.damage).toBeGreaterThan(0);
    expect(def.baseStats.windupMs).toBeGreaterThan(0);
  });

  it('weightTier is between 0 and 3', () => {
    expect(def.baseStats.weightTier).toBeGreaterThanOrEqual(0);
    expect(def.baseStats.weightTier).toBeLessThanOrEqual(3);
  });

  if (spec.arcAngle !== undefined) {
    it('has correct arcAngle', () => {
      expect(def.baseStats.arcAngle).toBeCloseTo(spec.arcAngle!);
    });
  }

  if (spec.bounces !== undefined) {
    it('has correct bounces', () => {
      expect(def.baseStats.bounces).toBe(spec.bounces!);
    });
  }

  if (spec.projectileSpeed !== undefined) {
    it('has correct projectileSpeed', () => {
      expect(def.baseStats.projectileSpeed).toBe(spec.projectileSpeed!);
    });
  }

  if (spec.blockReduction !== undefined) {
    it('has correct shield properties', () => {
      expect(def.baseStats.blockReduction).toBe(spec.blockReduction!);
      expect(def.baseStats.blockArcDegrees).toBe(spec.blockArcDegrees!);
      expect(def.baseStats.staggerOnBreakMs).toBe(spec.staggerOnBreakMs!);
      expect(def.baseStats.isBoomerang).toBe(spec.isBoomerang!);
    });
  }
});

describe('Weapon special properties', () => {
  it('THROWING_AXE has correct meleeStats', () => {
    const def = weaponRegistry.getDefinition(WeaponType.THROWING_AXE);
    expect(def.meleeStats).toBeDefined();
    expect(def.meleeStats!.damage).toBe(10);
    expect(def.meleeStats!.range).toBe(160);
    expect(def.meleeStats!.cooldown).toBe(400);
    expect(def.meleeStats!.knockback).toBe(5);
    expect(def.meleeStats!.attackType).toBe(AttackType.ARC);
    expect(def.meleeStats!.arcAngle).toBeCloseTo(Math.PI / 2);
    expect(def.meleeStats!.windupMs).toBe(80);
  });

  it('only THROWING_AXE has bounces > 0', () => {
    const throwableSpecs = SPECS.filter((s) => s.type !== WeaponType.THROWING_AXE);
    for (const spec of throwableSpecs) {
      const def = weaponRegistry.getDefinition(spec.type);
      expect(def.baseStats.bounces).toBe(0);
    }
    const throwingAxe = weaponRegistry.getDefinition(WeaponType.THROWING_AXE);
    expect(throwingAxe.baseStats.bounces).toBe(3);
  });

  it('throw-capable weapons have throwSpeed, throwRange, throwKnockback', () => {
    const throwableSpecs = SPECS.filter((s) => s.canThrow);
    for (const spec of throwableSpecs) {
      const def = weaponRegistry.getDefinition(spec.type);
      expect(def.baseStats.throwSpeed).toBeDefined();
      expect(def.baseStats.throwSpeed!).toBeGreaterThan(0);
      expect(def.baseStats.throwRange).toBeDefined();
      expect(def.baseStats.throwRange!).toBeGreaterThan(0);
      expect(def.baseStats.throwKnockback).toBeDefined();
      expect(def.baseStats.throwKnockback!).toBeGreaterThan(0);
    }
  });
});

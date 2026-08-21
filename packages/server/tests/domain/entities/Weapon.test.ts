import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import {
  WeaponType,
  WeaponTier,
  FISTS_INFINITE_DURABILITY,
  DURABILITY_BY_TIER,
} from '@sector-battle/shared';

describe('WeaponEntity', () => {
  describe('Weapon Creation with Type, Tier, Durability', () => {
    it('creates DAGGER COMMON with all fields', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      expect(weapon.id).toBe('w1');
      expect(weapon.type).toBe(WeaponType.DAGGER);
      expect(weapon.tier).toBe(WeaponTier.COMMON);
      expect(weapon.ammo).toBe(20);
      expect(weapon.maxAmmo).toBe(20);
      expect(weapon.durability).toBe(20);
      expect(weapon.cooldown).toBe(30);
      expect(weapon.cooldownRemaining).toBe(0);
    });

    it('creates LONG_SWORD RARE with correct fields', () => {
      const weapon = new WeaponEntity('w2', WeaponType.LONG_SWORD, WeaponTier.RARE, 10, 10, 40);
      expect(weapon.durability).toBe(10);
      expect(weapon.tier).toBe(WeaponTier.RARE);
    });

    it('creates HAMMER LEGENDARY with correct fields', () => {
      const weapon = new WeaponEntity('w3', WeaponType.HAMMER, WeaponTier.LEGENDARY, 8, 8, 50);
      expect(weapon.durability).toBe(8);
      expect(weapon.tier).toBe(WeaponTier.LEGENDARY);
    });
  });

  describe('Durability Consumption and Break', () => {
    it('use() decrements ammo by 1 and sets cooldownRemaining, returns true', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const result = weapon.use();
      expect(result).toBe(true);
      expect(weapon.ammo).toBe(19);
      expect(weapon.cooldownRemaining).toBe(30);
    });

    it('use() does not decrement ammo when FISTS_INFINITE_DURABILITY', () => {
      const weapon = new WeaponEntity(
        'f1',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      const result = weapon.use();
      expect(result).toBe(true);
      expect(weapon.ammo).toBe(FISTS_INFINITE_DURABILITY);
    });

    it('use() returns false when ammo === 0 (broken weapon)', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 0, 20, 30);
      expect(weapon.use()).toBe(false);
    });

    it('use() returns false when cooldownRemaining > 0', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 5, 20, 30);
      weapon.use();
      expect(weapon.cooldownRemaining).toBe(30);
      expect(weapon.use()).toBe(false);
    });

    it('consumeDurability(1) decreases ammo by 1 and returns new ammo', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const result = weapon.consumeDurability(1);
      expect(result).toBe(19);
      expect(weapon.ammo).toBe(19);
    });

    it('consumeDurability(5) on ammo=3 clamps to 0', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 3, 20, 30);
      const result = weapon.consumeDurability(5);
      expect(result).toBe(0);
      expect(weapon.ammo).toBe(0);
    });

    it('isBroken returns true when ammo === 0', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 0, 20, 30);
      expect(weapon.isBroken).toBe(true);
    });

    it('isBroken returns false when ammo > 0', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 5, 20, 30);
      expect(weapon.isBroken).toBe(false);
    });

    it('sequential durability: ammo=1 consumeDurability(1) breaks weapon, subsequent use() returns false', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 30);
      weapon.consumeDurability(1);
      expect(weapon.ammo).toBe(0);
      expect(weapon.isBroken).toBe(true);
      expect(weapon.use()).toBe(false);
    });
  });

  describe('Cooldown Management', () => {
    it('fresh weapon has cooldownRemaining=0 and canUse=true', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      expect(weapon.cooldownRemaining).toBe(0);
      expect(weapon.canUse).toBe(true);
    });

    it('after use() cooldownRemaining equals cooldown and canUse=false', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      weapon.use();
      expect(weapon.cooldownRemaining).toBe(30);
      expect(weapon.canUse).toBe(false);
    });

    it('tick() decrements cooldownRemaining by 1', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      weapon.use();
      weapon.tick();
      expect(weapon.cooldownRemaining).toBe(29);
    });

    it('after cooldown ticks: cooldownRemaining=0 and canUse=true', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      weapon.use();
      for (let i = 0; i < 30; i++) {
        weapon.tick();
      }
      expect(weapon.cooldownRemaining).toBe(0);
      expect(weapon.canUse).toBe(true);
    });

    it('tick() when cooldownRemaining=0 does not go negative', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      expect(weapon.cooldownRemaining).toBe(0);
      weapon.tick();
      expect(weapon.cooldownRemaining).toBe(0);
    });

    it('cooldown minimum clamped to 1 when 0 passed', () => {
      const weapon = new WeaponEntity('w', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 0);
      expect(weapon.cooldown).toBe(1);
    });
  });

  describe('startAttack()', () => {
    it('sets cooldownRemaining=cooldown and returns true', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const result = weapon.startAttack();
      expect(result).toBe(true);
      expect(weapon.cooldownRemaining).toBe(30);
    });

    it('returns false when canUse is false', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      weapon.startAttack();
      expect(weapon.startAttack()).toBe(false);
    });

    it('does NOT consume durability unlike use()', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      weapon.startAttack();
      expect(weapon.ammo).toBe(20);
    });
  });

  describe('Fists Special Behavior (Infinite Durability)', () => {
    it('has ammo=-1, durability=-1, isBroken=false', () => {
      const fists = new WeaponEntity(
        '__fists_0',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      expect(fists.ammo).toBe(-1);
      expect(fists.durability).toBe(-1);
      expect(fists.isBroken).toBe(false);
    });

    it('canUse=true when cooldown allows', () => {
      const fists = new WeaponEntity(
        '__fists_0',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      expect(fists.canUse).toBe(true);
    });

    it('use() does NOT decrement ammo (stays -1), sets cooldown, returns true', () => {
      const fists = new WeaponEntity(
        '__fists_0',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      const result = fists.use();
      expect(result).toBe(true);
      expect(fists.ammo).toBe(FISTS_INFINITE_DURABILITY);
      expect(fists.cooldownRemaining).toBe(24);
    });

    it('consumeDurability(1) returns FISTS_INFINITE_DURABILITY, ammo unchanged', () => {
      const fists = new WeaponEntity(
        '__fists_0',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      const result = fists.consumeDurability(1);
      expect(result).toBe(FISTS_INFINITE_DURABILITY);
      expect(fists.ammo).toBe(FISTS_INFINITE_DURABILITY);
    });

    it('consumeDurability(5) returns FISTS_INFINITE_DURABILITY, ammo unchanged', () => {
      const fists = new WeaponEntity(
        '__fists_0',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      const result = fists.consumeDurability(5);
      expect(result).toBe(FISTS_INFINITE_DURABILITY);
      expect(fists.ammo).toBe(FISTS_INFINITE_DURABILITY);
    });
  });

  describe('Tier-Based Durability Values', () => {
    it('DURABILITY_BY_TIER has correct values', () => {
      expect(DURABILITY_BY_TIER[WeaponTier.COMMON]).toBe(8);
      expect(DURABILITY_BY_TIER[WeaponTier.UNCOMMON]).toBe(10);
      expect(DURABILITY_BY_TIER[WeaponTier.RARE]).toBe(15);
      expect(DURABILITY_BY_TIER[WeaponTier.LEGENDARY]).toBe(20);
    });

    it('weapons created at each tier have correct ammo', () => {
      const common = new WeaponEntity(
        'c',
        WeaponType.DAGGER,
        WeaponTier.COMMON,
        DURABILITY_BY_TIER[WeaponTier.COMMON],
        DURABILITY_BY_TIER[WeaponTier.COMMON],
        30,
      );
      expect(common.ammo).toBe(8);

      const uncommon = new WeaponEntity(
        'u',
        WeaponType.DAGGER,
        WeaponTier.UNCOMMON,
        DURABILITY_BY_TIER[WeaponTier.UNCOMMON],
        DURABILITY_BY_TIER[WeaponTier.UNCOMMON],
        30,
      );
      expect(uncommon.ammo).toBe(10);

      const rare = new WeaponEntity(
        'r',
        WeaponType.DAGGER,
        WeaponTier.RARE,
        DURABILITY_BY_TIER[WeaponTier.RARE],
        DURABILITY_BY_TIER[WeaponTier.RARE],
        30,
      );
      expect(rare.ammo).toBe(15);

      const legendary = new WeaponEntity(
        'l',
        WeaponType.DAGGER,
        WeaponTier.LEGENDARY,
        DURABILITY_BY_TIER[WeaponTier.LEGENDARY],
        DURABILITY_BY_TIER[WeaponTier.LEGENDARY],
        30,
      );
      expect(legendary.ammo).toBe(20);
    });
  });

  describe('canUse Property', () => {
    it('returns true when ammo > 0 and cooldownRemaining <= 0', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 5, 20, 30);
      expect(weapon.canUse).toBe(true);
    });

    it('returns false when ammo === 0 (broken)', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 0, 20, 30);
      expect(weapon.canUse).toBe(false);
    });

    it('returns false when cooldownRemaining > 0', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 5, 20, 30);
      weapon.use();
      expect(weapon.canUse).toBe(false);
    });

    it('returns true for Fists (ammo=-1) when cooldown allows', () => {
      const fists = new WeaponEntity(
        '__fists_0',
        WeaponType.FISTS,
        WeaponTier.COMMON,
        FISTS_INFINITE_DURABILITY,
        FISTS_INFINITE_DURABILITY,
        24,
      );
      expect(fists.canUse).toBe(true);
    });
  });
});

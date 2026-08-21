import { describe, it, expect } from 'vitest';
import { WeaponPickup } from '../../../src/domain/entities/WeaponPickup.ts';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { WeaponType, WeaponTier } from '@sector-battle/shared';

describe('WeaponPickup', () => {
  describe('factory creation', () => {
    it('creates with correct defaults', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const pickup = WeaponPickup.create('wp1', weapon, new Position(100, 100), 0);

      expect(pickup.id).toBe('wp1');
      expect(pickup.weapon).toBe(weapon);
      expect(pickup.position.x).toBe(100);
      expect(pickup.position.y).toBe(100);
      expect(pickup.spawnTick).toBe(0);
      expect(pickup.isActive).toBe(true);
    });

    it('preserves weapon reference', () => {
      const weapon = new WeaponEntity('w1', WeaponType.LONG_SWORD, WeaponTier.RARE, 10, 10, 40);
      const pickup = WeaponPickup.create('wp2', weapon, new Position(50, 50), 100);

      expect(pickup.weapon.id).toBe('w1');
      expect(pickup.weapon.type).toBe(WeaponType.LONG_SWORD);
      expect(pickup.weapon.tier).toBe(WeaponTier.RARE);
    });

    it('stores spawnTick correctly', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const pickup = WeaponPickup.create('wp1', weapon, new Position(0, 0), 500);
      expect(pickup.spawnTick).toBe(500);
    });
  });

  describe('deactivation', () => {
    it('sets isActive to false', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const pickup = WeaponPickup.create('wp1', weapon, new Position(0, 0), 0);
      expect(pickup.isActive).toBe(true);

      pickup.deactivate();
      expect(pickup.isActive).toBe(false);
    });

    it('deactivate is idempotent', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const pickup = WeaponPickup.create('wp1', weapon, new Position(0, 0), 0);
      pickup.deactivate();
      pickup.deactivate();
      expect(pickup.isActive).toBe(false);
    });
  });

  describe('persists indefinitely', () => {
    it('isActive stays true until explicitly deactivated', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const pickup = WeaponPickup.create('wp1', weapon, new Position(0, 0), 0);

      expect(pickup.isActive).toBe(true);
      expect(pickup.isActive).toBe(true);
      expect(pickup.isActive).toBe(true);

      pickup.deactivate();
      expect(pickup.isActive).toBe(false);
    });

    it('has no auto-despawn logic', () => {
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 20, 20, 30);
      const pickup = WeaponPickup.create('wp1', weapon, new Position(0, 0), 0);

      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(pickup));
      const hasDespawnMethod = methods.some(
        (m) =>
          m.toLowerCase().includes('despawn') ||
          m.toLowerCase().includes('expire') ||
          m.toLowerCase().includes('timeout'),
      );
      expect(hasDespawnMethod).toBe(false);
    });
  });
});

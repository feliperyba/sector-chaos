import { ShieldHandler } from '../../../src/domain/handlers/ShieldHandler.ts';
import { Player, WeaponEntity } from '../../../src/domain/entities/index.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { DamageType, WeaponType, WeaponTier } from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';

function createDefaultConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 200,
    dashCooldown: 2000,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: 32,
    hitboxHeight: 32,
    ...overrides,
  };
}

function createPlayer(id: string, x: number, y: number, facing: number): Player {
  const player = new Player(id, `player_${id}`, new Position(x, y), createDefaultConfig());
  player.movement.facingAngle = facing;
  return player;
}

function equipShield(player: Player, type: WeaponType = WeaponType.SMALL_SHIELD): void {
  const weapon = new WeaponEntity('shield-1', type, WeaponTier.COMMON, 15, 15, 0);
  const slot = player.addWeapon(weapon);
  if (slot !== -1) player.forceSwitchSlot(slot);
}

const handler = new ShieldHandler();

describe('ShieldHandler', () => {
  describe('processIncomingDamage — passive blocking', () => {
    it('blocks MELEE_HIT from front when shield equipped', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.MELEE_HIT, 0);

      expect(result.damage).toBe(0);
      expect(result.knockback).toBe(0);
      expect(result.blocked).toBe(true);
      expect(result.shieldBroken).toBe(false);
    });

    it('does NOT block when no shield equipped', () => {
      const player = createPlayer('p1', 100, 100, 0);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.MELEE_HIT, 0);

      expect(result.blocked).toBe(false);
      expect(result.damage).toBe(20);
    });

    it('blocks THROWN_HIT from front', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.THROWN_HIT, 0);

      expect(result.blocked).toBe(true);
    });

    it('blocks RANGED_HIT from front', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.RANGED_HIT, 0);

      expect(result.blocked).toBe(true);
    });

    it('does NOT block BARREL_EXPLOSION', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(
        player,
        20,
        10,
        0,
        5,
        DamageType.BARREL_EXPLOSION,
        0,
      );

      expect(result.blocked).toBe(false);
    });

    it('does NOT block SIEGE_CRUSH', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.SIEGE_CRUSH, 0);

      expect(result.blocked).toBe(false);
    });

    it('does NOT block TRAP_DAMAGE', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.TRAP_DAMAGE, 0);

      expect(result.blocked).toBe(false);
    });

    it('does NOT block from behind', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(
        player,
        20,
        10,
        Math.PI,
        5,
        DamageType.MELEE_HIT,
        0,
      );

      expect(result.blocked).toBe(false);
    });

    it('does NOT block from side (90 degrees) with small shield', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player, WeaponType.SMALL_SHIELD);

      const result = handler.processIncomingDamage(
        player,
        20,
        10,
        Math.PI / 2,
        5,
        DamageType.MELEE_HIT,
        0,
      );

      expect(result.blocked).toBe(false);
    });

    it('large shield blocks from side (90 degrees)', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player, WeaponType.LARGE_SHIELD);

      const result = handler.processIncomingDamage(
        player,
        20,
        10,
        Math.PI / 2,
        5,
        DamageType.MELEE_HIT,
        0,
      );

      expect(result.blocked).toBe(true);
    });

    it('front attack within 45 degrees of facing blocks', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0.5, 5, DamageType.MELEE_HIT, 0);

      expect(result.blocked).toBe(true);
    });

    it('shieldBroken at durability 1', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 1, DamageType.MELEE_HIT, 0);

      expect(result.blocked).toBe(true);
      expect(result.shieldBroken).toBe(true);
    });

    it('shield NOT broken at durability 2+', () => {
      const player = createPlayer('p1', 100, 100, 0);
      equipShield(player);

      const result = handler.processIncomingDamage(player, 20, 10, 0, 5, DamageType.MELEE_HIT, 0);

      expect(result.shieldBroken).toBe(false);
    });

    it('different facing angles: facing down blocks attack from below', () => {
      const player = createPlayer('p1', 100, 100, Math.PI / 2);
      equipShield(player);

      const result = handler.processIncomingDamage(
        player,
        20,
        10,
        Math.PI / 2 + 0.3,
        5,
        DamageType.MELEE_HIT,
        0,
      );

      expect(result.blocked).toBe(true);
    });
  });
});

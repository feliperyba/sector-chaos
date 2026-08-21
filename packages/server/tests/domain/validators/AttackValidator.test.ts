import { AttackValidator } from '../../../src/domain/validators/AttackValidator.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import {
  PlayerStatus,
  type PlayerStatusType,
  WeaponType,
  WeaponTier,
  MatchPhase,
} from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';

function createDefaultConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 10,
    dashCooldown: 60,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: 24,
    hitboxHeight: 24,
    ...overrides,
  };
}

function createPlayer(id: string, x: number, y: number, status?: PlayerStatusType): Player {
  const player = new Player(id, `player_${id}`, new Position(x, y), createDefaultConfig());
  if (status !== undefined) player.statusEffects.status = status;
  return player;
}

function createWeapon(ammo = 10, cooldown = 10): WeaponEntity {
  return new WeaponEntity('weapon-1', WeaponType.DAGGER, WeaponTier.COMMON, ammo, ammo, cooldown);
}

const validator = new AttackValidator();

describe('AttackValidator', () => {
  describe('validate', () => {
    it('valid attack passes all checks', () => {
      const player = createPlayer('p1', 100, 100);
      const weapon = createWeapon();

      const result = validator.validate(player, weapon, 0, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects staggered player with PLAYER_STAGGERED', () => {
      const player = createPlayer('p1', 100, 100, PlayerStatus.STAGGERED);
      const weapon = createWeapon();

      const result = validator.validate(player, weapon, 0, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PLAYER_STAGGERED');
    });

    it('rejects dead player with PLAYER_NOT_ALIVE', () => {
      const player = createPlayer('p1', 100, 100, PlayerStatus.SPECTATING);
      const weapon = createWeapon();

      const result = validator.validate(player, weapon, 0, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PLAYER_NOT_ALIVE');
    });

    it('rejects null weapon with NO_WEAPON', () => {
      const player = createPlayer('p1', 100, 100);

      const result = validator.validate(player, null, 0, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('NO_WEAPON');
    });

    it('rejects weapon on cooldown with WEAPON_NOT_READY', () => {
      const player = createPlayer('p1', 100, 100);
      const weapon = createWeapon();
      weapon.cooldownRemaining = 5;

      const result = validator.validate(player, weapon, 0, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('WEAPON_NOT_READY');
    });

    it('rejects when attack cooldown not elapsed with COOLDOWN_NOT_ELAPSED', () => {
      const player = createPlayer('p1', 100, 100);
      const weapon = createWeapon(10, 30);

      const result = validator.validate(player, weapon, 95, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('COOLDOWN_NOT_ELAPSED');
    });

    it('rejects when match is not active with MATCH_NOT_ACTIVE', () => {
      const player = createPlayer('p1', 100, 100);
      const weapon = createWeapon();

      const result = validator.validate(player, weapon, 0, 100, MatchPhase.WAITING);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('MATCH_NOT_ACTIVE');
    });

    it('rejects player in windup with PLAYER_IN_WINDUP', () => {
      const player = createPlayer('p1', 100, 100);
      player.combat.startWindup(3, 0, 'arc');
      const weapon = createWeapon();

      const result = validator.validate(player, weapon, 0, 100, MatchPhase.ACTIVE);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('PLAYER_IN_WINDUP');
    });
  });

  describe('validateRate', () => {
    it('allows 10 or fewer attacks in 60 tick window', () => {
      const attacks = Array.from({ length: 10 }, (_, i) => ({ tick: 100 + i }));

      const result = validator.validateRate('p1', attacks, 160);

      expect(result).toBe(true);
    });

    it('rejects more than 10 attacks in 60 tick window', () => {
      const attacks = Array.from({ length: 11 }, (_, i) => ({ tick: 103 + i }));

      const result = validator.validateRate('p1', attacks, 162);

      expect(result).toBe(false);
    });

    it('ignores attacks outside the window', () => {
      const oldAttacks = Array.from({ length: 10 }, (_, i) => ({ tick: 50 + i }));
      const recentAttacks = [{ tick: 110 }, { tick: 115 }];

      const result = validator.validateRate('p1', [...oldAttacks, ...recentAttacks], 120);

      expect(result).toBe(true);
    });
  });

  describe('validateWeaponInInventory', () => {
    it('returns true when weapon is in inventory', () => {
      const player = createPlayer('p1', 100, 100);
      const weapon = createWeapon();
      player.addWeapon(weapon);

      const result = validator.validateWeaponInInventory(player, weapon);

      expect(result).toBe(true);
    });

    it('returns false when weapon is not in inventory', () => {
      const player = createPlayer('p1', 100, 100);
      const weapon = createWeapon();
      const otherWeapon = new WeaponEntity(
        'weapon-2',
        WeaponType.SHORT_SWORD,
        WeaponTier.COMMON,
        10,
        10,
        10,
      );
      player.addWeapon(otherWeapon);

      const result = validator.validateWeaponInInventory(player, weapon);

      expect(result).toBe(false);
    });
  });
});

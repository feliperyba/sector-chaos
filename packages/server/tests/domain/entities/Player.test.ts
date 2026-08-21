import { Player, WeaponEntity } from '../../../src/domain/entities/index.ts';
import { Position, Direction as DirectionVO } from '../../../src/domain/value-objects/index.ts';
import {
  Direction,
  PlayerStatus,
  WeaponType,
  WeaponTier,
  PLAYER,
  COMBAT,
  NETWORK,
} from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';
import { FISTS_INFINITE_DURABILITY, weaponRegistry } from '@sector-battle/shared';

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

describe('Player', () => {
  describe('Player Creation with Correct Defaults', () => {
    it('initializes all fields from config with Position(0, 0)', () => {
      const config = createDefaultConfig();
      const player = new Player('p1', 'Alice', new Position(0, 0), config);

      expect(player.id).toBe('p1');
      expect(player.name).toBe('Alice');
      expect(player.movement.position.x).toBe(0);
      expect(player.movement.position.y).toBe(0);
      expect(player.health.current).toBe(PLAYER.BASE_HEALTH);
      expect(player.health.current).toBe(100);
      expect(player.health.max).toBe(PLAYER.MAX_HEALTH);
      expect(player.health.max).toBe(100);
      expect(player.movement.speed.value).toBe(200);
      expect(player.movement.direction).toBe(DirectionVO.NONE);
      expect(player.inventory.weapons).toHaveLength(PLAYER.INVENTORY_SIZE);
      expect(player.inventory.weapons).toHaveLength(4);
      expect(player.inventory.weapons[0]).not.toBeNull();
      expect(player.inventory.weapons[0]!.type).toBe(WeaponType.FISTS);
      expect(player.inventory.weapons[1]).toBeNull();
      expect(player.inventory.weapons[2]).toBeNull();
      expect(player.inventory.weapons[3]).toBeNull();
      expect(player.inventory.activeSlot).toBe(0);
      expect(player.statusEffects.status).toBe(
        PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE | PlayerStatus.FRESH_SPAWN,
      );
      expect(player.statusEffects.status).toBe(41);
      expect(player.connected).toBe(true);
      expect(player.kills).toBe(0);
      expect(player.damageDealt).toBe(0);
      expect(player.damageTaken).toBe(0);
      expect(player.movement.dashCooldownRemaining).toBe(0);
      expect(player.movement.isDashing).toBe(false);
      expect(player.statusEffects.barrierActive).toBe(false);
    });
  });

  describe('Status Bitmask Operations', () => {
    it('setStatus adds flag and hasStatus detects it', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.statusEffects.setStatus(PlayerStatus.STAGGERED);
      expect(player.statusEffects.hasStatus(PlayerStatus.STAGGERED)).toBe(true);
    });

    it('clearStatus removes flag and hasStatus returns false', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE | PlayerStatus.STAGGERED;
      player.statusEffects.clearStatus(PlayerStatus.STAGGERED);
      expect(player.statusEffects.hasStatus(PlayerStatus.STAGGERED)).toBe(false);
    });

    it('multiple flags can coexist (ALIVE | INVINCIBLE | STAGGERED = 25)', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status =
        PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE | PlayerStatus.STAGGERED;
      expect(player.statusEffects.status).toBe(25);
      expect(player.statusEffects.hasStatus(PlayerStatus.ALIVE)).toBe(true);
      expect(player.statusEffects.hasStatus(PlayerStatus.INVINCIBLE)).toBe(true);
      expect(player.statusEffects.hasStatus(PlayerStatus.STAGGERED)).toBe(true);
    });

    it('isAlive returns true when ALIVE bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      expect(player.isAlive()).toBe(true);
      player.statusEffects.status = PlayerStatus.DEAD;
      expect(player.isAlive()).toBe(false);
    });

    it('isDead returns true when DEAD bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.DEAD;
      expect(player.isDead()).toBe(true);
    });

    it('isSpectating returns true when SPECTATING bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.SPECTATING;
      expect(player.isSpectating()).toBe(true);
    });

    it('isInvincibleStatus returns true when INVINCIBLE bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.INVINCIBLE;
      expect(player.isInvincibleStatus()).toBe(true);
    });

    it('isStaggered returns true when STAGGERED bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.STAGGERED;
      expect(player.isStaggered()).toBe(true);
    });

    it('isDying returns true when DYING bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.DYING;
      expect(player.isDying()).toBe(true);
    });

    it('isFreshSpawn returns true when FRESH_SPAWN bit set', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.isFreshSpawn()).toBe(true);
      player.statusEffects.clearStatus(PlayerStatus.FRESH_SPAWN);
      expect(player.isFreshSpawn()).toBe(false);
    });
  });

  describe('Health Management', () => {
    it('takeDamage(30) reduces health and returns correct result', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      const result = player.takeDamage(30, 10);
      expect(result).toEqual({ killed: false, damageApplied: 30 });
      expect(player.health.current).toBe(70);
    });

    it('takeDamage(100) kills player', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      const result = player.takeDamage(100, 10);
      expect(result).toEqual({ killed: true, damageApplied: 100 });
      expect(player.health.current).toBe(0);
    });

    it('takeDamage on dead player returns zero damage', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.die();
      const result = player.takeDamage(50, 10);
      expect(result).toEqual({ killed: false, damageApplied: 0 });
    });

    it('takeDamage blocked while fresh spawn invulnerable', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      const result = player.takeDamage(10, 10);
      expect(result).toEqual({ killed: false, damageApplied: 0 });
    });

    it('takeDamage with skipInvulnerability bypasses protection', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      const result = player.takeDamage(10, 10, true);
      expect(result.damageApplied).toBe(10);
      expect(player.health.current).toBe(90);
    });

    it('heal caps at max health from partial damage', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      player.takeDamage(30, 10);
      player.heal(30);
      expect(player.health.current).toBe(100);
    });

    it('heal does not exceed max from full HP', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.heal(30);
      expect(player.health.current).toBe(100);
    });

    it('heal caps at max from zero HP', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      player.takeDamage(100, 10);
      expect(player.health.current).toBe(0);
      player.heal(100);
      expect(player.health.current).toBe(100);
    });

    it('damageTaken accumulates across multiple hits', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      player.takeDamage(30, 10);
      player.takeDamage(30, 20);
      expect(player.damageTaken).toBe(60);
    });
  });

  describe('Inventory Management', () => {
    it('addWeapon fills first empty slot and returns true', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      expect(player.addWeapon(weapon)).toBe(1);
      expect(player.inventory.weapons[1]).toBe(weapon);
    });

    it('addWeapon fills slots sequentially', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const w1 = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      const w2 = new WeaponEntity('w2', WeaponType.SWORD, WeaponTier.COMMON, 1, 1, 10);
      const w3 = new WeaponEntity('w3', WeaponType.HAMMER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(w1);
      player.addWeapon(w2);
      expect(player.addWeapon(w3)).toBe(3);
      expect(player.inventory.weapons[1]).toBe(w1);
      expect(player.inventory.weapons[2]).toBe(w2);
      expect(player.inventory.weapons[3]).toBe(w3);
    });

    it('addWeapon returns false when inventory full', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.addWeapon(new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      player.addWeapon(new WeaponEntity('w2', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      player.addWeapon(new WeaponEntity('w3', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      expect(
        player.addWeapon(new WeaponEntity('w4', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10)),
      ).toBe(-1);
    });

    it('removeWeapon returns weapon and nullifies slot', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      const removed = player.removeWeapon(1);
      expect(removed).toBe(weapon);
      expect(player.inventory.weapons[1]).toBeNull();
    });

    it('removeWeapon(0) returns null (Fists permanent)', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.removeWeapon(0)).toBeNull();
      expect(player.inventory.weapons[0]).not.toBeNull();
    });

    it('removeWeapon with out-of-range slot returns null', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.removeWeapon(-1)).toBeNull();
      expect(player.removeWeapon(4)).toBeNull();
    });

    it('removing active slot resets activeSlot to 0', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const w1 = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      const w2 = new WeaponEntity('w2', WeaponType.SWORD, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(w1);
      player.addWeapon(w2);
      player.forceSwitchSlot(2);
      expect(player.inventory.activeSlot).toBe(2);
      player.removeWeapon(2);
      expect(player.inventory.activeSlot).toBe(0);
    });

    it('getActiveWeapon returns weapon at activeSlot', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.getActiveWeapon().type).toBe(WeaponType.FISTS);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      expect(player.getActiveWeapon()).toBe(weapon);
    });

    it('hasEmptySlot returns true when slots available', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.hasEmptySlot()).toBe(true);
      player.addWeapon(new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      player.addWeapon(new WeaponEntity('w2', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      player.addWeapon(new WeaponEntity('w3', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      expect(player.hasEmptySlot()).toBe(false);
    });

    it('findFirstEmptySlot returns first null index or null when full', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.findFirstEmptySlot()).toBe(1);
      player.addWeapon(new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      expect(player.findFirstEmptySlot()).toBe(2);
      player.addWeapon(new WeaponEntity('w2', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      player.addWeapon(new WeaponEntity('w3', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10));
      expect(player.findFirstEmptySlot()).toBeNull();
    });

    it('switchSlot initiates switch with cooldown', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      expect(player.switchSlot(1)).toBe(true);
      expect(player.inventory.switchTarget).toBe(1);
      expect(player.inventory.switchRemaining).toBe(Math.ceil(COMBAT.WEAPON_SWITCH_TIME * 60));
    });

    it('forceSwitchSlot is immediate', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      expect(player.inventory.activeSlot).toBe(1);
      expect(player.inventory.switchTarget).toBeNull();
      expect(player.inventory.switchRemaining).toBe(0);
    });

    it('canSwitch returns false when staggered, in windup, in cooldown, or already switching', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);

      expect(player.canSwitch()).toBe(true);

      player.statusEffects.setStatus(PlayerStatus.STAGGERED);
      expect(player.canSwitch()).toBe(false);
      player.statusEffects.clearStatus(PlayerStatus.STAGGERED);

      player.combat.startWindup(3, 0, 'arc');
      expect(player.canSwitch()).toBe(false);
      player.combat.clearWindup();

      player.getActiveWeapon().cooldownRemaining = 5;
      expect(player.canSwitch()).toBe(false);
      player.getActiveWeapon().cooldownRemaining = 0;

      player.switchSlot(1);
      expect(player.canSwitch()).toBe(false);
    });
  });

  describe('Dash State Transitions', () => {
    it('startDash succeeds when conditions met', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const result = player.startDash();
      expect(result).toBe(true);
      expect(player.movement.isDashing).toBe(true);
    });

    it('startDash returns false when already dashing', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDash();
      expect(player.startDash()).toBe(false);
    });

    it('startDash returns false when staggered', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.setStatus(PlayerStatus.STAGGERED);
      expect(player.startDash()).toBe(false);
    });

    it('startDash returns false when on cooldown', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.movement.dashCooldownRemaining = 10;
      expect(player.startDash()).toBe(false);
    });

    it('startDash sets dashCooldownRemaining to config.dashCooldown', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDash();
      expect(player.movement.dashCooldownRemaining).toBe(createDefaultConfig().dashCooldown);
    });

    it('startDashSpeed sets speed to baseSpeed * DASH_SPEED_MULTIPLIER', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDashSpeed();
      expect(player.movement.speed.value).toBe(400);
    });

    it('endDash sets isDashing to false', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDash();
      player.endDash();
      expect(player.movement.isDashing).toBe(false);
    });

    it('endDashSpeed restores pre-dash speed', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const originalSpeed = player.movement.speed.value;
      player.startDashSpeed();
      player.endDashSpeed();
      expect(player.movement.speed.value).toBe(originalSpeed);
    });

    it('endDashSpeed falls back to baseSpeed when no pre-dash speed', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDashSpeed();
      player.endDashSpeed();
      expect(player.movement.speed.value).toBe(200);
    });

    it('cancelDash ends dash and restores speed', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const originalSpeed = player.movement.speed.value;
      player.startDash();
      player.startDashSpeed();
      player.cancelDash();
      expect(player.movement.isDashing).toBe(false);
      expect(player.movement.speed.value).toBe(originalSpeed);
    });

    it('updateDashCooldown decrements remaining floored at 0', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDash();
      player.endDash();
      player.updateDashCooldown(10);
      expect(player.movement.dashCooldownRemaining).toBe(50);
      player.updateDashCooldown(100);
      expect(player.movement.dashCooldownRemaining).toBe(0);
    });

    it('after cooldown reaches 0 startDash succeeds again', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.startDash();
      player.endDash();
      player.updateDashCooldown(player.movement.dashCooldownRemaining);
      expect(player.movement.dashCooldownRemaining).toBe(0);
      expect(player.startDash()).toBe(true);
    });
  });

  describe('Stagger Application and Expiry', () => {
    it('startStagger sets staggered status', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.startStagger(200, NETWORK.TICK_RATE);
      expect(player.isStaggered()).toBe(true);
      expect(player.statusEffects.staggerRemaining).toBe(
        Math.ceil((200 / 1000) * NETWORK.TICK_RATE),
      );
    });

    it('startStagger when already staggered overwrites remaining duration', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.startStagger(200, NETWORK.TICK_RATE);
      player.startStagger(500, NETWORK.TICK_RATE);
      expect(player.statusEffects.staggerRemaining).toBe(
        Math.ceil((500 / 1000) * NETWORK.TICK_RATE),
      );
      expect(player.isStaggered()).toBe(true);
    });

    it('startStagger applies staggered status regardless of duration', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.startStagger(0, NETWORK.TICK_RATE);
      expect(player.isStaggered()).toBe(true);
      player.startStagger(-100, NETWORK.TICK_RATE);
      expect(player.isStaggered()).toBe(true);
    });

    it('updateStagger decrements and clears when reaches 0', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.startStagger(200, NETWORK.TICK_RATE);
      const ticks = Math.ceil((200 / 1000) * NETWORK.TICK_RATE);
      player.updateStagger(ticks - 1);
      expect(player.isStaggered()).toBe(true);
      player.updateStagger(1);
      expect(player.isStaggered()).toBe(false);
      expect(player.statusEffects.staggerRemaining).toBe(0);
    });

    it('after stagger expires queued slot switch is applied', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      const w1 = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      const w2 = new WeaponEntity('w2', WeaponType.SWORD, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(w1);
      player.addWeapon(w2);
      player.forceSwitchSlot(1);
      player.inventory.queuedSlotSwitch = 2;
      player.startStagger(200, NETWORK.TICK_RATE);
      const ticks = Math.ceil((200 / 1000) * NETWORK.TICK_RATE);
      player.updateStagger(ticks);
      expect(player.isStaggered()).toBe(false);
      expect(player.inventory.activeSlot).toBe(2);
      expect(player.inventory.queuedSlotSwitch).toBeNull();
    });

    it('onWeaponBreak removes weapon and starts stagger (non-shield)', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      player.onWeaponBreak(1, false, NETWORK.TICK_RATE);
      expect(player.inventory.weapons[1]).toBeNull();
      expect(player.isStaggered()).toBe(true);
      const expectedTicks = Math.ceil(
        ((COMBAT.WEAPON_BREAK_STAGGER * 1000) / 1000) * NETWORK.TICK_RATE,
      );
      expect(player.statusEffects.staggerRemaining).toBe(expectedTicks);
    });

    it('onWeaponBreak with isShield starts longer stagger', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      const shield = new WeaponEntity('s1', WeaponType.SMALL_SHIELD, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(shield);
      player.forceSwitchSlot(1);
      player.onWeaponBreak(1, true, NETWORK.TICK_RATE);
      expect(player.inventory.weapons[1]).toBeNull();
      expect(player.isStaggered()).toBe(true);
      // Stagger duration comes from the weapon's staggerOnBreakMs (300ms for
      // SMALL_SHIELD per definitions.ts), NOT the generic SHIELD_BREAK_STAGGER
      // fallback. The fallback only applies when the weapon type has no
      // staggerOnBreakMs defined.
      const shieldDef = weaponRegistry.getDefinition(WeaponType.SMALL_SHIELD);
      const expectedTicks = Math.ceil(
        ((shieldDef?.baseStats.staggerOnBreakMs ?? COMBAT.SHIELD_BREAK_STAGGER * 1000) / 1000) *
          NETWORK.TICK_RATE,
      );
      expect(player.statusEffects.staggerRemaining).toBe(expectedTicks);
    });
  });

  describe('Fresh Spawn Timer', () => {
    it('fresh spawn status set on creation', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.isFreshSpawn()).toBe(true);
    });

    it('isFreshSpawnActive returns true while currentTick < freshSpawnExpiryTick', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      expect(player.isFreshSpawnActive(100)).toBe(true);
      expect(player.isFreshSpawnActive(279)).toBe(true);
    });

    it('isFreshSpawnActive returns false after expiry', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      const spawnInvincibilityTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      expect(player.isFreshSpawnActive(100 + spawnInvincibilityTicks)).toBe(false);
    });

    it('expireFreshSpawn clears FRESH_SPAWN flag after timer', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      const spawnInvincibilityTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      player.expireFreshSpawn(spawnInvincibilityTicks);
      expect(player.isFreshSpawn()).toBe(false);
    });

    it('expireFreshSpawn clears INVINCIBLE if barrier not active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      const spawnInvincibilityTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      player.expireFreshSpawn(spawnInvincibilityTicks);
      expect(player.isInvincibleStatus()).toBe(false);
      expect(player.statusEffects.status).toBe(PlayerStatus.ALIVE);
    });

    it('expireFreshSpawn preserves INVINCIBLE if barrier active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      player.activateBarrier(50, 600);
      const spawnInvincibilityTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      player.expireFreshSpawn(spawnInvincibilityTicks);
      expect(player.isFreshSpawn()).toBe(false);
      expect(player.isInvulnerable(200)).toBe(true);
    });

    it('revive resets status to ALIVE | INVINCIBLE | FRESH_SPAWN with full health', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.die();
      player.revive(500);
      expect(player.statusEffects.status).toBe(
        PlayerStatus.ALIVE | PlayerStatus.INVINCIBLE | PlayerStatus.FRESH_SPAWN,
      );
      expect(player.health.current).toBe(100);
      expect(player.isFreshSpawn()).toBe(true);
    });

    it('fresh spawn blocks canAttack', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      expect(player.canAttack(150)).toBe(false);
    });

    it('fresh spawn blocks canThrow', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      expect(player.canThrow(150)).toBe(false);
    });

    it('fresh spawn blocks canBlock', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      expect(player.canBlock(150)).toBe(false);
    });

    it('fresh spawn blocks canDash', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      expect(player.canDash(150)).toBe(false);
    });

    it('fresh spawn allows move', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      player.movement.position = new Position(50, 50);
      expect(player.movement.position.x).toBe(50);
      expect(player.movement.position.y).toBe(50);
    });

    it('fresh spawn allows pickup (addWeapon)', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      expect(player.addWeapon(weapon)).toBe(1);
    });

    it('takeDamage blocks damage during fresh spawn window', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      const result = player.takeDamage(50, 150);
      expect(result.damageApplied).toBe(0);
      expect(result.killed).toBe(false);
      expect(player.health.current).toBe(100);
    });

    it('takeDamage applies damage after fresh spawn expires', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      const spawnInvincibilityTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      player.expireFreshSpawn(spawnInvincibilityTicks);
      const result = player.takeDamage(50, 200);
      expect(result.damageApplied).toBe(50);
      expect(player.health.current).toBe(50);
    });
  });

  describe('Kill/Damage Tracking', () => {
    it('recordKill increments kills', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.kills).toBe(0);
      player.recordKill();
      expect(player.kills).toBe(1);
      player.recordKill();
      expect(player.kills).toBe(2);
    });

    it('recordDamageDealt increments damageDealt', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.damageDealt).toBe(0);
      player.recordDamageDealt(25);
      expect(player.damageDealt).toBe(25);
      player.recordDamageDealt(15);
      expect(player.damageDealt).toBe(40);
    });

    it('damageTaken is updated automatically by takeDamage', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      player.takeDamage(30, 10);
      expect(player.damageTaken).toBe(30);
      player.takeDamage(20, 20);
      expect(player.damageTaken).toBe(50);
    });

    it('recordItemCollected increments itemsCollected', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.itemsCollected).toBe(0);
      player.recordItemCollected();
      expect(player.itemsCollected).toBe(1);
      player.recordItemCollected();
      expect(player.itemsCollected).toBe(2);
    });

    it('getSurvivalTimeMs returns correct milliseconds', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.survivalStartTick = 100;
      const tickRate = 60;
      expect(player.getSurvivalTimeMs(160, tickRate)).toBeCloseTo(1000, 5);
      expect(player.getSurvivalTimeMs(220, tickRate)).toBeCloseTo(2000, 5);
    });
  });

  describe('Death', () => {
    it('die sets status to SPECTATING and clears windup and knockback', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(5, 0, 'arc');
      player.movement.knockbackVelocityX = 100;
      player.movement.knockbackVelocityY = 50;
      player.die();
      expect(player.statusEffects.status).toBe(PlayerStatus.SPECTATING);
      expect(player.combat.isInWindup()).toBe(false);
      expect(player.movement.knockbackVelocityX).toBe(0);
      expect(player.movement.knockbackVelocityY).toBe(0);
    });

    it('die on already spectating is no-op', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.die();
      expect(player.statusEffects.status).toBe(PlayerStatus.SPECTATING);
      player.die();
      expect(player.statusEffects.status).toBe(PlayerStatus.SPECTATING);
    });

    it('dieWithTick sets DYING status and deathTick', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.dieWithTick(42);
      expect(player.statusEffects.status).toBe(PlayerStatus.DYING);
      expect(player.statusEffects.deathTick).toBe(42);
      expect(player.isDying()).toBe(true);
    });

    it('dieWithTick clears windup and knockback', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(5, 0, 'arc');
      player.movement.knockbackVelocityX = 100;
      player.dieWithTick(42);
      expect(player.combat.isInWindup()).toBe(false);
      expect(player.movement.knockbackVelocityX).toBe(0);
    });

    it('dieWithTick on already dying is no-op', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.dieWithTick(42);
      expect(player.statusEffects.deathTick).toBe(42);
      player.dieWithTick(100);
      expect(player.statusEffects.deathTick).toBe(42);
    });

    it('completeDeath sets SPECTATING status', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.dieWithTick(42);
      expect(player.isDying()).toBe(true);
      player.completeDeath();
      expect(player.isSpectating()).toBe(true);
    });

    it('isCorpse returns true when deathTick >= 0 and isDying', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.isCorpse()).toBe(false);
      player.dieWithTick(42);
      expect(player.isCorpse()).toBe(true);
      player.completeDeath();
      expect(player.isCorpse()).toBe(false);
    });

    it('hasDeathCollision returns true during death animation window', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.dieWithTick(100);
      const deathAnimTicks = Math.round(COMBAT.DEATH_ANIMATION_DURATION * 60);
      expect(player.hasDeathCollision(100)).toBe(true);
      expect(player.hasDeathCollision(100 + deathAnimTicks - 1)).toBe(true);
      expect(player.hasDeathCollision(100 + deathAnimTicks)).toBe(false);
    });

    it('hasDeathCollision returns false when not dying', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.hasDeathCollision(0)).toBe(false);
    });
  });

  describe('canAttack / canThrow / canBlock / canDash', () => {
    it('all blocked during fresh spawn active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      expect(player.canAttack(150)).toBe(false);
      expect(player.canBlock(150)).toBe(false);
      expect(player.canDash(150)).toBe(false);
    });

    it('all blocked during stagger', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      player.statusEffects.setStatus(PlayerStatus.STAGGERED);
      expect(player.canAttack(99999)).toBe(false);
      expect(player.canBlock(99999)).toBe(false);
      expect(player.canDash(99999)).toBe(false);
    });

    it('canThrow blocked during stagger', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      player.statusEffects.setStatus(PlayerStatus.STAGGERED);
      expect(player.canThrow(99999)).toBe(false);
    });

    it('canDash blocked when dashCooldownRemaining > 0', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      player.movement.dashCooldownRemaining = 30;
      expect(player.canDash(99999)).toBe(false);
    });

    it('canDash blocked when isDashing', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      player.movement.isDashing = true;
      expect(player.canDash(99999)).toBe(false);
    });

    it('canThrow blocked when activeSlot === 0 (fists)', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      expect(player.inventory.activeSlot).toBe(0);
      expect(player.canThrow(99999)).toBe(false);
    });

    it('canThrow blocked when isInWindup', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      player.combat.startWindup(3, 1, 'arc');
      expect(player.canThrow(99999)).toBe(false);
    });

    it('canThrow blocked when isInAttackCooldown', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      player.getActiveWeapon().cooldownRemaining = 5;
      expect(player.canThrow(99999)).toBe(false);
    });

    it('canThrow returns true when all conditions met', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      expect(player.canThrow(99999)).toBe(true);
    });

    it('canDash returns true when all conditions met', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      expect(player.canDash(99999)).toBe(true);
    });
  });

  describe('Hitbox', () => {
    it('returns AABB centered on position', () => {
      const player = new Player('p1', 'Alice', new Position(100, 200), createDefaultConfig());
      const box = player.hitbox;
      expect(box.x).toBe(88);
      expect(box.y).toBe(188);
      expect(box.width).toBe(24);
      expect(box.height).toBe(24);
    });
  });

  describe('Windup', () => {
    it('isInWindup returns false initially', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.combat.isInWindup()).toBe(false);
    });

    it('startWindup sets windup state', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(3, 0, 'arc');
      expect(player.combat.isInWindup()).toBe(true);
      expect(player.combat.windupRemaining).toBe(3);
      expect(player.combat.windupWeaponSlot).toBe(0);
      expect(player.combat.windupAttackType).toBe('arc');
    });

    it('tickWindup decrements remaining and returns true when complete', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(3, 0, 'arc');
      expect(player.combat.tickWindup()).toBe(false);
      expect(player.combat.tickWindup()).toBe(false);
      expect(player.combat.tickWindup()).toBe(true);
      expect(player.combat.windupRemaining).toBe(0);
    });

    it('clearWindup resets all windup state', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(5, 1, 'line');
      player.combat.clearWindup();
      expect(player.combat.isInWindup()).toBe(false);
      expect(player.combat.windupRemaining).toBe(0);
      expect(player.combat.windupWeaponSlot).toBe(-1);
      expect(player.combat.windupAttackType).toBeNull();
    });

    it('die clears windup', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(5, 0, 'arc');
      player.die();
      expect(player.combat.isInWindup()).toBe(false);
    });

    it('dieWithTick clears windup', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.startWindup(5, 0, 'arc');
      player.dieWithTick(42);
      expect(player.combat.isInWindup()).toBe(false);
    });
  });

  describe('Invulnerability', () => {
    it('returns false when no source active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      expect(player.isInvulnerable(0)).toBe(false);
    });

    it('returns true when barrier active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.barrierExpiryTick = 600;
      expect(player.isInvulnerable(100)).toBe(true);
    });

    it('returns false when barrier expired', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.barrierExpiryTick = 600;
      expect(player.isInvulnerable(600)).toBe(false);
    });

    it('returns true when fresh spawn active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(0);
      expect(player.isInvulnerable(100)).toBe(true);
    });

    it('bypassBarrier skips barrier check', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.barrierExpiryTick = 600;
      player.statusEffects.status = PlayerStatus.ALIVE;
      expect(player.isInvulnerable(100, true)).toBe(false);
    });
  });

  describe('Shield/Barrier', () => {
    it('activateBarrier sets barrier active and INVINCIBLE', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.activateBarrier(100, 50);
      expect(player.statusEffects.barrierActive).toBe(true);
      expect(player.statusEffects.barrierExpiryTick).toBe(150);
      expect(player.isInvincibleStatus()).toBe(true);
    });

    it('expireBarrier deactivates when expired', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.activateBarrier(100, 50);
      player.expireBarrier(150);
      expect(player.statusEffects.barrierActive).toBe(false);
    });

    it('expireBarrier preserves INVINCIBLE if fresh spawn active', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.revive(100);
      player.activateBarrier(100, 150);
      player.expireBarrier(251);
      expect(player.statusEffects.barrierExpiryTick).toBe(0);
      expect(player.isInvulnerable(251)).toBe(true);
    });

    it('expireBarrier clears INVINCIBLE if no other source', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      player.activateBarrier(100, 200);
      player.expireBarrier(301);
      expect(player.isInvulnerable(301)).toBe(false);
      expect(player.statusEffects.status & PlayerStatus.INVINCIBLE).toBe(0);
    });
  });

  describe('Attack Rate Limit', () => {
    const ATTACK_RATE_LIMIT_TICKS = Math.ceil(COMBAT.ATTACK_RATE_LIMIT / (1000 / 60));

    it('canAttack returns false within rate limit window', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      player.recordAttack(100);
      expect(player.canAttack(100 + ATTACK_RATE_LIMIT_TICKS - 1)).toBe(false);
    });

    it('canAttack returns true at rate limit boundary', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      player.recordAttack(100);
      expect(player.canAttack(100 + ATTACK_RATE_LIMIT_TICKS)).toBe(true);
    });

    it('recordAttack updates lastAttackTick', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.combat.lastAttackTick).toBe(-Infinity);
      player.recordAttack(50);
      expect(player.combat.lastAttackTick).toBe(50);
    });
  });

  describe('Weapon Switching', () => {
    const SWITCH_TICKS = Math.ceil(COMBAT.WEAPON_SWITCH_TIME * 60);

    it('switchSlot sets switchTarget and switchRemaining', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      expect(player.switchSlot(1)).toBe(true);
      expect(player.inventory.switchTarget).toBe(1);
      expect(player.inventory.switchRemaining).toBe(SWITCH_TICKS);
    });

    it('activeSlot changes after updateSwitch completes', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.switchSlot(1);
      player.updateSwitch(SWITCH_TICKS);
      expect(player.inventory.activeSlot).toBe(1);
      expect(player.inventory.switchTarget).toBeNull();
    });

    it('cannot switch to empty slot', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.switchSlot(2)).toBe(false);
    });

    it('cannot switch while already switching', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const w1 = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      const w2 = new WeaponEntity('w2', WeaponType.SWORD, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(w1);
      player.addWeapon(w2);
      player.switchSlot(1);
      expect(player.switchSlot(2)).toBe(false);
    });

    it('cannot switch during windup', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.combat.startWindup(5, 0, 'arc');
      expect(player.switchSlot(1)).toBe(false);
    });

    it('cannot switch during stagger', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.statusEffects.setStatus(PlayerStatus.STAGGERED);
      expect(player.switchSlot(1)).toBe(false);
    });

    it('cannot switch when throw in flight', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.combat.addThrowInFlight('proj_1');
      expect(player.switchSlot(1)).toBe(false);
    });

    it('cannot switch during attack cooldown', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.getActiveWeapon().cooldownRemaining = 5;
      expect(player.switchSlot(1)).toBe(false);
    });

    it('forceSwitchSlot bypasses delay', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.forceSwitchSlot(1);
      expect(player.inventory.activeSlot).toBe(1);
      expect(player.inventory.switchTarget).toBeNull();
      expect(player.inventory.switchRemaining).toBe(0);
    });

    it('dieWithTick clears switch state', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.expireFreshSpawn(99999);
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(weapon);
      player.switchSlot(1);
      expect(player.inventory.switchRemaining).toBeGreaterThan(0);
      player.dieWithTick(100);
      expect(player.inventory.switchTarget).toBeNull();
      expect(player.inventory.switchRemaining).toBe(0);
    });

    it('auto-switch from weapon break is immediate after stagger', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.status = PlayerStatus.ALIVE;
      const w1 = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 1, 1, 10);
      const w2 = new WeaponEntity('w2', WeaponType.SWORD, WeaponTier.COMMON, 1, 1, 10);
      player.addWeapon(w1);
      player.addWeapon(w2);
      player.forceSwitchSlot(1);
      player.onWeaponBreak(1, false, NETWORK.TICK_RATE);
      expect(player.isStaggered()).toBe(true);
      const staggerTicks = Math.ceil(
        ((COMBAT.WEAPON_BREAK_STAGGER * 1000) / 1000) * NETWORK.TICK_RATE,
      );
      player.updateStagger(staggerTicks);
      expect(player.isStaggered()).toBe(false);
      expect(player.inventory.activeSlot).toBe(2);
    });
  });

  describe('Throws In Flight', () => {
    it('initializes empty', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      expect(player.combat.throwsInFlight.size).toBe(0);
      expect(player.combat.hasThrowInFlight()).toBe(false);
    });

    it('add and remove throw in flight', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.combat.addThrowInFlight('proj_1');
      expect(player.combat.hasThrowInFlight()).toBe(true);
      player.combat.removeThrowInFlight('proj_1');
      expect(player.combat.hasThrowInFlight()).toBe(false);
    });
  });

  describe('Stat Upgrades', () => {
    it('heal increases health', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.statusEffects.freshSpawnExpiryTick = 0;
      player.takeDamage(50, 0);
      player.heal(20);
      expect(player.health.current).toBe(70);
    });

    it('addSpeed scales speed', () => {
      const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
      player.addSpeed(1.5);
      expect(player.movement.speed.value).toBe(300);
    });
  });

  it('move updates position', () => {
    const player = new Player('p1', 'Alice', new Position(0, 0), createDefaultConfig());
    player.movement.position = new Position(50, 60);
    expect(player.movement.position.x).toBe(50);
    expect(player.movement.position.y).toBe(60);
  });
});

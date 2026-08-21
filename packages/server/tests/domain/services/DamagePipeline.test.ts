import { describe, it, expect } from 'vitest';
import { DamagePipeline, type AttackContext } from '../../../src/domain/services/DamagePipeline.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { DamageType, EntityType, WeaponType, WeaponTier } from '@sector-battle/shared';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { ShieldHandler } from '../../../src/domain/handlers/ShieldHandler.ts';

function createDefaultPlayerConfig() {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 10,
    dashCooldown: 60,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: 96,
    hitboxHeight: 96,
  };
}

function createPlayer(id: string, x: number, y: number): Player {
  const config = createDefaultPlayerConfig();
  const player = new Player(id, id, new Position(x, y), config);
  player.spawnTick = -9999;
  return player;
}

describe('DamagePipeline', () => {
  const pipeline = new DamagePipeline(new ShieldHandler());

  describe('processAttack', () => {
    it('applies damage to a single target', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      const dmgEvent = events.find((e) => e.type === 'PlayerDamaged');
      expect(dmgEvent).toBeDefined();
      expect(dmgEvent!.damage).toBe(30);
      expect(dmgEvent!.sourceId).toBe('a');
    });

    it('applies damage to multiple targets', () => {
      const attacker = createPlayer('a', 0, 0);
      const b = createPlayer('b', 100, 0);
      const c = createPlayer('c', 0, 100);
      const d = createPlayer('d', -100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 20,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b', 'c', 'd'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return b;
        if (id === 'c') return c;
        if (id === 'd') return d;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);
      const dmgEvents = events.filter((e) => e.type === 'PlayerDamaged');
      expect(dmgEvents).toHaveLength(3);
    });

    it('shield blocks front arc attack within π/4', () => {
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = 0;

      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const attacker = createPlayer('a', 200, 100);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 200, y: 100 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events.some((e) => e.type === 'ShieldBlocked')).toBe(true);
      expect(events.some((e) => e.type === 'PlayerDamaged' && e.playerId === 'b')).toBe(false);
      expect(shieldWeapon.durability).toBe(9);
    });

    it('shield break triggers onWeaponBreak', () => {
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = 0;

      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        1,
        1,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const attacker = createPlayer('a', 200, 100);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 200, y: 100 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events.some((e) => e.type === 'ShieldBlocked')).toBe(true);
      expect(events.some((e) => e.type === 'PlayerDamaged' && e.playerId === 'b')).toBe(false);
      expect(shieldWeapon.isBroken).toBe(true);
      expect(target.inventory.weapons[1]).toBeNull();
    });

    it('barrier active but outside arc applies damage', () => {
      const target = createPlayer('b', 100, 100);
      target.statusEffects.barrierActive = true;
      target.movement.facingAngle = 0;

      const attacker = createPlayer('a', 0, 100);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 100 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events.some((e) => e.type === 'ShieldBlocked')).toBe(false);
      expect(events.some((e) => e.type === 'PlayerDamaged' && e.playerId === 'b')).toBe(true);
    });

    it('fresh spawn invulnerability skips target', () => {
      const target = createPlayer('b', 100, 0);
      target.statusEffects.freshSpawnExpiryTick = 200;

      const attacker = createPlayer('a', 0, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events).toHaveLength(0);
    });

    it('barrier active invulnerability skips target', () => {
      const target = createPlayer('b', 100, 0);
      target.statusEffects.barrierExpiryTick = 200;
      target.statusEffects.freshSpawnExpiryTick = 0;

      const attacker = createPlayer('a', 0, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events).toHaveLength(0);
    });

    it('SIEGE_CRUSH bypasses shield and invulnerability', () => {
      const target = createPlayer('b', 100, 0);
      target.statusEffects.barrierActive = true;
      target.movement.facingAngle = 0;
      target.statusEffects.freshSpawnExpiryTick = 200;
      target.statusEffects.barrierExpiryTick = 200;

      const attacker = createPlayer('a', 0, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.SIEGE_CRUSH,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events.some((e) => e.type === 'ShieldBlocked')).toBe(false);
      expect(events.some((e) => e.type === 'PlayerDamaged' && e.playerId === 'b')).toBe(true);
    });

    it('emits elimination event on kill', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 100,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events.some((e) => e.type === 'PlayerDamaged')).toBe(true);
      const elimEvent = events.find((e) => e.type === 'PlayerEliminated');
      expect(elimEvent).toBeDefined();
      expect(elimEvent!.placement).toBe(5);
      expect(elimEvent!.killedBy).toBe('a');
    });

    it('attacker records damage dealt', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const before = attacker.damageDealt;
      pipeline.processAttack(context, lookup);

      expect(attacker.damageDealt).toBe(before + 30);
    });

    it('inactive target is skipped', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);
      target.die();

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events).toHaveLength(0);
    });

    it('applies knockback velocity per target', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      pipeline.processAttack(context, lookup);

      expect(target.movement.knockbackVelocityX).toBeGreaterThan(0);
    });

    it('sets lastDamageSource per target', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        if (id === 'b') return target;
        return undefined;
      };

      pipeline.processAttack(context, lookup);

      expect(target.statusEffects.lastDamageSource).not.toBeNull();
      expect(target.statusEffects.lastDamageSource!.playerId).toBe('a');
      expect(target.statusEffects.lastDamageSource!.weaponType).toBe(WeaponType.FISTS.toString());
    });

    it('returns empty array for empty hitTargetIds', () => {
      const attacker = createPlayer('a', 0, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: [],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const lookup = (id: string) => {
        if (id === 'a') return attacker;
        return undefined;
      };

      const events = pipeline.processAttack(context, lookup);

      expect(events).toEqual([]);
    });

    it('emits the exact normalized knockback vector (raw in event, x20 as velocity)', () => {
      const attacker = createPlayer('a', 0, 0);
      // 3-4-5 triangle: dist 500, force 200 -> kb (120, 160), velocity (2400, 3200)
      const target = createPlayer('b', 300, 400);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const events = pipeline.processAttack(context, (id) =>
        id === 'a' ? attacker : id === 'b' ? target : undefined,
      );

      const dmgEvent = events.find((e) => e.type === 'PlayerDamaged')!;
      expect(dmgEvent.knockbackX).toBeCloseTo(120, 10);
      expect(dmgEvent.knockbackY).toBeCloseTo(160, 10);
      expect(target.movement.knockbackVelocityX).toBeCloseTo(2400, 10);
      expect(target.movement.knockbackVelocityY).toBeCloseTo(3200, 10);
    });

    it('applies per-weapon hit stagger (HAMMER 280ms -> 17 ticks at 60tps)', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.HAMMER,
        damage: 30,
        knockbackForce: 0,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      pipeline.processAttack(context, (id) =>
        id === 'a' ? attacker : id === 'b' ? target : undefined,
      );

      // weaponRegistry HAMMER hitStaggerMs=280 -> Math.ceil(280/1000*60)=17
      expect(target.statusEffects.staggerRemaining).toBe(17);
    });

    it('does not stagger a killing hit', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.HAMMER,
        damage: 100,
        knockbackForce: 0,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      pipeline.processAttack(context, (id) =>
        id === 'a' ? attacker : id === 'b' ? target : undefined,
      );

      expect(target.statusEffects.staggerRemaining).toBe(0);
    });

    it('hit stagger never shortens an already-running longer stagger', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);
      target.startStagger(500, 60); // 30 ticks — longer than SHORT_SWORD's 60ms (4 ticks)

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.SHORT_SWORD,
        damage: 30,
        knockbackForce: 0,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      pipeline.processAttack(context, (id) =>
        id === 'a' ? attacker : id === 'b' ? target : undefined,
      );

      expect(target.statusEffects.staggerRemaining).toBe(30);
    });

    it('shield angle uses the live attacker position, not sourcePosition', () => {
      // Attacker stands at (200,100) but the recorded sourcePosition is (0,100).
      // Target faces PI (towards sourcePosition). If the arc check used
      // sourcePosition the hit would be blocked; using the live attacker the
      // hit comes from behind the guard and must land.
      const attacker = createPlayer('a', 200, 100);
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = Math.PI;
      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 100 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const events = pipeline.processAttack(context, (id) =>
        id === 'a' ? attacker : id === 'b' ? target : undefined,
      );

      expect(events.some((e) => e.type === 'ShieldBlocked')).toBe(false);
      expect(events.some((e) => e.type === 'PlayerDamaged' && e.playerId === 'b')).toBe(true);
    });

    it('shield angle falls back to sourcePosition when the attacker is gone', () => {
      // attackerId 'gone' resolves to no player -> sourcePosition drives the arc.
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = 0; // faces (200,100)
      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const context: AttackContext = {
        attackerId: 'gone',
        weaponType: WeaponType.FISTS,
        damage: 30,
        knockbackForce: 200,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 200, y: 100 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const events = pipeline.processAttack(context, (id) => (id === 'b' ? target : undefined));

      const blockEvent = events.find((e) => e.type === 'ShieldBlocked');
      expect(blockEvent).toBeDefined();
      expect(blockEvent!.sourceId).toBe('gone');
      expect(blockEvent!.damageType).toBe(DamageType.MELEE_HIT);
      expect(blockEvent!.x).toBe(100);
      expect(blockEvent!.y).toBe(100);
      expect(shieldWeapon.durability).toBe(9);
    });

    it('PlayerEliminated carries weapon and killerName', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const context: AttackContext = {
        attackerId: 'a',
        weaponType: WeaponType.HAMMER,
        damage: 100,
        knockbackForce: 0,
        damageType: DamageType.MELEE_HIT,
        hitTargetIds: ['b'],
        attackAngle: 0,
        sourcePosition: { x: 0, y: 0 },
        currentTick: 100,
        tickRate: 60,
        alivePlayerCount: 5,
      };

      const events = pipeline.processAttack(context, (id) =>
        id === 'a' ? attacker : id === 'b' ? target : undefined,
      );

      const elim = events.find((e) => e.type === 'PlayerEliminated')!;
      expect(elim).toBeDefined();
      expect(elim.weapon).toBe(WeaponType.HAMMER);
      expect(elim.killerName).toBe('a');
      expect(elim.cause).toBe(DamageType.MELEE_HIT);
      expect(elim.playerName).toBe('b');
    });
  });

  describe('processDamage', () => {
    it('applies damage and returns events/killed/damageApplied with full PlayerDamaged payload', () => {
      const target = createPlayer('b', 100, 0);

      const result = pipeline.processDamage(
        {
          sourceId: 'barrel-x',
          damage: 30,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'b' ? target : undefined),
      );

      expect(result.killed).toBe(false);
      expect(result.damageApplied).toBe(30);
      expect(result.events).toHaveLength(1);
      const dmgEvent = result.events[0]!;
      expect(dmgEvent.type).toBe('PlayerDamaged');
      expect(dmgEvent.playerId).toBe('b');
      expect(dmgEvent.damage).toBe(30);
      expect(dmgEvent.sourceId).toBe('barrel-x');
      expect(dmgEvent.sourceType).toBe(EntityType.PLAYER); // default
      expect(dmgEvent.damageType).toBe(DamageType.BARREL_EXPLOSION);
      expect(dmgEvent.knockbackX).toBe(0);
      expect(dmgEvent.knockbackY).toBe(0);
      expect(dmgEvent.killed).toBe(false);
      expect(dmgEvent.x).toBe(100);
      expect(dmgEvent.y).toBe(0);
      expect(dmgEvent.tick).toBe(100);
    });

    it('emits the exact normalized knockback vector (raw in event, x20 as velocity)', () => {
      // 3-4-5 triangle: dist 500, force 200 -> kb (120, 160), velocity (2400, 3200)
      const target = createPlayer('b', 300, 400);

      const result = pipeline.processDamage(
        {
          sourceId: 'barrel-x',
          damage: 30,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          knockbackForce: 200,
        },
        (id) => (id === 'b' ? target : undefined),
      );

      const dmgEvent = result.events.find((e) => e.type === 'PlayerDamaged')!;
      expect(dmgEvent.knockbackX).toBeCloseTo(120, 10);
      expect(dmgEvent.knockbackY).toBeCloseTo(160, 10);
      expect(target.movement.knockbackVelocityX).toBeCloseTo(2400, 10);
      expect(target.movement.knockbackVelocityY).toBeCloseTo(3200, 10);
    });

    it('shield blocks blockable damage using the sourcePosition angle (generic source id)', () => {
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = 0; // faces the source at (200,100)
      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const result = pipeline.processDamage(
        {
          sourceId: 'trap-x',
          damage: 30,
          damageType: DamageType.MELEE_HIT, // blockable via the generic path too
          targetIds: ['b'],
          sourcePosition: { x: 200, y: 100 },
          currentTick: 100,
        },
        (id) => (id === 'b' ? target : undefined),
      );

      const blockEvent = result.events.find((e) => e.type === 'ShieldBlocked');
      expect(blockEvent).toBeDefined();
      expect(blockEvent!.playerId).toBe('b');
      expect(blockEvent!.sourceId).toBe('trap-x');
      expect(blockEvent!.damageType).toBe(DamageType.MELEE_HIT);
      expect(blockEvent!.x).toBe(100);
      expect(blockEvent!.y).toBe(100);
      expect(result.events.some((e) => e.type === 'PlayerDamaged')).toBe(false);
      expect(result.damageApplied).toBe(0);
      expect(result.killed).toBe(false);
      expect(shieldWeapon.durability).toBe(9);
    });

    it('shield angle uses sourcePosition even when the source player is resolvable', () => {
      // Source player 'a' stands at (200,100) but sourcePosition is (0,100).
      // Target faces PI (towards sourcePosition). The generic path must use
      // sourcePosition -> blocked; using the player position it would land.
      const attacker = createPlayer('a', 200, 100);
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = Math.PI;
      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const result = pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 30,
          damageType: DamageType.MELEE_HIT,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 100 },
          currentTick: 100,
        },
        (id) => (id === 'a' ? attacker : id === 'b' ? target : undefined),
      );

      expect(result.events.some((e) => e.type === 'ShieldBlocked')).toBe(true);
      expect(result.events.some((e) => e.type === 'PlayerDamaged')).toBe(false);
    });

    it('shield break removes the shield and staggers with the default tickRate of 60', () => {
      const target = createPlayer('b', 100, 100);
      target.combat.isBlocking = true;
      target.movement.facingAngle = 0;
      const shieldWeapon = new WeaponEntity(
        'shield1',
        WeaponType.SMALL_SHIELD,
        WeaponTier.COMMON,
        1,
        1,
        30,
      );
      target.inventory.weapons[1] = shieldWeapon;
      target.inventory.activeSlot = 1;

      const result = pipeline.processDamage(
        {
          sourceId: 'trap-x',
          damage: 30,
          damageType: DamageType.MELEE_HIT,
          targetIds: ['b'],
          sourcePosition: { x: 200, y: 100 },
          currentTick: 100,
          // tickRate intentionally omitted -> defaults to 60
        },
        (id) => (id === 'b' ? target : undefined),
      );

      expect(result.events.some((e) => e.type === 'ShieldBlocked')).toBe(true);
      expect(target.inventory.weapons[1]).toBeNull();
      // SMALL_SHIELD staggerOnBreakMs=300 -> Math.ceil(300/1000*60)=18 pins tickRate ?? 60
      expect(target.statusEffects.staggerRemaining).toBe(18);
    });

    it('barrier active skips target', () => {
      const target = createPlayer('b', 100, 0);
      target.statusEffects.barrierExpiryTick = 200;

      const result = pipeline.processDamage(
        {
          sourceId: 'zone',
          damage: 30,
          damageType: DamageType.ZONE_DAMAGE,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'b' ? target : undefined),
      );

      expect(result.events).toEqual([]);
      expect(result.damageApplied).toBe(0);
      expect(result.killed).toBe(false);
    });

    it('fresh spawn invulnerability skips target', () => {
      const target = createPlayer('b', 100, 0);
      target.statusEffects.freshSpawnExpiryTick = 200;

      const result = pipeline.processDamage(
        {
          sourceId: 'zone',
          damage: 30,
          damageType: DamageType.ZONE_DAMAGE,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'b' ? target : undefined),
      );

      expect(result.events).toEqual([]);
      expect(result.damageApplied).toBe(0);
    });

    it('records damage dealt on the source player when resolvable (barrel owner)', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const before = attacker.damageDealt;
      pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 30,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'a' ? attacker : id === 'b' ? target : undefined),
      );

      expect(attacker.damageDealt).toBe(before + 30);
    });

    it('lastDamageSource uses the source id with an empty weapon label', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 30,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'a' ? attacker : id === 'b' ? target : undefined),
      );

      expect(target.statusEffects.lastDamageSource).not.toBeNull();
      expect(target.statusEffects.lastDamageSource!.playerId).toBe('a');
      expect(target.statusEffects.lastDamageSource!.weaponType).toBe('');
      expect(target.statusEffects.lastDamageSource!.tick).toBe(100);
    });

    it('does not apply hit stagger (weaponless path)', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 30,
          damageType: DamageType.MELEE_HIT,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'a' ? attacker : id === 'b' ? target : undefined),
      );

      expect(target.statusEffects.staggerRemaining).toBe(0);
    });

    it('elimination event uses weapon -1 and the provided placement', () => {
      const attacker = createPlayer('a', 0, 0);
      const target = createPlayer('b', 100, 0);

      const result = pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 100,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          alivePlayerCount: 7,
          sourceType: EntityType.EXPLOSION,
        },
        (id) => (id === 'a' ? attacker : id === 'b' ? target : undefined),
      );

      expect(result.killed).toBe(true);
      expect(result.damageApplied).toBe(100);
      const elim = result.events.find((e) => e.type === 'PlayerEliminated')!;
      expect(elim).toBeDefined();
      expect(elim.weapon).toBe(-1);
      expect(elim.killedBy).toBe('a');
      expect(elim.killerName).toBe('a');
      expect(elim.placement).toBe(7);
      expect(elim.cause).toBe(DamageType.BARREL_EXPLOSION);
      const dmgEvent = result.events.find((e) => e.type === 'PlayerDamaged')!;
      expect(dmgEvent.sourceType).toBe(EntityType.EXPLOSION); // passthrough
      expect(dmgEvent.killed).toBe(true);
    });

    it('suppresses the elimination event when alivePlayerCount is omitted', () => {
      const target = createPlayer('b', 100, 0);

      const result = pipeline.processDamage(
        {
          sourceId: 'zone',
          damage: 100,
          damageType: DamageType.ZONE_DAMAGE,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
        },
        (id) => (id === 'b' ? target : undefined),
      );

      expect(result.killed).toBe(true);
      expect(result.damageApplied).toBe(100);
      expect(result.events.some((e) => e.type === 'PlayerEliminated')).toBe(false);
      expect(result.events.some((e) => e.type === 'PlayerDamaged')).toBe(true);
    });

    it('accumulates damage/kills across targets and skips inactive ones', () => {
      const attacker = createPlayer('a', 0, 0);
      const b = createPlayer('b', 100, 0);
      const c = createPlayer('c', -100, 0);
      const dead = createPlayer('d', 0, 100);
      dead.die();

      const result = pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 100,
          damageType: DamageType.BARREL_EXPLOSION,
          targetIds: ['b', 'c', 'd'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          alivePlayerCount: 5,
        },
        (id) =>
          id === 'a' ? attacker : id === 'b' ? b : id === 'c' ? c : id === 'd' ? dead : undefined,
      );

      expect(result.damageApplied).toBe(200);
      expect(result.killed).toBe(true);
      expect(result.events.filter((e) => e.type === 'PlayerDamaged')).toHaveLength(2);
      expect(result.events.filter((e) => e.type === 'PlayerEliminated')).toHaveLength(2);
      expect(attacker.damageDealt).toBe(200);
    });
  });

  describe('attack/damage path equivalence', () => {
    it('equivalent inputs produce identical PlayerDamaged events and target state', () => {
      // Attacker position == sourcePosition and FISTS (hitStaggerMs=0) make the
      // two entry points semantically aligned for these inputs.
      const attackerA = createPlayer('a', 0, 0);
      const targetA = createPlayer('b', 300, 400);
      const attackerD = createPlayer('a', 0, 0);
      const targetD = createPlayer('b', 300, 400);

      const attackEvents = pipeline.processAttack(
        {
          attackerId: 'a',
          weaponType: WeaponType.FISTS,
          damage: 30,
          knockbackForce: 200,
          damageType: DamageType.MELEE_HIT,
          hitTargetIds: ['b'],
          attackAngle: 0,
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          tickRate: 60,
          alivePlayerCount: 5,
        },
        (id) => (id === 'a' ? attackerA : id === 'b' ? targetA : undefined),
      );

      const damageResult = pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 30,
          damageType: DamageType.MELEE_HIT,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          knockbackForce: 200,
          tickRate: 60,
          alivePlayerCount: 5,
        },
        (id) => (id === 'a' ? attackerD : id === 'b' ? targetD : undefined),
      );

      const attackDmg = attackEvents.find((e) => e.type === 'PlayerDamaged')!;
      const damageDmg = damageResult.events.find((e) => e.type === 'PlayerDamaged')!;
      const { timestamp: _ta, ...attackRest } = attackDmg;
      const { timestamp: _td, ...damageRest } = damageDmg;
      expect(attackRest).toEqual(damageRest);

      expect(damageResult.damageApplied).toBe(30);
      expect(targetD.health.current).toBe(targetA.health.current);
      expect(targetD.movement.knockbackVelocityX).toBe(targetA.movement.knockbackVelocityX);
      expect(targetD.movement.knockbackVelocityY).toBe(targetA.movement.knockbackVelocityY);
      expect(attackerD.damageDealt).toBe(attackerA.damageDealt);
      expect(targetD.statusEffects.staggerRemaining).toBe(targetA.statusEffects.staggerRemaining);
    });

    it('equivalent killing inputs produce identical elimination events except the weapon field', () => {
      const attackerA = createPlayer('a', 0, 0);
      const targetA = createPlayer('b', 100, 0);
      const attackerD = createPlayer('a', 0, 0);
      const targetD = createPlayer('b', 100, 0);

      const attackEvents = pipeline.processAttack(
        {
          attackerId: 'a',
          weaponType: WeaponType.FISTS,
          damage: 100,
          knockbackForce: 0,
          damageType: DamageType.MELEE_HIT,
          hitTargetIds: ['b'],
          attackAngle: 0,
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          tickRate: 60,
          alivePlayerCount: 5,
        },
        (id) => (id === 'a' ? attackerA : id === 'b' ? targetA : undefined),
      );

      const damageResult = pipeline.processDamage(
        {
          sourceId: 'a',
          damage: 100,
          damageType: DamageType.MELEE_HIT,
          targetIds: ['b'],
          sourcePosition: { x: 0, y: 0 },
          currentTick: 100,
          tickRate: 60,
          alivePlayerCount: 5,
        },
        (id) => (id === 'a' ? attackerD : id === 'b' ? targetD : undefined),
      );

      const attackElim = attackEvents.find((e) => e.type === 'PlayerEliminated')!;
      const damageElim = damageResult.events.find((e) => e.type === 'PlayerEliminated')!;
      const { timestamp: _ta, weapon: attackWeapon, ...attackRest } = attackElim;
      const { timestamp: _td, weapon: damageWeapon, ...damageRest } = damageElim;
      expect(attackRest).toEqual(damageRest);

      // The deliberate weapon-field divergence between the two paths:
      expect(attackWeapon).toBe(WeaponType.FISTS);
      expect(damageWeapon).toBe(-1);
      // ...and the lastDamageSource weapon label divergence:
      expect(targetA.statusEffects.lastDamageSource!.weaponType).toBe(
        WeaponType.FISTS.toString(),
      );
      expect(targetD.statusEffects.lastDamageSource!.weaponType).toBe('');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { DamagePipeline } from '../../src/domain/services/DamagePipeline.ts';
import { ShieldHandler } from '../../src/domain/handlers/ShieldHandler.ts';
import { DamageType, WeaponType, EntityType } from '@sector-battle/shared';
import type { Player } from '../../src/domain/entities/index.ts';
import type { DomainEvent } from '../../src/domain/events/index.ts';

function makeMockPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'player-1',
    isActive: true,
    name: 'TestPlayer',
    movement: {
      position: { x: 100, y: 100 },
      facingAngle: 0,
      isDashing: false,
      knockbackVelocityX: 0,
      knockbackVelocityY: 0,
      speed: { value: 200, max: 600 },
    },
    combat: {
      isBlocking: false,
    },
    statusEffects: {
      lastDamageSource: null,
      staggerRemaining: 0,
    },
    inventory: {
      activeSlot: 0,
    },
    health: { current: 100, max: 100 },
    getActiveWeapon: () => ({
      durability: 5,
      type: WeaponType.SHORT_SWORD,
      consumeDurability: () => {},
    }),
    takeDamage: (dmg: number) => ({ damageApplied: dmg, killed: false }),
    isBarrierActive: () => false,
    isFreshSpawnActive: () => false,
    recordDamageDealt: () => {},
    onWeaponBreak: () => {},
    applyKnockbackVelocity: () => {},
    cancelDash: () => {},
    startStagger: () => {},
    canBlock: () => false,
    ...overrides,
  } as unknown as Player;
}

describe('RT-047 Runtime Validation', () => {
  it('ShieldHandler blocks front-arc damage for blocking player', () => {
    const shieldHandler = new ShieldHandler();
    const pipeline = new DamagePipeline(shieldHandler);

    const blockingPlayer = makeMockPlayer({
      id: 'target-1',
      combat: { isBlocking: true },
      movement: {
        position: { x: 110, y: 100 },
        facingAngle: 0,
        isDashing: false,
        knockbackVelocityX: 0,
        knockbackVelocityY: 0,
      },
      getActiveWeapon: () => ({
        durability: 5,
        type: WeaponType.SMALL_SHIELD,
        consumeDurability: () => {},
      }),
      canBlock: () => true,
    });

    const attacker = makeMockPlayer({
      id: 'attacker-1',
      movement: {
        position: { x: 120, y: 100 },
        facingAngle: Math.PI,
        isDashing: false,
        knockbackVelocityX: 0,
        knockbackVelocityY: 0,
      },
      recordDamageDealt: () => {},
    });

    const context = {
      attackerId: 'attacker-1',
      weaponType: WeaponType.SHORT_SWORD,
      damage: 25,
      knockbackForce: 100,
      damageType: DamageType.MELEE_HIT,
      hitTargetIds: ['target-1'],
      attackAngle: 0,
      sourcePosition: { x: 110, y: 100 },
      currentTick: 100,
      tickRate: 60,
      alivePlayerCount: 2,
    };

    const events = pipeline.processAttack(context, (id) => {
      if (id === 'target-1') return blockingPlayer;
      if (id === 'attacker-1') return attacker;
      return undefined;
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('ShieldBlocked');
    expect(events[0]!.playerId).toBe('target-1');
    expect(events[0]!.damageType).toBe(DamageType.MELEE_HIT);
    expect(events[0]!.sourceId).toBe('attacker-1');
  });

  it('Non-blocking player takes damage normally', () => {
    const shieldHandler = new ShieldHandler();
    const pipeline = new DamagePipeline(shieldHandler);

    const nonBlockingPlayer = makeMockPlayer({
      id: 'target-1',
      movement: {
        position: { x: 110, y: 100 },
        facingAngle: 0,
        isDashing: false,
        knockbackVelocityX: 0,
        knockbackVelocityY: 0,
      },
      takeDamage: (dmg: number) => ({ damageApplied: dmg, killed: false }),
      getActiveWeapon: () => ({
        durability: 5,
        type: WeaponType.SHORT_SWORD,
        consumeDurability: () => {},
      }),
      canBlock: () => false,
    });

    const attacker = makeMockPlayer({
      id: 'attacker-1',
      recordDamageDealt: () => {},
    });

    const context = {
      attackerId: 'attacker-1',
      weaponType: WeaponType.SHORT_SWORD,
      damage: 25,
      knockbackForce: 0,
      damageType: DamageType.MELEE_HIT,
      hitTargetIds: ['target-1'],
      attackAngle: Math.PI,
      sourcePosition: { x: 100, y: 100 },
      currentTick: 100,
      tickRate: 60,
      alivePlayerCount: 2,
    };

    const events = pipeline.processAttack(context, (id) => {
      if (id === 'target-1') return nonBlockingPlayer;
      if (id === 'attacker-1') return attacker;
      return undefined;
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('PlayerDamaged');
    expect(events[0]!.damage).toBe(25);
    expect(events[0]!.playerId).toBe('target-1');
  });

  it('Shield durability decreases on successful block', () => {
    const shieldHandler = new ShieldHandler();
    const result = shieldHandler.processIncomingDamage(
      {
        combat: { isBlocking: true },
        movement: { facingAngle: 0 },
        getActiveWeapon: () => ({
          durability: 5,
          type: WeaponType.SMALL_SHIELD,
          consumeDurability: () => {},
        }),
        canBlock: () => true,
      } as unknown as Player,
      25,
      100,
      0,
      5,
      DamageType.MELEE_HIT,
      100,
    );

    expect(result.blocked).toBe(true);
    expect(result.damage).toBe(0);
    expect(result.knockback).toBe(0);
    expect(result.shieldBroken).toBe(false);
  });

  it('Shield breaks when durability reaches 0', () => {
    const shieldHandler = new ShieldHandler();
    const result = shieldHandler.processIncomingDamage(
      {
        combat: { isBlocking: true },
        movement: { facingAngle: 0 },
        getActiveWeapon: () => ({
          durability: 5,
          type: WeaponType.SMALL_SHIELD,
          consumeDurability: () => {},
        }),
        canBlock: () => true,
      } as unknown as Player,
      25,
      100,
      0,
      1,
      DamageType.MELEE_HIT,
      100,
    );

    expect(result.blocked).toBe(true);
    expect(result.shieldBroken).toBe(true);
  });

  it('Side attack is NOT blocked (outside shield arc)', () => {
    const shieldHandler = new ShieldHandler();
    const result = shieldHandler.processIncomingDamage(
      {
        combat: { isBlocking: true },
        movement: { facingAngle: 0 },
        getActiveWeapon: () => ({
          durability: 5,
          type: WeaponType.SMALL_SHIELD,
          consumeDurability: () => {},
        }),
        canBlock: () => true,
      } as unknown as Player,
      25,
      100,
      Math.PI / 2,
      5,
      DamageType.MELEE_HIT,
      100,
    );

    expect(result.blocked).toBe(false);
    expect(result.damage).toBe(25);
  });

  it('SIEGE_CRUSH bypasses shield entirely', () => {
    const shieldHandler = new ShieldHandler();
    const pipeline = new DamagePipeline(shieldHandler);

    const blockingPlayer = makeMockPlayer({
      id: 'target-1',
      combat: { isBlocking: true },
      movement: {
        position: { x: 110, y: 100 },
        facingAngle: 0,
        isDashing: false,
        knockbackVelocityX: 0,
        knockbackVelocityY: 0,
      },
      getActiveWeapon: () => ({
        durability: 5,
        type: WeaponType.SMALL_SHIELD,
        consumeDurability: () => {},
      }),
      canBlock: () => true,
    });

    const context = {
      attackerId: 'zone',
      weaponType: WeaponType.FISTS,
      damage: 50,
      knockbackForce: 0,
      damageType: DamageType.SIEGE_CRUSH,
      hitTargetIds: ['target-1'],
      attackAngle: Math.PI,
      sourcePosition: { x: 100, y: 100 },
      currentTick: 100,
      tickRate: 60,
      alivePlayerCount: 2,
    };

    const events = pipeline.processAttack(context, (id) => {
      if (id === 'target-1') return blockingPlayer;
      return undefined;
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('PlayerDamaged');
    expect(events[0]!.damage).toBe(50);
  });
});

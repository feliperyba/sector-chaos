import { describe, it, expect } from 'vitest';
import { Trap } from '../../../src/domain/entities/index.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { TRAP, TrapType } from '@sector-battle/shared';

describe('Trap', () => {
  describe('create', () => {
    it('creates a spike trap with correct defaults', () => {
      const trap = Trap.create('t1', TrapType.SPIKE, new Position(100, 200));
      expect(trap.id).toBe('t1');
      expect(trap.type).toBe(TrapType.SPIKE);
      expect(trap.position.x).toBe(100);
      expect(trap.position.y).toBe(200);
      expect(trap.cooldownRemaining).toBe(0);
      expect(trap.lastTriggerTime).toBe(-Infinity);
      expect(trap.isRevealed).toBe(false);
      expect(trap.fireAreaActive).toBe(false);
      expect(trap.fireAreaRemainingTicks).toBe(0);
    });

    it('creates a fire trap with correct defaults', () => {
      const trap = Trap.create('t2', TrapType.FIRE, new Position(0, 0));
      expect(trap.isRevealed).toBe(false);
      expect(trap.fireAreaActive).toBe(false);
      expect(trap.fireAreaRemainingTicks).toBe(0);
    });

    it('creates a teleport trap with correct defaults', () => {
      const trap = Trap.create('t3', TrapType.TELEPORT, new Position(0, 0));
      expect(trap.isRevealed).toBe(false);
      expect(trap.cooldownRemaining).toBe(0);
    });

    it('stores optional visual properties', () => {
      const trap = Trap.create(
        't4',
        TrapType.SPIKE,
        new Position(0, 0),
        'spike_tex',
        1.5,
        true,
        false,
      );
      expect(trap.textureKey).toBe('spike_tex');
      expect(trap.rotation).toBe(1.5);
      expect(trap.flipH).toBe(true);
      expect(trap.flipV).toBe(false);
    });
  });

  describe('getTriggerRadius', () => {
    it('returns TRAP.TRIGGER_RADIUS for all trap types', () => {
      for (const type of [TrapType.SPIKE, TrapType.FIRE, TrapType.TELEPORT]) {
        expect(Trap.create('t', type, new Position(0, 0)).getTriggerRadius()).toBe(
          TRAP.TRIGGER_RADIUS,
        );
      }
    });
  });

  describe('trigger - spike', () => {
    it('returns damage and knockback effects', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      const effects = trap.trigger(10, 'p1');
      expect(effects).toHaveLength(2);
      expect(effects[0]).toEqual({
        type: 'damage',
        amount: TRAP.SPIKE_DAMAGE,
        stunDuration: TRAP.SPIKE_STUN_DURATION,
        targetId: 'p1',
      });
      expect(effects[1]).toEqual({
        type: 'knockback',
        targetId: 'p1',
        knockbackForce: TRAP.SPIKE_KNOCKBACK,
      });
    });

    it('sets cooldown to 60 ticks', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.cooldownRemaining).toBe(60);
    });

    it('reveals the trap and records last trigger time', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      expect(trap.isRevealed).toBe(false);
      trap.trigger(42, 'p1');
      expect(trap.isRevealed).toBe(true);
      expect(trap.lastTriggerTime).toBe(42);
    });
  });

  describe('trigger - fire', () => {
    it('activates persistent fire area (+ tuned instant damage) on trigger', () => {
      const trap = Trap.create('ft', TrapType.FIRE, new Position(0, 0));
      const effects = trap.trigger(10, 'p1');
      // FIRE_INSTANT_DAMAGE is a tuned value (3725faf3): when > 0 the trigger
      // emits one instant damage effect before the area DOT takes over; the
      // GDD §10.2.2 zero-instant reading is the `0` configuration.
      expect(effects).toHaveLength(TRAP.FIRE_INSTANT_DAMAGE > 0 ? 1 : 0);
      if (TRAP.FIRE_INSTANT_DAMAGE > 0) {
        expect(effects[0]).toEqual({
          type: 'damage',
          amount: TRAP.FIRE_INSTANT_DAMAGE,
          targetId: 'p1',
        });
      }
      expect(trap.fireAreaActive).toBe(true);
      expect(trap.fireAreaRemainingTicks).toBe(TRAP.FIRE_DURATION_TICKS);
    });

    it('has zero cooldown (re-triggerable after area expires)', () => {
      const trap = Trap.create('ft', TrapType.FIRE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.cooldownRemaining).toBe(0);
    });

    it('reveals the trap and records last trigger time', () => {
      const trap = Trap.create('ft', TrapType.FIRE, new Position(0, 0));
      trap.trigger(77, 'p1');
      expect(trap.isRevealed).toBe(true);
      expect(trap.lastTriggerTime).toBe(77);
    });
  });

  describe('trigger - teleport', () => {
    it('returns teleport effect', () => {
      const trap = Trap.create('t', TrapType.TELEPORT, new Position(0, 0));
      const effects = trap.trigger(10, 'p1');
      expect(effects).toHaveLength(1);
      expect(effects[0]).toEqual({ type: 'teleport', targetId: 'p1' });
    });

    it('sets cooldown to 60 ticks', () => {
      const trap = Trap.create('t', TrapType.TELEPORT, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.cooldownRemaining).toBe(60);
    });

    it('reveals the trap', () => {
      const trap = Trap.create('t', TrapType.TELEPORT, new Position(0, 0));
      trap.trigger(10, 'p1');
      expect(trap.isRevealed).toBe(true);
    });
  });

  describe('reveal', () => {
    it('sets isRevealed to true', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      expect(trap.isRevealed).toBe(false);
      trap.reveal();
      expect(trap.isRevealed).toBe(true);
    });

    it('is idempotent - calling reveal twice does not change state', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.reveal();
      trap.reveal();
      expect(trap.isRevealed).toBe(true);
    });
  });

  describe('canTrigger', () => {
    it('returns true when never triggered', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      expect(trap.canTrigger(100)).toBe(true);
    });

    it('returns false while cooldown is active (spike)', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.canTrigger(1)).toBe(false);
      expect(trap.canTrigger(59)).toBe(false);
    });

    it('spike can re-trigger after cooldown expires', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.canTrigger(59)).toBe(false);
      trap.tickCooldown(60);
      expect(trap.cooldownRemaining).toBe(0);
      expect(trap.canTrigger(60)).toBe(true);
    });

    it('returns false when cooldownRemaining > 0 regardless of tick', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.cooldownRemaining = 5;
      expect(trap.canTrigger(0)).toBe(false);
    });

    it('returns true after manually-set cooldown reaches zero', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.cooldownRemaining = 3;
      trap.tickCooldown(3);
      expect(trap.cooldownRemaining).toBe(0);
      expect(trap.canTrigger(0)).toBe(true);
    });

    it('fire returns false while fire area is active', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.fireAreaActive).toBe(true);
      expect(trap.canTrigger(1)).toBe(false);
      expect(trap.canTrigger(1000)).toBe(false);
    });

    it('fire can re-trigger after fire area expires', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.canTrigger(100)).toBe(false);
      trap.tickCooldown(300);
      expect(trap.fireAreaActive).toBe(false);
      expect(trap.canTrigger(301)).toBe(true);
    });

    it('teleport returns false while cooldown active', () => {
      const trap = Trap.create('t', TrapType.TELEPORT, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.canTrigger(1)).toBe(false);
    });

    it('teleport can re-trigger after cooldown expires', () => {
      const trap = Trap.create('t', TrapType.TELEPORT, new Position(0, 0));
      trap.trigger(0, 'p1');
      trap.tickCooldown(60);
      expect(trap.cooldownRemaining).toBe(0);
      expect(trap.canTrigger(60)).toBe(true);
    });
  });

  describe('tickCooldown', () => {
    it('decrements cooldownRemaining', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.cooldownRemaining = 10;
      trap.tickCooldown(3);
      expect(trap.cooldownRemaining).toBe(7);
    });

    it('does not go below zero', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.cooldownRemaining = 5;
      trap.tickCooldown(100);
      expect(trap.cooldownRemaining).toBe(0);
    });

    it('does nothing when cooldown is already zero', () => {
      const trap = Trap.create('t', TrapType.SPIKE, new Position(0, 0));
      trap.tickCooldown(5);
      expect(trap.cooldownRemaining).toBe(0);
    });

    it('decrements fire area remaining ticks', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      trap.trigger(0, 'p1');
      expect(trap.fireAreaRemainingTicks).toBe(300);
      trap.tickCooldown(50);
      expect(trap.fireAreaRemainingTicks).toBe(250);
      expect(trap.fireAreaActive).toBe(true);
    });

    it('deactivates fire area when ticks reach zero', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      trap.trigger(0, 'p1');
      trap.tickCooldown(300);
      expect(trap.fireAreaRemainingTicks).toBe(0);
      expect(trap.fireAreaActive).toBe(false);
    });
  });

  describe('fire area helpers', () => {
    it('getFireAreaDotPerTick returns configured value', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      expect(trap.getFireAreaDotPerTick()).toBe(5);
    });

    it('getFireAreaRadius returns configured value', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      expect(trap.getFireAreaRadius()).toBe(1);
    });

    it('resetFireCooldown restores fire area duration to 300 ticks', () => {
      const trap = Trap.create('t', TrapType.FIRE, new Position(0, 0));
      trap.trigger(0, 'p1');
      trap.tickCooldown(100);
      expect(trap.fireAreaRemainingTicks).toBe(200);
      trap.resetFireCooldown();
      expect(trap.fireAreaRemainingTicks).toBe(300);
    });
  });
});

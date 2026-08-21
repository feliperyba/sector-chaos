import { describe, it, expect, beforeEach } from 'vitest';
import { ZONE } from '@sector-battle/shared';
import {
  SuddenDeathService,
  type SuddenDeathState,
} from '../../../src/domain/services/SuddenDeathService.ts';

describe('SuddenDeathService', () => {
  let service: SuddenDeathService;

  beforeEach(() => {
    service = new SuddenDeathService();
  });

  describe('activate', () => {
    it('sets active state', () => {
      service.activate(1000, ['p1', 'p2']);

      const state: SuddenDeathState = service.getState();

      expect(state.active).toBe(true);
      expect(state.startTime).toBe(1000);
      expect(state.remainingPlayerIds).toEqual(['p1', 'p2']);
      expect(state.elapsedMs).toBe(0);
      expect(state.escalationLevel).toBe(0);
    });

    it('emits SuddenDeathTriggered event', () => {
      service.activate(1000, ['p1', 'p2']);

      const events = service.drainEvents();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('SuddenDeathTriggered');
      expect(events[0]).toHaveProperty('remainingPlayers', ['p1', 'p2']);
    });
  });

  describe('update', () => {
    it('accumulates elapsed time', () => {
      service.activate(1000, ['p1', 'p2']);

      service.update(5000);
      expect(service.getState().elapsedMs).toBe(5000);

      service.update(3000);
      expect(service.getState().elapsedMs).toBe(8000);
    });

    it('is a no-op when not active', () => {
      service.update(1000);

      expect(service.getState().elapsedMs).toBe(0);
    });

    it('escalates after escalation interval', () => {
      service = new SuddenDeathService({ escalationIntervalMs: 10000 });
      service.activate(1000, ['p1']);

      service.update(10000);
      expect(service.getState().escalationLevel).toBe(1);

      service.update(10000);
      expect(service.getState().escalationLevel).toBe(2);
    });

    it('emits SuddenDeathEscalation event on escalation', () => {
      service = new SuddenDeathService({ escalationIntervalMs: 10000 });
      service.activate(1000, ['p1']);
      service.drainEvents();

      service.update(10000);
      const events = service.drainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('SuddenDeathEscalation');
      expect(events[0]).toHaveProperty('level', 1);
    });

    it('does not escalate before interval', () => {
      service = new SuddenDeathService({ escalationIntervalMs: 30000 });
      service.activate(1000, ['p1']);
      service.drainEvents();

      service.update(15000);
      expect(service.getState().escalationLevel).toBe(0);
      expect(service.drainEvents()).toHaveLength(0);
    });
  });

  describe('getDamagePerTick', () => {
    it('returns base damage at escalation level 0', () => {
      service.activate(1000, ['p1']);
      expect(service.getDamagePerTick()).toBe(ZONE.ZONE_DAMAGE_SUDDEN_DEATH);
    });

    it('increases damage with escalation level', () => {
      service = new SuddenDeathService({ escalationIntervalMs: 1000, damagePerEscalation: 5 });
      service.activate(1000, ['p1']);

      service.update(1000);
      expect(service.getDamagePerTick()).toBe(ZONE.ZONE_DAMAGE_SUDDEN_DEATH + 5);

      service.update(1000);
      expect(service.getDamagePerTick()).toBe(ZONE.ZONE_DAMAGE_SUDDEN_DEATH + 10);
    });
  });

  describe('getShrinkRateMultiplier', () => {
    it('returns configured multiplier', () => {
      service = new SuddenDeathService({ shrinkRateMultiplier: 3.0 });
      expect(service.getShrinkRateMultiplier()).toBe(3.0);
    });
  });

  describe('getState', () => {
    it('returns a copy of remainingPlayerIds', () => {
      service.activate(1000, ['p1', 'p2']);

      const state: SuddenDeathState = service.getState();
      state.remainingPlayerIds.push('p3');
      state.remainingPlayerIds.splice(0, 1);

      const stateAfter: SuddenDeathState = service.getState();
      expect(stateAfter.remainingPlayerIds).toEqual(['p1', 'p2']);
    });

    it('includes escalation data', () => {
      service = new SuddenDeathService({ escalationIntervalMs: 5000 });
      service.activate(1000, ['p1']);

      service.update(5000);
      const state = service.getState();

      expect(state.escalationLevel).toBe(1);
      expect(state.currentDamagePerTick).toBe(ZONE.ZONE_DAMAGE_SUDDEN_DEATH + 5);
      expect(state.shrinkRateMultiplier).toBe(2.0);
    });
  });

  describe('drainEvents', () => {
    it('returns and clears events', () => {
      service.activate(1000, ['p1', 'p2']);

      const first = service.drainEvents();
      expect(first.length).toBeGreaterThanOrEqual(1);

      const second = service.drainEvents();
      expect(second).toEqual([]);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { EliminationService } from '../../../src/domain/services/EliminationService.ts';
import type { EliminationRecord } from '../../../src/domain/services/EliminationService.ts';

interface DamageSourceEntry {
  attackerId: string;
  timestamp: number;
}

type ServiceInternals = {
  damageSources: Map<string, DamageSourceEntry>;
};

function getDamageSources(service: EliminationService): Map<string, DamageSourceEntry> {
  return (service as unknown as ServiceInternals).damageSources;
}

describe('EliminationService', () => {
  describe('recordElimination — basic recording', () => {
    it('returns correct EliminationRecord', () => {
      const service = new EliminationService();

      const record = service.recordElimination('p1', 'k1', 1, { x: 100, y: 200 }, 1000);

      expect(record).toEqual({
        order: 1,
        playerId: 'p1',
        killerId: 'k1',
        weaponType: 1,
        timestamp: 1000,
        position: { x: 100, y: 200 },
      });
    });
  });

  describe('recordElimination — auto-incrementing order', () => {
    it('order values are 1, 2, 3', () => {
      const service = new EliminationService();

      const r1 = service.recordElimination('p1', 'k1', 1, { x: 0, y: 0 }, 1000);
      const r2 = service.recordElimination('p2', 'k2', 2, { x: 0, y: 0 }, 2000);
      const r3 = service.recordElimination('p3', 'k3', 3, { x: 0, y: 0 }, 3000);

      expect(r1.order).toBe(1);
      expect(r2.order).toBe(2);
      expect(r3.order).toBe(3);
    });
  });

  describe('recordElimination — null killerId resolved via getLastKiller', () => {
    it('resolves to last killer when entry exists', () => {
      const service = new EliminationService();
      getDamageSources(service).set('p1', {
        attackerId: 'k1',
        timestamp: Date.now(),
      });

      const record = service.recordElimination('p1', null, 1, { x: 100, y: 200 }, 1000);

      expect(record.killerId).toBe('k1');
    });

    it('keeps null when no last killer', () => {
      const service = new EliminationService();

      const record = service.recordElimination('p1', null, 1, { x: 100, y: 200 }, 1000);

      expect(record.killerId).toBeNull();
    });
  });

  describe('getEliminations — returns all records', () => {
    it('returns readonly array with all recordings', () => {
      const service = new EliminationService();
      service.recordElimination('p1', 'k1', 1, { x: 0, y: 0 }, 1000);
      service.recordElimination('p2', 'k2', 2, { x: 0, y: 0 }, 2000);
      service.recordElimination('p3', 'k3', 3, { x: 0, y: 0 }, 3000);

      const result = service.getEliminations();

      expect(result.length).toBe(3);
    });
  });

  describe('getLastKiller — no entry', () => {
    it('returns null for unknown player', () => {
      const service = new EliminationService();

      expect(service.getLastKiller('unknown')).toBeNull();
    });
  });

  describe('getLastKiller — entry within TTL', () => {
    it('returns attacker ID when entry is recent', () => {
      const service = new EliminationService();
      getDamageSources(service).set('p1', {
        attackerId: 'k1',
        timestamp: Date.now() - 100,
      });

      expect(service.getLastKiller('p1')).toBe('k1');
    });
  });

  describe('getLastKiller — expired entry (2s TTL)', () => {
    it('returns null and removes entry older than 2000ms', () => {
      const service = new EliminationService();
      getDamageSources(service).set('p1', {
        attackerId: 'k1',
        timestamp: Date.now() - 3000,
      });

      expect(service.getLastKiller('p1')).toBeNull();
      expect(getDamageSources(service).has('p1')).toBe(false);
    });
  });
});

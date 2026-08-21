import { describe, it, expect, beforeEach } from 'vitest';
import { MatchFlowService } from '../../../src/domain/services/MatchFlowService.ts';
import { SpawnService } from '../../../src/domain/services/SpawnService.ts';
import { MatchPhase, MATCH } from '@sector-battle/shared';
import type { SpawnPoint } from '@sector-battle/shared';

function createSpawnService(): SpawnService {
  const svc = new SpawnService();
  svc.initialize([{ x: 100, y: 100, sectorCoord: { row: 0, col: 0 }, priority: 0 }]);
  return svc;
}

function setPhase(service: MatchFlowService, phase: MatchPhase): void {
  (service as unknown as { phase: MatchPhase }).phase = phase;
}

describe('MatchFlowService', () => {
  let service: MatchFlowService;
  let spawnService: SpawnService;

  beforeEach(() => {
    service = new MatchFlowService();
    spawnService = createSpawnService();
  });

  describe('startMatch', () => {
    it('transitions WAITING to COUNTDOWN', () => {
      service.startMatch(['p1', 'p2', 'p3'], spawnService);

      expect(service.getCurrentState().phase).toBe(MatchPhase.COUNTDOWN);

      const events = service.drainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'MatchPhaseChanged',
        from: MatchPhase.WAITING,
        to: MatchPhase.COUNTDOWN,
      });
    });

    it('throws from non-WAITING phase', () => {
      service.startMatch(['p1'], spawnService);

      expect(() => service.startMatch(['p1'], spawnService)).toThrow(
        `Cannot start match from phase ${MatchPhase[MatchPhase.COUNTDOWN]}`,
      );
    });

    it('records player IDs', () => {
      service.startMatch(['p1', 'p2', 'p3'], spawnService);

      expect(service.getPlayerIds()).toEqual(['p1', 'p2', 'p3']);

      const alive = service.getAlivePlayerIds();
      expect(alive.has('p1')).toBe(true);
      expect(alive.has('p2')).toBe(true);
      expect(alive.has('p3')).toBe(true);
    });
  });

  describe('update', () => {
    it('transitions COUNTDOWN to ACTIVE after 5 seconds', () => {
      service.startMatch(['p1'], spawnService);
      service.drainEvents();

      service.update(MATCH.COUNTDOWN_DURATION * 1000);

      expect(service.getCurrentState().phase).toBe(MatchPhase.ACTIVE);

      const events = service.drainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'MatchPhaseChanged',
        from: MatchPhase.COUNTDOWN,
        to: MatchPhase.ACTIVE,
      });
    });

    it('does not transition COUNTDOWN before 5 seconds', () => {
      service.startMatch(['p1'], spawnService);

      service.update(MATCH.COUNTDOWN_DURATION * 1000 - 1);
      expect(service.getCurrentState().phase).toBe(MatchPhase.COUNTDOWN);

      service.update(1);
      expect(service.getCurrentState().phase).toBe(MatchPhase.ACTIVE);
    });
  });

  describe('transitionTo', () => {
    const validTransitions: [MatchPhase, MatchPhase][] = [
      [MatchPhase.WAITING, MatchPhase.COUNTDOWN],
      [MatchPhase.COUNTDOWN, MatchPhase.ACTIVE],
      [MatchPhase.ACTIVE, MatchPhase.ZONE_SHRINKING],
      [MatchPhase.ZONE_SHRINKING, MatchPhase.FINAL_CLOSURE],
      [MatchPhase.FINAL_CLOSURE, MatchPhase.OVERTIME],
      [MatchPhase.OVERTIME, MatchPhase.FINISHED],
    ];

    it('valid transitions succeed', () => {
      for (const [from, to] of validTransitions) {
        const svc = new MatchFlowService();
        setPhase(svc, from);

        expect(() => svc.transitionTo(to)).not.toThrow();
        expect(svc.getCurrentState().phase).toBe(to);
      }
    });

    it('invalid transitions throw', () => {
      const invalidTransitions: [MatchPhase, MatchPhase][] = [
        [MatchPhase.WAITING, MatchPhase.ACTIVE],
        [MatchPhase.WAITING, MatchPhase.FINISHED],
        [MatchPhase.COUNTDOWN, MatchPhase.ZONE_SHRINKING],
        [MatchPhase.FINISHED, MatchPhase.ACTIVE],
      ];

      for (const [from, to] of invalidTransitions) {
        const svc = new MatchFlowService();
        setPhase(svc, from);

        expect(() => svc.transitionTo(to)).toThrow();
      }
    });

    it('resets phaseElapsedMs', () => {
      setPhase(service, MatchPhase.WAITING);

      service.transitionTo(MatchPhase.COUNTDOWN);

      expect(service.getPhaseElapsedMs()).toBe(0);
    });
  });

  describe('isInputAllowed', () => {
    it('returns true during gameplay phases', () => {
      const gameplayPhases: MatchPhase[] = [
        MatchPhase.ACTIVE,
        MatchPhase.ZONE_SHRINKING,
        MatchPhase.FINAL_CLOSURE,
        MatchPhase.OVERTIME,
      ];

      for (const phase of gameplayPhases) {
        setPhase(service, phase);
        expect(service.isInputAllowed()).toBe(true);
      }
    });

    it('returns false during non-gameplay phases', () => {
      const nonGameplayPhases: MatchPhase[] = [
        MatchPhase.WAITING,
        MatchPhase.COUNTDOWN,
        MatchPhase.FINISHED,
      ];

      for (const phase of nonGameplayPhases) {
        setPhase(service, phase);
        expect(service.isInputAllowed()).toBe(false);
      }
    });
  });

  describe('markPlayerDead', () => {
    beforeEach(() => {
      service.startMatch(['p1', 'p2', 'p3'], spawnService);
    });

    it('removes from alive set', () => {
      service.markPlayerDead('p1');

      expect(service.getAlivePlayerIds().has('p1')).toBe(false);
    });

    it('does not affect other players', () => {
      service.markPlayerDead('p1');

      const alive = service.getAlivePlayerIds();
      expect(alive.has('p2')).toBe(true);
      expect(alive.has('p3')).toBe(true);
    });

    it('is idempotent', () => {
      service.markPlayerDead('p1');
      service.markPlayerDead('p1');

      expect(service.getAlivePlayerIds().has('p1')).toBe(false);
    });

    it('getAlivePlayerCount matches getAlivePlayerIds().size across mutations (server-alive-count-no-copy)', () => {
      // server-alive-count-no-copy: the per-tick phases path reads
      // getAlivePlayerCount() instead of materializing the Set copy.
      expect(service.getAlivePlayerCount()).toBe(service.getAlivePlayerIds().size);
      expect(service.getAlivePlayerCount()).toBe(3);

      service.markPlayerDead('p1');
      expect(service.getAlivePlayerCount()).toBe(service.getAlivePlayerIds().size);
      expect(service.getAlivePlayerCount()).toBe(2);

      service.addLatePlayer('p4');
      expect(service.getAlivePlayerCount()).toBe(service.getAlivePlayerIds().size);
      expect(service.getAlivePlayerCount()).toBe(3);

      service.markPlayerDead('p2');
      service.markPlayerDead('p3');
      service.markPlayerDead('p4');
      expect(service.getAlivePlayerCount()).toBe(service.getAlivePlayerIds().size);
      expect(service.getAlivePlayerCount()).toBe(0);
    });
  });

  describe('forceFinish', () => {
    it('sets phase to FINISHED', () => {
      service.startMatch(['p1'], spawnService);

      service.forceFinish();

      expect(service.getCurrentState().phase).toBe(MatchPhase.FINISHED);
    });
  });

  describe('drainEvents', () => {
    it('returns and clears events', () => {
      service.startMatch(['p1'], spawnService);

      const first = service.drainEvents();
      expect(first.length).toBeGreaterThan(0);

      const second = service.drainEvents();
      expect(second).toHaveLength(0);
    });
  });

  describe('elapsedMs', () => {
    it('accumulates across update calls', () => {
      service.startMatch(['p1'], spawnService);

      service.update(1000);
      service.update(500);

      expect(service.getCurrentState().elapsedMs).toBe(1500);
    });
  });
});

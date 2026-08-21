import { describe, it, expect, beforeEach } from 'vitest';
import {
  MatchEndService,
  type PlacementData,
  type PlayerRoundStats,
  type RoundEndResult,
} from '../../../src/domain/services/MatchEndService.ts';
import type { EliminationRecord } from '../../../src/domain/services/EliminationService.ts';

function stat(overrides: Partial<PlayerRoundStats> & { playerId: string }): PlayerRoundStats {
  return {
    alive: true,
    hp: 100,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    itemsCollected: 0,
    survivalTimeMs: 0,
    weaponsUsed: 0,
    ...overrides,
  };
}

function elim(
  overrides: Partial<EliminationRecord> & { playerId: string; order: number },
): EliminationRecord {
  return {
    killerId: null,
    weaponType: null,
    timestamp: 0,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

describe('MatchEndService', () => {
  let service: MatchEndService;

  beforeEach(() => {
    service = new MatchEndService();
  });

  describe('checkRoundEnd', () => {
    it('returns null when multiple players are alive', () => {
      const alive = [stat({ playerId: '1' }), stat({ playerId: '2' })];
      const eliminations = [elim({ playerId: '3', order: 1 })];

      const result = service.checkRoundEnd(alive, eliminations, new Map(), 0, 0, 1);

      expect(result).toBeNull();
    });

    it('returns last_standing result when one player is alive (threshold=1)', () => {
      const alive = [stat({ playerId: '1' })];
      const eliminations = [elim({ playerId: '2', order: 1 }), elim({ playerId: '3', order: 2 })];

      const result = service.checkRoundEnd(alive, eliminations, new Map(), 0, 0, 1);

      expect(result).not.toBeNull();
      expect(result!.winnerId).toBe('1');
      expect(result!.reason).toBe('last_standing');
      expect(result!.placements).toHaveLength(3);
      const winnerPlacement = result!.placements.find((p) => p.playerId === '1');
      expect(winnerPlacement!.placement).toBe(1);
    });

    it('returns null when one player is alive but threshold=0 (test scene)', () => {
      const alive = [stat({ playerId: '1' })];
      const eliminations = [elim({ playerId: '2', order: 1 })];

      const result = service.checkRoundEnd(alive, eliminations, new Map(), 0, 0, 0);

      expect(result).toBeNull();
    });

    it('returns null when check is disabled (threshold=-1)', () => {
      const alive = [stat({ playerId: '1' })];

      const result = service.checkRoundEnd(alive, [], new Map(), 0, 0, -1);

      expect(result).toBeNull();
    });

    it('returns simultaneous_death result when no players are alive but eliminations exist', () => {
      const eliminations = [elim({ playerId: '1', order: 1 }), elim({ playerId: '2', order: 2 })];

      const result = service.checkRoundEnd([], eliminations, new Map(), 0, 0, 1);

      expect(result).not.toBeNull();
      expect(result!.reason).toBe('simultaneous_death');
      expect(result!.winnerId).toBe('2');
      expect(result!.winnerId).toBe(result!.placements[0]!.playerId);
      expect(result!.placements).toHaveLength(2);
    });

    it('returns null when no players are alive and no eliminations', () => {
      const result = service.checkRoundEnd([], [], new Map(), 0, 0, 1);

      expect(result).toBeNull();
    });
  });

  describe('calculatePlacements', () => {
    it('ranks alive players above all eliminated players', () => {
      const alive = [stat({ playerId: '10' }), stat({ playerId: '20' })];
      const eliminations = [
        elim({ playerId: '30', order: 1 }),
        elim({ playerId: '40', order: 2 }),
        elim({ playerId: '50', order: 3 }),
      ];

      const placements = service.calculatePlacements(alive, eliminations);

      expect(placements).toHaveLength(5);
      const topTwoIds = [placements[0]!.playerId, placements[1]!.playerId];
      expect(topTwoIds).toContain('10');
      expect(topTwoIds).toContain('20');
      expect(placements[0]!.placement).toBe(1);
      expect(placements[1]!.placement).toBe(2);
      expect(placements[2]!.placement).toBe(3);
      expect(placements[3]!.placement).toBe(4);
      expect(placements[4]!.placement).toBe(5);
    });

    it('uses elimination order as tiebreaker: higher order places better', () => {
      const stats = [
        stat({ playerId: '1', alive: false, hp: 0 }),
        stat({ playerId: '2', alive: false, hp: 0 }),
      ];
      const eliminations = [elim({ playerId: '1', order: 1 }), elim({ playerId: '2', order: 2 })];

      const placements = service.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('2');
      expect(placements[1]!.playerId).toBe('1');
    });

    it('uses kills as tiebreaker when elimination order is the same', () => {
      const stats = [
        stat({ playerId: '1', alive: false, hp: 0, kills: 3 }),
        stat({ playerId: '2', alive: false, hp: 0, kills: 5 }),
      ];
      const eliminations = [elim({ playerId: '1', order: 1 }), elim({ playerId: '2', order: 1 })];

      const placements = service.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('2');
      expect(placements[1]!.playerId).toBe('1');
    });

    it('uses damage dealt as tiebreaker when kills are the same', () => {
      const stats = [
        stat({ playerId: '1', alive: false, hp: 0, kills: 2, damageDealt: 100 }),
        stat({ playerId: '2', alive: false, hp: 0, kills: 2, damageDealt: 250 }),
      ];
      const eliminations = [elim({ playerId: '1', order: 1 }), elim({ playerId: '2', order: 1 })];

      const placements = service.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('2');
      expect(placements[1]!.playerId).toBe('1');
    });

    it('uses survival time as tiebreaker when damage dealt is the same', () => {
      const stats = [
        stat({
          playerId: '1',
          alive: false,
          hp: 0,
          kills: 2,
          damageDealt: 100,
          survivalTimeMs: 5000,
        }),
        stat({
          playerId: '2',
          alive: false,
          hp: 0,
          kills: 2,
          damageDealt: 100,
          survivalTimeMs: 8000,
        }),
      ];
      const eliminations = [elim({ playerId: '1', order: 1 }), elim({ playerId: '2', order: 1 })];

      const placements = service.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('2');
      expect(placements[1]!.playerId).toBe('1');
    });

    it('uses lowest numeric player ID as final tiebreaker when all other stats are equal', () => {
      const stats = [
        stat({ playerId: '5', alive: false, hp: 0, kills: 0, damageDealt: 0, survivalTimeMs: 0 }),
        stat({ playerId: '2', alive: false, hp: 0, kills: 0, damageDealt: 0, survivalTimeMs: 0 }),
        stat({ playerId: '10', alive: false, hp: 0, kills: 0, damageDealt: 0, survivalTimeMs: 0 }),
      ];
      const eliminations = [
        elim({ playerId: '5', order: 1 }),
        elim({ playerId: '2', order: 1 }),
        elim({ playerId: '10', order: 1 }),
      ];

      const placements = service.calculatePlacements(stats, eliminations);

      expect(placements[0]!.playerId).toBe('2');
      expect(placements[1]!.playerId).toBe('5');
      expect(placements[2]!.playerId).toBe('10');
    });

    it('assigns sequential placements from 1 to N with no gaps', () => {
      const stats = [
        stat({ playerId: '1', alive: false, hp: 0 }),
        stat({ playerId: '2', alive: false, hp: 0 }),
        stat({ playerId: '3', alive: false, hp: 0 }),
        stat({ playerId: '4', alive: false, hp: 0 }),
        stat({ playerId: '5', alive: false, hp: 0 }),
      ];
      const eliminations = [
        elim({ playerId: '1', order: 5 }),
        elim({ playerId: '2', order: 4 }),
        elim({ playerId: '3', order: 3 }),
        elim({ playerId: '4', order: 2 }),
        elim({ playerId: '5', order: 1 }),
      ];

      const placements = service.calculatePlacements(stats, eliminations);

      expect(placements.map((p) => p.placement)).toEqual([1, 2, 3, 4, 5]);
    });

    it('converts survivalTicks to survivalTimeMs when survivalTimeMs is undefined', () => {
      const base = stat({ playerId: '1', alive: false, hp: 0, survivalTicks: 120 });
      const player: PlayerRoundStats = { ...base, survivalTimeMs: undefined as unknown as number };

      const placements = service.calculatePlacements([player], []);

      expect(placements[0]!.survivalTimeMs).toBe(120 * (1000 / 60));
    });
  });
});

import { describe, it, expect } from 'vitest';
import { Chest } from '../../../src/domain/entities/Chest.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { ChestRarity, WeaponType } from '@sector-battle/shared';

describe('Chest', () => {
  describe('state machine', () => {
    it('starts in CLOSED state', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      expect(chest.state).toBe('closed');
    });

    it('transitions CLOSED → OPENING → OPEN', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);

      const startResult = chest.startOpening('p1', 10, playerPos);
      expect(startResult.success).toBe(true);
      expect(chest.state).toBe('opening');
      expect(chest.openingPlayerId).toBe('p1');

      const tickResult = chest.tickOpening(0.5, playerPos);
      expect(tickResult.completed).toBe(true);
      expect(tickResult.interrupted).toBe(false);

      chest.completeOpening({ type: 'pistol', tier: ChestRarity.COMMON });
      expect(chest.state).toBe('open');
    });

    it('rejects opening an already OPEN chest', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);
      chest.tickOpening(0.5, playerPos);
      chest.completeOpening({ type: 'pistol', tier: ChestRarity.COMMON });

      expect(() => chest.startOpening('p2', 10, playerPos)).toThrow(
        "Invalid transition: cannot start opening from state 'open'",
      );
    });

    it('rejects opening an OPENING chest', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);

      expect(() => chest.startOpening('p2', 10, playerPos)).toThrow(
        "Invalid transition: cannot start opening from state 'opening'",
      );
    });
  });

  describe('interruption', () => {
    it('interrupts when player moves from start position', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);

      const movedPos = new Position(19, 0);
      const tickResult = chest.tickOpening(0.2, movedPos);
      expect(tickResult.interrupted).toBe(true);
      expect(tickResult.completed).toBe(false);
      expect(chest.state).toBe('closed');
      expect(chest.openingPlayerId).toBeNull();
    });

    it('resets progress on interruption', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);
      chest.tickOpening(0.3, startPos);

      const movedPos = new Position(19, 0);
      chest.tickOpening(0.1, movedPos);
      expect(chest.openingProgress).toBe(0);
    });

    it('can be opened again after interruption', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);
      const movedPos = new Position(19, 0);
      chest.tickOpening(0.2, movedPos);

      const newPos = new Position(10, 0);
      const result = chest.startOpening('p1', 10, newPos);
      expect(result.success).toBe(true);
    });
  });

  describe('0.5-second channel', () => {
    it('does not complete before 0.5 seconds', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);

      const tickResult = chest.tickOpening(0.49, playerPos);
      expect(tickResult.completed).toBe(false);
    });

    it('completes at exactly 0.5 seconds', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);

      const tickResult = chest.tickOpening(0.5, playerPos);
      expect(tickResult.completed).toBe(true);
    });

    it('accumulates progress across multiple ticks', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);

      expect(chest.tickOpening(0.1, playerPos).completed).toBe(false);
      expect(chest.tickOpening(0.1, playerPos).completed).toBe(false);
      expect(chest.tickOpening(0.1, playerPos).completed).toBe(false);
      expect(chest.tickOpening(0.1, playerPos).completed).toBe(false);
      expect(chest.tickOpening(0.1, playerPos).completed).toBe(true);
    });
  });

  describe('rejection reasons', () => {
    it('does NOT reject for inventory state (chest loot is a ground pickup, not inventory)', () => {
      // Regression: GDD §11.2 specifies chest loot spawns as a ground pickup
      // on an adjacent tile — inventory state is irrelevant to opening. The
      // previous inventory_full gate was unsanctioned and blocked valid opens.
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      const result = chest.startOpening('p1', 10, playerPos);
      expect(result.success).toBe(true);
      expect(chest.state).toBe('opening');
    });

    it('rejects with out_of_range', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(200, 0);
      const result = chest.startOpening('p1', 200, playerPos);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('out_of_range');
    });

    it('throws for already_open', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);
      expect(() => chest.startOpening('p2', 10, playerPos)).toThrow(
        "Invalid transition: cannot start opening from state 'opening'",
      );
    });
  });

  describe('tier distribution', () => {
    it('has correct distribution weights', () => {
      expect(Chest.TIER_DISTRIBUTION[ChestRarity.COMMON]).toBe(0.7);
      expect(Chest.TIER_DISTRIBUTION[ChestRarity.RARE]).toBe(0.2);
      expect(Chest.TIER_DISTRIBUTION[ChestRarity.EPIC]).toBe(0.08);
      expect(Chest.TIER_DISTRIBUTION[ChestRarity.LEGENDARY]).toBe(0.02);
    });

    it('weights sum to exactly 1.0', () => {
      const weights = Object.values(Chest.TIER_DISTRIBUTION);
      const sum = weights.reduce((s, w) => s + w, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    });

    it('weighted rolls produce correct distribution over 10000 samples', () => {
      const entries = Object.entries(Chest.TIER_DISTRIBUTION) as [string, number][];
      const totalWeight = entries.reduce((sum, [, w]) => sum + w, 0);
      const counts: Record<number, number> = {
        [ChestRarity.COMMON]: 0,
        [ChestRarity.RARE]: 0,
        [ChestRarity.EPIC]: 0,
        [ChestRarity.LEGENDARY]: 0,
      };

      const ROLLS = 10000;
      for (let i = 0; i < ROLLS; i++) {
        const roll = Math.random() * totalWeight;
        let cumulative = 0;
        for (const [key, weight] of entries) {
          cumulative += weight;
          if (roll < cumulative) {
            counts[Number(key)]++;
            break;
          }
        }
      }

      expect(counts[ChestRarity.COMMON] / ROLLS).toBeCloseTo(0.7, 1);
      expect(counts[ChestRarity.RARE] / ROLLS).toBeCloseTo(0.2, 1);
      expect(counts[ChestRarity.EPIC] / ROLLS).toBeCloseTo(0.08, 1);
      expect(counts[ChestRarity.LEGENDARY] / ROLLS).toBeCloseTo(0.02, 1);
    });
  });

  describe('static create', () => {
    it('creates chest with correct defaults', () => {
      const chest = Chest.create('c1', ChestRarity.RARE, new Position(100, 200));
      expect(chest.id).toBe('c1');
      expect(chest.tier).toBe(ChestRarity.RARE);
      expect(chest.position.x).toBe(100);
      expect(chest.position.y).toBe(200);
      expect(chest.state).toBe('closed');
      expect(chest.contents).toBeNull();
      expect(chest.openingPlayerId).toBeNull();
      expect(chest.openingProgress).toBe(0);
    });
  });

  describe('range validation (via startOpening)', () => {
    it('returns success when player is in range', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(30, 0);
      const result = chest.startOpening('p1', 30, playerPos);
      expect(result.success).toBe(true);
    });

    it('returns out_of_range when too far', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(200, 0);
      const result = chest.startOpening('p1', 200, playerPos);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('out_of_range');
    });

    it('returns success at exactly boundary range', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(192, 0);
      const result = chest.startOpening('p1', 192, playerPos);
      expect(result.success).toBe(true);
    });
  });

  describe('ChestOpening stationary check', () => {
    it('ChestOpening_stationaryCompletes: player stays still for 0.5s', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(10, 0);
      chest.startOpening('p1', 10, playerPos);

      const result = chest.tickOpening(0.5, playerPos);
      expect(result.completed).toBe(true);
      expect(result.interrupted).toBe(false);
      expect(chest.state).toBe('opening');
    });

    it('ChestOpening_moveCancels: player moves >8px from start position', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);
      chest.tickOpening(0.3, startPos);

      const movedPos = new Position(19, 0);
      const result = chest.tickOpening(0.1, movedPos);
      expect(result.completed).toBe(false);
      expect(result.interrupted).toBe(true);
      expect(chest.state).toBe('closed');
      expect(chest.openingPlayerId).toBeNull();
      expect(chest.openingProgress).toBe(0);
    });

    it('ChestOpening_tinyMoveTolerance: player moves exactly 1px continues', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);

      const slightlyMovedPos = new Position(11, 0);
      chest.tickOpening(0.3, slightlyMovedPos);
      expect(chest.state).toBe('opening');

      const result = chest.tickOpening(0.2, slightlyMovedPos);
      expect(result.completed).toBe(true);
    });

    it('ChestOpening_deathCancelsNotConsumed: interrupt resets chest for other player', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);
      chest.tickOpening(0.4, startPos);

      chest.interrupt();
      expect(chest.state).toBe('closed');
      expect(chest.openingPlayerId).toBeNull();
      expect(chest.openingProgress).toBe(0);

      const otherPos = new Position(5, 0);
      const result = chest.startOpening('p2', 5, otherPos);
      expect(result.success).toBe(true);
      expect(chest.openingPlayerId).toBe('p2');
    });

    it('ChestOpening_yAxisMoveCancels: player moves >8px on Y axis', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(10, 0);
      chest.startOpening('p1', 10, startPos);

      const movedPos = new Position(10, 9);
      const result = chest.tickOpening(0.1, movedPos);
      expect(result.interrupted).toBe(true);
      expect(chest.state).toBe('closed');
    });
  });

  describe('static constants', () => {
    it('INTERACTION_RANGE is 192', () => {
      expect(Chest.INTERACTION_RANGE).toBe(192);
    });

    it('OPENING_DURATION is 0.5', () => {
      expect(Chest.OPENING_DURATION).toBe(0.5);
    });
  });

  describe('opening progress with exact values', () => {
    it('tracks progress at 0.25s increments', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(0, 0);

      const startResult = chest.startOpening('p1', 20, playerPos);
      expect(startResult.success).toBe(true);
      expect(chest.state).toBe('opening');
      expect(chest.openingPlayerId).toBe('p1');
      expect(chest.openingProgress).toBe(0);

      const tick1 = chest.tickOpening(0.25, playerPos);
      expect(tick1.completed).toBe(false);
      expect(tick1.interrupted).toBe(false);
      expect(chest.openingProgress).toBe(0.25);

      const tick2 = chest.tickOpening(0.25, playerPos);
      expect(tick2.completed).toBe(true);
      expect(tick2.interrupted).toBe(false);
    });

    it('completeOpening sets contents with WeaponType.DAGGER', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const playerPos = new Position(0, 0);
      chest.startOpening('p1', 20, playerPos);
      chest.tickOpening(0.5, playerPos);
      chest.completeOpening({ type: WeaponType.DAGGER, tier: ChestRarity.COMMON });

      expect(chest.state).toBe('open');
      expect(chest.contents).not.toBeNull();
      expect(chest.contents!.type).toBe(WeaponType.DAGGER);
    });

    it('interrupts when player moves >8 from start and chest is saved', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(0, 0);
      chest.startOpening('p1', 20, startPos);

      const tickResult = chest.tickOpening(0.1, new Position(9, 0));
      expect(tickResult.completed).toBe(false);
      expect(tickResult.interrupted).toBe(true);
      expect(chest.state).toBe('closed');
      expect(chest.openingPlayerId).toBeNull();
    });

    it('can be re-opened after interruption', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const startPos = new Position(0, 0);
      chest.startOpening('p1', 20, startPos);
      chest.tickOpening(0.1, new Position(9, 0));

      const result = chest.startOpening('p1', 20, startPos);
      expect(result.success).toBe(true);
    });
  });

  describe('out of range', () => {
    it('rejects when playerDistance > 192', () => {
      const chest = Chest.create('c1', ChestRarity.COMMON, new Position(0, 0));
      const result = chest.startOpening('p1', 200, new Position(200, 0));
      expect(result.success).toBe(false);
      expect(result.reason).toBe('out_of_range');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from '../../src/ai/BotContext.ts';
import {
  flagLooters,
  collectOpeningPlayerIds,
  flagSpawnPrey,
  deriveEngagement,
  populateHotBarrels,
  vulnerabilityScore,
} from '../../src/ai/IntentSignals.ts';

/** Minimal BotContext-shaped object. IntentSignals only touches .enemies,
 *  .hotBarrels, .x, .y, .tick — so a partial cast is safe and keeps the test
 *  focused on the signal logic, not BotContext construction. */
function makeCtx(enemies: EnemyInfo[], tick = 0, x = 0, y = 0): BotContext {
  return {
    enemies,
    hotBarrels: [],
    tick,
    x,
    y,
  } as unknown as BotContext;
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 100,
    health: 100,
    maxHealth: 100,
    weaponType: WeaponType.FISTS,
    weaponTier: 0,
    isInWindup: false,
    windupRemaining: 0,
    lastAttackTick: -9999,
    facingAngle: 0,
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...overrides,
  };
}

describe('IntentSignals', () => {
  describe('collectOpeningPlayerIds / flagLooters', () => {
    it('collects ids of players opening chests', () => {
      const ids = collectOpeningPlayerIds((cb) => {
        cb({ openingPlayerId: 'p1' });
        cb({ openingPlayerId: 'p2' });
        cb({ openingPlayerId: '' }); // empty id ignored
      });
      expect(ids.has('p1')).toBe(true);
      expect(ids.has('p2')).toBe(true);
      expect(ids.size).toBe(2);
    });

    it('flags an enemy whose id is in the opening set', () => {
      const e = enemy({ id: 'looter' });
      const ctx = makeCtx([e]);
      flagLooters(ctx, new Set(['looter']));
      expect(e.isLooting).toBe(true);
    });

    it('does not flag an enemy not in the opening set', () => {
      const e = enemy({ id: 'fighter' });
      const ctx = makeCtx([e]);
      flagLooters(ctx, new Set(['someone_else']));
      expect(e.isLooting).toBe(false);
    });
  });

  describe('flagSpawnPrey', () => {
    it('computes ticks until invuln clears from the expiry map', () => {
      const e = enemy({ id: 'spawn', isFreshSpawn: true });
      const ctx = makeCtx([e], /*tick*/ 100);
      flagSpawnPrey(ctx, 100, new Map([['spawn', 130]]));
      expect(e.spawnInvulnTicksLeft).toBe(30);
    });

    it('clamps to 0 when already past expiry', () => {
      const e = enemy({ id: 'spawn', isFreshSpawn: true });
      const ctx = makeCtx([e], 200);
      flagSpawnPrey(ctx, 200, new Map([['spawn', 150]]));
      expect(e.spawnInvulnTicksLeft).toBe(0);
    });

    it('sets 0 for non-fresh-spawn enemies', () => {
      const e = enemy({ id: 'normal', isFreshSpawn: false });
      const ctx = makeCtx([e], 0);
      flagSpawnPrey(ctx, 0, new Map());
      expect(e.spawnInvulnTicksLeft).toBe(0);
    });
  });

  describe('deriveEngagement (third-party signal)', () => {
    it('marks an enemy as engaged when recently attacking AND facing another enemy', () => {
      // A at (0,0), facing +x (angle 0). B at (200,0) — directly in front of A.
      const a = enemy({ id: 'a', x: 0, y: 0, facingAngle: 0, lastAttackTick: 0 });
      const b = enemy({ id: 'b', x: 200, y: 0 });
      const ctx = makeCtx([a, b], /*tick*/ 30); // 30 ticks since A's attack < 60 window
      deriveEngagement(ctx);
      expect(a.engagedTargetId).toBe('b');
    });

    it('does NOT mark engagement if the attack is stale', () => {
      const a = enemy({ id: 'a', x: 0, y: 0, facingAngle: 0, lastAttackTick: 0 });
      const b = enemy({ id: 'b', x: 200, y: 0 });
      const ctx = makeCtx([a, b], /*tick*/ 100); // 100 ticks since attack > 60 window
      deriveEngagement(ctx);
      expect(a.engagedTargetId).toBeNull();
    });

    it('does NOT mark engagement if A is not facing B', () => {
      // A facing +x, B behind A at (-200, 0).
      const a = enemy({ id: 'a', x: 0, y: 0, facingAngle: 0, lastAttackTick: 0 });
      const b = enemy({ id: 'b', x: -200, y: 0 });
      const ctx = makeCtx([a, b], 10);
      deriveEngagement(ctx);
      expect(a.engagedTargetId).toBeNull();
    });

    it('does NOT mark engagement if B is too far away', () => {
      const a = enemy({ id: 'a', x: 0, y: 0, facingAngle: 0, lastAttackTick: 0 });
      const b = enemy({ id: 'b', x: 1000, y: 0 }); // > NEAR_DIST(600)
      const ctx = makeCtx([a, b], 10);
      deriveEngagement(ctx);
      expect(a.engagedTargetId).toBeNull();
    });
  });

  describe('populateHotBarrels', () => {
    it('marks a barrel in blast range of an enemy as hot', () => {
      const enemyAt = enemy({ id: 'e', x: 100, y: 0 }); // 100px from barrel at origin
      const ctx = makeCtx([enemyAt], 0, 0, 0);
      const barrels = [{ x: 0, y: 0 }]; // within 256px blast of enemy
      populateHotBarrels(ctx, (cb) => barrels.forEach(cb));
      expect(ctx.hotBarrels.length).toBe(1);
      expect(ctx.hotBarrels[0]).toMatchObject({ x: 0, y: 0 });
    });

    it('does not mark a barrel with no enemy in blast range', () => {
      const enemyAt = enemy({ id: 'e', x: 1000, y: 0 }); // far from barrel
      const ctx = makeCtx([enemyAt], 0, 0, 0);
      populateHotBarrels(ctx, (cb) => [{ x: 0, y: 0 }].forEach(cb));
      expect(ctx.hotBarrels.length).toBe(0);
    });

    it('skips entirely when no enemies are present', () => {
      const ctx = makeCtx([], 0, 0, 0);
      let barrelCalls = 0;
      populateHotBarrels(ctx, () => {
        barrelCalls++;
      });
      expect(ctx.hotBarrels.length).toBe(0);
      expect(barrelCalls).toBe(0); // early-returns before iterating barrels
    });
  });

  describe('vulnerabilityScore', () => {
    it('returns 0 for a barriered (invulnerable) enemy', () => {
      expect(vulnerabilityScore(enemy({ barrierActive: true }))).toBe(0);
    });

    it('returns ~0.9 for a looter (committed, locked out)', () => {
      expect(vulnerabilityScore(enemy({ isLooting: true }))).toBeGreaterThanOrEqual(0.9);
    });

    it('returns high for a fresh-spawn enemy about to clear invuln', () => {
      const e = enemy({ isFreshSpawn: true, spawnInvulnTicksLeft: 3 });
      expect(vulnerabilityScore(e)).toBeGreaterThanOrEqual(0.9);
    });

    it('returns low for a fresh-spawn enemy with long invuln remaining', () => {
      const e = enemy({ isFreshSpawn: true, spawnInvulnTicksLeft: 60 });
      const score = vulnerabilityScore(e);
      expect(score).toBeGreaterThanOrEqual(0.1);
      expect(score).toBeLessThan(0.3);
    });

    it('rewards low-HP kill-secure targets', () => {
      const lowHp = enemy({ health: 10, maxHealth: 100 });
      const fullHp = enemy({ health: 100, maxHealth: 100 });
      expect(vulnerabilityScore(lowHp)).toBeGreaterThan(vulnerabilityScore(fullHp));
    });

    it('rewards third-party targets (engagedTargetId set)', () => {
      const thirdPartying = enemy({ engagedTargetId: 'other', lastAttackTick: 0 });
      const lone = enemy({ engagedTargetId: null });
      expect(vulnerabilityScore(thirdPartying)).toBeGreaterThan(vulnerabilityScore(lone));
    });

    it('rewards fists-only prey', () => {
      const fists = enemy({ weaponType: WeaponType.FISTS, weaponTier: 0 });
      const armed = enemy({ weaponType: WeaponType.LONG_SWORD, weaponTier: 2 });
      expect(vulnerabilityScore(fists)).toBeGreaterThan(vulnerabilityScore(armed));
    });
  });
});

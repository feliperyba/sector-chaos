import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, type EnemyInfo } from '../../../src/ai/BotContext.ts';
import { selectTarget } from '../../../src/ai/BotTargeting.ts';
import { LOCK_FRESHNESS_TICKS } from '../../../src/ai/belief/BeliefConfig.ts';
import { EnemyBelief } from '../../../src/ai/belief/BeliefTypes.ts';

/**
 * Target locks gate on BELIEF FRESHNESS (bot-ai-v2 ticket 05, DEC-003 /
 * AUDIT §10c.6): selectTarget honors a lock only while the bot's belief
 * about the target is fresh, and the scoring loop skips enemies whose
 * beliefs went stale — the 3-tick-stale scan leftovers can no longer hold a
 * lock or win a re-score.
 */

function makeCtx(): BotContext {
  const ctx = new BotContext('target-belief-bot');
  ctx.tick = 100;
  ctx.x = 0;
  ctx.y = 0;
  ctx.weapons = [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }];
  ctx.activeSlot = 0;
  return ctx;
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 300,
    y: 0,
    vx: 0,
    vy: 0,
    distance: 300,
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

/** A fresh (this-tick) seen belief for an enemy id. */
function freshBelief(ctx: BotContext, id: string): void {
  ctx.beliefs.set(id, new EnemyBelief(300, 0, 0, 0, ctx.tick, 0.9, 'seen'));
}

describe('selectTarget belief-freshness gating (DEC-003 / AUDIT §10c.6)', () => {
  it('honors a lock whose belief is fresh (the normal 1v1 case)', () => {
    const ctx = makeCtx();
    ctx.enemies = [enemy()];
    freshBelief(ctx, 'e1');
    ctx.targetId = 'e1';
    ctx.targetLockTick = ctx.tick;
    const target = selectTarget(ctx);
    expect(target).not.toBeNull();
    expect(target!.id).toBe('e1'); // the locked enemy, short-circuited
  });

  it('does NOT honor a lock whose belief went stale — the stale-scan vulnerability lock is dead', () => {
    const ctx = makeCtx();
    ctx.enemies = [enemy(), enemy({ id: 'e2', x: 500, distance: 500, health: 40 })];
    // e1's belief is older than LOCK_FRESHNESS_TICKS (the scan-cycle
    // leftover scenario); e2's belief is fresh.
    ctx.beliefs.set(
      'e1',
      new EnemyBelief(300, 0, 0, 0, ctx.tick - LOCK_FRESHNESS_TICKS - 1, 0.9, 'seen'),
    );
    freshBelief(ctx, 'e2');
    ctx.targetId = 'e1';
    ctx.targetLockTick = ctx.tick;
    const target = selectTarget(ctx);
    // The lock did not short-circuit: the re-score skipped the stale e1 and
    // picked the fresh, low-HP e2 instead.
    expect(target!.id).toBe('e2');
    expect(ctx.targetId).toBe('e2');
  });

  it('the scoring loop skips enemies with stale beliefs entirely', () => {
    const ctx = makeCtx();
    // Only a stale-believed enemy exists: no target can be picked at all.
    ctx.enemies = [enemy()];
    ctx.beliefs.set('e1', new EnemyBelief(300, 0, 0, 0, ctx.tick - 10, 0.9, 'seen'));
    expect(selectTarget(ctx)).toBeNull();
    expect(ctx.targetId).toBeNull();
  });

  it('an enemy with NO belief is not targetable (believed-world gate)', () => {
    const ctx = makeCtx();
    ctx.enemies = [enemy()];
    // No belief ever written (defensive shape — production writes beliefs on
    // every scan before executors run).
    expect(selectTarget(ctx)).toBeNull();
  });
});

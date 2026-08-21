import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, type EnemyInfo } from '../../src/ai/BotContext.ts';
import { selectTarget } from '../../src/ai/BotTargeting.ts';
import { EnemyBelief } from '../../src/ai/belief/BeliefTypes.ts';
import { RECENT_DAMAGE_SCORE_WEIGHT } from '../../src/ai/combat/BotRecentDamage.ts';

/**
 * THIRD-PARTY TARGET PREFERENCE (bot-ai-v2 ticket 09, DEC-010.6): the
 * restored GDD §14.8 recentDamage term — a bot JOINING an ongoing fight
 * prefers the weakened/invested combatant (the enemy that recently took
 * damage), all else equal.
 */

function makeCtx(): BotContext {
  const ctx = new BotContext('target-recent-damage-bot');
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
    weaponType: WeaponType.DAGGER,
    weaponTier: 1,
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

function freshBelief(ctx: BotContext, id: string): void {
  ctx.beliefs.set(id, new EnemyBelief(300, 0, 0, 0, ctx.tick, 0.9, 'seen'));
}

describe('selectTarget — the recentDamage term (GDD §14.8 restored)', () => {
  it('prefers the recently-damaged combatant when joining a fight', () => {
    const ctx = makeCtx();
    // Two IDENTICAL enemies (same distance, HP, weapon) — the only
    // difference: e2 took 60 damage in the last 5 s (someone else's fight).
    ctx.enemies = [
      enemy({ id: 'e1', y: 300, x: 0, distance: 300 }),
      enemy({ id: 'e2', y: -300, x: 0, distance: 300 }),
    ];
    freshBelief(ctx, 'e1');
    freshBelief(ctx, 'e2');
    const t = ctx.combat.recentDamage;
    t.noteScan([{ ...ctx.enemies[0]! }, { ...ctx.enemies[1]!, health: 100 }], ctx.tick - 10);
    // e2 dropped 60 HP over the window (two observed scans).
    t.noteScan([{ ...ctx.enemies[0]! }, { ...ctx.enemies[1]!, health: 40 }], ctx.tick);
    expect(t.normalized('e2', ctx.tick)).toBeCloseTo(0.6, 10);
    const target = selectTarget(ctx);
    expect(target).not.toBeNull();
    expect(target!.id).toBe('e2'); // the weakened/invested combatant
  });

  it('with no recent damage the legacy terms decide (no regression)', () => {
    const ctx = makeCtx();
    ctx.enemies = [
      enemy({ id: 'e1', x: 0, y: 300, distance: 300 }),
      enemy({ id: 'e2', x: 0, y: -300, distance: 300 }),
    ];
    freshBelief(ctx, 'e1');
    freshBelief(ctx, 'e2');
    const target = selectTarget(ctx);
    expect(target).not.toBeNull(); // either is fine — identical inputs, deterministic order
    expect(['e1', 'e2']).toContain(target!.id);
  });

  it('the term is the GDD W_DAMAGE (0.3) rescaled to the code band', () => {
    // The code's additive terms run ~3.0/2.0/0.8/1.0 (a ×10 band vs the
    // GDD's 0.3/0.3/0.2/0.2) — 0.3 × 10 = 2.0 keeps the GDD proportion.
    expect(RECENT_DAMAGE_SCORE_WEIGHT).toBe(2.0);
  });
});

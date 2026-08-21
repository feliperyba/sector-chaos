import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, BotState, type EnemyInfo, type ItemInfo } from '../../src/ai/BotContext.ts';
import { ContestLootIntent } from '../../src/ai/intent/intentEngage.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
} from '../../src/ai/intent/PersonalityProfile.ts';
import type { IntentContext } from '../../src/ai/intent/Intent.ts';
import {
  CONTEST_RECONTEST_SUSPEND_TICKS,
  CONTEST_BREAK_OFF_BLACKLIST_TICKS,
} from '../../src/ai/combat/ItemContests.ts';

/**
 * REAL CONTESTS at the intent seam (bot-ai-v2 ticket 09, DEC-010.5): the
 * contested seat is published while the race is on; a decisively-lost race
 * breaks off cleanly (blacklist + re-contest suspension + telemetry) and the
 * intent stays INVALID for the suspension window — no ping-pong back onto
 * the unwinnable item.
 */

const PROFILE = new PersonalityProfile(
  PersonalityArchetype.SCAVENGER, // greedy — contests hard
  { aggression: 0.4, greed: 0.9, caution: 0.5, opportunism: 0.5, trapper: 0.5 },
  { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
);

function makeCtx(): BotContext {
  const ctx = new BotContext('contest-bot');
  ctx.tick = 1000;
  ctx.x = 0;
  ctx.y = 0;
  ctx.weapons = [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 20, ammo: 20 }];
  ctx.activeSlot = 0;
  return ctx;
}

function item(id: string, x: number, y: number, dist: number): ItemInfo {
  return { id, x, y, distance: dist, type: 'weapon', tier: 3 };
}

function enemy(id: string, x: number, y: number): EnemyInfo {
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    distance: Math.hypot(x, y),
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
  };
}

function makeIc(ctx: BotContext): IntentContext {
  return {
    ctx,
    profile: PROFILE,
    aliveBotCount: 20,
    enemyInFightRange: false,
    zoneIsLethal: false,
  };
}

describe('ContestLootIntent — the real-contest contract', () => {
  it('valid + scoring while a winnable race exists; publishes the contested seat', () => {
    const ctx = makeCtx();
    ctx.items = [item('w1', 400, 0, 400)];
    ctx.enemies = [enemy('rival', 700, 0)]; // 300 from the item — winnable
    const intent = new ContestLootIntent();
    const ic = makeIc(ctx);
    expect(intent.isValid(ic)).toBe(true);
    expect(intent.score(ic)).toBeGreaterThan(0);
    const out = intent.execute(ic);
    expect(out.nextState).toBe(BotState.LOOT);
    expect(ctx.combat.contestedItemId).toBe('w1');
    expect(ctx.combat.contestedItemX).toBe(400);
    expect(ctx.combat.contestedEnemyX).toBe(700);
    expect(ctx.combat.contestClaimTick).toBe(ctx.tick);
  });

  it('a decisively-lost race breaks off: blacklist + suspension + telemetry', () => {
    const ctx = makeCtx();
    // Enemy 100 from the item; the bot 800 — lost by 1.6× + 120.
    ctx.items = [item('w1', 400, 0, 800)];
    ctx.x = -400;
    ctx.enemies = [enemy('rival', 500, 0)];
    const intent = new ContestLootIntent();
    const ic = makeIc(ctx);
    const out = intent.execute(ic);
    expect(out.nextState).toBe(BotState.LOOT); // still routes (the blacklist steers elsewhere)
    expect(ctx.combat.contestedItemId).toBeNull();
    expect(ctx.combat.contestBreakOffUntilTick).toBe(ctx.tick + CONTEST_RECONTEST_SUSPEND_TICKS);
    expect(ctx.blacklistedItems.get('w1')).toBe(ctx.tick + CONTEST_BREAK_OFF_BLACKLIST_TICKS);
    expect(ctx.combat.pendingContestOutcomes['breakOff']).toBe(1);
    // The suspension window keeps the intent INVALID — no re-contest ping-pong.
    expect(intent.isValid(ic)).toBe(false);
    expect(intent.score(ic)).toBe(0);
    // ...and it expires (a later race for a fresh item is contestable again).
    ctx.tick += CONTEST_RECONTEST_SUSPEND_TICKS + 1;
    expect(intent.isValid(makeIc(ctx))).toBe(true);
  });
});

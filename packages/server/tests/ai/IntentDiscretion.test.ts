import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import { BotContext, BotState, type EnemyInfo } from '../../src/ai/BotContext.ts';
import { RetreatAndResetIntent } from '../../src/ai/intent/intentSurvival.ts';
import { IntentSelector } from '../../src/ai/intent/IntentSelector.ts';
import { buildPhase2Intents } from '../../src/ai/intent/intents.ts';
import { IntentId, type IntentContext } from '../../src/ai/intent/Intent.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
} from '../../src/ai/intent/PersonalityProfile.ts';
import type { StimulusScanView } from '../../src/ai/stimulus/StimulusScan.ts';
import { DISENGAGE_SCORE } from '../../src/ai/combat/DiscretionTables.ts';

/**
 * ENGAGEMENT DISCRETION at the intent seam (bot-ai-v2 ticket 09, DEC-010.3):
 * a fired trigger makes RETREAT_AND_RESET win the selection (routing to the
 * navigated break-line retreat via BotState.RETREAT), stamps the episode
 * once (cooldown), and the hold clause keeps it valid through trigger
 * flicker.
 */

const PROFILE = new PersonalityProfile(
  PersonalityArchetype.DUELIST,
  { aggression: 0.6, greed: 0.5, caution: 0.4, opportunism: 0.5, trapper: 0.5 },
  { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
);

function makeCtx(): BotContext {
  const ctx = new BotContext('discretion-bot');
  ctx.tick = 1000;
  ctx.x = 0;
  ctx.y = 0;
  ctx.health = 100;
  ctx.maxHealth = 100;
  ctx.weapons = [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 20, ammo: 20 }];
  ctx.activeSlot = 0;
  return ctx;
}

function enemy(id: string, overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id,
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
    facingAngle: Math.PI,
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...overrides,
  };
}

function makeIc(ctx: BotContext, o: Partial<IntentContext> = {}): IntentContext {
  return {
    ctx,
    profile: PROFILE,
    aliveBotCount: 20,
    enemyInFightRange: true,
    zoneIsLethal: false,
    ...o,
  };
}

const EMPTY_SCAN: StimulusScanView = {
  entries: [],
  strongestByType: {},
  heardFightX: 0,
  heardFightY: 0,
  heardFightTick: -9999,
};

/** Two attackers + the target = the outnumbered trigger. */
function outnumberedCtx(): BotContext {
  const ctx = makeCtx();
  ctx.enemies = [
    enemy('a', { engagedTargetId: ctx.playerId }),
    enemy('b', { x: 350, lastAttackTick: ctx.tick - 10, facingAngle: Math.PI }),
  ];
  ctx.nearestEnemy = ctx.enemies[0]!;
  ctx.targetId = 'a';
  return ctx;
}

describe('RetreatAndResetIntent — the discretion fold', () => {
  it('a fired trigger makes the retreat valid with the cause score floor', () => {
    const ctx = outnumberedCtx();
    const intent = new RetreatAndResetIntent();
    const ic = makeIc(ctx, { stimulusScan: EMPTY_SCAN });
    expect(intent.isValid(ic)).toBe(true);
    expect(intent.score(ic)).toBe(DISENGAGE_SCORE.outnumbered);
  });

  it('execute() routes to BotState.RETREAT (the break-line retreat) and stamps once', () => {
    const ctx = outnumberedCtx();
    const intent = new RetreatAndResetIntent();
    const ic = makeIc(ctx, { stimulusScan: EMPTY_SCAN });
    const out = intent.execute(ic);
    expect(out.nextState).toBe(BotState.RETREAT);
    expect(ctx.combat.lastDisengageTick).toBe(ctx.tick);
    expect(ctx.combat.lastDisengageCause).toBe('outnumbered');
    expect(ctx.combat.pendingDisengages['outnumbered']).toBe(1);
    // The cooldown bars re-stamping on the next selected tick.
    ctx.tick += 1;
    intent.execute(makeIc(ctx, { stimulusScan: EMPTY_SCAN }));
    expect(ctx.combat.pendingDisengages['outnumbered']).toBe(1);
  });

  it('the hold clause keeps the retreat valid through a one-tick trigger flicker', () => {
    const ctx = outnumberedCtx();
    const intent = new RetreatAndResetIntent();
    intent.execute(makeIc(ctx, { stimulusScan: EMPTY_SCAN })); // stamp
    ctx.state = BotState.RETREAT;
    // The trigger clears for one tick (attackers' flags aged out)...
    ctx.enemies[1]!.lastAttackTick = -9999;
    ctx.enemies[0]!.engagedTargetId = null;
    const flickerIc = makeIc(ctx, { stimulusScan: EMPTY_SCAN });
    // ...but inside the cooldown window the retreat HOLDS (no ping-pong).
    expect(intent.isValid(flickerIc)).toBe(true);
    expect(intent.score(flickerIc)).toBe(0.6);
  });

  it('a healthy 1v1 with a stocked weapon does NOT disengage (no passivity collapse)', () => {
    const ctx = makeCtx();
    ctx.enemies = [enemy('a')];
    ctx.nearestEnemy = ctx.enemies[0]!;
    ctx.targetId = 'a';
    const intent = new RetreatAndResetIntent();
    const ic = makeIc(ctx, { stimulusScan: EMPTY_SCAN });
    // Legacy decision for a full-HP DUELIST above the floor: invalid.
    expect(intent.isValid(ic)).toBe(false);
    expect(intent.score(ic)).toBe(0);
  });
});

describe('IntentSelector — the full pipeline routes the trigger to RETREAT', () => {
  it('an outnumbered armed bot selects RETREAT_AND_RESET over DUEL', () => {
    const ctx = outnumberedCtx();
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(makeIc(ctx, { stimulusScan: EMPTY_SCAN }));
    expect(result.intentId).toBe(IntentId.RETREAT_AND_RESET);
  });
});

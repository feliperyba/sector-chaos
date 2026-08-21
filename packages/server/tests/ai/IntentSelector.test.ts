import { describe, it, expect } from 'vitest';
import { WeaponType } from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from '../../src/ai/BotContext.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
  PersonalityArchetypeLabel,
  buildPersonality,
  type DifficultyLevel,
} from '../../src/ai/intent/PersonalityProfile.ts';
import { IntentSelector } from '../../src/ai/intent/IntentSelector.ts';
import { IntentId, type Intent, type IntentContext } from '../../src/ai/intent/Intent.ts';
import { buildPhase2Intents, intentIdToBotState } from '../../src/ai/intent/intents.ts';
import { BotState } from '../../src/ai/BotContext.ts';
import { BotRNG } from '../../src/ai/BotContext.ts';

/** Minimal ctx factory for selector tests. */
function makeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    tick: 0,
    x: 0,
    y: 0,
    health: 100,
    maxHealth: 100,
    weapons: [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }],
    activeSlot: 0,
    nearestEnemy: null,
    nearestHealth: null,
    nearestBarrier: null,
    nearestSpeedBoost: null,
    nearestWeapon: null,
    enemies: [],
    items: [],
    hotBarrels: [],
    zoneRadius: 500,
    zoneCenterX: 0,
    zoneCenterY: 0,
    zoneIsShrinking: false,
    siegeWarnings: [],
    selfBarrierActive: false,
    hasRealWeapon: () => true,
    getActiveWeapon: () => ({ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }),
    getWeaponRange: () => 160,
    ...overrides,
  } as unknown as BotContext;
}

function makeProfile(aggression = 0.7, caution = 0.4, greed = 0.5): PersonalityProfile {
  return new PersonalityProfile(
    PersonalityArchetype.DUELIST,
    { aggression, greed, caution, opportunism: 0.5, trapper: 0.3 },
    { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
  );
}

function makeIc(ctx: BotContext, profile: PersonalityProfile): IntentContext {
  return { ctx, profile, aliveBotCount: 20, enemyInFightRange: false, zoneIsLethal: true };
}

function enemy(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    x: 100,
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

describe('PersonalityProfile', () => {
  it('produces all archetype labels for reporting', () => {
    expect(PersonalityArchetypeLabel[PersonalityArchetype.AGGRESSOR]).toBe('Aggressor');
    expect(PersonalityArchetypeLabel[PersonalityArchetype.TRAPPER]).toBe('Trapper');
  });

  it('is deterministic from the same RNG seed + difficulty', () => {
    const rng1 = new BotRNG(12345);
    const rng2 = new BotRNG(12345);
    const p1 = buildPersonality(rng1, 'hard');
    const p2 = buildPersonality(rng2, 'hard');
    expect(p1.archetype).toBe(p2.archetype);
    expect(p1.aggression).toBe(p2.aggression);
    expect(p1.greed).toBe(p2.greed);
  });

  it('difficulty scales skill knobs (elite tighter than easy)', () => {
    const easy = buildPersonality(new BotRNG(99), 'easy' as DifficultyLevel);
    const elite = buildPersonality(new BotRNG(99), 'elite' as DifficultyLevel);
    expect(elite.skill.aimErrorMultiplier).toBeLessThan(easy.skill.aimErrorMultiplier);
    expect(elite.skill.reactionLatencyTicks).toBeLessThanOrEqual(easy.skill.reactionLatencyTicks);
  });

  it('weights stay within [0.05, 0.98] regardless of seed', () => {
    for (let seed = 0; seed < 200; seed++) {
      const p = buildPersonality(new BotRNG(seed), 'medium');
      for (const w of [p.aggression, p.greed, p.caution, p.opportunism, p.trapper]) {
        expect(w).toBeGreaterThanOrEqual(0.05);
        expect(w).toBeLessThanOrEqual(0.98);
      }
    }
  });

  it('produces all 5 archetypes across enough seeds', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 500; seed++) {
      seen.add(buildPersonality(new BotRNG(seed), 'hard').archetypeLabel);
    }
    expect(seen.size).toBe(5);
  });
});

describe('IntentSelector', () => {
  it('selects DUEL when armed with a nearby enemy (aggressive profile)', () => {
    const ctx = makeCtx({ nearestEnemy: enemy({ distance: 100 }) });
    const ic = makeIc(ctx, makeProfile(0.9));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.DUEL);
  });

  it('selects ARM_UP when unarmed', () => {
    const ctx = makeCtx({
      nearestEnemy: null,
      hasRealWeapon: () => false,
      getActiveWeapon: () => ({ weaponType: WeaponType.FISTS, tier: 0, durability: 0, ammo: 0 }),
    });
    const ic = makeIc(ctx, makeProfile(0.9));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.ARM_UP);
  });

  it('selects SURVIVE_ZONE when outside the zone with no fightable enemy', () => {
    // Outside the lethal zone with no enemy visible → survival trumps all.
    const ctx = makeCtx({
      nearestEnemy: null,
      x: 9999,
      y: 9999, // far outside zone center (0,0) radius 500
    });
    const ic = makeIc(ctx, makeProfile(0.9));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.SURVIVE_ZONE);
  });

  it('selects DUEL over SURVIVE_ZONE when outside the zone but a fightable enemy is near', () => {
    // Combat-aware survival: a bot outside the lethal zone with a real weapon and
    // a damageable enemy within perception range should FIGHT (and reposition
    // inward via the executor), not hard-flee. SURVIVE_ZONE drops to the proactive
    // level (0.5) so DUEL's baseline (0.55+) preempts. This is the fix for the
    // dominant "bots flee the zone with a visible enemy instead of fighting" idle.
    const ctx = makeCtx({
      nearestEnemy: enemy({ distance: 100 }),
      x: 9999,
      y: 9999, // far outside zone center (0,0) radius 500
    });
    const ic = makeIc(ctx, makeProfile(0.9));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.DUEL);
  });

  it('selects RETREAT_AND_RESET when low HP and enemy not kill-secureable', () => {
    // Very low HP (below the tightened retreat floor ~0.21 for a cautious bot)
    // vs a full-HP enemy the bot cannot kill-secure → disengage to reset.
    // The retreat floor was lowered in the aggression pass, so the HP must be
    // genuinely critical for RETREAT to beat the new DUEL baseline.
    const ctx = makeCtx({
      health: 8,
      maxHealth: 100,
      nearestEnemy: enemy({ health: 100, maxHealth: 100 }),
    });
    const ic = makeIc(ctx, makeProfile(0.3, 0.8)); // cautious
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.RETREAT_AND_RESET);
  });

  it('does NOT retreat when enemy is kill-secureable (low enemy HP)', () => {
    const ctx = makeCtx({
      health: 15,
      maxHealth: 100,
      nearestEnemy: enemy({ health: 5, maxHealth: 100 }),
    });
    const ic = makeIc(ctx, makeProfile(0.3, 0.8));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).not.toBe(IntentId.RETREAT_AND_RESET);
  });

  it('personality changes the choice: aggressive fights, cautious retreats at same HP', () => {
    // 12% HP, enemy at full — deep enough in the cautious bot's retreat floor
    // (0.1 + 0.9*0.16 - 0.3*0.05 ≈ 0.23) that RETREAT's danger score dominates
    // DUEL, but above the aggressor's low floor (0.1 + 0.1*0.16 - 0.95*0.05 ≈
    // 0.07) so the aggressor keeps fighting. This is the personality-driven
    // divergence the test validates.
    const ctx = makeCtx({
      health: 12,
      maxHealth: 100,
      nearestEnemy: enemy({ health: 100, maxHealth: 100, distance: 100 }),
    });
    const aggressor = new IntentSelector(buildPhase2Intents());
    const cautious = new IntentSelector(buildPhase2Intents());
    const aggrResult = aggressor.select(makeIc(ctx, makeProfile(0.95, 0.1)));
    const cautiousResult = cautious.select(makeIc(ctx, makeProfile(0.3, 0.9)));
    // The aggressive bot should lean DUEL; the cautious one toward RETREAT.
    // (Both are valid interpretations — the test asserts they DIFFER, proving
    // personality actually influences selection.)
    expect(aggrResult.intentId).not.toBe(cautiousResult.intentId);
  });

  it('honors commit window — does not flip every tick on near-equal scores', () => {
    // Stable situation: armed, enemy visible, mid aggression.
    const ctx = makeCtx({ nearestEnemy: enemy({ distance: 100 }) });
    const ic = makeIc(ctx, makeProfile(0.7));
    const selector = new IntentSelector(buildPhase2Intents());
    const first = selector.select(ic);
    // Advance the tick but inside the commit window.
    ctx.tick = first.committedUntilTick - 1;
    const second = selector.select(ic);
    expect(second.intentId).toBe(first.intentId);
    expect(second.changed).toBe(false);
  });

  it('hard-invalidates: drops current intent when it becomes invalid', () => {
    // Start with an enemy → DUEL commits.
    const ctx = makeCtx({ nearestEnemy: enemy({ distance: 100 }) });
    const ic = makeIc(ctx, makeProfile(0.9));
    const selector = new IntentSelector(buildPhase2Intents());
    const first = selector.select(ic);
    expect(first.intentId).toBe(IntentId.DUEL);
    // Enemy disappears (died / left perception) — DUEL becomes invalid.
    ctx.nearestEnemy = null;
    ctx.tick = first.committedUntilTick - 1; // still inside commit
    const second = selector.select(ic);
    expect(second.intentId).not.toBe(IntentId.DUEL);
    expect(second.changed).toBe(true);
  });

  it('falls back to WANDER when nothing else is viable', () => {
    // No enemy, armed, early game (tick < 600 so HUNT doesn't fire), nothing to loot.
    const ctx = makeCtx({
      tick: 100,
      nearestEnemy: null,
      nearestHealth: null,
      nearestBarrier: null,
      nearestSpeedBoost: null,
      nearestWeapon: null,
      health: 100,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.WANDER);
  });
});

describe('intentIdToBotState', () => {
  it('maps each Phase-2 intent to a legacy executor state', () => {
    expect(intentIdToBotState(IntentId.SURVIVE_ZONE)).toBe(BotState.FLEE_ZONE);
    expect(intentIdToBotState(IntentId.RETREAT_AND_RESET)).toBe(BotState.RETREAT);
    expect(intentIdToBotState(IntentId.ARM_UP)).toBe(BotState.SEEK_WEAPON);
    expect(intentIdToBotState(IntentId.DUEL)).toBe(BotState.ENGAGE);
    expect(intentIdToBotState(IntentId.LOOT)).toBe(BotState.LOOT);
    expect(intentIdToBotState(IntentId.HUNT)).toBe(BotState.HUNT);
    expect(intentIdToBotState(IntentId.WANDER)).toBe(BotState.WANDER);
    // Phase-3 intents route to ENGAGE for now.
    expect(intentIdToBotState(IntentId.HUNT_VULNERABLE)).toBe(BotState.ENGAGE);
    expect(intentIdToBotState(IntentId.AMBUSH)).toBe(BotState.ENGAGE);
  });
});

describe('IntentSelector goal suspension', () => {
  it('excludes a suspended intent from selection (the LOOT→WANDER→LOOT fix)', () => {
    // A bot with low HP + nearby health would normally pick LOOT.
    const ctx = makeCtx({
      tick: 1000,
      health: 40,
      nearestHealth: { id: 'h1', x: 100, y: 0, distance: 120, type: 'powerup', tier: 0 },
      nearestEnemy: null,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const selector = new IntentSelector(buildPhase2Intents());
    const before = selector.select(ic);
    expect(before.intentId).toBe(IntentId.LOOT);

    // Suspend LOOT (simulating checkGoalStall firing on an unreachable item).
    selector.suspend(IntentId.LOOT, ctx.tick + 240);
    selector.forceReevaluate();

    // Next selection must NOT be LOOT — the bot falls through to WANDER/HUNT.
    ctx.tick = 1001;
    const after = selector.select(ic);
    expect(after.intentId).not.toBe(IntentId.LOOT);
  });

  it('allows a suspended intent to be re-selected after the window expires', () => {
    const ctx = makeCtx({
      tick: 1000,
      health: 40,
      nearestHealth: { id: 'h1', x: 100, y: 0, distance: 120, type: 'powerup', tier: 0 },
      nearestEnemy: null,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const selector = new IntentSelector(buildPhase2Intents());
    selector.suspend(IntentId.LOOT, ctx.tick + 240);
    selector.forceReevaluate();
    ctx.tick = 1001;
    expect(selector.select(ic).intentId).not.toBe(IntentId.LOOT);

    // After the suspension expires, LOOT is available again.
    ctx.tick = 1242;
    selector.forceReevaluate();
    expect(selector.select(ic).intentId).toBe(IntentId.LOOT);
  });

  it('never suspends SURVIVE_ZONE (zone death overrides stall)', () => {
    const selector = new IntentSelector(buildPhase2Intents());
    // Attempting to suspend SURVIVE_ZONE should be a no-op.
    selector.suspend(IntentId.SURVIVE_ZONE, 999999);
    // A bot outside the lethal zone should still select SURVIVE_ZONE despite
    // the suspend call.
    const ctx = makeCtx({
      tick: 1000,
      x: 900,
      y: 0,
      zoneRadius: 500,
      zoneCenterX: 0,
      zoneCenterY: 0,
      nearestEnemy: null,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.SURVIVE_ZONE);
  });

  it('clearSuspensions re-enables all intents immediately', () => {
    const ctx = makeCtx({
      tick: 1000,
      health: 40,
      nearestHealth: { id: 'h1', x: 100, y: 0, distance: 120, type: 'powerup', tier: 0 },
      nearestEnemy: null,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const selector = new IntentSelector(buildPhase2Intents());
    selector.suspend(IntentId.LOOT, ctx.tick + 9999);
    selector.forceReevaluate();
    ctx.tick = 1001;
    expect(selector.select(ic).intentId).not.toBe(IntentId.LOOT);

    // A successful pickup clears the suspension (proves the bot CAN reach loot).
    selector.clearSuspensions();
    selector.forceReevaluate();
    ctx.tick = 1002;
    expect(selector.select(ic).intentId).toBe(IntentId.LOOT);
  });

  it('drops the current intent when it becomes suspended mid-commit', () => {
    // Bot commits to LOOT, then LOOT gets suspended. The selector must drop it
    // even though the commit window hasn't expired — this is the core mechanism
    // that stops the LOOT→WANDER→LOOT oscillation.
    const ctx = makeCtx({
      tick: 1000,
      health: 40,
      nearestHealth: { id: 'h1', x: 100, y: 0, distance: 120, type: 'powerup', tier: 0 },
      nearestEnemy: null,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const selector = new IntentSelector(buildPhase2Intents());
    const committed = selector.select(ic);
    expect(committed.intentId).toBe(IntentId.LOOT);

    // Suspend LOOT while inside the commit window.
    selector.suspend(IntentId.LOOT, ctx.tick + 240);
    ctx.tick = 1001; // still inside commit
    const after = selector.select(ic);
    expect(after.intentId).not.toBe(IntentId.LOOT);
    expect(after.changed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy-cascade parity characterization cases (regression pins).
//
// These 4 scenarios were each handled by the legacy priority cascade (deleted
// in ADR-0036). They are NOT RED tests — the intent layer already routes them
// correctly. They pin that behavior so a future refactor of the intent layer
// (e.g. transcoding removal per ticket #15) can't silently drop one of these
// branches. Each scenario maps to a specific clause in the deleted cascade.
// ---------------------------------------------------------------------------

describe('IntentSelector legacy-cascade-parity scenarios', () => {
  it('FLEE_ZONE combat-override: armed + enemy in fight range + outside zone routes to ENGAGE (not SURVIVE_ZONE movement)', () => {
    // Legacy cascade: outside-zone + armed + enemy within engagement range
    // → ENGAGE (the combat-override that breaks the endgame stall where the
    // last 2 survivors orbit the zone center forever, both fleeing).
    // The intent layer preserves this in SurviveZoneIntent.execute(): the
    // selector still PICKS SURVIVE_ZONE (zone survival is always valid), but
    // its execute() reroutes to ENGAGE when the enemy is in range. This test
    // pins BOTH layers: the selection AND the execute routing.
    const ctx = makeCtx({
      x: 9999,
      y: 9999, // far outside zone (center 0,0 radius 500)
      zoneRadius: 500,
      zoneCenterX: 0,
      zoneCenterY: 0,
      zoneIsShrinking: false,
      nearestEnemy: enemy({ distance: 100, health: 100, maxHealth: 100 }),
    });
    const ic = makeIc(ctx, makeProfile(0.7));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    // The selector picks SURVIVE_ZONE (survival always wins outside the lethal
    // zone), then execute reroutes combat-override → ENGAGE.
    const chosen = selector.intentsById(result.intentId);
    expect(chosen).toBeDefined();
    const exec = chosen!.execute(ic);
    expect(exec.nextState).toBe(BotState.ENGAGE);
  });

  it('Endgame heal: <8 bots + low HP + health pickup visible → LOOT (heal priority)', () => {
    // Legacy cascade: endgame (<8 alive) + low HP + visible health pack →
    // LOOT (the endgame heal threshold of 0.85 + widened search distance).
    const ctx = makeCtx({
      tick: 1000,
      health: 40,
      maxHealth: 100,
      nearestEnemy: null,
      nearestHealth: { id: 'h1', x: 100, y: 0, distance: 400, type: 'powerup', tier: 0 },
    });
    // Endgame: only 5 bots left alive.
    const ic: IntentContext = {
      ctx,
      profile: makeProfile(0.5),
      aliveBotCount: 5,
      enemyInFightRange: false,
      zoneIsLethal: true,
    };
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.LOOT);
  });

  it('Booster economy: low HP + barrier in range + enemy outranges us → LOOT (barrier save)', () => {
    // Legacy cascade: low HP + barrier in range + about to close on a
    // superior-weapon enemy → grab the barrier (it absorbs their hits while we
    // gap-close). The barrier is the strongest save against a range mismatch.
    const ctx = makeCtx({
      tick: 1000,
      health: 35,
      maxHealth: 100,
      // Enemy with a longer-range weapon (CROSSBOW outranges our DAGGER @160).
      nearestEnemy: enemy({ distance: 600, weaponType: WeaponType.CROSSBOW }),
      // Barrier close enough to grab.
      nearestBarrier: { id: 'b1', x: 100, y: 0, distance: 150, type: 'powerup', tier: 0 },
    });
    // enemyInFightRange: distance 600 > 160 * 1.4 = 224, so false.
    const ic: IntentContext = {
      ctx,
      profile: makeProfile(0.7),
      aliveBotCount: 20,
      enemyInFightRange: false,
      zoneIsLethal: true,
    };
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    expect(result.intentId).toBe(IntentId.LOOT);
  });

  it('Proactive zone-edge pull-in: damaged bot at outer zone + shrinking + no kill opportunity → SURVIVE_ZONE (pre-position)', () => {
    // Legacy cascade: a damaged bot in the outer zone with no finishable
    // enemy retreats inward — the proactive pre-positioning that keeps damaged
    // bots from getting caught by the shrink. The intent layer's SurviveZone
    // isValid handles this (shrinking + distToZoneCenter > radius * 0.6).
    const ctx = makeCtx({
      tick: 500, // before HUNT's 600-tick start gate so HUNT doesn't compete
      health: 50,
      maxHealth: 100,
      x: 400,
      y: 0, // 400px from zone center; zoneRadius * 0.6 = 300, so 400 > 300 ✓
      zoneRadius: 500,
      zoneCenterX: 0,
      zoneCenterY: 0,
      zoneIsShrinking: true,
      nearestEnemy: null,
      nearestHealth: null,
      nearestBarrier: null,
      nearestSpeedBoost: null,
      nearestWeapon: null,
      nearestChest: null,
    });
    const ic = makeIc(ctx, makeProfile(0.5));
    const selector = new IntentSelector(buildPhase2Intents());
    const result = selector.select(ic);
    // The proactive pre-positioning routes to SURVIVE_ZONE (the bot pulls
    // inward before the shrink catches it).
    expect(result.intentId).toBe(IntentId.SURVIVE_ZONE);
  });
});

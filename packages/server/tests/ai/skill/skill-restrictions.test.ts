import { describe, it, expect } from 'vitest';
import { AttackType, WeaponType, InputAction } from '@sector-battle/shared';
import { BotContext } from '../../../src/ai/BotContext.ts';
import { BotState } from '../../../src/ai/BotContextTypes.ts';
import {
  RESTRICTIONS_BY_DIFFICULTY,
  botAllowsWeapon,
  botCanDashDuringOwnWindup,
  botCanSwitchSlotNow,
  restrictionsFor,
} from '../../../src/ai/skill/RestrictionTables.ts';
import { isWeaponUpgrade } from '../../../src/ai/BotEconomyExecutors.ts';
import { executeEngage } from '../../../src/ai/BotCombatEngage.ts';
import { executeRetreat } from '../../../src/ai/BotCombatRetreat.ts';
import { executeDemolition } from '../../../src/ai/BotCombatDemolition.ts';
import { buildPersonality } from '../../../src/ai/intent/PersonalityProfile.ts';
import { Pathfinder } from '../../../src/ai/navigation/Pathfinder.ts';
import type { EnemyInfo, ItemInfo } from '../../../src/ai/BotContextTypes.ts';
import type { QueuedInput } from '../../../src/application/simulation/InputQueue.ts';

/**
 * bot-ai-v2 ticket 08 (DEC-009.3) — SCOPED INCOMPETENCE: a low-tier bot's
 * narrow, CONSISTENT, learnable restrictions enforced at the executor/input
 * layer: weapon-class lock (2-3 classes), no mid-fight slot switch, no
 * dash-cancel of its own windup. High tiers unlock everything. FISTS always
 * pass. Published per bot at spawn, never recomputed.
 */

/** A minimal fresh ctx at the given difficulty with the published restrictions. */
function ctxAt(difficulty: 'easy' | 'hard'): BotContext {
  const ctx = new BotContext('bot_test_1');
  ctx.restrictions = restrictionsFor(difficulty);
  return ctx;
}

/** A fully-walkable open pathfinder (wall validation passes un-deflected —
 *  these tests pin the RESTRICTION gates, not the wall geometry; review M1
 *  has its own wall-geometry coverage in the reactor suite). */
const OPEN_PF = new Pathfinder(
  Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => true)),
  128,
);

function slot(type: WeaponType, tier = 1) {
  return { weaponType: type, tier, durability: 100, ammo: 10 };
}

describe('the per-tier restriction table (DEC-009.3)', () => {
  it('low tiers lock 2-3 weapon classes; high tiers unlock all', () => {
    const easy = RESTRICTIONS_BY_DIFFICULTY.easy;
    expect(easy.allowedAttackClasses).not.toBeNull();
    expect(easy.allowedAttackClasses!).toHaveLength(2);
    const normal = RESTRICTIONS_BY_DIFFICULTY.normal;
    expect(normal.allowedAttackClasses!).toHaveLength(3);
    for (const d of ['medium', 'hard', 'elite'] as const) {
      expect(RESTRICTIONS_BY_DIFFICULTY[d].allowedAttackClasses).toBeNull();
    }
    // ARC and LINE (the melee staples) are always among the allowed classes —
    // a locked bot is never defenseless and never refuses to punch walls.
    for (const classes of [easy.allowedAttackClasses!, normal.allowedAttackClasses!]) {
      expect(classes).toContain(AttackType.ARC);
      expect(classes).toContain(AttackType.LINE);
    }
  });

  it('the two mid-fight tricks: only hard+ may dash-cancel; medium may switch slots', () => {
    expect(RESTRICTIONS_BY_DIFFICULTY.easy.canSwitchSlotsMidFight).toBe(false);
    expect(RESTRICTIONS_BY_DIFFICULTY.normal.canSwitchSlotsMidFight).toBe(false);
    expect(RESTRICTIONS_BY_DIFFICULTY.medium.canSwitchSlotsMidFight).toBe(true);
    expect(RESTRICTIONS_BY_DIFFICULTY.medium.canDashDuringOwnWindup).toBe(false);
    expect(RESTRICTIONS_BY_DIFFICULTY.hard.canDashDuringOwnWindup).toBe(true);
    expect(RESTRICTIONS_BY_DIFFICULTY.elite.canDashDuringOwnWindup).toBe(true);
  });

  it('botAllowsWeapon: FISTS always pass; null restrictions (unrestricted) pass all', () => {
    const easy = RESTRICTIONS_BY_DIFFICULTY.easy;
    expect(botAllowsWeapon(easy, WeaponType.FISTS)).toBe(true);
    // RANGED/THROWN/SHIELD are out of the easy lock.
    expect(botAllowsWeapon(easy, WeaponType.SHORT_BOW)).toBe(false);
    expect(botAllowsWeapon(easy, WeaponType.CROSSBOW)).toBe(false);
    expect(botAllowsWeapon(easy, WeaponType.THROWING_AXE)).toBe(false);
    expect(botAllowsWeapon(easy, WeaponType.SMALL_SHIELD)).toBe(false);
    // ARC + LINE are in the lock.
    expect(botAllowsWeapon(easy, WeaponType.DAGGER)).toBe(true);
    expect(botAllowsWeapon(easy, WeaponType.SPEAR)).toBe(true);
    // Unrestricted (null — unit-test literals / high tiers) passes everything.
    const allWeapons = Object.values(WeaponType) as WeaponType[];
    for (const w of allWeapons) {
      expect(botAllowsWeapon(null, w)).toBe(true);
      expect(botAllowsWeapon(RESTRICTIONS_BY_DIFFICULTY.hard, w)).toBe(true);
    }
  });
});

describe('scripted scenario: a low-tier bot never violates its restrictions', () => {
  // Loadout: slot 0 DAGGER (ARC, short), slot 1 SPEAR (LINE, longer), slot 2
  // SHORT_BOW (RANGED, longest) — the bow outranges everything, so an
  // UNRESTRICTED bot wants slot 2 at distance; the easy lock must exclude it.
  function armedCtx(difficulty: 'easy' | 'hard'): BotContext {
    const ctx = ctxAt(difficulty);
    ctx.weapons = [slot(WeaponType.DAGGER), slot(WeaponType.SPEAR), slot(WeaponType.SHORT_BOW)];
    ctx.activeSlot = 0;
    return ctx;
  }

  it('weapon-class lock: the easy bot NEVER selects the out-of-class bow slot', () => {
    const ctx = armedCtx('easy');
    const enemyRange = 128; // a dagger-range enemy
    for (let dist = 60; dist <= 900; dist += 20) {
      expect(ctx.getBestSlotForMatchup(dist, enemyRange)).not.toBe(2);
      expect(ctx.getBestSlotForDistance(dist)).not.toBe(2);
    }
    // The hard bot CAN choose the bow at long range (the lock is the
    // difference, not the weapons).
    const hard = armedCtx('hard');
    let hardPickedBow = false;
    for (let dist = 60; dist <= 900; dist += 20) {
      if (hard.getBestSlotForMatchup(dist, enemyRange) === 2) hardPickedBow = true;
    }
    expect(hardPickedBow).toBe(true);
  });

  it('isWeaponUpgrade: an out-of-class floor weapon is NEVER an upgrade for the lock', () => {
    const ctx = armedCtx('easy');
    const bow: ItemInfo = {
      id: 'floor1',
      x: 0,
      y: 0,
      distance: 10,
      type: 'weapon',
      tier: 3, // a legendary bow…
      weaponType: WeaponType.SHORT_BOW,
    };
    expect(isWeaponUpgrade(ctx, bow)).toBe(false);
    // …while an in-class LINE upgrade IS (tier above the active DAGGER).
    const spear: ItemInfo = { ...bow, weaponType: WeaponType.SPEAR, tier: 2 };
    expect(isWeaponUpgrade(ctx, spear)).toBe(true);
    // The hard bot sees the legendary bow as the upgrade it is.
    expect(isWeaponUpgrade(armedCtx('hard'), bow)).toBe(true);
  });

  /** A recovering dagger enemy at punish distance — the canonical setup where
   *  an unrestricted bot SWITCHES to the outranging spear and DASH-punishes.
   *  200px sits inside the dash-punish band (128×0.9 .. 128×3×min-reach) for
   *  EVERY archetype's dashPunishReach (0.6..1.3), so the test does not
   *  depend on which archetype the seeded RNG draws. */
  function punishEnemy(ctx: BotContext): EnemyInfo {
    return {
      id: 'e1',
      x: ctx.x + 200,
      y: ctx.y,
      vx: 0,
      vy: 0,
      distance: 200,
      health: 80,
      maxHealth: 100,
      weaponType: WeaponType.DAGGER,
      weaponTier: 1,
      isInWindup: false,
      windupRemaining: 0,
      lastAttackTick: ctx.tick - 2, // just whiffed → in recovery (canPunish)
      facingAngle: Math.PI,
      barrierActive: false,
      isFreshSpawn: false,
      spawnInvulnTicksLeft: 0,
      isLooting: false,
      engagedTargetId: null,
    };
  }

  function actions(inputs: readonly QueuedInput[]): InputAction[] {
    return inputs.map((i) => i.action);
  }

  it('mid-fight slot switch: the easy bot emits NO SWITCH_SLOT while engaged', () => {
    const ctx = armedCtx('easy');
    ctx.state = BotState.ENGAGE;
    ctx.tick = 500;
    ctx.lastSwitchSlotTick = 0; // switch cooldown long elapsed
    const profile = buildPersonality(ctx.rng, 'easy');
    const inputs = executeEngage(ctx, punishEnemy(ctx), profile, 0, OPEN_PF);
    // The matchup favors slot 1 (SPEAR outranges the dagger enemy at 200px)…
    expect(ctx.getBestSlotForMatchup(200, 128)).not.toBe(ctx.activeSlot);
    // …but the mid-fight gate suppresses the switch.
    expect(botCanSwitchSlotNow(ctx)).toBe(false);
    expect(actions(inputs)).not.toContain(InputAction.SWITCH_SLOT);
    // Between fights (no nearby enemy, patrol state) the same bot re-equips.
    ctx.state = BotState.WANDER;
    ctx.nearestEnemy = null;
    expect(botCanSwitchSlotNow(ctx)).toBe(true);
  });

  it('dash-cancel: the easy bot never dashes out of its OWN windup (hard does)', () => {
    const easy = armedCtx('easy');
    easy.state = BotState.ENGAGE;
    easy.tick = 500;
    easy.lastDashTick = -9999; // dash cooldown ready
    easy.lastAttackTick = -9999;
    easy.isInOwnWindup = true; // mid-swing
    const easyProfile = buildPersonality(easy.rng, 'easy');
    const easyInputs = executeEngage(easy, punishEnemy(easy), easyProfile, 0, OPEN_PF);
    expect(botCanDashDuringOwnWindup(easy)).toBe(false);
    expect(actions(easyInputs)).not.toContain(InputAction.DASH);

    const hard = armedCtx('hard');
    hard.state = BotState.ENGAGE;
    hard.tick = 500;
    hard.lastDashTick = -9999;
    hard.lastAttackTick = -9999;
    hard.isInOwnWindup = true;
    const hardProfile = buildPersonality(hard.rng, 'hard');
    const hardInputs = executeEngage(hard, punishEnemy(hard), hardProfile, 0, OPEN_PF);
    expect(botCanDashDuringOwnWindup(hard)).toBe(true);
    expect(actions(hardInputs)).toContain(InputAction.DASH);

    // Outside its own windup the easy bot may dash again (the lock is the
    // CANCEL trick, never mobility itself).
    easy.isInOwnWindup = false;
    expect(botCanDashDuringOwnWindup(easy)).toBe(true);
  });

  it('restrictions are published at spawn and stay the same all match (identity)', () => {
    // registerBot derives the set ONCE from the assigned difficulty; the
    // stored reference is the table row itself — nothing clones or
    // recomputes it, so every later tick enforces the exact same set.
    const easy = ctxAt('easy');
    expect(easy.restrictions).toBe(RESTRICTIONS_BY_DIFFICULTY.easy);
    // "Later in the match": the gate reads the same object with the same
    // verdicts (pure functions of the immutable row).
    easy.state = BotState.ENGAGE;
    easy.isInOwnWindup = true;
    for (let t = 0; t < 3000; t += 97) {
      easy.tick = t;
      expect(easy.restrictions).toBe(RESTRICTIONS_BY_DIFFICULTY.easy);
      expect(botCanSwitchSlotNow(easy)).toBe(false);
      expect(botCanDashDuringOwnWindup(easy)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review M2 — the two tricks enforced at the RETREAT and DEMOLITION emission
// sites too (pre-fix they were only wired at the engage sites, so a locked
// tier "fumbled with its inventory under pressure" exactly where the habit
// was most visible).
// ─────────────────────────────────────────────────────────────────────────────

describe('scripted scenario (review M2): retreat + demolition restriction wiring', () => {
  /** The InputAction projection of a tick's inputs (module-describe twin of
   *  the engage block's helper — sibling describes do not share scope). */
  function actionsOf(inputs: readonly QueuedInput[]): InputAction[] {
    return inputs.map((i) => i.action);
  }

  /** A pursuing enemy 150px away — inside the retreat-dash band (<200). */
  function pursuerClose(ctx: BotContext): EnemyInfo {
    return {
      id: 'p1',
      x: ctx.x - 150,
      y: ctx.y,
      vx: 0,
      vy: 0,
      distance: 150,
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

  function retreatCtx(difficulty: 'easy' | 'hard'): BotContext {
    const ctx = ctxAt(difficulty);
    ctx.weapons = [slot(WeaponType.DAGGER), slot(WeaponType.SPEAR)];
    ctx.activeSlot = 0;
    ctx.state = BotState.RETREAT;
    ctx.tick = 500;
    ctx.lastDashTick = -9999;
    ctx.lastAttackTick = -9999;
    ctx.lastSwitchSlotTick = -9999;
    return ctx;
  }

  it('retreat-dash: the easy bot never dashes out of its OWN windup (hard does)', () => {
    const easy = retreatCtx('easy');
    easy.isInOwnWindup = true; // mid-swing while fleeing
    const easyInputs = executeRetreat(
      easy,
      pursuerClose(easy),
      buildPersonality(easy.rng, 'easy'),
      0,
    );
    expect(botCanDashDuringOwnWindup(easy)).toBe(false);
    expect(actionsOf(easyInputs)).not.toContain(InputAction.DASH);

    const hard = retreatCtx('hard');
    hard.isInOwnWindup = true;
    const hardInputs = executeRetreat(
      hard,
      pursuerClose(hard),
      buildPersonality(hard.rng, 'hard'),
      0,
    );
    expect(botCanDashDuringOwnWindup(hard)).toBe(true);
    expect(actionsOf(hardInputs)).toContain(InputAction.DASH);
  });

  it('retreat-switch-spare: the easy bot throws but never swaps mid-retreat (hard swaps)', () => {
    // Enemy at 300px: inside the deny-throw band (150 < d < 700), cooldown
    // ready, spare SPEAR in slot 1 — the throw fires and the post-throw
    // spare switch is the gated emission under test.
    const enemyAt = (ctx: BotContext, d: number): EnemyInfo => ({
      ...pursuerClose(ctx),
      x: ctx.x - d,
      distance: d,
    });
    const easy = retreatCtx('easy');
    const easyInputs = executeRetreat(
      easy,
      enemyAt(easy, 300),
      buildPersonality(easy.rng, 'easy'),
      0,
    );
    expect(botCanSwitchSlotNow(easy)).toBe(false); // RETREAT state locks it
    expect(actionsOf(easyInputs)).toContain(InputAction.THROW); // still fights
    expect(actionsOf(easyInputs)).not.toContain(InputAction.SWITCH_SLOT);

    const hard = retreatCtx('hard');
    const hardInputs = executeRetreat(
      hard,
      enemyAt(hard, 300),
      buildPersonality(hard.rng, 'hard'),
      0,
    );
    expect(botCanSwitchSlotNow(hard)).toBe(true);
    expect(actionsOf(hardInputs)).toContain(InputAction.THROW);
    expect(actionsOf(hardInputs)).toContain(InputAction.SWITCH_SLOT);
  });

  it('demolition-switch-breaker: the easy bot breaks walls with what it holds (hard swaps to the hammer)', () => {
    // DAGGER (low destructibleDamage) active, HAMMER (the breaker) in slot 1 —
    // getBestSlotForDestructibles prefers the hammer for BOTH tiers (both
    // ARC-class, allowed under the easy lock): the gate is the difference.
    function demoCtx(difficulty: 'easy' | 'hard'): BotContext {
      const ctx = ctxAt(difficulty);
      ctx.weapons = [slot(WeaponType.DAGGER), slot(WeaponType.HAMMER)];
      ctx.activeSlot = 0;
      ctx.state = BotState.DEMOLITION;
      ctx.tick = 500;
      ctx.lastSwitchSlotTick = -9999;
      return ctx;
    }
    const easy = demoCtx('easy');
    expect(easy.getBestSlotForDestructibles()).toBe(1); // wants the hammer…
    const easyInputs = executeDemolition(easy, easy.x + 100, easy.y);
    expect(botCanSwitchSlotNow(easy)).toBe(false); // …but the habit gates it
    expect(actionsOf(easyInputs)).not.toContain(InputAction.SWITCH_SLOT);

    const hard = demoCtx('hard');
    const hardInputs = executeDemolition(hard, hard.x + 100, hard.y);
    expect(botCanSwitchSlotNow(hard)).toBe(true);
    expect(actionsOf(hardInputs)).toContain(InputAction.SWITCH_SLOT);
  });
});

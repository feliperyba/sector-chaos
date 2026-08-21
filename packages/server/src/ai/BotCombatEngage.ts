import { AttackType, WeaponType, angleTo, normalizeAngle } from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from './BotContext.ts';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import type { PersonalityProfile } from './intent/PersonalityProfile.ts';
import { safeGetWeaponDef } from './BotLoadout.ts';
import {
  makeMoveInput,
  makeAttackInput,
  makeDashInput,
  makeSwitchSlotInput,
  makeThrowInput,
} from './BotInput.ts';
import { executeRanged } from './BotCombatEngageRanged.ts';
import { applyMovementShaping } from './skill/BotMovementSignature.ts';
import {
  accuracyCapFor,
  engagementSpreadMultiplier,
  fireDisciplineFor,
} from './skill/CombatCapTables.ts';
import { MOVEMENT_PROFILES } from './skill/MovementProfileTables.ts';
import { botCanDashDuringOwnWindup, botCanSwitchSlotNow } from './skill/RestrictionTables.ts';
import {
  DASH_COOLDOWN_TICKS,
  ENEMY_WHIFF_THRESHOLD,
  AIM_ERROR_RAD,
  ATTACK_RANGE_MARGIN,
  PREDICTION_TICKS_MELEE,
  PERCENT_TO_TICKS,
  isAttackUnsafeNearBarrel,
  getBackoffTicks,
  blendDangerAvoidance,
  predictAim,
} from './BotCombatShared.ts';
import {
  strafeDirFor,
  underProjectileFire,
  weaveSide,
  WEAVE_APPROACH_OFFSET_RAD,
} from './combat/BotCombatWeave.ts';

/**
 * Execute one ENGAGE tick (approach/spacing/attack).
 *
 * The windup-reactive dodge that used to live here MOVED to the Reactor
 * (bot-ai-v2 ticket 04, DEC-004/DEC-010.2): the windup reaction is priority 5
 * of the reactor's interrupt layer, un-gated from the caution threshold for
 * every archetype, and fires in ALL intent states — not only while ENGAGE's
 * executor happened to run. Archetype flavor comes from the reactor's mix
 * table (AGGRESSOR minimal punish-ready sidestep → SCAVENGER full evade).
 *
 * @param startleAimPenalty the Reactor's startle accuracy penalty at this
 *  tick (0 when not startled; decays linearly — DEC-007). Multiplies the aim
 *  spread by (1 + penalty): a freshly-startled bot swings wild, recovering
 *  over the penalty window.
 * @param pf the pathfinder — wall validation on the emitted movement angles
 *  (DEC-005.1 at the combat seam, review M1: blendDangerAvoidance validates
 *  its final angle; the caller threads system.pathfinder like every other
 *  executor seam).
 */
export function executeEngage(
  ctx: BotContext,
  enemy: EnemyInfo,
  profile: PersonalityProfile,
  startleAimPenalty = 0,
  pf: Pathfinder,
): QueuedInput[] {
  const inputs: QueuedInput[] = [];
  const weapon = ctx.getActiveWeapon();
  const def = safeGetWeaponDef(weapon.weaponType);
  if (!def) return inputs; // unknown weapon type — bail (defensive; unreachable for registry-minted weapons)
  const range = def.baseStats.range;
  const cooldownTicks = Math.ceil((def.baseStats.cooldown ?? 400) * PERCENT_TO_TICKS);
  const windupTicks = Math.ceil((def.baseStats.windupMs ?? 100) * PERCENT_TO_TICKS);
  const attackType = def.baseStats.attackType;
  const isRanged = attackType === AttackType.RANGED;
  const isLine = attackType === AttackType.LINE;
  const isShield = attackType === AttackType.SHIELD;
  const isThrown = attackType === AttackType.THROWN;
  const isFists = weapon.weaponType === WeaponType.FISTS;
  const backoffTicks = getBackoffTicks(weapon.weaponType);

  const enemyDef = safeGetWeaponDef(enemy.weaponType);
  if (!enemyDef) return inputs; // unknown enemy weapon type — bail (defensive; unreachable for registry-minted weapons)
  const enemyRange = enemyDef.baseStats.range;

  // ── bot-ai-v2 ticket 08 (DEC-009) per-bot combat identity ─────────────────
  // Signature movement profile (DUELIST spacing discipline + dash-punish
  // reach; falls back to the archetype's table row for null-signature test
  // contexts), the FIRE-DISCIPLINE cap (sustain-fire-range band + first-shot
  // delay after LOS acquire — BotCombatExecutors maintains
  // ctx.losHeldSinceTick), and the AIM-CONVERGENCE half of the accuracy cap.
  const sig = ctx.movement?.profile ?? MOVEMENT_PROFILES[profile.archetype];
  const fireCap = fireDisciplineFor(profile.difficulty);
  const accuracyCap = accuracyCapFor(profile.difficulty);
  const firstShotReady = ctx.tick - ctx.losHeldSinceTick >= fireCap.firstShotDelayTicks;
  const effectiveAttackRange = range * ATTACK_RANGE_MARGIN * fireCap.sustainFireRangeFactor;

  // MATCHUP-AWARE SLOT SWITCH: prefer a weapon that OUTRANGES the enemy when one
  // is available and can hit (Spear+Dagger vs Dagger picks the Spear, not the
  // Dagger). Falls back to tier ranking when no weapon outranges the enemy.
  // Class-locked inside getBestSlotForMatchup (DEC-009.3: a low tier never
  // CHOOSES an out-of-class weapon) and gated on botCanSwitchSlotNow (low
  // tiers never switch slots mid-fight — the learnable inventory habit).
  const bestSlot = ctx.getBestSlotForMatchup(enemy.distance, enemyRange);
  const switchReady = ctx.tick - ctx.lastSwitchSlotTick > 9 && botCanSwitchSlotNow(ctx);
  if (bestSlot !== ctx.activeSlot && switchReady) {
    inputs.push(makeSwitchSlotInput(ctx.playerId, bestSlot, ctx.tick, 'engage-switch-matchup'));
    ctx.lastSwitchSlotTick = ctx.tick;
  }

  let predictionTick: number;
  if (isRanged) {
    const projSpeed = def.baseStats.projectileSpeed ?? 2000;
    predictionTick = Math.ceil((enemy.distance / projSpeed) * 60);
  } else {
    predictionTick = PREDICTION_TICKS_MELEE + windupTicks;
  }
  // Precision weapons (LINE thrust = thin 20px hitbox, RANGED projectile) need
  // tight aim — random spread at 300px easily misses the narrow hitbox. ARC
  // weapons swing a 90° cone so they're forgiving; keep their spread for
  // natural-feeling misses. The skill knob scales the spread: easy bots (1.6)
  // spray wider and miss more, elite bots (0.45) aim tight. This is the only
  // place difficulty changes how WELL a bot aims — previously the knob was dead.
  // AIM CONVERGENCE (bot-ai-v2 ticket 08, DEC-007.2/DEC-009.4): the opening
  // spread of a FRESH engagement starts at the tier's opening multiplier and
  // decays linearly to baseline over its convergence window (measured from
  // ctx.engageStartTick) — multi-adjustment aiming: first contact is
  // survivable, sustained fights are dangerous.
  const basePrecision = isLine || isRanged ? AIM_ERROR_RAD * 0.25 : AIM_ERROR_RAD;
  const convergenceMul = engagementSpreadMultiplier(accuracyCap, ctx.tick - ctx.engageStartTick);
  const precision =
    basePrecision * profile.skill.aimErrorMultiplier * convergenceMul * (1 + startleAimPenalty);
  const aimAngle = predictAim(ctx, enemy, predictionTick, precision);

  const dist = enemy.distance;
  // SUSTAIN-FIRE-RANGE (fire discipline, DEC-009.4): full fire commitment
  // only inside the weapon's win band — the tier factor scales the band, so
  // an easy bot closes visibly before committing while a hard bot fires at
  // the band edge.
  const inAttackRange = dist <= effectiveAttackRange;
  const cooldownReady = ctx.tick - ctx.lastAttackTick >= cooldownTicks;
  // Suppress attacks that would detonate a barrel in the bot's own blast
  // radius (suicidal). Directional + weapon-aware: only suppresses when the
  // attack would actually HIT a barrel in the swing arc / firing ray (was a
  // flat "any barrel within 256px" that starved combat in barrel-dense zones).
  const attackUnsafe = isAttackUnsafeNearBarrel(ctx, aimAngle, range, attackType);

  const ticksSinceAttack = ctx.tick - ctx.lastAttackTick;
  // Enemy-on-cooldown is computed first so we can use it to SUPPRESS the backoff:
  // if the enemy is in recovery (just whiffed or is locked out), pressing the
  // advantage beats retreating. The backoff exists to avoid trading into a
  // ready counter — but a recovering enemy can't counter, so don't give ground.
  const enemyCooldownTicks = Math.ceil((enemyDef.baseStats.cooldown ?? 400) * PERCENT_TO_TICKS);
  const enemyCooldown = Math.max(0, enemyCooldownTicks - (ctx.tick - enemy.lastAttackTick));
  const enemyInRecovery = enemyCooldown > ENEMY_WHIFF_THRESHOLD;
  const justAttacked =
    backoffTicks > 0 &&
    ticksSinceAttack >= 0 &&
    ticksSinceAttack < backoffTicks &&
    !ctx.selfBarrierActive && // invulnerable: no need to back off after attacking
    !enemyInRecovery; // enemy can't counter → press the advantage, don't retreat
  const canPunish = enemyInRecovery && !justAttacked;
  // DASH-CANCEL RESTRICTION (DEC-009.3): a low tier NEVER dashes out of its
  // own attack windup — gating `dashReady` here covers every dash site below
  // (punish, backoff, fists-close, shield-approach, kill-secure) with the one
  // learnable habit. Survival dashes (zone flee) sit outside this executor
  // and stay ungated by design (GDD §14.4 instant threat override).
  const dashReady =
    ctx.tick - ctx.lastDashTick >= DASH_COOLDOWN_TICKS && botCanDashDuringOwnWindup(ctx);

  // Enemy weapon reach — needed for range-advantage spacing (Change C).
  // enemyDef/enemyRange are computed at the top (the matchup-aware slot
  // switch needs enemyRange there). (The enemy windup length used to be
  // computed here for the windup-reactive dodge — that check moved to the
  // Reactor, which derives it itself in detectWindupThreat.)

  // WEIGHT-TIER CLASSIFICATION: the heaviness axis (0=light/fast → 3=heavy/slow)
  // drives the combat style split below. Heavy ARC weapons (Long Sword, Hammer,
  // Large Axe, Bladed Axe, Double Axe) play bait-and-punish — they have long
  // cooldowns/windups so yolo-dashing in or trading aggressively loses to faster
  // weapons. Light ARC (Fists, Dagger, Short Sword) play pressure — high attack
  // frequency wins. LINE weapons (Spear, Polearm, Staff) hold range and time
  // their thrusts. isFists is already computed above; isHeavyMelee narrows ARC
  // to the heavy subset (excludes Fists, which are weightTier 0).
  const myWeightTier = def.baseStats.weightTier ?? 0;
  const isHeavyMelee = !isRanged && !isThrown && !isShield && !isLine && myWeightTier >= 2;
  const enemyWeaponIsFaster =
    !isRanged &&
    !isThrown &&
    (enemyDef.baseStats.weightTier ?? 1) < myWeightTier &&
    enemyDef.baseStats.attackType !== AttackType.RANGED;

  if (isRanged) {
    return executeRanged(
      ctx,
      enemy,
      inputs,
      aimAngle,
      range,
      dist,
      cooldownReady,
      dashReady,
      effectiveAttackRange,
      firstShotReady,
      pf,
    );
  }

  // THROWN (Throwing Axe): a dual-mode weapon — throw at range (it's a bouncing
  // projectile dealing 15 dmg), melee (ARC, 10 dmg) when adjacent. The legacy
  // bot NEVER threw it — it walked to range*0.88 and swung it as generic melee,
  // wasting the throw. Now: throw when at throw-range with cooldown ready (the
  // axe has a 500ms cooldown); close to melee only when the enemy is too close
  // to safely throw. The throw leads the target (predictAim with longer horizon).
  if (isThrown) {
    const throwRange = range; // 800 for Throwing Axe
    const inThrowRange = dist <= throwRange * 0.9 && dist > 120; // not too close (self-immunity window)
    if (inThrowRange && cooldownReady && !attackUnsafe && firstShotReady) {
      // Throw leads more than melee (projectile travel time).
      const throwAim = predictAim(ctx, enemy, predictionTick + 4, precision);
      inputs.push(makeThrowInput(ctx.playerId, throwAim, ctx.tick, 'engage-throw-dual-mode'));
      ctx.lastAttackTick = ctx.tick;
      // After throwing, strafe to reset (don't stand still eating return fire).
      // STICKY WEAVE (DEC-010.1): under projectile fire the strafe direction
      // comes from the committed weave (0.5-1 s side commitment), not the
      // per-tick hazard re-pick.
      const baseAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
      const strafeDir = strafeDirFor(ctx, enemy);
      const moveAngle = normalizeAngle(baseAngle + (strafeDir * Math.PI) / 2);
      // blendDangerAvoidance wall-validates its final angle (review M1).
      inputs.push(
        makeMoveInput(ctx.playerId, blendDangerAvoidance(ctx, moveAngle, pf), throwAim, ctx.tick),
      );
      return inputs;
    }
    // Too close or on cooldown — fall through to melee (the Throwing Axe has a
    // melee ARC fallback mode). The generic attack branch below handles it.
  }

  // SHIELD reactive block: when the enemy is winding up an attack AND facing
  // us, HOLD ATTACK to block (block = the attack input for shields, per GDD
  // §7.3). The shield's front arc absorbs the incoming hit (100% negation),
  // then we bash during the enemy's cooldown. Without this, shield bots just
  // dash in and bash offensively — they never use the block defensively, so
  // the shield's core identity (a mobile wall) is wasted.
  if (isShield && enemy.isInWindup && cooldownReady && !justAttacked) {
    // Is the enemy facing us? (their facing toward us = their attack will hit)
    const enemyFacingX = Math.cos(enemy.facingAngle);
    const enemyFacingY = Math.sin(enemy.facingAngle);
    const toUsX = ctx.x - enemy.x;
    const toUsY = ctx.y - enemy.y;
    const toUsLen = Math.sqrt(toUsX * toUsX + toUsY * toUsY) || 1;
    const facingDot = (enemyFacingX * toUsX + enemyFacingY * toUsY) / toUsLen;
    if (facingDot > 0.3 && dist < range * 1.2) {
      // Enemy is winding up AND facing us → hold block (attack input). Face the
      // enemy so our block arc covers the incoming swing.
      const blockAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
      inputs.push(makeAttackInput(ctx.playerId, blockAngle, ctx.tick));
      ctx.lastAttackTick = ctx.tick;
      // Hold position (blocking has a 50% speed penalty anyway; don't move much).
      inputs.push(makeMoveInput(ctx.playerId, blockAngle, blockAngle, ctx.tick));
      return inputs;
    }
  }

  // LINE TIMING: thrust weapons (Spear/Polearm/Staff) have long cooldowns
  // (500-700ms), so firing into a fast-retreating enemy wastes the cooldown.
  // But the previous gate (fire only when approaching or in recovery) created a
  // DEADLOCK: two bots strafing perpendicular → enemyApproaching false, neither
  // has attacked → enemyInRecovery false → neither ever fires → mutual stall.
  // Fix: fire when the enemy is NOT actively retreating. A stationary, slow,
  // approaching, or lateral-strafing enemy is hittable via predictAim; only a
  // fast-retreating enemy is worth holding the cooldown for.
  const toBotX = ctx.x - enemy.x;
  const toBotY = ctx.y - enemy.y;
  const enemyRetreating = enemy.vx * toBotX + enemy.vy * toBotY < -50;
  const shouldFireLine = !isLine || !enemyRetreating || enemyInRecovery;
  if (
    inAttackRange &&
    cooldownReady &&
    !justAttacked &&
    !attackUnsafe &&
    shouldFireLine &&
    firstShotReady
  ) {
    inputs.push(makeAttackInput(ctx.playerId, aimAngle, ctx.tick));
    ctx.lastAttackTick = ctx.tick;
  }

  // HEAVY-WEAPON RESTRAINT: the dash-punish closes distance to exploit enemy
  // recovery. For heavy ARC weapons (weightTier 2-3) this is correct ONLY when
  // the enemy is in recovery — a heavy weapon dashing into a ready faster enemy
  // gets out-traded (the Dagger swings twice during the Hammer's windup). Gate
  // the dash-punish for heavy weapons on canPunish (enemy in recovery) AND the
  // enemy not having a faster weapon ready. Light/medium weapons and LINE keep
  // the original generous gate (they either trade well or poke from range).
  // DUELIST SIGNATURE (DEC-009.2): the archetype's dashPunishReach scales the
  // outer trigger band — the fencer punishes whiffs from noticeably further
  // out, the survivor almost never spends the dash.
  const heavyCanDash = !isHeavyMelee || (canPunish && !enemyWeaponIsFaster);
  if (
    dashReady &&
    canPunish &&
    heavyCanDash &&
    dist > range * 0.9 &&
    dist < range * 3.0 * sig.dashPunishReach &&
    !isShield
  ) {
    inputs.push(
      makeDashInput(
        ctx.playerId,
        angleTo(ctx.x, ctx.y, enemy.x, enemy.y),
        ctx.tick,
        'engage-dash-punish',
      ),
    );
    ctx.lastDashTick = ctx.tick;
    return inputs;
  }

  let moveAngle: number;

  // (WINDUP-REACTIVE DODGE moved to the Reactor — see the module-header note.
  // The windup reaction now preempts this entire executor for its window,
  // un-gated from the caution threshold for every archetype.)

  if (justAttacked) {
    moveAngle = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
    // Heavy weapons dash-back after EVERY swing (their recovery is long — 700-
    // 850ms — so standing in range eating return fire loses the trade). Light/
    // medium weapons only dash-back in the first 3 ticks (they recover fast
    // enough to hold position). This pairs with the weightTier-scaled backoff
    // window: heavy weapons retreat further AND dash to create space.
    const heavyDashWindow = isHeavyMelee ? backoffTicks : 3;
    if (dashReady && ticksSinceAttack < heavyDashWindow && !isFists) {
      inputs.push(makeDashInput(ctx.playerId, moveAngle, ctx.tick, 'engage-backoff'));
      ctx.lastDashTick = ctx.tick;
    }
  } else if (isFists && dist > range * 1.1 && dashReady) {
    moveAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
    inputs.push(makeDashInput(ctx.playerId, moveAngle, ctx.tick, 'engage-fists-close'));
    ctx.lastDashTick = ctx.tick;
  } else if (isShield && dist > range * 0.85 && dashReady) {
    // Shield approach: dash to close the gap. The shield's block arc absorbs
    // incoming hits while closing, so dashing in is low-risk and lets the
    // slower shield bot reach bash range instead of being kited indefinitely.
    moveAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
    inputs.push(makeDashInput(ctx.playerId, moveAngle, ctx.tick, 'engage-shield-approach'));
    ctx.lastDashTick = ctx.tick;
  } else if (
    shouldPursueKill(
      enemy,
      dist,
      dashReady,
      range,
      enemyRange,
      enemy.weaponType === WeaponType.FISTS,
    )
  ) {
    // KILL-SECURE / FREE-KILL CHASE: abandon spacing and dash-pursue when the
    // enemy is low-HP (retreating to reset/heal) OR a free-kill matchup (FISTS /
    // decisively outranged). The spacing logic below holds a fixed distance — a
    // retreating enemy at the same speed keeps that distance forever, so the
    // enemy escapes. Lead the dash toward where the enemy is GOING.
    const leadX = enemy.x + enemy.vx * 8;
    const leadY = enemy.y + enemy.vy * 8;
    moveAngle = angleTo(ctx.x, ctx.y, leadX, leadY);
    inputs.push(makeDashInput(ctx.playerId, moveAngle, ctx.tick, 'engage-kill-secure'));
    ctx.lastDashTick = ctx.tick;
  } else {
    // RANGE-ADVANTAGE SPACING — hold the right distance for the matchup, in
    // ABSOLUTE pixels (was ratio-of-own-range, blind to the enemy's reach).
    // If we outrange the enemy, hold the sweet-spot: inside our reach, just
    // outside theirs — we can hit, they can't. Otherwise hold inside our own
    // range (neutral/outranged; DuelIntent already down-scores outranged fights
    // so we're usually here only when we chose to press). Fists stay permissive
    // (free/spammable, no reason to manage spacing). A ±margin hysteresis band
    // prevents thrashing between approach/back-off at the boundary. The
    // signature's spacingMarginScale (DEC-009.2) widens/narrows the band per
    // archetype — DUELIST holds the exact distance (0.5×), AGGRESSOR brawls
    // through it (1.5×).
    const hasRangeAdvantage = range > enemyRange + 30;
    // DECISIVE-ADVANTAGE / LOW-HP COLLAPSE: if the enemy is a free kill (FISTS,
    // or we outrange them by >150px) OR low-HP, collapse idealDist to point-
    // blank so the bot ALWAYS closes — even when dash is on cooldown. Without
    // this, an armed bot circles an unarmed survivor at range*0.92 forever.
    const enemyHpRatio = enemy.health / (enemy.maxHealth || 100);
    const enemyIsFistsType = enemy.weaponType === WeaponType.FISTS;
    const freeKillMatchup =
      enemyIsFistsType ||
      (hasRangeAdvantage && range > enemyRange + 150) ||
      enemyHpRatio < KILL_PURSUE_HP;
    let idealDist: number;
    let spacingMargin: number;
    if (freeKillMatchup && !isFists) {
      // Collapse to point-blank — close and finish. No spacing hold on a free kill.
      idealDist = range * 0.45;
      spacingMargin = range * 0.15;
    } else if (isFists) {
      idealDist = range * 0.65;
      spacingMargin = range * 0.3;
    } else if (isHeavyMelee) {
      // HEAVY-WEAPON PATIENCE: a heavy ARC weapon (Hammer/Double Axe/etc) has a
      // long windup (200ms) and long cooldown (700-850ms). Pressing into the
      // sweet-spot (range*0.76) puts it inside a faster enemy's effective range
      // where the enemy out-trades it during the heavy's recovery. Instead hold
      // at the EDGE of range (range*0.92) — bait the enemy's approach, punish
      // their whiff with the heavy hit, then back off during recovery. This is
      // the bait-and-punish playstyle heavy weapons are designed for; the old
      // generic spacing made them play like Daggers and lose the trade.
      idealDist = range * 0.92;
      spacingMargin = 16;
    } else if (hasRangeAdvantage) {
      // Sweet-spot: as close to the enemy's max reach as safe (just outside it),
      // but not past our own. This is the depth a Spear-vs-Dagger duel was
      // missing — the Spear now kites at ~155px instead of charging into 160.
      idealDist = Math.min(range * 0.85, Math.max(range * 0.5, enemyRange * 0.95));
      spacingMargin = 24;
    } else {
      idealDist = range * 0.76;
      spacingMargin = range * 0.1;
    }
    if (dist < idealDist - spacingMargin * sig.spacingMarginScale) {
      moveAngle = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
    } else if (dist > idealDist + spacingMargin * sig.spacingMarginScale) {
      moveAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
      // APPROACH-CURVE SIGNATURE (DEC-009.2): the AGGRESSOR's beeline+weave /
      // TRAPPER's arc show on the CLOSING movement — the spacing hold and the
      // combat strafes below stay unshaped (precision movement).
      // UNDER-FIRE OVERRIDE (bot-ai-v2 ticket 09, DEC-010.1): while under
      // projectile fire the closing movement WEAVES on the committed side
      // (the zigzag approach a human under fire shows) instead of the
      // signature curve — the weave is the under-fire signature.
      if (underProjectileFire(ctx)) {
        moveAngle = normalizeAngle(moveAngle + weaveSide(ctx) * WEAVE_APPROACH_OFFSET_RAD);
      } else {
        moveAngle = applyMovementShaping(ctx.movement, ctx.tick, moveAngle);
      }
    } else {
      // STICKY WEAVE (bot-ai-v2 ticket 09, DEC-010.1): under projectile fire
      // the combat strafe is the committed perpendicular weave (direction
      // held 0.5-1 s, per-bot RNG on the side); otherwise the legacy
      // hazard-scored strafe with its 20-45-tick window.
      const weaveDir = strafeDirFor(ctx, enemy);
      const baseAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
      if (isLine) {
        moveAngle = baseAngle;
      } else {
        moveAngle = normalizeAngle(baseAngle + (weaveDir * Math.PI) / 2);
      }
    }
  }

  // blendDangerAvoidance wall-validates its final angle (review M1 — the
  // DEC-005.1 invariant holds at this emission seam too).
  inputs.push(
    makeMoveInput(ctx.playerId, blendDangerAvoidance(ctx, moveAngle, pf), aimAngle, ctx.tick),
  );
  return inputs;
}

/** HP fraction below which a low-HP enemy is worth pursuing to secure the kill.
 *  Above this, the enemy can still turn and trade — holding spacing is correct.
 *  Below this, they're 1-2 hits from death and retreating to reset, so the bot
 *  must press the chase or the enemy escapes and heals. Kept above
 *  KILL_SECURE_ENEMY_HP_PERCENT (0.15) — the targeting/retreat floor — so pursuit
 *  starts before the enemy crosses into the "free kill" band where every bot
 *  already hard-commits. */
const KILL_PURSUE_HP = 0.3;

/** Decide whether to abandon range-advantage spacing and DASH-pursue to secure
 *  a kill. Fires when: (1) enemy is low-HP (< KILL_PURSUE_HP — 1-2 hits from
 *  death, retreating to reset), OR (2) decisive matchup advantage (enemy has
 *  FISTS, or bot outranges them by >150px — a free kill at any HP). Gated on
 *  dash-ready + closeable distance. Pure (no mutation). */
function shouldPursueKill(
  enemy: EnemyInfo,
  dist: number,
  dashReady: boolean,
  myRange: number,
  enemyRange: number,
  enemyIsFists: boolean,
): boolean {
  if (!dashReady) return false;
  const hpRatio = enemy.health / (enemy.maxHealth || 100);
  const lowHp = hpRatio < KILL_PURSUE_HP;
  const decisiveAdvantage = enemyIsFists || myRange > enemyRange + 150;
  if (!lowHp && !decisiveAdvantage) return false;
  return dist < 450;
}

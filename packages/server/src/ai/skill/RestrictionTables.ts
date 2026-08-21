/**
 * Scoped-incompetence restriction DATA + guards — bot-ai-v2 ticket 08
 * (DEC-009.3).
 *
 * THE PROBLEM THIS SOLVES: low-skill bots must read as BEATABLE HUMANS with
 * learnable habits, not broken AI (Maya's dissent, DEC-009). The scoped
 * incompetence is NARROW and CONSISTENT: a low-tier bot always locks to a
 * small set of weapon classes, never switches slots mid-fight, and never
 * dash-cancels its own windups — all match long, so a player can learn and
 * exploit exactly those habits (SPEC user story 27). High tiers unlock
 * everything (story 28: dangerous through speed and discipline).
 *
 * GDD §14.2 spirit (mistake-chance column): the lock replaces random-looking
 * mistakes with deterministic, learnable ones.
 *
 * Enforcement (the executor/input layer): the guards below are consumed by
 * the slot-selection methods (BotContext.getBestSlot*), the weapon-upgrade
 * decision (isWeaponUpgrade), the SEEK_WEAPON/LOOT target selection, the
 * ENGAGE matchup switch site, the ENGAGE/RANGED dash sites, the RETREAT dash
 * + retreat-switch-spare sites, and the DEMOLITION switch-breaker site
 * (review M2 — the two tricks are enforced at EVERY emission site, not only
 * the engage ones). FISTS are always allowed (never lock a bot out of its
 * default). Chest drops may still place an out-of-class weapon in a slot
 * involuntarily — the lock governs CHOICES (pursue/pickup/switch), never
 * forced equipment: a bot never looks broken refusing to swing a bow it just
 * picked up.
 *
 * ONE EXEMPTION, BY DESIGN: the weapon-break switch
 * (combat/WeaponBreakReaction.ts, 'weapon-break-switch') bypasses
 * botCanSwitchSlotNow for EVERY tier — a broken weapon forces the re-arm;
 * that is survival, not incompetence, and a low-tier bot standing on FISTS
 * next to a loaded spare because its "habit" forbids the swap would read as
 * broken AI, not beatable AI (the forced-equipment principle above).
 *
 * Published per bot AT SPAWN: BotSystem.registerBot derives the restriction
 * set from the assigned difficulty once, stores it on the BotContext, and
 * nothing recomputes it — consistent for the whole match.
 */

import { AttackType, WeaponType, weaponRegistry } from '@sector-battle/shared';
import type { BotContext } from '../BotContext.ts';
import { BotState } from '../BotContextTypes.ts';
import type { DifficultyLevel } from '../intent/PersonalityProfile.ts';

/** A tier's incompetence scope (pure data). */
export interface SkillRestrictions {
  /** The AttackType classes this tier will CHOOSE to use (null = all).
   *  Weapon classes = the game's five AttackType values: ARC, LINE, THROWN,
   *  RANGED, SHIELD. */
  readonly allowedAttackClasses: readonly AttackType[] | null;
  /** May the bot switch weapon slots while an enemy is engaged/nearby? */
  readonly canSwitchSlotsMidFight: boolean;
  /** May the bot dash while in its OWN attack windup (dash-cancel)? */
  readonly canDashDuringOwnWindup: boolean;
}

/**
 * THE per-tier table (DEC-009.3): the two low tiers lock 2 / 3 weapon
 * classes and lose both tricks; medium unlocks classes and slot freedom but
 * keeps the no-dash-cancel discipline; hard/elite unlock everything.
 */
export const RESTRICTIONS_BY_DIFFICULTY: Record<DifficultyLevel, SkillRestrictions> = {
  easy: {
    allowedAttackClasses: [AttackType.ARC, AttackType.LINE],
    canSwitchSlotsMidFight: false,
    canDashDuringOwnWindup: false,
  },
  normal: {
    allowedAttackClasses: [AttackType.ARC, AttackType.LINE, AttackType.RANGED],
    canSwitchSlotsMidFight: false,
    canDashDuringOwnWindup: false,
  },
  medium: {
    allowedAttackClasses: null,
    canSwitchSlotsMidFight: true,
    canDashDuringOwnWindup: false,
  },
  hard: {
    allowedAttackClasses: null,
    canSwitchSlotsMidFight: true,
    canDashDuringOwnWindup: true,
  },
  elite: {
    allowedAttackClasses: null,
    canSwitchSlotsMidFight: true,
    canDashDuringOwnWindup: true,
  },
};

/** Restrictions for a difficulty (lookup — the spawn-time publisher). */
export function restrictionsFor(difficulty: DifficultyLevel): SkillRestrictions {
  return RESTRICTIONS_BY_DIFFICULTY[difficulty];
}

/** May this bot CHOOSE to use the given weapon type? Null restrictions
 *  (unrestricted / test contexts) and FISTS always pass. */
export function botAllowsWeapon(restrictions: SkillRestrictions | null, type: WeaponType): boolean {
  if (!restrictions || restrictions.allowedAttackClasses === null) return true;
  if (type === WeaponType.FISTS) return true;
  return restrictions.allowedAttackClasses.includes(primaryAttackClass(type));
}

/** The weapon's PRIMARY attack class — the class the lock governs. NOT shared
 *  `resolveAttackType`: that animation helper prefers dual-mode `meleeStats`
 *  (THROWING_AXE reads ARC there), which would leak the THROWN class into an
 *  ARC|LINE lock — the axe a low-tier bot "may not choose" would pass. The
 *  registry's top-level attackType is the weapon's identity (THROWN for the
 *  axe, RANGED for bows, …). */
function primaryAttackClass(type: WeaponType): AttackType {
  try {
    return weaponRegistry.getDefinition(type).attackType;
  } catch {
    return AttackType.ARC; // unknown weapon — defensive, same fallback class
  }
}

/** Within-fight definition: an enemy in perception within this range, or an
 *  ENGAGE/RETREAT/DEMOLITION state. Tuning data for the switch gate. */
export const MIDFIGHT_ENEMY_RANGE_PX = 600;

/**
 * May this bot emit a SWITCH_SLOT right now? Unrestricted tiers: yes. Locked
 * tiers: only OUTSIDE a fight (no nearby enemy, not in a combat state) —
 * between fights they still re-equip, so the habit reads as "doesn't fumble
 * with their inventory under pressure", not "never changes weapons".
 */
export function botCanSwitchSlotNow(ctx: BotContext): boolean {
  const r = ctx.restrictions;
  if (!r || r.canSwitchSlotsMidFight) return true;
  if (
    ctx.state === BotState.ENGAGE ||
    ctx.state === BotState.RETREAT ||
    ctx.state === BotState.DEMOLITION
  ) {
    return false;
  }
  const enemy = ctx.nearestEnemy;
  return !(enemy && enemy.distance < MIDFIGHT_ENEMY_RANGE_PX);
}

/**
 * May this bot dash while its OWN attack windup is active (the dash-cancel
 * trick)? Survival overrides are exempt BY DESIGN — the GDD §14.4 instant
 * threat override sits above every skill gate, so the zone-flee dash in
 * executeFleeZone never consults this guard.
 */
export function botCanDashDuringOwnWindup(ctx: BotContext): boolean {
  const r = ctx.restrictions;
  if (!r) return true;
  if (r.canDashDuringOwnWindup) return true;
  return !ctx.isInOwnWindup;
}

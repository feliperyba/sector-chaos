/**
 * Engagement-discretion data + evaluation — bot-ai-v2 ticket 09 (DEC-010.3).
 *
 * Mid-fight DISENGAGE TRIGGERS, as per-archetype DATA (never algorithm
 * constants — the DEC-009 data-table house rule). Four causes:
 *  - 'hp'          own HP fraction below the archetype's floor;
 *  - 'supply'      the active weapon's remaining uses critical (or it just
 *                  broke — WeaponBreakReaction stamps the same trigger);
 *  - 'thirdParty'  a fresh fight stimulus (stimulus fight density) arrived
 *                  near MY engagement from someone who is not my target;
 *  - 'outnumbered' incoming-threat aggregation reaches 2+v-1 (enemies
 *                  committed to ME, off perception's engagedTargetId flag +
 *                  recent-attack/facing reads).
 *
 * Routing: an accepted trigger folds into RetreatAndResetIntent (the intent
 * layer stays the single decision point), which dispatches BotState.RETREAT —
 * ticket-06's NAVIGATED BREAK-LINE RETREAT (BotCombatRetreat) — instead of
 * fighting to the death.
 *
 * MARCUS DISSENT GUARD (discretion must not collapse engagement, CT): the
 * triggers are archetype-SCALED (an AGGRESSOR's floors/radii demand far worse
 * odds than a SURVIVOR's), ALL causes are suppressed while the target is
 * kill-secureable (finishing a 15%-HP enemy is always right), and a cooldown
 * bars trigger churn. The bench gate watches engage-fraction BOTH ways.
 *
 * Determinism: pure flag/geometric reads over (ctx, scan, profile) — zero
 * RNG, zero wall-clock, zero mutation.
 */

import { WeaponType } from '@sector-battle/shared';
import type { BotContext } from '../BotContext.ts';
import type { PersonalityProfile } from '../intent/PersonalityProfile.ts';
import { PersonalityArchetype } from '../intent/PersonalityProfile.ts';
import type { StimulusScanView } from '../stimulus/StimulusScan.ts';

/** The four disengage causes (telemetry keys + evaluation order). */
export type DisengageCause = 'hp' | 'supply' | 'thirdParty' | 'outnumbered';

/** Per-archetype disengage tuning row. */
export interface DiscretionProfile {
  /** Own HP fraction below which 'hp' fires (AGGRESSOR low, SURVIVOR high). */
  readonly hpFloor: number;
  /** Remaining uses of the active weapon at/below which 'supply' fires. */
  readonly supplyCriticalHits: number;
  /** A fight stimulus within this range of ME (px) counts as a third party. */
  readonly thirdPartyRadiusPx: number;
  /** Max age of a fight stimulus (ticks) to still count as "arrived". */
  readonly thirdPartyFreshTicks: number;
  /** Incoming-threat count that trips 'outnumbered' (2 = 2v1). */
  readonly outnumberedAt: number;
}

/** The per-archetype data table of record (DEC-010.3). */
export const ARCHETYPE_DISCRETION: Readonly<Record<PersonalityArchetype, DiscretionProfile>> = {
  // AGGRESSOR: fights through damage and dry ammo; only bails at death's door,
  // ignores single third parties, needs a true 3v1 to reconsider.
  [PersonalityArchetype.AGGRESSOR]: {
    hpFloor: 0.12,
    supplyCriticalHits: 0,
    thirdPartyRadiusPx: 220,
    thirdPartyFreshTicks: 20,
    outnumberedAt: 3,
  },
  // SCAVENGER: values the loot run over a lost fight — early bail, wide
  // third-party ear, standard 2v1 read.
  [PersonalityArchetype.SCAVENGER]: {
    hpFloor: 0.34,
    supplyCriticalHits: 2,
    thirdPartyRadiusPx: 420,
    thirdPartyFreshTicks: 30,
    outnumberedAt: 2,
  },
  // TRAPPER: environmental player — disengages to re-set the trap field.
  [PersonalityArchetype.TRAPPER]: {
    hpFloor: 0.3,
    supplyCriticalHits: 2,
    thirdPartyRadiusPx: 380,
    thirdPartyFreshTicks: 30,
    outnumberedAt: 2,
  },
  // DUELIST: confident in the 1v1 — moderate floor, but hates third parties
  // (they ruin the duel) more than raw odds.
  [PersonalityArchetype.DUELIST]: {
    hpFloor: 0.2,
    supplyCriticalHits: 1,
    thirdPartyRadiusPx: 460,
    thirdPartyFreshTicks: 30,
    outnumberedAt: 2,
  },
  // SURVIVOR: placement-focused — earliest floor, widest ear, standard 2v1.
  [PersonalityArchetype.SURVIVOR]: {
    hpFloor: 0.42,
    supplyCriticalHits: 3,
    thirdPartyRadiusPx: 480,
    thirdPartyFreshTicks: 36,
    outnumberedAt: 2,
  },
};

/**
 * The retreat-intent score floor an accepted cause contributes (folded into
 * RetreatAndResetIntent via max() with the legacy danger score). All above
 * DUEL's realistic band so a trigger reliably wins the next full re-score
 * (mid-commit preemption still respects PREEMPT_MARGIN — an aggressive DUEL
 * commit resists a few ticks; that asymmetry is the dissent guard).
 */
export const DISENGAGE_SCORE: Readonly<Record<DisengageCause, number>> = {
  hp: 0.9,
  supply: 0.78,
  thirdParty: 0.82,
  outnumbered: 0.88,
};

/** Cooldown between accepted triggers (ticks) — bars RETREAT churn. */
export const DISENGAGE_COOLDOWN_TICKS = 90;

/** Recent-attack window for the incoming-threat aggregation (ticks, ~1s —
 * mirrors IntentSignals.ATTACK_RECENT_TICKS). */
const THREAT_ATTACK_RECENT_TICKS = 60;
/** Range within which a recently-attacking enemy counts as ON me (px). */
const THREAT_RANGE_PX = 700;
/** Facing-dot threshold for "their swing was aimed at me". */
const THREAT_FACING_DOT = 0.35;

/**
 * OUTNUMBERED AWARENESS (DEC-010.3 / criterion 4): count the DISTINCT enemies
 * currently committed to THIS bot — the incoming-threat aggregation off
 * perception's engagement flags (deriveEngagement's engagedTargetId) plus the
 * recent-attack/facing read (an enemy that just swung while facing me is on
 * me even when the pairwise heuristic could not name my id). Pure.
 */
export function incomingThreatCount(ctx: BotContext): number {
  let count = 0;
  for (const e of ctx.enemies) {
    if (e.health <= 0) continue;
    if (e.distance > THREAT_RANGE_PX) continue;
    if (e.engagedTargetId === ctx.playerId) {
      count++;
      continue;
    }
    if (ctx.tick - e.lastAttackTick <= THREAT_ATTACK_RECENT_TICKS) {
      const toMeX = ctx.x - e.x;
      const toMeY = ctx.y - e.y;
      const len = Math.sqrt(toMeX * toMeX + toMeY * toMeY) || 1;
      const facingDot = (Math.cos(e.facingAngle) * toMeX + Math.sin(e.facingAngle) * toMeY) / len;
      if (facingDot >= THREAT_FACING_DOT) count++;
    }
  }
  return count;
}

/**
 * Remaining "uses" of a weapon slot: ammo where tracked, else durability
 * (melee durability is the break counter; -1 = infinite → large). Pure.
 */
function remainingUses(ammo: number, durability: number): number {
  if (ammo > 0) return ammo;
  if (durability > 0) return durability;
  return Number.MAX_SAFE_INTEGER; // infinite (FISTS-like) — never critical
}

/**
 * Evaluate the four disengage triggers for this tick. Returns the FIRST
 * accepted cause (severity order: hp > outnumbered > thirdParty > supply) or
 * null. Pure over (ctx, scan, profile) — the caller owns the cooldown stamp.
 *
 * Suppressions (the no-passivity-collapse guards):
 *  - no live target/enemy in reach → no discretion (nothing to disengage FROM);
 *  - kill-secureable target (HP fraction < KILL_SECURE 0.15) → all causes off
 *    (finishing the kill is always correct — mirrors RetreatAndReset G2);
 *  - inside DISENGAGE_COOLDOWN_TICKS of the last accepted trigger → off.
 */
export function evaluateDisengage(
  ctx: BotContext,
  scan: StimulusScanView | undefined,
  profile: PersonalityProfile,
): DisengageCause | null {
  const c = ctx.combat;
  if (!c) return null;
  if (ctx.tick - c.lastDisengageTick < DISENGAGE_COOLDOWN_TICKS) return null;

  // Must actually be IN a fight: a target lock or a near enemy.
  let target = ctx.targetId ? ctx.enemies.find((e) => e.id === ctx.targetId) : null;
  if (!target) target = ctx.nearestEnemy ?? null;
  if (!target || target.health <= 0) return null;
  if (target.distance > 900) return null; // not actually engaged

  // Kill-secure suppression (Marcus dissent): never disengage a finishable kill.
  if (target.health / (target.maxHealth || 100) < 0.15) return null;

  const row = ARCHETYPE_DISCRETION[profile.archetype];

  // 1. HP floor.
  if (ctx.health / (ctx.maxHealth || 100) < row.hpFloor) return 'hp';

  // 2. Outnumbered (incoming-threat aggregation).
  if (incomingThreatCount(ctx) >= row.outnumberedAt) return 'outnumbered';

  // 3. Third party arrived (stimulus fight density near MY seat, fresh, and
  //    not fired by my own target — gunfire from the target is just the fight).
  if (scan) {
    for (const s of scan.entries) {
      if (s.type !== 'attack' && s.type !== 'explosion') continue;
      const age = ctx.tick - s.tick;
      if (age < 0 || age > row.thirdPartyFreshTicks) continue;
      const dx = s.worldX - ctx.x;
      const dy = s.worldY - ctx.y;
      if (Math.sqrt(dx * dx + dy * dy) > row.thirdPartyRadiusPx) continue;
      if (s.type === 'attack' && s.sourcePlayerId === target.id) continue;
      return 'thirdParty';
    }
  }

  // 4. Supply critical (active weapon nearly broken — includes the just-broke
  //    stamp from WeaponBreakReaction: a fresh break IS the critical case).
  const w = ctx.getActiveWeapon();
  if (w.weaponType !== WeaponType.FISTS) {
    if (remainingUses(w.ammo, w.durability) <= row.supplyCriticalHits) return 'supply';
    if (ctx.tick - c.weaponBrokeTick <= 45) return 'supply';
  }
  return null;
}

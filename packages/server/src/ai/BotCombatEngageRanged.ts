/**
 * Ranged ENGAGE executor — verbatim extraction from BotCombatEngage.ts
 * (bot-ai-v2 ticket 08), extended with the ticket-08 combat-cap consumption:
 * the fire-discipline band (attacks only inside `effectiveAttackRange` +
 * the first-shot delay gate) and the dash-cancel restriction on the escape
 * dash. Extracted to hold the 500-line module gate while executeEngage
 * gains the signature/caps/restriction wiring.
 */

import { AttackType, angleTo, normalizeAngle } from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from './BotContext.ts';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import { makeMoveInput, makeDashInput, makeAttackInput } from './BotInput.ts';
import { blendDangerAvoidance, isAttackUnsafeNearBarrel } from './BotCombatShared.ts';
import { strafeDirFor } from './combat/BotCombatWeave.ts';
import { botCanDashDuringOwnWindup } from './skill/RestrictionTables.ts';

export function executeRanged(
  ctx: BotContext,
  enemy: EnemyInfo,
  inputs: QueuedInput[],
  aimAngle: number,
  range: number,
  dist: number,
  cooldownReady: boolean,
  dashReady: boolean,
  /** Effective fire band (range × ATTACK_RANGE_MARGIN × tier factor) — the
   *  fire-discipline sustain-fire-range cap (DEC-009.4). */
  effectiveAttackRange: number,
  /** Fire-discipline first-shot gate (LOS-acquire delay already elapsed). */
  firstShotReady: boolean,
  /** Wall validation on the emitted movement angles (review M1 — threaded
   *  from executeEngage, which gets it from the executor seam). */
  pf: Pathfinder,
): QueuedInput[] {
  const idealRange = range * 0.75;
  const minSafeRange = range * 0.3;
  // DASH-CANCEL RESTRICTION (DEC-009.3): low tiers never dash out of their
  // own windup — the escape dash waits for the swing to finish.
  const dashAllowed = dashReady && botCanDashDuringOwnWindup(ctx);

  if (dist < minSafeRange) {
    const fleeAngle = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
    if (dashAllowed) {
      inputs.push(makeDashInput(ctx.playerId, fleeAngle, ctx.tick, 'ranged-escape'));
      ctx.lastDashTick = ctx.tick;
    }
    inputs.push(
      makeMoveInput(ctx.playerId, blendDangerAvoidance(ctx, fleeAngle, pf), aimAngle, ctx.tick),
    );
    return inputs;
  }

  if (
    cooldownReady &&
    firstShotReady &&
    dist <= effectiveAttackRange &&
    !isAttackUnsafeNearBarrel(ctx, aimAngle, range, AttackType.RANGED)
  ) {
    inputs.push(makeAttackInput(ctx.playerId, aimAngle, ctx.tick));
    ctx.lastAttackTick = ctx.tick;
  }

  if (dist > idealRange * 1.1) {
    const approachAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
    // STICKY WEAVE (DEC-010.1): under fire the strafe-approach side is the
    // committed weave, not the per-tick re-pick.
    const strafeDir = strafeDirFor(ctx, enemy);
    const strafeAngle = normalizeAngle(approachAngle + (strafeDir * Math.PI) / 6);
    inputs.push(
      makeMoveInput(ctx.playerId, blendDangerAvoidance(ctx, strafeAngle, pf), aimAngle, ctx.tick),
    );
  } else if (dist < idealRange * 0.8) {
    const kiteAngle = angleTo(enemy.x, enemy.y, ctx.x, ctx.y);
    inputs.push(
      makeMoveInput(ctx.playerId, blendDangerAvoidance(ctx, kiteAngle, pf), aimAngle, ctx.tick),
    );
  } else {
    // STICKY WEAVE (DEC-010.1): same seam on the hold-band strafe.
    const strafeDir = strafeDirFor(ctx, enemy);
    const baseAngle = angleTo(ctx.x, ctx.y, enemy.x, enemy.y);
    const strafeAngle = normalizeAngle(baseAngle + (strafeDir * Math.PI) / 2);
    inputs.push(
      makeMoveInput(ctx.playerId, blendDangerAvoidance(ctx, strafeAngle, pf), aimAngle, ctx.tick),
    );
  }

  return inputs;
}

/**
 * Stall machinery partial (bot-ai-v2 ticket 06, DEC-005): the universal
 * anti-stall position window (moved verbatim from BotTickPhases.ts to hold
 * the module-length gate) PLUS the stuck-ladder rung-(e) relocation
 * consumption. Both run inside the runAntiStall phase slot (before intent
 * selection — see the driver's phase-order notes).
 */

import { distance } from '@sector-battle/shared';
import type { BotSystem } from './BotSystem.ts';
import { BotState } from './BotContext.ts';
import type { BotContext } from './BotContext.ts';
import { botStateToIntentFamily } from './intent/intents.ts';
import { noteGoalSuspension } from './BotTelemetry.ts';
import {
  GOAL_SUSPEND_TICKS,
  GOAL_SUSPEND_TICKS_LONG,
  BLACKLIST_TICKS,
} from './BotSystemConstants.ts';

/**
 * STUCK-LADDER RUNG (e) CONSUMPTION (DEC-005.2): the ladder's relocation
 * request (set inside navigateTo, which has no BotSystem) executes HERE —
 * goal suspension + forced wander + stall epicenter via the EXISTING
 * relocation mechanism, now the LAST resort of the ladder instead of the
 * first response of the goal-stall. Runs before the anti-stall window so
 * the forced wander is visible to this tick's intent selection.
 */
export function consumeLadderRelocation(system: BotSystem, ctx: BotContext): void {
  if (!ctx.ladder.relocationPending) return;
  ctx.ladder.relocationPending = false;
  suspendCurrentGoal(system, ctx, GOAL_SUSPEND_TICKS);
  ctx.setPath(null);
  ctx.targetId = null;
  ctx.demolitionGridX = -1;
  ctx.demolitionGridY = -1;
  ctx.forceWanderUntilTick = ctx.tick + 60;
  // Ladder discharged — a fresh wedge starts a fresh ladder.
  ctx.ladder.reset();
}

/**
 * Universal anti-stall (brute-force position anchor): every 300 ticks (5s),
 * snapshot the bot's position. On the NEXT 300-tick mark, if the bot hasn't
 * moved >50px from the snapshot, it's stuck in an oscillation loop (moving
 * just enough to defeat finer stall detectors but never escaping). Force a
 * full reset: clear targets/paths/intent, force a wander. This is the
 * backstop that catches ALL stuck patterns regardless of WHY the finer
 * detectors failed (zone damage resetting progress, state-flip resetting
 * per-state timers, oscillation defeating displacement checks).
 *
 * PROGRESS MASK (bot-ai-v2 ticket 06, DEC-005.3): "progress" that exempts
 * the reset is now ONLY completed pickups / kills (lastProgressTick) or
 * pursuit-closing displacement — a wedged bot that is EMITTING ATTACKS or
 * TAKING DAMAGE no longer reads as progressing and gets relocated within
 * the bound (the pre-fix combat exemption is what this ticket removes).
 */
export function runAntiStallWindow(system: BotSystem, ctx: BotContext): void {
  if (ctx.antiStallSnapTick < 0) {
    ctx.antiStallSnapTick = ctx.tick;
    ctx.antiStallSnapX = ctx.x;
    ctx.antiStallSnapY = ctx.y;
    ctx.antiStallSnapTargetDist = currentPursuitDistance(ctx);
  } else if (ctx.tick - ctx.antiStallSnapTick >= 300) {
    const dx = ctx.x - ctx.antiStallSnapX;
    const dy = ctx.y - ctx.antiStallSnapY;
    const moved = Math.sqrt(dx * dx + dy * dy);
    const madeProgress = ctx.tick - ctx.lastProgressTick < 300;
    // PURSUIT-CLOSING PROGRESS: a bot chasing a kiting enemy moves <50px net
    // (the enemy matches its speed) but its distance-to-target keeps dropping.
    // The position-only check mis-flags this as stuck and force-resets it to
    // WANDER, dropping a target it was legitimately pursuing — a "bot flees
    // mid-pursuit" symptom. If the bot is in ENGAGE/HUNT and has closed >80px
    // on its target since the last snapshot, count that as displacement-
    // toward-goal progress (DEC-005.3's sanctioned progress class).
    const curTargetDist = currentPursuitDistance(ctx);
    const closingProgress =
      ctx.antiStallSnapTargetDist > 0 &&
      curTargetDist > 0 &&
      ctx.antiStallSnapTargetDist - curTargetDist > 80;
    ctx.antiStallSnapTick = ctx.tick;
    ctx.antiStallSnapX = ctx.x;
    ctx.antiStallSnapY = ctx.y;
    ctx.antiStallSnapTargetDist = curTargetDist;
    if (moved < 50 && !madeProgress && !closingProgress) {
      // Stuck for 10s with <50px progress — force full reset.
      // SUSPEND the current goal family so the selector can't re-pick it.
      // This is the critical mechanism: forceReevaluate alone just clears
      // the commit window, so the selector immediately re-scores and picks
      // LOOT again (items still visible). Suspending the family excludes it
      // entirely for the window, forcing a fall-through to HUNT/WANDER.
      const suspendFamily = botStateToIntentFamily(ctx.state);
      const selector = system.selectors.get(ctx.playerId);
      if (selector) {
        selector.suspend(suspendFamily, ctx.tick + GOAL_SUSPEND_TICKS_LONG);
        selector.forceReevaluate();
      }
      noteGoalSuspension(system, ctx.playerId, suspendFamily);
      ctx.setPath(null);
      ctx.targetId = null;
      ctx.demolitionGridX = -1;
      ctx.demolitionGridY = -1;
      ctx.forceWanderUntilTick = ctx.tick + 90;
      // A forced relocation invalidates any in-flight ladder episode.
      ctx.ladder.reset();
      // Blacklist ALL currently-visible items so the bot is forced to wander to
      // a new area entirely, not just cycle to the next unreachable item in the
      // same sector.
      if (ctx.nearestWeapon)
        ctx.blacklistedItems.set(ctx.nearestWeapon.id, ctx.tick + BLACKLIST_TICKS);
      if (ctx.nearestChest)
        ctx.blacklistedItems.set(ctx.nearestChest.id, ctx.tick + BLACKLIST_TICKS);
      if (ctx.nearestHealth)
        ctx.blacklistedItems.set(ctx.nearestHealth.id, ctx.tick + BLACKLIST_TICKS);
      if (ctx.nearestBarrier)
        ctx.blacklistedItems.set(ctx.nearestBarrier.id, ctx.tick + BLACKLIST_TICKS);
      if (ctx.nearestSpeedBoost)
        ctx.blacklistedItems.set(ctx.nearestSpeedBoost.id, ctx.tick + BLACKLIST_TICKS);
    }
  }
}

/** Suspend the intent family that drives the bot's current BotState for
 *  `ticks` ticks (same mechanism as BotTickUtilities.suspendCurrentGoal —
 *  kept local so this partial owns its full stall-response surface). */
function suspendCurrentGoal(system: BotSystem, ctx: BotContext, ticks: number): void {
  const sel = system.selectors.get(ctx.playerId);
  if (!sel) return;
  const family = botStateToIntentFamily(ctx.state);
  sel.suspend(family, ctx.tick + ticks);
  noteGoalSuspension(system, ctx.playerId, family);
  ctx.stallEpicenterX = ctx.x;
  ctx.stallEpicenterY = ctx.y;
  ctx.stallEpicenterTick = ctx.tick;
}

/** Current distance to the bot's pursuit target (live enemy, or last-known
 *  position if the enemy is momentarily out of perception). Returns -1 when the
 *  bot has no pursuit target (not in ENGAGE/HUNT, or no enemy/memory). Used by
 *  the universal anti-stall to detect CLOSING progress — a pursuing bot whose
 *  target distance drops is making real combat progress even if its net position
 *  displacement is small (kiting enemy matches speed). */
function currentPursuitDistance(ctx: BotContext): number {
  if (ctx.state !== BotState.ENGAGE && ctx.state !== BotState.HUNT) return -1;
  if (ctx.nearestEnemy) return ctx.nearestEnemy.distance;
  // HUNT chases last-known position when the enemy is out of perception.
  if (ctx.tick - ctx.lastSeenEnemyTick < 480) {
    return distance(ctx.x, ctx.y, ctx.lastSeenEnemyX, ctx.lastSeenEnemyY);
  }
  return -1;
}

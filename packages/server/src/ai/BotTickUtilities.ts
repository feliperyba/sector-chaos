/**
 * Per-tick utility helpers extracted verbatim from the original BotSystem.ts.
 *
 * Each function body is byte-identical to the original method except `this.`
 * → `system.`. Behavior is provably preserved by construction.
 */

import { angleTo, distance } from '@sector-battle/shared';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { BotSystem } from './BotSystem.ts';
import type { BotContext } from './BotContext.ts';
import { makeDashInput } from './BotInput.ts';
import { botStateToIntentFamily } from './intent/intents.ts';
import { noteGoalSuspension } from './BotTelemetry.ts';
import {
  DASH_COOLDOWN_TICKS,
  GOAL_SUSPEND_TICKS,
  GOAL_SUSPEND_TICKS_LONG,
} from './BotSystemConstants.ts';

/**
 * Grab-while-passing: power-ups (barrier/speed-boost) auto-collect on walk-over
 * (GameSimulationWalkovers.checkPowerUpWalkOverSim fires whenever the bot's
 * position is within PICKUP_RADIUS). A bot moving past a powerup will collect
 * it automatically — no PICKUP action is needed (and a PICKUP input for a
 * powerup is a silent no-op that would halt the bot mid-path). So this helper
 * no longer emits a pickup; it returns null and lets the walkover handle it.
 *
 * Health packs are left to LOOT/RETREAT (those need HP gating). Barriers and
 * speed-boosts are always worth taking if the bot passes through their radius,
 * which the auto-collect guarantees. Returning null preserves the bot's current
 * movement toward its real goal while still snatching the free powerup.
 */
export function checkGrabWhilePassing(system: BotSystem, ctx: BotContext): QueuedInput | null {
  void system;
  void ctx;
  return null;
}

/**
 * Mobility dash: if the bot is far from its goal and dash is ready, dash toward
 * the goal to close the gap. Reads as urgency/purpose instead of a stroll — the
 * polish that makes "a bot walking 600px to a weapon" feel like "a bot sprinting
 * to re-arm." Only fires outside combat (ENGAGE/RETREAT manage their own dashes).
 * @returns a dash-toward-goal input, or null to continue normally.
 */
export function checkMobilityDash(
  _system: BotSystem,
  ctx: BotContext,
  goalX: number,
  goalY: number,
): QueuedInput | null {
  const dashReady = ctx.tick - ctx.lastDashTick >= DASH_COOLDOWN_TICKS;
  if (!dashReady) return null;
  const dist = distance(ctx.x, ctx.y, goalX, goalY);
  if (dist < 400) return null; // close enough — walk, don't waste the dash
  ctx.lastDashTick = ctx.tick;
  return makeDashInput(
    ctx.playerId,
    angleTo(ctx.x, ctx.y, goalX, goalY),
    ctx.tick,
    'mobility-commute',
  );
}

/**
 * Position-stall escape: if a SEEK_WEAPON/LOOT bot hasn't moved meaningfully
 * in a window, it's pressing against collision geometry the pathfinder grid
 * says is walkable but the SAT collider blocks (the bot emits move inputs the
 * physics zeroes — "moving in intent, stationary in reality"). Position-based
 * (not target-id-based, because perception shuffles "nearest" every few ticks,
 * defeating target-id tracking).
 *
 * STALL → SUSPEND: when a stall fires, the bot's CURRENT intent is suspended
 * in the IntentSelector for GOAL_SUSPEND_TICKS. During suspension the
 * selector can't re-pick it, so the bot falls through to a DIFFERENT goal
 * (armed → HUNT, unarmed → WANDER) that relocates it. This is the structural
 * fix for the LOOT→WANDER→LOOT oscillation: the old code forceWandered for
 * 60 ticks but that was invisible to the selector, which re-picked LOOT the
 * moment the commit window expired (items still visible from the same spot).
 * Suspending at the decision layer breaks the loop at its source.
 * @returns true if the bot should defer to WANDER this tick.
 */
export function checkGoalStall(system: BotSystem, ctx: BotContext): boolean {
  if (ctx.tick < ctx.forceWanderUntilTick) return true;
  // SHORT window (2s / 40px): catches hard stalls (bot not moving at all).
  const STALL_TICKS = 90; // 1.5s
  const STALL_PROGRESS_PX = 25; // <25px in 1.5s = stuck (was 40 — oscillating bots passed it)
  const elapsed = ctx.tick - ctx.goalStartTick;
  if (elapsed > STALL_TICKS) {
    const dx = ctx.x - ctx.goalStartX;
    const dy = ctx.y - ctx.goalStartY;
    const moved = Math.sqrt(dx * dx + dy * dy);
    ctx.goalStartTick = ctx.tick;
    ctx.goalStartX = ctx.x;
    ctx.goalStartY = ctx.y;
    if (moved < STALL_PROGRESS_PX) {
      // SUSPENSION DEMOTED TO LAST RESORT (bot-ai-v2 ticket 06, DEC-005.2):
      // while the stuck ladder is engaged and still inside its total budget,
      // it owns the recovery (sidestep → back up → replan → smash → and only
      // then its OWN relocation). The legacy short-window suspend yields —
      // the window has already re-anchored above, so deferring here just
      // gives the ladder its next detection window.
      if (ctx.ladder.preemptsLegacySuspension(ctx.tick)) return false;
      suspendCurrentGoal(system, ctx, GOAL_SUSPEND_TICKS);
      ctx.forceWanderUntilTick = ctx.tick + 60;
      ctx.setPath(null);
      return true;
    }
  } else if (ctx.goalStartTick < 0) {
    ctx.goalStartTick = ctx.tick;
    ctx.goalStartX = ctx.x;
    ctx.goalStartY = ctx.y;
  }
  // LONG window (10s / 100px): catches micro-oscillation — a bot that wiggles
  // just enough to reset the short window (>40px/2s) but never actually escapes
  // (e.g. oscillating against geometry). The diagnostic found 108-second stalls
  // from exactly this: the bot moved ~41px every 120 ticks, passing the short
  // threshold, but was effectively trapped. The long window catches it.
  const LONG_STALL_TICKS = 600; // 10s
  const LONG_STALL_PROGRESS_PX = 100;
  const longElapsed = ctx.tick - ctx.longStallStartTick;
  if (longElapsed > LONG_STALL_TICKS) {
    const ldx = ctx.x - ctx.longStallStartX;
    const ldy = ctx.y - ctx.longStallStartY;
    const longMoved = Math.sqrt(ldx * ldx + ldy * ldy);
    ctx.longStallStartTick = ctx.tick;
    ctx.longStallStartX = ctx.x;
    ctx.longStallStartY = ctx.y;
    if (longMoved < LONG_STALL_PROGRESS_PX) {
      suspendCurrentGoal(system, ctx, GOAL_SUSPEND_TICKS_LONG);
      ctx.forceWanderUntilTick = ctx.tick + 90; // longer wander to fully break free
      ctx.setPath(null);
      return true;
    }
  } else if (ctx.longStallStartTick < 0) {
    ctx.longStallStartTick = ctx.tick;
    ctx.longStallStartX = ctx.x;
    ctx.longStallStartY = ctx.y;
  }
  return false;
}

/** Suspend the intent family that drives the bot's current BotState for
 *  `ticks` ticks. After the suspension, the selector can't pick that intent,
 *  so the bot falls through to a different goal that relocates it. Also
 *  records the stall epicenter so WANDER relocates AWAY from this point
 *  (otherwise a suspended HUNT bot wanders ~800px — still within the 3400px
 *  hotspot attract range — and re-enters HUNT at the same dead spot when the
 *  suspension expires). No-op if the bot has no selector or the current
 *  state maps to WANDER/FLEE_ZONE. */
export function suspendCurrentGoal(system: BotSystem, ctx: BotContext, ticks: number): void {
  const sel = system.selectors.get(ctx.playerId);
  if (!sel) return;
  const family = botStateToIntentFamily(ctx.state);
  sel.suspend(family, ctx.tick + ticks);
  noteGoalSuspension(system, ctx.playerId, family);
  ctx.stallEpicenterX = ctx.x;
  ctx.stallEpicenterY = ctx.y;
  ctx.stallEpicenterTick = ctx.tick;
}

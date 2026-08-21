/**
 * Sticky zigzag weave — bot-ai-v2 ticket 09 (DEC-010.1).
 *
 * THE TELL THIS FIXES: under projectile fire the old combat strafe re-picked
 * its side effectively at hazard-score whim — per-tick direction flips read
 * as an AI jitterbug, not a human strafe (BRP §2.C: humans COMMIT to a
 * strafe; the commit is what makes the weave readable at top-down zoom —
 * Shinji's dissent resolution, 0.5-1 s).
 *
 * THE MODEL: while under projectile fire the bot weaves PERPENDICULAR to the
 * threat axis on a side drawn from the per-bot BotRNG, committed for a window
 * drawn in [WEAVE_MIN_COMMIT_TICKS, WEAVE_MAX_COMMIT_TICKS] (0.5-1 s at 60
 * ticks/s). Within the window the side NEVER re-draws — no per-tick
 * re-weaving. The Reactor's projectile/windup dodges SEED the weave with the
 * dodge's own committed side (seedWeaveFromReaction), so the reflex and the
 * sustained strafe read as one continuous human movement (the ticket-09
 * combat-side integration of ticket 04's un-gated windup dodges).
 *
 * Determinism: the side + window draws are the ONLY stochastic seams and
 * both route through ctx.rng (per-bot BotRNG — the byte-identity contract
 * holds). No wall-clock reads; everything is tick arithmetic.
 */

import { normalizeAngle } from '@sector-battle/shared';
import type { BotContext, EnemyInfo } from '../BotContext.ts';
import { pickStrafeDir, STRAFE_MIN_TICKS, STRAFE_MAX_TICKS } from '../BotCombatShared.ts';

/** Minimum weave commitment window (ticks) — 0.5 s (DEC-010.1 lower bound). */
export const WEAVE_MIN_COMMIT_TICKS = 30;
/** Maximum weave commitment window (ticks) — 1.0 s (DEC-010.1 upper bound). */
export const WEAVE_MAX_COMMIT_TICKS = 60;
/** A projectile within this range and closing counts as "under fire" (px). */
export const WEAVE_UNDER_FIRE_RANGE_PX = 340;
/** Angular offset of the weaving APPROACH from the direct approach axis
 *  (radians) — a zigzag close-in rather than a perpendicular stall. */
export const WEAVE_APPROACH_OFFSET_RAD = Math.PI / 3.2; // ~56°

/**
 * Is the bot under projectile fire this tick? TRUE when any perceived
 * projectile is inside WEAVE_UNDER_FIRE_RANGE_PX and its velocity closes on
 * the bot (the same incoming test blendDangerAvoidance uses, hoisted here as
 * the under-fire predicate). Pure read over the per-tick hazard rescan's
 * projectile list — no queries, no allocation.
 */
export function underProjectileFire(ctx: BotContext): boolean {
  for (const proj of ctx.projectiles) {
    if (proj.distance > WEAVE_UNDER_FIRE_RANGE_PX) continue;
    const dx = ctx.x - proj.x;
    const dy = ctx.y - proj.y;
    if (dx * proj.vx + dy * proj.vy > 0) return true; // closing on us
  }
  return false;
}

/**
 * The committed weave side (+1 | -1). Draws (per-bot RNG) a fresh side +
 * window only when no commitment is live; inside the window the side is
 * returned unchanged — the stickiness. Fresh commitments bump the pending
 * telemetry counters on ctx.combat (drained by recordTickTelemetry).
 */
export function weaveSide(ctx: BotContext): number {
  const c = ctx.combat;
  if (c && ctx.tick < c.weaveUntilTick && c.weaveDir !== 0) return c.weaveDir;
  const dir = ctx.rng.next() < 0.5 ? -1 : 1;
  // int() is max-EXCLUSIVE: +1 keeps the 60-tick upper bound reachable.
  const window = ctx.rng.int(WEAVE_MIN_COMMIT_TICKS, WEAVE_MAX_COMMIT_TICKS + 1);
  if (c) {
    c.weaveDir = dir;
    c.weaveUntilTick = ctx.tick + window;
    c.pendingWeaveCommits++;
    c.pendingWeaveCommitTicks += window;
  }
  return dir;
}

/**
 * The weave movement angle: perpendicular to the threat axis on the committed
 * side. The threat axis is evaluated per tick (a dodge tracks the CURRENT
 * source of fire); the committed SIDE is what provides the human strafe
 * stickiness. Pure given weaveSide's commitment state.
 */
export function weaveMoveAngle(ctx: BotContext, threatAngle: number): number {
  const side = weaveSide(ctx);
  return normalizeAngle(threatAngle + (side * Math.PI) / 2);
}

/**
 * The REACTOR HANDOFF (ticket-09 combat-side integration): adopt the dodge
 * reaction's committed side as the weave side with a fresh full window, so
 * the post-dodge movement continues in the SAME direction instead of
 * re-rolling into a fresh sidestep (the readable dodge→strafe continuation).
 * Called from BotReactor.activate for projectile/windup reactions only.
 */
export function seedWeaveFromReaction(ctx: BotContext, side: number): void {
  const c = ctx.combat;
  if (!c) return;
  // int() is max-EXCLUSIVE: +1 keeps the 60-tick upper bound reachable.
  const window = ctx.rng.int(WEAVE_MIN_COMMIT_TICKS, WEAVE_MAX_COMMIT_TICKS + 1);
  const changed = c.weaveDir !== side || ctx.tick >= c.weaveUntilTick;
  c.weaveDir = side;
  c.weaveUntilTick = ctx.tick + window;
  if (changed) {
    c.pendingWeaveCommits++;
    c.pendingWeaveCommitTicks += window;
  }
}

/**
 * THE COMBAT-MOVEMENT SEAM: the strafe-direction picker every combat site
 * calls. Under projectile fire → the sticky weave side (perpendicular to the
 * enemy axis); otherwise → the legacy hazard-scored strafe with its original
 * 20-45-tick window (unchanged behavior when not under fire — the weave is
 * strictly the under-fire upgrade). Null-tolerates a literal-cast test ctx
 * without `combat` (falls back to the legacy path).
 */
export function strafeDirFor(ctx: BotContext, enemy: EnemyInfo): number {
  if (ctx.combat && underProjectileFire(ctx)) return weaveSide(ctx);
  if (ctx.tick >= ctx.strafeUntilTick) {
    ctx.strafeDir = pickStrafeDir(ctx, enemy);
    ctx.strafeUntilTick =
      ctx.tick + STRAFE_MIN_TICKS + ctx.rng.int(0, STRAFE_MAX_TICKS - STRAFE_MIN_TICKS);
  }
  return ctx.strafeDir;
}

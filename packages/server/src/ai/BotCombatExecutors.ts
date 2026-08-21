/**
 * Combat state executors extracted verbatim from the original BotSystem.ts.
 *
 * Each function body is byte-identical to the original method except `this.`
 * → `system.`. Behavior is provably preserved by construction.
 */

import { angleTo, distance } from '@sector-battle/shared';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { BotSystem } from './BotSystem.ts';
import type { BotContext } from './BotContext.ts';
import type { TickBlackboard } from './TickBlackboard.ts';
import { BotState } from './BotContext.ts';
import { selectTarget } from './BotTargeting.ts';
import { executeEngage, executeRetreat, executeDemolition } from './BotCombat.ts';
import { navigateTo } from './BotNavigation.ts';
import { makeMoveInput } from './BotInput.ts';
import { reactToWeaponBreak } from './combat/WeaponBreakReaction.ts';
import { packGridKey } from './BotDestructibles.ts';
import { DEFAULT_PROFILE } from './intent/PersonalityProfile.ts';
import { clearEnemyHistory } from './BotContextEnemyHistory.ts';

export function executeEngageState(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
): QueuedInput[] | null {
  // WEAPON-BREAK REACTION (bot-ai-v2 ticket 09, DEC-010.7): the immediate
  // visible response to the active weapon breaking mid-fight — an instant
  // forced switch when a spare exists, else a one-tick fighting withdrawal +
  // re-evaluation (ARM_UP grabs / discretion-supply retreats). Runs before
  // targeting: a broken-weapon bot has nothing to duel WITH until it reacts.
  const breakReaction = reactToWeaponBreak(system, ctx);
  if (breakReaction) return breakReaction;

  const target = selectTarget(ctx, bb.huntersPerTarget);
  if (!target) return [];
  // Register this bot as a hunter on its chosen target so later bots this
  // tick see the contest count and prefer a less-contested target.
  bb.huntersPerTarget.set(target.id, (bb.huntersPerTarget.get(target.id) ?? 0) + 1);

  // Stale-engagement detection: if this is a new target, record the start
  // distance/tick. If we've been chasing the SAME target for a long time
  // without closing distance or dealing damage, the target is unreachable
  // (likely behind a solid wall we can't path around or break). Drop it and
  // fall back to HUNT so the bot seeks a reachable enemy instead of orbiting
  // forever — the #1 cause of combat starvation.
  const targetChanged = ctx.targetId !== target.id;
  if (targetChanged) {
    ctx.engageStartTick = ctx.tick;
    ctx.engageStartDist = target.distance;
  }
  const STALE_ENGAGE_TICKS = 180; // 3s with no progress = unreachable
  // Compute LOS early — the stale check (below) and the no-LOS navigation path
  // both need it. Cached per-tick per-target to amortize the raycast cost.
  let hasLOS: boolean;
  const cached = ctx.getCachedLOS(target.id, ctx.tick);
  if (cached !== undefined) {
    hasLOS = cached;
  } else {
    hasLOS = system.pathfinder.hasLineOfSightWorld(
      { x: ctx.x, y: ctx.y },
      { x: target.x, y: target.y },
    );
    ctx.setCachedLOS(target.id, ctx.tick, hasLOS);
  }
  // LOS-HELD TRACKING (bot-ai-v2 ticket 08, DEC-009.4): the fire-discipline
  // cap's first-shot delay counts from LOS (re)acquisition on the current
  // target. Maintained here — the only site that knows both the target and
  // the fresh LOS bit — and read by executeEngage's fire gates via
  // ctx.losHeldSinceTick. A target change or a LOS drop resets the clock
  // (re-acquiring re-arms the delay: the human "reacquire your swing" beat).
  if (hasLOS) {
    if (ctx.losHeldTargetId !== target.id || ctx.losHeldSinceTick < 0) {
      ctx.losHeldTargetId = target.id;
      ctx.losHeldSinceTick = ctx.tick;
    }
  } else {
    ctx.losHeldTargetId = null;
    ctx.losHeldSinceTick = -1;
  }
  // IN-RANGE EXEMPTION: the stale check must NOT fire when the bot has LOS to
  // the target AND is within attack range. The old check used lastAttackTick
  // (>180 ticks since a hit) as a progress signal, but that's wrong for a bot
  // that's in combat position but simply hasn't LANDED a hit yet (bad aim,
  // suppressed by barrel gate, LINE timing gate, etc.). The result was a
  // DUEL→ENGAGE→stale-drop→HUNT→DUEL bounce every 180 ticks: the bot enters
  // ENGAGE, the stale check fires immediately (lastAttackTick is ancient),
  // drops to HUNT, DUEL re-wins next tick, repeat — the bot never stays in
  // ENGAGE long enough to actually swing. Two bots at 96px with LOS would
  // circle forever in this bounce, neither attacking (the face-to-face stall).
  // Now: only declare stale when the bot is NOT in a fightable position — i.e.
  // either no LOS (truly unreachable) OR far outside attack range (chasing but
  // not closing). A bot with LOS + in-range is actively fighting, not stale.
  const myRange = ctx.getWeaponRange(ctx.getActiveWeapon().weaponType);
  const inFightRange = target.distance < myRange * 1.3;
  const stale =
    ctx.tick - ctx.engageStartTick > STALE_ENGAGE_TICKS &&
    target.distance < ctx.engageStartDist + 60 && // didn't close meaningfully
    ctx.tick - ctx.lastAttackTick > STALE_ENGAGE_TICKS && // haven't landed a hit
    (!hasLOS || !inFightRange); // NOT in a fightable position (no LOS or out of range)
  if (stale) {
    ctx.targetId = null;
    clearEnemyHistory(ctx, target.id);
    ctx.lastSeenEnemyTick = -9999;
    ctx.state = BotState.HUNT;
    const ang = angleTo(ctx.x, ctx.y, target.x, target.y);
    return [makeMoveInput(ctx.playerId, ang, ang, ctx.tick)];
  }

  if (!hasLOS) {
    const input = navigateTo(
      ctx,
      target.x,
      target.y,
      system.pathfinder,
      120,
      system.destructibleMap,
    );
    if (input === null && ctx.demolitionGridX >= 0) {
      ctx.preDemolitionState = BotState.ENGAGE;
      ctx.state = BotState.DEMOLITION;
      return null;
    }
    if (input) return [input];
    // No path AND no demolition target: the enemy is unreachable (solid wall,
    // no destructible to break). Do NOT straight-line into the wall — that
    // freezes the bot pushing against the obstacle (the dominant cause of
    // "stuck in combat not moving"). Drop the target and let HUNT find a
    // reachable enemy. The stale-engagement check below also covers this, but
    // only after a 3s timeout; dropping immediately when pathing fails is
    // cleaner and avoids the freeze window entirely.
    //
    // IDLE FIX: previously this returned `null` for targets ≥150px away,
    // which emits NO input — the bot stood still in ENGAGE for up to 3s
    // waiting for the stale timer, visibly "idling with an enemy around."
    // Now we drop the unreachable target regardless of distance and hand off
    // to HUNT, which either re-acquires via last-known-position or picks a
    // new reachable enemy. This eliminates the idle window entirely.
    ctx.targetId = null;
    clearEnemyHistory(ctx, target.id);
    // OSCILLATION FIX: same as the stale-engagement drop above — clear
    // lastSeenEnemyTick so HUNT doesn't re-chase this proven-unreachable coord
    // next tick (engage→hunt→engage stutter against a solid wall).
    ctx.lastSeenEnemyTick = -9999;
    ctx.state = BotState.HUNT;
    return [];
  }

  if (target.distance > 1000) {
    // Long-range approach: use pathfinding instead of a straight-line move.
    // A straight-line move walks into walls and gets stuck; pathfinding routes
    // around obstacles so the bot actually closes distance and reaches combat.
    // Pass the destructible map so a bot walled off from a distant enemy
    // breaks through instead of sliding along the wall forever.
    const input = navigateTo(
      ctx,
      target.x,
      target.y,
      system.pathfinder,
      900,
      system.destructibleMap,
    );
    if (input === null && ctx.demolitionGridX >= 0) {
      ctx.preDemolitionState = BotState.ENGAGE;
      ctx.state = BotState.DEMOLITION;
      return null;
    }
    if (input) return [input];
    // Fallback: straight-line if pathfinding fails (no path / at arrival).
    const angle = angleTo(ctx.x, ctx.y, target.x, target.y);
    return [makeMoveInput(ctx.playerId, angle, angle, ctx.tick)];
  }
  // DESTRUCTIBLE-WEDGE GUARD: executeEngage (BotCombat) does combat strafing/
  // approach movement that does NOT call navigateTo, so it never runs the
  // demolition triggers. A bot pressing toward an enemy through a destructible
  // wall would wedge against it for up to 3s (the stale-engagement timeout),
  // visibly "stuck on a wall." This was invisible to the harness (which only
  // measures DEMOLITION-state episodes) and is the dominant real-play wall-
  // stuck cause. Fix: before combat movement, probe the tile directly between
  // the bot and the target; if it's a destructible, trigger demolition. Fires
  // regardless of distance — even a ranged bot 800px away with a wall between
  // it and the target should break through, not wedge. (An adjacent-stall
  // variant was tried and reverted — it over-fired, sending too many bots into
  // DEMOLITION and increasing demolition-cooldown idle. The direct-toward-
  // target probe is the clean fix.)
  if (system.destructibleMap.size > 0) {
    const ts = system.pathfinder.getTileSize();
    const dx = target.x - ctx.x;
    const dy = target.y - ctx.y;
    const distToTarget = Math.sqrt(dx * dx + dy * dy) || 1;
    // Trigger A — direct: a destructible is immediately ahead toward the
    // target (the bot is pressing INTO it to reach the enemy).
    const probeX = ctx.x + (dx / distToTarget) * ts * 0.7;
    const probeY = ctx.y + (dy / distToTarget) * ts * 0.7;
    const probeGrid = system.pathfinder.worldToGrid({ x: probeX, y: probeY });
    const probeKey = packGridKey(probeGrid.x, probeGrid.y);
    let wedgeGridX = -1;
    let wedgeGridY = -1;
    if (system.destructibleMap.has(probeKey)) {
      wedgeGridX = probeGrid.x;
      wedgeGridY = probeGrid.y;
    } else {
      // Trigger B — velocity-wedge: the bot has near-zero velocity (collision
      // is stopping it despite move inputs) AND a destructible is adjacent.
      // This catches the strafe-into-wall case (wall not toward target, but
      // the bot is wedged sideways). The velocity gate makes it PRECISE: a
      // bot legitimately strafing has real velocity and won't trigger; only a
      // bot whose movement is being zeroed by collision fires. This is the
      // fix the previous adjacent-stall variant lacked (it over-fired because
      // it used position-displacement which is noisy; velocity is the direct
      // collision-stopped signal).
      //
      // MULTI-TICK CONFIRMATION: a single speed<1.0 frame is too eager — a
      // combat strafe that momentarily slows (turning, collision nudge, attack
      // windup speed penalty) trips demolition and sends the bot into a 5s
      // wall-break mid-fight while the enemy escapes or kills it. Require the
      // low-speed state to PERSIST for ≥6 ticks (~0.1s) before diverting. A
      // genuine wedge (bot pressed into a wall by collision) stays at ~0 speed
      // indefinitely, so the confirmation doesn't delay a real break; it only
      // filters transient slowdowns. lowSpeedSinceTick is updated every tick
      // below regardless of whether a destructible is adjacent (so the count
      // is accurate the moment one comes into adjacency).
      const speed = Math.sqrt(ctx.vx * ctx.vx + ctx.vy * ctx.vy);
      if (speed < 1.0) {
        if (ctx.lowSpeedSinceTick < 0) ctx.lowSpeedSinceTick = ctx.tick;
      } else {
        ctx.lowSpeedSinceTick = -9999;
      }
      const LOW_SPEED_CONFIRM_TICKS = 6;
      if (
        ctx.lowSpeedSinceTick >= 0 &&
        ctx.tick - ctx.lowSpeedSinceTick >= LOW_SPEED_CONFIRM_TICKS
      ) {
        const gx = Math.floor(ctx.x / ts);
        const gy = Math.floor(ctx.y / ts);
        for (let ax = -1; ax <= 1 && wedgeGridX < 0; ax++) {
          for (let ay = -1; ay <= 1 && wedgeGridY < 0; ay++) {
            if (ax === 0 && ay === 0) continue;
            if (system.destructibleMap.has(packGridKey(gx + ax, gy + ay))) {
              wedgeGridX = gx + ax;
              wedgeGridY = gy + ay;
            }
          }
        }
      }
    }
    if (wedgeGridX >= 0) {
      ctx.demolitionTargetX = wedgeGridX * ts + ts / 2;
      ctx.demolitionTargetY = wedgeGridY * ts + ts / 2;
      ctx.demolitionGridX = wedgeGridX;
      ctx.demolitionGridY = wedgeGridY;
      ctx.preDemolitionState = BotState.ENGAGE;
      ctx.state = BotState.DEMOLITION;
      return [];
    }
  }
  return executeEngage(
    ctx,
    target,
    system.profiles.get(ctx.playerId) ?? DEFAULT_PROFILE,
    system.reactor.startleAimPenalty(ctx.playerId, ctx.tick),
    system.pathfinder,
  );
}

export function executeRetreatState(system: BotSystem, ctx: BotContext): QueuedInput[] {
  const enemy = ctx.nearestEnemy;
  if (!enemy) return [];
  // Power-ups (barrier / health pack) auto-collect on walk-over — a fleeing
  // bot moving past one will grab it automatically (checkPowerUpWalkOverSim).
  // Previously this emitted a PICKUP for in-range powerups, but PICKUP is a
  // no-op for powerups AND it halted the retreat (single pickup input, no
  // movement) — exactly the wrong move for a bot under fire. Continue the
  // retreat; the retreat path steers the bot through the powerup's radius and
  // the auto-collect snatches it without stopping.
  const inputs = executeRetreat(
    ctx,
    enemy,
    system.profiles.get(ctx.playerId) ?? DEFAULT_PROFILE,
    system.reactor.startleAimPenalty(ctx.playerId, ctx.tick),
    system.pathfinder,
    system.destructibleMap,
  );
  // NAVIGATED-RETREAT DEMOLITION HANDOFF (bot-ai-v2 ticket 06, DEC-005.4):
  // the retreat path may route THROUGH a destructible (the shorter safe
  // path); navigateTo flagged it via the standard demolition-target fields —
  // same handoff contract as every other navigateTo caller.
  if (ctx.demolitionGridX >= 0) {
    ctx.preDemolitionState = BotState.RETREAT;
    ctx.state = BotState.DEMOLITION;
  }
  return inputs;
}

export function executeDemolitionState(system: BotSystem, ctx: BotContext): QueuedInput[] {
  if (ctx.demolitionGridX < 0) {
    ctx.state = ctx.preDemolitionState;
    return [];
  }

  const destructibleKey = packGridKey(ctx.demolitionGridX, ctx.demolitionGridY);
  const stillExists = system.destructibleMap.has(destructibleKey);
  if (!stillExists) {
    ctx.demolitionGridX = -1;
    ctx.demolitionGridY = -1;
    ctx.setPath(null);
    ctx.state = ctx.preDemolitionState;
    // Demolition SUCCESS: the bot broke through a wall/crate it was wedged
    // against — the obstruction that caused any prior stall is now gone.
    // Clear suspensions so the selector can re-route to LOOT/HUNT if the
    // now-open path makes them attractive again.
    const sel = system.selectors.get(ctx.playerId);
    if (sel) sel.clearSuspensions();
    ctx.stallEpicenterTick = -9999;
    // LADDER RESET on demolition SUCCESS (DEC-005.2): the blocker that
    // wedged the bot is gone — the ladder episode is complete (its SMASH
    // rung won), not still pending. Without this, the first post-breach
    // navigateTo window sees the demolition-episode displacement against a
    // stale anchor and could mis-escalate a dead SMASH rung to RELOCATE.
    ctx.ladder.reset();
    // (PROGRESS-MASK, DEC-005.3: breaking a wall no longer stamps
    // lastProgressTick — only displacement/pickups/kills count. The DEMOLITION
    // flow has its own timeout; a breach that never translates into movement
    // must remain relocatable.)
    return [];
  }

  // NOTE: demolitionTick is set ONCE when demolition begins (in the yield guard
  // at line ~844), not every tick here. It tracks the START of the episode for
  // the 5s timeout, not the last tick it ran.

  // Aim at the REAL SAT collider polygon centroid, not the tile-center /
  // raycast point that navigateTo wrote into demolitionTargetX/Y. The server's
  // hit test (MeleeSweepHandler → CollisionService.segmentIntersectsTileCollider)
  // tests the same transformed artist polygon; aiming at its centroid is what
  // aligns the bot's swing with that test. Without this, off-center wall
  // colliders are missed ~88% of the time and the bot swings forever.
  const centroid = system.destructibleCentroidMap.get(destructibleKey);
  const aimX = centroid ? centroid.x : ctx.demolitionTargetX;
  const aimY = centroid ? centroid.y : ctx.demolitionTargetY;
  // Distance-for-bail still uses the nav target (where the bot is heading);
  // the aim point may be a few px off and shouldn't trip the too-far guard.
  const targetX = ctx.demolitionTargetX;
  const targetY = ctx.demolitionTargetY;
  const dist = distance(ctx.x, ctx.y, targetX, targetY);

  // Bail if the bot is too far to ever reach the target in a reasonable time.
  // The demolition target may be set by the planner-waypoint trigger (~192px),
  // the stuck-probe (~128px), OR the findBlockingDestructible raycast (up to
  // ~816px along the bot→navgoal line). For the raycast case, the bot needs to
  // APPROACH the wall first — executeDemolition handles that by moving toward
  // the target. So the bail must be generous enough to let the approach happen.
  // 600px ≈ 5 tiles: at base speed (~7px/tick) that's ~86 ticks to close, well
  // within a reasonable demolition episode. Beyond that, the target was likely
  // a spurious raycast hit on a wall the bot isn't actually near.
  if (dist > 600) {
    ctx.setPath(null);
    ctx.demolitionGridX = -1;
    ctx.demolitionGridY = -1;
    ctx.state = ctx.preDemolitionState;
    return [];
  }

  return executeDemolition(ctx, aimX, aimY);
}

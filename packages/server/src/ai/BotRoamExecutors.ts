/**
 * Roaming state executors — MACRO-GOAL BOUNDING (bot-ai-v2 ticket 07,
 * DEC-008).
 *
 * executeFleeZone is UNCHANGED (survival sits above the goal layer — a bot
 * taking zone damage ignores its macro-goal and runs).
 *
 * executeHunt: Priorities 1A (ground-truth contact) and 1B (believed-state
 * investigation, ticket 05) are preserved verbatim. The OLD Priority-2
 * inline hotspot branch and the Priority-3 geometric orbit (deterministic
 * id-hash angle + ~37° advance per repath ring — AUDIT §10a.7) are RETIRED:
 * the hotspot approach is now the HOTSPOT_STALK macro-goal (an EDGE point
 * around the fight centroid, saturation-limited, picked by the scoring
 * seam) and the fallback positioning is whatever macro-goal won (quiet
 * side / unexplored sector / pre-position / endgame hold — edge/center by
 * archetype). Movement reads as committed destinations, never rings.
 *
 * executeWander: the random barrel-sparse target every 120 ticks (AUDIT
 * §10c.1) is RETIRED — WANDER binds to the active macro-goal via
 * goalNavTarget (zone-as-cost routed). The only non-goal path is the
 * stall-relocation anchor (existing behavior, kept) and a deterministic
 * goal-less bridge point for the first ~2 s before the generator's first
 * commit (never random — findBarrelSparseTarget is deleted).
 */

import { angleTo, distance } from '@sector-battle/shared';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { BotSystem } from './BotSystem.ts';
import type { BotContext } from './BotContext.ts';
import type { TickBlackboard } from './TickBlackboard.ts';
import { BotState } from './BotContext.ts';
import { navigateTo, checkStuck } from './BotNavigation.ts';
import { makeDashInput } from './BotInput.ts';
import { checkGrabWhilePassing, checkMobilityDash, checkGoalStall } from './BotTickUtilities.ts';
import { pursueBelievedEnemy } from './belief/BeliefUpdate.ts';
import { WANDER_REPATH_TICKS, HUNT_ARRIVAL_ESCAPE_TICKS } from './BotSystemConstants.ts';
import { consumeGoal } from './goal/GoalGenerator.ts';
import { goalNavTarget, goallessFallbackPoint, type GoalNavTarget } from './goal/GoalBinding.ts';
import type { MacroGoalState } from './goal/GoalTypes.ts';

export function executeFleeZone(system: BotSystem, ctx: BotContext): QueuedInput | null {
  // Navigate toward the pre-computed safe point (target/next center during a
  // shrink) rather than the current center. The arrival radius is a fraction
  // of the safe radius so the bot embeds inside the next ring.
  const distToCenter = distance(ctx.x, ctx.y, ctx.zoneCenterX, ctx.zoneCenterY);
  const takingDamage = ctx.zoneRadius > 0 && distToCenter > ctx.zoneRadius;
  const dist = distance(ctx.x, ctx.y, ctx.zoneSafeX, ctx.zoneSafeY);
  const dashReady = ctx.tick - ctx.lastDashTick >= 180;
  // Dash aggressively: if taking zone damage right now, dash on sight (no
  // distance check — every tick outside the zone is 5 damage). Otherwise dash
  // when far from the safe point.
  if (dashReady && (takingDamage || dist > Math.max(ctx.zoneSafeRadius * 0.7, 200))) {
    ctx.lastDashTick = ctx.tick;
    const dashAngle = angleTo(ctx.x, ctx.y, ctx.zoneSafeX, ctx.zoneSafeY);
    return makeDashInput(ctx.playerId, dashAngle, ctx.tick, 'zone-flee-dash');
  }
  const arrival = Math.max(ctx.zoneSafeRadius * 0.4, 120);
  const input = navigateTo(
    ctx,
    ctx.zoneSafeX,
    ctx.zoneSafeY,
    system.pathfinder,
    arrival,
    system.destructibleMap,
  );
  if (input === null && ctx.demolitionGridX >= 0) {
    // A bot fleeing the zone that's walled off must break through — getting
    // caught outside the zone is lethal, so demolishing is always worth it.
    ctx.preDemolitionState = BotState.FLEE_ZONE;
    ctx.state = BotState.DEMOLITION;
    return null;
  }
  if (checkStuck(ctx)) {
    ctx.setPath(null);
    ctx.pathRepathTick = 0;
  }
  return input;
}

export function executeHunt(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
): QueuedInput | null {
  // Under-fire flinching lives in the Reactor now (bot-ai-v2 ticket 04,
  // DEC-004) — the interrupt layer fires the took-damage STARTLE for bots in
  // EVERY intent state, not just the three executors that used to carry the
  // retired under-fire special case.
  // Grab a free powerup if we're passing over one while patrolling.
  const grab = checkGrabWhilePassing(system, ctx);
  if (grab) return grab;
  // ARRIVAL-ESCAPE (Fix A3): if we recently arrived at a HUNT target but found
  // no enemy there, do NOT re-path to the same dead coordinate. Fall through
  // to the macro-goal branch so the bot leaves the dead point instead of
  // orbiting it (the "trance"). The arrival flag clears once enough time has
  // passed OR a fresh enemy is perceived (handled in perception).
  const arrivedRecently = ctx.tick - ctx.huntArrivalTick < HUNT_ARRIVAL_ESCAPE_TICKS;

  // PRIORITY 1A — GROUND-TRUTH CONTACT (the legacy chase, preserved): a live
  // enemy is in perception beyond fight range → press toward it directly
  // (in-scan enemies are ground truth; DEC-003's belief pursuit is for
  // out-of-scan enemies only). This is the anti-passivity fix: an armed bot
  // that spots an enemy across the sector converges instead of wandering.
  if (ctx.nearestEnemy && !arrivedRecently) {
    const mobDash = checkMobilityDash(system, ctx, ctx.nearestEnemy.x, ctx.nearestEnemy.y);
    if (mobDash) return mobDash;
    const input = navigateTo(
      ctx,
      ctx.nearestEnemy.x,
      ctx.nearestEnemy.y,
      system.pathfinder,
      80,
      system.destructibleMap,
    );
    if (input === null && ctx.demolitionGridX >= 0) {
      ctx.preDemolitionState = BotState.HUNT;
      ctx.state = BotState.DEMOLITION;
      return null;
    }
    if (checkStuck(ctx)) {
      ctx.setPath(null);
      ctx.pathRepathTick = 0;
    }
    return input;
  }

  // PRIORITY 1B — BELIEVED-STATE INVESTIGATION (bot-ai-v2 ticket 05,
  // DEC-003): nothing in perception; chase the bot's freshest BELIEF about an
  // out-of-scan enemy — the believed last-known position (foveation-noised
  // memory), a heard shot seat, or a damage-direction estimate — instead of
  // the raw lastSeenEnemy coordinates. pursueBelievedEnemy arms the
  // search-failure-bounded pursuit (BeliefUpdate.enforceSearchFailure: no
  // re-acquisition within ~90 ticks → belief drop + intent-family cooldown —
  // no infinite ghost chases).
  const pursuit = pursueBelievedEnemy(
    ctx,
    system.skillTrackers.get(ctx.playerId)?.believability.beliefs ?? null,
  );
  if (pursuit && !arrivedRecently) {
    // Mobility dash: sprint to close on a fleeing enemy instead of jogging.
    const mobDash = checkMobilityDash(system, ctx, pursuit.x, pursuit.y);
    if (mobDash) return mobDash;
    const input = navigateTo(
      ctx,
      pursuit.x,
      pursuit.y,
      system.pathfinder,
      80,
      system.destructibleMap,
    );
    if (input === null && ctx.demolitionGridX >= 0) {
      ctx.preDemolitionState = BotState.HUNT;
      ctx.state = BotState.DEMOLITION;
      return null;
    }
    // ARRIVAL at the believed position without the enemy in scan: set the
    // arrival-escape flag so the bot leaves the dead coordinate instead of
    // orbiting it (the search-failure bound then drops the belief if the
    // enemy never re-appears).
    if (input === null && ctx.demolitionGridX < 0 && !ctx.nearestEnemy) {
      ctx.huntArrivalTick = ctx.tick;
      ctx.setPath(null);
      // Fall through to the macro-goal branch (leave the dead point).
    } else {
      if (checkStuck(ctx)) {
        ctx.setPath(null);
        ctx.pathRepathTick = 0;
      }
      return input;
    }
  }

  // PRIORITY 2 (bot-ai-v2 ticket 07, DEC-008) — MACRO-GOAL BINDING. This
  // replaces BOTH the retired inline hotspot branch (Priority 2: converge on
  // the shared hotspot + barrel-sparse divert) AND the retired geometric
  // orbit (Priority 3: deterministic id-hash angle + ~37°/repath ring sweep
  // — the mechanical endgame rings, AUDIT §10a.7). The committed macro-goal
  // already encodes the strategic choice:
  //   HOTSPOT_STALK   → an EDGE point around the fight centroid (the scorer
  //                     picked the low-density/low-barrel approach angle and
  //                     enforced saturation — a few stalkers, not the lobby).
  //   QUIET_SIDE / UNEXPLORED_SECTOR / PRE_POSITION / ENDGAME_HOLD / LOOT —
  //                     the committed destination, zone-as-cost routed.
  // The endgame hold is goal-driven edge/center positioning per archetype
  // (ENDGAME_HOLD's point comes from ZoneTiming.endgameHoldPoint with the
  // archetype's edge bias; with ≤3 alive it collapses toward center for
  // everyone so final circles still resolve — matches must finish).
  const goalState = system.macroGoals?.get(ctx.playerId) ?? null;
  const nav = goalNavTarget(system, ctx, bb, null);
  if (nav) {
    // Saturation echo for a fight stalk: count this bot so later bots this
    // tick score the stalk down (same cross-bot sequential semantics the
    // retired hotspot branch had via bb.convergingCount).
    if (nav.kind === 'HOTSPOT_STALK') bb.convergingCount++;
    if (!arrivedRecently) {
      const input = navigateTo(
        ctx,
        nav.x,
        nav.y,
        system.pathfinder,
        nav.kind === 'HOTSPOT_STALK' ? 100 : 80,
        system.destructibleMap,
      );
      if (input === null && ctx.demolitionGridX >= 0) {
        ctx.preDemolitionState = BotState.HUNT;
        ctx.state = BotState.DEMOLITION;
        return null;
      }
      // ARRIVAL at the goal point with nothing to show for it: mark the
      // arrival escape AND consume the goal so the generator re-scores next
      // tick (the bot leaves the dead point — no orbiting it).
      if (input === null && ctx.demolitionGridX < 0) {
        ctx.huntArrivalTick = ctx.tick;
        if (goalState) consumeGoal(goalState, ctx.tick);
        ctx.setPath(null);
      } else {
        if (checkStuck(ctx)) {
          ctx.setPath(null);
          ctx.pathRepathTick = 0;
        }
        return input;
      }
    }
  }

  // GOAL-LESS BRIDGE (first ~2 s before the generator's first commit, or an
  // unregister race): a DETERMINISTIC hold point on the zone-safe ring at
  // the bot's stable angle — enough movement to bridge the cadence, never a
  // random target, never a sweeping ring (the angle does not advance per
  // repath; that advancing sweep was exactly the retired orbit).
  const bridge = goallessFallbackPoint(system, ctx);
  const input = navigateTo(ctx, bridge.x, bridge.y, system.pathfinder, 80, system.destructibleMap);
  if (input === null && ctx.demolitionGridX >= 0) {
    ctx.preDemolitionState = BotState.HUNT;
    ctx.state = BotState.DEMOLITION;
    return null;
  }
  if (checkStuck(ctx)) {
    ctx.setPath(null);
    ctx.pathRepathTick = 0;
  }
  // Position-stall escape: if we haven't moved meaningfully in 2s (geometry-
  // stuck against collision the pathfinder says is walkable), force a WANDER
  // to break free. Without this, a HUNT bot can stall indefinitely — checkStuck
  // re-paths to the same wedged position every 18 ticks forever.
  if (checkGoalStall(system, ctx)) {
    return executeWander(system, ctx, bb);
  }
  return input;
}

export function executeWander(
  system: BotSystem,
  ctx: BotContext,
  bb?: TickBlackboard,
): QueuedInput | null {
  // MACRO-GOAL BINDING (bot-ai-v2 ticket 07, DEC-008): WANDER follows the
  // committed macro-goal — loot routes, quiet-side rotations, sector
  // exploration, pre-positioning. The retired behavior (random barrel-sparse
  // cell every 120 ticks, no memory, no objective — AUDIT §10c.1) is gone
  // along with its picker (findBarrelSparseTarget, deleted).
  const goalState: MacroGoalState | null = system.macroGoals?.get(ctx.playerId) ?? null;

  // STALL-RELOCATION OVERRIDE (kept from the pre-v2 executor): if a goal was
  // recently suspended (stallEpicenter fresh), the bot must physically LEAVE
  // the stall area — anchor the nav target AWAY from the epicenter so the
  // wander covers new ground. This override outranks the macro-goal for its
  // bounded window (the ladder's rung-(e) relocation), else the same
  // unreachable goal would be re-entered at the same dead spot.
  const stallAge = ctx.tick - ctx.stallEpicenterTick;
  const stallFresh = stallAge < 480; // 8s — covers the long suspend window
  const nav: GoalNavTarget | null = stallFresh
    ? null
    : goalNavTarget(system, ctx, bb ?? null, null);

  if (nav) {
    ctx.wanderTargetX = nav.x;
    ctx.wanderTargetY = nav.y;
    const input = navigateTo(ctx, nav.x, nav.y, system.pathfinder, 80, system.destructibleMap);
    if (input === null && ctx.demolitionGridX >= 0) {
      ctx.preDemolitionState = BotState.WANDER;
      ctx.state = BotState.DEMOLITION;
      return null;
    }
    // ARRIVAL at the goal point: consume the goal so the generator re-scores
    // next tick (the old ARRIVAL FIX collapsed the idle window to 1 tick;
    // goal consumption collapses it to a fresh GOAL instead of a fresh
    // random target).
    if (input === null && ctx.demolitionGridX < 0) {
      if (goalState) consumeGoal(goalState, ctx.tick);
      ctx.wanderRepathTick = ctx.tick;
    }
    if (checkStuck(ctx)) {
      ctx.setPath(null);
      ctx.pathRepathTick = 0;
    }
    if (checkGoalStall(system, ctx)) {
      ctx.wanderRepathTick = ctx.tick; // force the relocation branch
    }
    return input;
  }

  // GOAL-LESS / STALL-RELOCATION PATH: deterministic anchor selection at the
  // (kept) 120-tick cadence. The stall anchor moves AWAY from the epicenter
  // (the relocation contract); the goal-less bridge holds the zone-safe
  // point or a stable-angle step. No random draws anywhere in this path.
  if (ctx.tick >= ctx.wanderRepathTick || (ctx.path === null && ctx.wanderRepathTick === 0)) {
    ctx.wanderRepathTick = ctx.tick + WANDER_REPATH_TICKS;
    let targetX: number;
    let targetY: number;
    if (stallFresh) {
      // Relocating from a stall: move away from the epicenter AND blend
      // toward zone-safe so the bot stays alive (pure away could push it
      // into the zone edge).
      const awayX = ctx.x + (ctx.x - ctx.stallEpicenterX) * 2.5;
      const awayY = ctx.y + (ctx.y - ctx.stallEpicenterY) * 2.5;
      if (ctx.zoneSafeRadius > 0) {
        targetX = (awayX + ctx.zoneSafeX) / 2;
        targetY = (awayY + ctx.zoneSafeY) / 2;
      } else {
        targetX = awayX;
        targetY = awayY;
      }
    } else {
      const bridge = goallessFallbackPoint(system, ctx);
      targetX = bridge.x;
      targetY = bridge.y;
    }
    ctx.wanderTargetX = targetX;
    ctx.wanderTargetY = targetY;
    ctx.setPath(null);
  }
  const input = navigateTo(
    ctx,
    ctx.wanderTargetX,
    ctx.wanderTargetY,
    system.pathfinder,
    80,
    system.destructibleMap,
  );
  if (input === null && ctx.demolitionGridX >= 0) {
    ctx.preDemolitionState = BotState.WANDER;
    ctx.state = BotState.DEMOLITION;
    return null;
  }
  if (checkStuck(ctx)) {
    ctx.setPath(null);
    ctx.pathRepathTick = 0;
  }
  // Position-stall escape: same as HUNT — force a fresh target if wedged.
  if (checkGoalStall(system, ctx)) {
    ctx.wanderRepathTick = ctx.tick; // force immediate re-anchor
    ctx.setPath(null);
  }
  // ARRIVAL FIX (kept): navigateTo returns null at arrival (within 80px).
  // Expire the anchor so next tick picks a fresh point — the bot keeps
  // moving instead of idling out the cadence window.
  if (input === null && ctx.demolitionGridX < 0) {
    ctx.wanderRepathTick = ctx.tick;
  }
  return input;
}

import { angleTo, distance } from '@sector-battle/shared';
import type { Pathfinder } from './navigation/Pathfinder.ts';
import { type BotContext, BotState } from './BotContext.ts';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import { makeMoveInput, clampToWalkable } from './BotInput.ts';
import { packGridKey } from './BotDestructibles.ts';
import {
  resolveWallSlide,
  computeSeparation,
  computeDangerAvoidance,
  blendAngleVector,
  validateFinalAngle,
} from './BotNavigationBlend.ts';
import { StuckLadderRung, LANE_SWING_RAD, advanceStuckLadder } from './navigation/StuckLadder.ts';
import {
  applyHotspotAvoidance,
  applyMovementShaping,
  applyZoneEdgePreference,
  signatureStopInput,
} from './skill/BotMovementSignature.ts';
import {
  BARREL_ANCHOR_RANGE_PX,
  FEATURE_ANCHOR_RANGE_PX,
  LOOT_ANCHOR_RANGE_PX,
} from './skill/MovementProfileTables.ts';

const PATH_REPATH_TICKS = 20;
const ARRIVAL_RADIUS = 80;
const STUCK_TICKS = 18;
const STUCK_DISTANCE = 16;
const DEMOLITION_SCAN_STEPS = 8;

/**
 * THE UNIFIED ARRIVAL MODEL (DEC-005.6): the closest walkable position to a
 * target. Walkable targets map to themselves; a target on a NON-walkable
 * tile (a weapon dropped on a destructible/solid tile edge, a chest, a
 * crate) maps to the center of the nearest walkable tile within a 4-tile
 * ring (Pathfinder.findNearestWalkable). navigateTo measures arrival
 * against THIS point — "as close as walkably possible" — which replaces the
 * four ad-hoc <120/<160px loot-arrival patches (see BotEconomyExecutors).
 */
export function nearestWalkableApproach(
  pf: Pathfinder,
  x: number,
  y: number,
): { x: number; y: number } {
  const grid = pf.worldToGrid({ x, y });
  const gx = grid.x;
  const gy = grid.y;
  if (pf.isWalkable(gx, gy)) return { x, y };
  const near = pf.findNearestWalkable(gx, gy, 4);
  if (near) {
    const ts = pf.getTileSize();
    return { x: near.x * ts + ts / 2, y: near.y * ts + ts / 2 };
  }
  return { x, y };
}

export function navigateTo(
  ctx: BotContext,
  targetX: number,
  targetY: number,
  pf: Pathfinder,
  arrivalRadius: number = ARRIVAL_RADIUS,
  destructibleMap: Map<number, number> | null = null,
): QueuedInput | null {
  // SIGNATURE STOP (ticket 08, DEC-009.2): while an anchor-loiter window or
  // micro-pause owns the tick, emit the hold input. Patrol states only.
  const stop = signatureStopInput(ctx.movement, {
    tick: ctx.tick,
    playerId: ctx.playerId,
    state: ctx.state,
    hasLootNearby: ctx.items.some((it) => it.distance < LOOT_ANCHOR_RANGE_PX),
    hasChestNearby:
      ctx.nearestChest !== null && ctx.nearestChest.distance < FEATURE_ANCHOR_RANGE_PX,
    hasBarrelNearby: ctx.dangers.some(
      (d) => d.type === 'barrel' && d.distance < BARREL_ANCHOR_RANGE_PX,
    ),
    aimAngle: angleTo(ctx.x, ctx.y, targetX, targetY),
  });
  if (stop) return stop;

  // ARRIVAL against the unified approach point (DEC-005.6). For walkable
  // targets the approach point IS the target (byte-identical to the old
  // distance check). For non-walkable targets the bot arrives at the nearest
  // walkable tile — the WALL-WEDGE GUARD below keeps routing when even that
  // approach point is occluded.
  const approach = nearestWalkableApproach(pf, targetX, targetY);
  const distToApproach = distance(ctx.x, ctx.y, approach.x, approach.y);
  if (distToApproach < arrivalRadius) {
    // WALL-WEDGE GUARD: verify LOS before declaring arrival. Without this, a
    // bot pushed flush against a wall (within arrival radius of a target on the
    // far side) would clear its path and return null — then the caller idles
    // because the target is "in range" but unreachable. If blocked, fall
    // through to pathfinding so the bot routes around the wall. The LOS
    // raycast only runs when already inside the arrival radius (cheap).
    if (pf.hasLineOfSightWorld({ x: ctx.x, y: ctx.y }, approach)) {
      ctx.setPath(null);
      return null;
    }
    ctx.setPath(null);
  }

  const targetChanged =
    ctx.path === null || distance(ctx.pathTargetX, ctx.pathTargetY, targetX, targetY) > 100;

  if (
    targetChanged ||
    ctx.tick >= ctx.pathRepathTick ||
    (ctx.path !== null && ctx.path.length - ctx.pathCursor === 0)
  ) {
    let goalX = approach.x;
    let goalY = approach.y;
    // STUCK-LADDER RUNG (c) — ALTERNATE-LANE REPLAN (DEC-005.2): while the
    // ladder is at REPLAN with an armed lane, the next repath targets a
    // lane-offset point (goal direction swung ±LANE_SWING_RAD, up to 3
    // tiles out) instead of the true goal — a visible wide swing around the
    // obstacle on a different corridor. One-shot: consumed here.
    if (ctx.ladder.rung === StuckLadderRung.REPLAN && ctx.ladder.laneArmed) {
      ctx.ladder.laneArmed = false;
      const base = Math.atan2(goalY - ctx.y, goalX - ctx.x);
      const reach = Math.min(distance(ctx.x, ctx.y, goalX, goalY), pf.getTileSize() * 3);
      const swing = base + ctx.ladder.laneBias * LANE_SWING_RAD;
      const clampedLane = clampToWalkable(
        pf,
        ctx.x + Math.cos(swing) * reach,
        ctx.y + Math.sin(swing) * reach,
      );
      goalX = clampedLane.x;
      goalY = clampedLane.y;
    }
    // TIERED PLANNER: try plain findPath first (cheap, cached, treats every
    // destructible as solid). Then — if a clear path exists — ALSO try
    // findPathThroughDestructibles and compare costs. If breaking through is
    // cheaper (the destructible-aware path cost < detour cost * 0.7), use it:
    // the bot proactively breaks a wall/crate to open a shorter way. This is the
    // user's directive: "bots must understand destructible walls and crates can
    // be destroyed to open ways, even if they only have fists." The cost model
    // (HP*10) already accounts for break time, so a crate (cost 20) is almost
    // always worth breaking, while a wall (cost 100) only when the detour is
    // long. Fists (2 dmg/hit) take longer but the pather doesn't need to know
    // the weapon — the HP-cost gate handles "is it worth the time" implicitly.
    // (SEARCH PRIORITY, ticket 11 DEC-012.3: arg 3 = the bot's LOD tier = its A* search class — T0 first.)
    let rawPath = pf.findPath({ x: ctx.x, y: ctx.y }, { x: goalX, y: goalY }, ctx.lodTier);
    // Only attempt the through-destructibles comparison if there's a destructible
    // within ~3 tiles of the bot (cheap grid check). This avoids burning an A*
    // search per repath for bots in open terrain, conserving the 24-search/tick
    // budget. Near a destructible, the bot proactively evaluates whether breaking
    // through opens a shorter way.
    if (
      destructibleMap &&
      destructibleMap.size > 0 &&
      hasDestructibleNearby(ctx, pf, destructibleMap, 3)
    ) {
      const throughPath = pf.findPathThroughDestructibles(
        { x: ctx.x, y: ctx.y },
        { x: goalX, y: goalY },
        destructibleMap,
        ctx.lodTier,
      );
      if (throughPath && throughPath.length >= 2) {
        if (!rawPath || rawPath.length < 2) {
          // No clear path at all — breaking through is the only option.
          rawPath = throughPath;
        } else {
          // COST-AWARE COMPARISON: break through when it's MEANINGFULLY cheaper.
          // The through-path cost = traversal (waypoint count) + break cost
          // (sum of HP*10 for each destructible tile). The detour cost = waypoint
          // count. Breaking has a hidden cost beyond HP: it takes time (swinging
          // while standing still), exposes the bot (stationary at a wall), and
          // consumes weapon durability. So we require the through-path to beat
          // the detour by a BREAK_PENALTY margin — not just marginally cheaper.
          // (The first version had no margin → "over-breaking" per user feedback;
          // the version before that compared waypoint count → "inconsistent."
          // The margin + real cost comparison is the balance.)
          const BREAK_PENALTY = 40; // detour must be >40 cost-units longer to justify breaking
          let throughCost = throughPath.length;
          for (const wp of throughPath) {
            const wg = pf.worldToGrid(wp);
            const hp = destructibleMap.get(packGridKey(wg.x, wg.y));
            if (hp !== undefined) throughCost += hp * 10;
          }
          const detourCost = rawPath.length;
          if (throughCost + BREAK_PENALTY < detourCost) {
            rawPath = throughPath;
          }
        }
      }
    }
    // Jitter the next repath by ±5 ticks so bots that happen to repath on the
    // same tick drift apart over time, preventing A* bursts that spike the 16ms
    // tick budget when 60+ bots share a repath phase.
    ctx.pathRepathTick = ctx.tick + PATH_REPATH_TICKS + ctx.rng.int(0, 11) - 5;
    ctx.pathTargetX = targetX;
    ctx.pathTargetY = targetY;

    if (rawPath && rawPath.length >= 2) {
      ctx.setPath(rawPath);
    } else if (rawPath === null && pf.lastFindDeferred) {
      // A*-CAP SENTINEL (DEC-005.5): the shared-search-budget cap was
      // exhausted — this is NOT unreachability. Retry next tick and KEEP the
      // previous path's remaining waypoints (the bot keeps moving along its
      // last good route) instead of collapsing into the unreachable
      // fallbacks: target drops, wander, or a spurious demolition.
      ctx.pathRepathTick = ctx.tick + 1;
    } else {
      ctx.setPath(null);
    }
  }
  // Whether THIS tick's planner attempt was deferred (the fallback block
  // below must not fire the unreachable machinery on a budget miss).
  const deferredThisTick =
    ctx.tick < ctx.pathRepathTick && ctx.path === null && pf.lastFindDeferred;

  if (!ctx.path || ctx.path.length - ctx.pathCursor < 2) {
    // Both planners failed. Fall back to the straight-line destructible scan
    // (cheap, finds a wall on the direct bot→target segment) as a last resort.
    // SKIPPED when the search was deferred (budget miss ≠ unreachable — a
    // spurious demolition here is exactly the collapse DEC-005.5 forbids).
    if (!deferredThisTick && destructibleMap && destructibleMap.size > 0) {
      const blocking = findBlockingDestructible(ctx, targetX, targetY, pf, destructibleMap);
      if (blocking) {
        ctx.demolitionTargetX = blocking.x;
        ctx.demolitionTargetY = blocking.y;
        ctx.demolitionGridX = blocking.gridX;
        ctx.demolitionGridY = blocking.gridY;
        return null;
      }
    }
    // FIX B3: never freeze. Wall-slide along the obstacle so the bot keeps
    // moving (and either finds a way around or triggers stuck-detection, which
    // is now demolition-aware). The old code returned the raw angle into the
    // wall here in some executors and null in others — both produced the
    // visible "bot frozen against a wall" behavior.
    const angle = angleTo(ctx.x, ctx.y, targetX, targetY);
    const slid = resolveWallSlide(ctx, angle, pf);
    // The ladder advances on THIS branch too — a wedged bot whose planners
    // both failed is exactly the ladder's jurisdiction (the SMASH rung may
    // arm a demolition even when the A* fallbacks found nothing).
    const fallbackEmit = advanceStuckLadder(ctx, angle, targetX, targetY, pf, destructibleMap);
    if (fallbackEmit?.demolition) return null;
    let fallbackMove = slid;
    let fallbackAim: number | null = null;
    if (fallbackEmit) {
      if (fallbackEmit.angleOverride !== null) fallbackMove = fallbackEmit.angleOverride;
      if (fallbackEmit.aimOverride !== null) fallbackAim = fallbackEmit.aimOverride;
    }
    const fallbackFinal = validateFinalAngle(ctx, fallbackMove, pf);
    // Signature shaping on the recovery path too (always-on identity), but no
    // stops/blends — a wedged bot's recovery must stay direct.
    const fallbackShaped = applyMovementShaping(ctx.movement, ctx.tick, fallbackFinal);
    return makeMoveInput(ctx.playerId, fallbackShaped, fallbackAim ?? fallbackShaped, ctx.tick);
  }

  // INDEX-ADVANCE (perf ticket 30): the loop used to shift() the front waypoint
  // off the array (O(L²) element moves per traversed cross-map path) — and since
  // the array can be the pathfinder's cached instance, shift() also corrupted
  // the cache. The cursor advances instead; the array length is immutable
  // between setPath calls. Waypoint identities are identical to the shift
  // version: "current" is path[cursor], "lookahead" is path[cursor+1], and one
  // advance step is cursor++ (old: length-1 via shift).
  const path = ctx.path;
  let cursor = ctx.pathCursor;
  while (path.length - cursor >= 3) {
    const next = path[cursor + 1]!;
    if (distance(ctx.x, ctx.y, next.x, next.y) < 50) {
      cursor++;
    } else {
      break;
    }
  }
  ctx.pathCursor = cursor;

  const waypoint = path[cursor + 1] ?? path[cursor]!;

  // FIX B2: destructible-waypoint → demolition target. If the planner routed us
  // THROUGH a destructible (the next waypoint sits on a destructible tile), the
  // bot must BREAK that tile to proceed — walking into it would just push
  // against the wall. Set the demolition target and let executeDemolitionState
  // handle the attack. This is the proactive wall-break: the planner chose this
  // breach because it was the cheapest route, not because the bot got stuck.
  if (destructibleMap && destructibleMap.size > 0) {
    const wpGrid = pf.worldToGrid(waypoint);
    if (pf.isDestructibleWaypoint(wpGrid.x, wpGrid.y, destructibleMap)) {
      // Only break it if we're close enough that it's actually blocking us (not
      // a distant future waypoint). Within ~2.5 tiles — generous because a bot
      // pushed off-center by separation/danger blend on a diagonal approach can
      // pass the waypoint center at >192px (the old 1.5-tile gate), walking past
      // the destructible without triggering demolition (an "inconsistent" cause).
      const distToWp = distance(ctx.x, ctx.y, waypoint.x, waypoint.y);
      if (distToWp < pf.getTileSize() * 2.5) {
        ctx.demolitionTargetX = waypoint.x;
        ctx.demolitionTargetY = waypoint.y;
        ctx.demolitionGridX = wpGrid.x;
        ctx.demolitionGridY = wpGrid.y;
        return null;
      }
    }
  }

  let moveAngle = angleTo(ctx.x, ctx.y, waypoint.x, waypoint.y);
  const directAngle = moveAngle;
  moveAngle = resolveWallSlide(ctx, moveAngle, pf);

  // BLOCKED-HEADING DEMOLITION TRIGGER: when the direct heading is blocked by
  // a destructible, break it instead of pushing forever. Fires in both the
  // slide-active and boxed-in cases (slide drifts <16px/18 ticks so checkStuck
  // never trips — probing the direct-heading tile catches both).
  if (destructibleMap && destructibleMap.size > 0) {
    const ts = pf.getTileSize();
    const blockX = ctx.x + Math.cos(directAngle) * ts * 0.6;
    const blockY = ctx.y + Math.sin(directAngle) * ts * 0.6;
    const blockGrid = pf.worldToGrid({ x: blockX, y: blockY });
    const blockKey = packGridKey(blockGrid.x, blockGrid.y);
    if (destructibleMap.has(blockKey)) {
      ctx.demolitionTargetX = blockGrid.x * ts + ts / 2;
      ctx.demolitionTargetY = blockGrid.y * ts + ts / 2;
      ctx.demolitionGridX = blockGrid.x;
      ctx.demolitionGridY = blockGrid.y;
      return null;
    }
  }

  // STUCK LADDER (DEC-005.2) — the human-legible escalation that REPLACED the
  // old blind ±90° unstuck jitter (shouldUnstuck). Rungs: sidestep → back up
  // facing the obstacle → alternate-lane replan (consumed in the repath block
  // above) → SMASH the destructible blocker via the existing demolition
  // executor → goal suspension + relocation (demoted to last resort).
  let aimAngle = 0;
  let ladderAim = false;
  const emit = advanceStuckLadder(ctx, directAngle, waypoint.x, waypoint.y, pf, destructibleMap);
  if (emit) {
    if (emit.demolition) {
      // Rung (d): the standard handoff — the caller's executor flips into
      // DEMOLITION on the null return (same contract as the triggers above).
      return null;
    }
    if (emit.angleOverride !== null) {
      moveAngle = emit.angleOverride;
      if (emit.aimOverride !== null) {
        aimAngle = emit.aimOverride;
        ladderAim = true;
      }
    }
  }

  const sepVec = computeSeparation(ctx);
  if (sepVec) {
    // State-aware separation: stronger outside combat (loot/wander/hunt — the
    // flocking case where bots pile on one tile), moderate in combat so it
    // doesn't scatter a bot out of attack range. Pairs with claimedItems.
    const combatState = ctx.state === BotState.ENGAGE || ctx.state === BotState.RETREAT;
    const sepWeight = combatState ? 0.2 : 0.45;
    moveAngle = blendAngleVector(moveAngle, sepVec, sepWeight);
  }

  const danger = computeDangerAvoidance(ctx);
  if (danger) {
    // Urgency-scaled blend: a barrel right next to us nearly overrides the
    // path; a distant trap only nudges it.
    const w = Math.min(0.85, 0.35 + danger.urgency * 0.2);
    moveAngle = blendAngleVector(moveAngle, danger.angle, w);
  }

  // BLEND-ORDER FIX (DEC-005.1): the FINAL blended angle — after separation
  // and hazard blending — is re-validated against walls and re-slid if
  // blocked. No emitted angle may point into a wall (the pre-fix ordering
  // could re-point the bot into the wall the slide just avoided, every tick).
  //
  // SIGNATURE STEERING + SHAPING (ticket 08, DEC-009.2), BETWEEN the blends
  // and the wall validation (so DEC-005.1 covers the shaped angle): hotspot
  // avoidance → zone-edge preference → curve + turn-smoothing shaping.
  moveAngle = applyHotspotAvoidance(
    ctx.movement,
    {
      tick: ctx.tick,
      state: ctx.state,
      x: ctx.x,
      y: ctx.y,
      fightMemoryX: ctx.fightMemoryX,
      fightMemoryY: ctx.fightMemoryY,
      fightMemoryTick: ctx.fightMemoryTick,
    },
    moveAngle,
  );
  moveAngle = applyZoneEdgePreference(
    ctx.movement,
    {
      state: ctx.state,
      x: ctx.x,
      y: ctx.y,
      zoneCenterX: ctx.zoneCenterX,
      zoneCenterY: ctx.zoneCenterY,
      zoneRadius: ctx.zoneRadius,
    },
    moveAngle,
  );
  moveAngle = applyMovementShaping(ctx.movement, ctx.tick, moveAngle);
  const finalAngle = validateFinalAngle(ctx, moveAngle, pf);
  return makeMoveInput(ctx.playerId, finalAngle, ladderAim ? aimAngle : finalAngle, ctx.tick);
}

/**
 * Straight-line closing move with the full wall guarantee: slide + final
 * validation. The executors' unified-arrival band (the last pixels toward a
 * non-walkable target, where the server's proximity pickup takes over) emits
 * through THIS instead of a raw angle, so the no-wall-angle invariant holds
 * on every movement emission path (DEC-005.1/DEC-005.6).
 */
export function validatedMoveToward(
  ctx: BotContext,
  x: number,
  y: number,
  pf: Pathfinder,
): QueuedInput {
  const angle = angleTo(ctx.x, ctx.y, x, y);
  const slid = resolveWallSlide(ctx, angle, pf);
  // Signature shaping before validation (same invariant as navigateTo's
  // final emission — the shaped angle is wall-checked, never raw).
  const shaped = applyMovementShaping(ctx.movement, ctx.tick, slid);
  const finalAngle = validateFinalAngle(ctx, shaped, pf);
  return makeMoveInput(ctx.playerId, finalAngle, finalAngle, ctx.tick);
}

/** Cheap grid-proximity check: is there a destructible within `radiusTiles` of
 *  the bot's current position? Used to gate the through-destructibles A* search
 *  so bots in open terrain don't burn a search per repath. */
function hasDestructibleNearby(
  ctx: BotContext,
  pf: Pathfinder,
  destructibleMap: Map<number, number>,
  radiusTiles: number,
): boolean {
  const ts = pf.getTileSize();
  const gx = Math.floor(ctx.x / ts);
  const gy = Math.floor(ctx.y / ts);
  for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
    for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
      if (destructibleMap.has(packGridKey(gx + dx, gy + dy))) return true;
    }
  }
  return false;
}

function findBlockingDestructible(
  ctx: BotContext,
  targetX: number,
  targetY: number,
  pf: Pathfinder,
  destructibleMap: Map<number, number>,
): { x: number; y: number; gridX: number; gridY: number } | null {
  const tileSize = pf.getTileSize();
  const dx = targetX - ctx.x;
  const dy = targetY - ctx.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return null;

  const stepSize = tileSize * 0.8;
  const steps = Math.min(DEMOLITION_SCAN_STEPS, Math.ceil(dist / stepSize));

  for (let i = 1; i <= steps; i++) {
    const t = (i * stepSize) / dist;
    if (t > 1) break;
    const checkX = ctx.x + dx * t;
    const checkY = ctx.y + dy * t;
    const grid = pf.worldToGrid({ x: checkX, y: checkY });
    const key = packGridKey(grid.x, grid.y);
    if (destructibleMap.has(key)) {
      return { x: checkX, y: checkY, gridX: grid.x, gridY: grid.y };
    }
  }
  return null;
}

export function checkStuck(ctx: BotContext): boolean {
  if (ctx.stuckStartTick < 0) {
    ctx.stuckStartX = ctx.x;
    ctx.stuckStartY = ctx.y;
    ctx.stuckStartTick = ctx.tick;
    return false;
  }

  const elapsed = ctx.tick - ctx.stuckStartTick;
  if (elapsed >= STUCK_TICKS) {
    const moved = distance(ctx.x, ctx.y, ctx.stuckStartX, ctx.stuckStartY);
    ctx.stuckStartX = ctx.x;
    ctx.stuckStartY = ctx.y;
    ctx.stuckStartTick = ctx.tick;
    if (moved < STUCK_DISTANCE) {
      // The visible unstuck response lives in the STUCK LADDER now
      // (navigation/StuckLadder.ts, DEC-005.2): sidestep → back up → replan
      // → smash → relocate. This detector's job is only the executors'
      // path-reset nudge below — the old ±90° jitter (stuckUnstuckTick /
      // unstuckDir / shouldUnstuck) was removed with the ladder replacing it.
      return true;
    }
  }
  return false;
}

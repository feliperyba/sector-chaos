/**
 * Economy state executors extracted from the original BotSystem.ts. Each
 * function body is byte-identical except `this.` → `system.`.
 *
 * The nomination GATES (isWeaponUpgrade / isAtDropSite / isWalkOverPickup +
 * their constants) moved verbatim to BotEconomyGates.ts in bot-ai-v2 ticket
 * 09 (module-length gate) — re-exported below for the historical import path.
 */

import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { BotSystem } from './BotSystem.ts';
import { BotState, type BotContext, type ItemInfo } from './BotContext.ts';
import type { TickBlackboard } from './TickBlackboard.ts';
import { navigateTo, checkStuck, validatedMoveToward } from './BotNavigation.ts';
import { makePickupInput, clampToWalkable } from './BotInput.ts';
import { checkGrabWhilePassing, checkMobilityDash, checkGoalStall } from './BotTickUtilities.ts';
import { executeWander } from './BotRoamExecutors.ts';
import { consumeGoal } from './goal/GoalGenerator.ts';
import { goalNavTarget } from './goal/GoalBinding.ts';
import { findNearestCrate } from './BotSpatialIndex.ts';
import { PICKUP_RADIUS, CHEST_OPEN_RADIUS, CHEST_TIER_SENTINEL } from './BotSystemConstants.ts';
import { distance, NETWORK, WeaponType } from '@sector-battle/shared';
import { packGridKey } from './BotDestructibles.ts';
import { botAllowsWeapon } from './skill/RestrictionTables.ts';
import {
  HEALTH_FULL_BLACKLIST_MS,
  isAtDropSite,
  isWeaponUpgrade,
  isWalkOverPickup,
} from './BotEconomyGates.ts';
import { claimItem, contestInterceptPoint, itemClaimedBy } from './combat/ItemContests.ts';

export { isWeaponUpgrade, isAtDropSite } from './BotEconomyGates.ts';

/** HEALTH_FULL_BLACKLIST_MS in ticks (blacklist expiries are tick counters). */
const HEALTH_FULL_BLACKLIST_TICKS = Math.round(
  (HEALTH_FULL_BLACKLIST_MS * NETWORK.TICK_RATE) / 1000,
);

/**
 * CONTEST RESOLUTION (bot-ai-v2 ticket 09, DEC-010.5): settle the active
 * loot race. The contested item vanishing from perception means SOMEONE
 * grabbed it — the winner is whoever was closer to the seat at the end (the
 * enemy's last observed seat vs my position; deterministic). A contest that
 * simply went stale (the intent stopped refreshing — selector moved on)
 * clears silently. Outcomes bump the pending telemetry drain (win/loss).
 */
function resolveContestIfFinished(system: BotSystem, ctx: BotContext): void {
  const c = ctx.combat;
  if (!c || c.contestedItemId === null) return;
  // Stale (intent no longer refreshing the seat): drop the race state only.
  if (ctx.tick - c.contestClaimTick > 90) {
    c.contestedItemId = null;
    return;
  }
  const stillVisible = ctx.items.some((it) => it.id === c.contestedItemId);
  if (stillVisible) return;
  // Gone: someone picked it up / the chest was opened.
  const myDist = distance(ctx.x, ctx.y, c.contestedItemX, c.contestedItemY);
  const enemyDist = distance(
    c.contestedEnemyX,
    c.contestedEnemyY,
    c.contestedItemX,
    c.contestedItemY,
  );
  c.bump(c.pendingContestOutcomes, myDist <= enemyDist ? 'win' : 'loss');
  c.contestedItemId = null;
  void system; // structural symmetry with the executor seams (no system read needed)
}

export function executeSeekWeapon(system: BotSystem, ctx: BotContext): QueuedInput | null {
  // Under-fire flinching lives in the Reactor now (bot-ai-v2 ticket 04,
  // DEC-004) — the took-damage STARTLE fires for bots in EVERY intent state.
  // Grab a free powerup if we're passing over one en route to a weapon.
  const grab = checkGrabWhilePassing(system, ctx);
  if (grab) return grab;
  // SCOPED INCOMPETENCE (DEC-009.3): an out-of-class floor weapon is NOT a
  // target for a class-locked low tier (crate/fallback path instead).
  const w = ctx.nearestWeapon;
  const weapon =
    w && botAllowsWeapon(ctx.restrictions, w.weaponType ?? WeaponType.FISTS) ? w : null;
  // Mobility dash: sprint to a distant weapon instead of strolling.
  if (weapon) {
    const mobDash = checkMobilityDash(system, ctx, weapon.x, weapon.y);
    if (mobDash) return mobDash;
  }
  // No weapon pickup in scan range: look for the nearest CRATE to break —
  // crates drop weapons when destroyed, so breaking one re-arms the bot.
  // This is critical for the endgame where all loose weapons have been
  // consumed and the only weapon source is unbroken crates. Without it,
  // disarmed survivors head to the empty map center and the match stalls in
  // overtime with everyone unarmed. Fall back to map center only if no crate
  // is reachable.
  if (!weapon) {
    const crate = findNearestCrate(system, ctx.x, ctx.y, 2000);
    const targetX = crate ? crate.x : system.mapCenter.x;
    const targetY = crate ? crate.y : system.mapCenter.y;
    const arrival = crate ? 60 : 200;
    const input = navigateTo(
      ctx,
      targetX,
      targetY,
      system.pathfinder,
      arrival,
      system.destructibleMap,
    );
    if (input === null && ctx.demolitionGridX >= 0) {
      ctx.preDemolitionState = BotState.SEEK_WEAPON;
      ctx.state = BotState.DEMOLITION;
      return null;
    }
    // ARRIVAL AT CRATE: navigateTo returns null at arrival (within 60px), but
    // the crate tile is non-walkable so demolition wasn't triggered inside
    // navigateTo. The bot is standing NEXT TO the crate it came to break —
    // trigger demolition on the crate's tile explicitly so the bot doesn't
    // stall idle beside the very thing it sought. (Major SEEK_WEAPON idle
    // contributor: bots reached crates then stood still.)
    if (input === null && crate) {
      const ts = system.pathfinder.getTileSize();
      const gx = Math.floor(crate.x / ts);
      const gy = Math.floor(crate.y / ts);
      const key = packGridKey(gx, gy);
      if (system.destructibleMap.has(key)) {
        ctx.demolitionTargetX = gx * ts + ts / 2;
        ctx.demolitionTargetY = gy * ts + ts / 2;
        ctx.demolitionGridX = gx;
        ctx.demolitionGridY = gy;
        ctx.preDemolitionState = BotState.SEEK_WEAPON;
        ctx.state = BotState.DEMOLITION;
        return null;
      }
    }
    if (checkStuck(ctx)) {
      ctx.setPath(null);
      ctx.pathRepathTick = 0;
    }
    return input;
  }
  if (weapon.distance < PICKUP_RADIUS) {
    return makePickupInput(ctx.playerId, weapon.id, ctx.tick);
  }
  // Goal-stall escape: if we haven't moved meaningfully in a window, we're
  // geometry-stuck against a wall we can't break. Force a wander to break free.
  // (No blackboard here — executeWander's bb is optional; SEEK_WEAPON keeps
  // its 2-arg surface for the existing unit-test call paths.)
  if (checkGoalStall(system, ctx)) {
    return executeWander(system, ctx);
  }
  // Pass the destructible map so a bot blocked from a weapon by a crate/wall
  // breaks through it (unarmed bots have FISTS — slow but better than being
  // permanently walled off from loot).
  const input = navigateTo(
    ctx,
    weapon.x,
    weapon.y,
    system.pathfinder,
    PICKUP_RADIUS,
    system.destructibleMap,
  );
  if (input === null && ctx.demolitionGridX >= 0) {
    ctx.preDemolitionState = BotState.SEEK_WEAPON;
    ctx.state = BotState.DEMOLITION;
    return null;
  }
  // UNIFIED ARRIVAL MODEL (bot-ai-v2 ticket 06, DEC-005.6): navigateTo
  // arrives at the NEAREST-WALKABLE APPROACH point of a non-walkable target
  // tile — one model for every "item parked on a wall edge" case. On
  // arrival: within PICKUP_RADIUS the server's proximity pickup honors a
  // direct PICKUP; otherwise close the last pixels with a WALL-VALIDATED
  // straight walk (the slide keeps the bot scraping along the tile edge
  // until it crosses the pickup radius — the walk-over equivalent for
  // action-based weapon pickups). This REPLACES the two old ad-hoc
  // <120/<160px SEEK_WEAPON arrival patches.
  if (input === null) {
    if (weapon.distance <= PICKUP_RADIUS) {
      return makePickupInput(ctx.playerId, weapon.id, ctx.tick);
    }
    return validatedMoveToward(ctx, weapon.x, weapon.y, system.pathfinder);
  }
  if (checkStuck(ctx)) {
    ctx.setPath(null);
    ctx.pathRepathTick = 0;
  }
  return input;
}

export function executeLoot(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
): QueuedInput | null {
  // CHEST CHANNEL HOLD: chest-opening is a 0.5s channeled action that
  // interrupts if the player moves >8px. Once we've started opening a chest,
  // it vanishes from the WorldSnapshot item list (only 'closed' chests are
  // streamed), so we must remember it here and hold still (pickup + no move)
  // until the channel completes or we drift out of range. Without this, bots
  // started 822 opens and completed 0 — every single one was interrupted when
  // the chest disappeared from perception and the bot re-picked a new target.
  if (ctx.openingChestId) {
    const distToOpening = distance(ctx.x, ctx.y, ctx.openingChestX, ctx.openingChestY);
    if (distToOpening < CHEST_OPEN_RADIUS) {
      // Still in range — hold the channel. Emitting PICKUP again is a no-op
      // server-side (already_open) but harmless, and crucially we emit NO
      // movement so the ±8px hold is preserved.
      return makePickupInput(ctx.playerId, ctx.openingChestId, ctx.tick);
    }
    // Drifted out of range (or the chest finished + was looted and we moved).
    // Clear and resume normal looting.
    ctx.openingChestId = null;
  }

  // CONTEST RESOLUTION (bot-ai-v2 ticket 09): settle any finished loot race
  // before re-targeting (win/loss telemetry + state clear).
  resolveContestIfFinished(system, ctx);

  // Under-fire flinching lives in the Reactor now (bot-ai-v2 ticket 04,
  // DEC-004) — the took-damage STARTLE fires for bots in EVERY intent state
  // (this executor's retired under-fire special case was one of three).

  // Pick the closest actionable pickup among the intent layer's LOOT
  // candidates. Health wins on ties (it directly extends survival); otherwise
  // closest-first keeps the bot efficient.
  const candidates: ItemInfo[] = [];
  // Filter out blacklisted items (unreachable items the bot abandoned after
  // stalling toward them — see the universal anti-stall blacklist).
  const isBlacklisted = (id: string): boolean => {
    const expiry = ctx.blacklistedItems.get(id);
    if (expiry === undefined) return false;
    if (ctx.tick > expiry) {
      ctx.blacklistedItems.delete(id);
      return false;
    }
    return true;
  };
  // ANTI-FLOCKING: skip items another bot claimed this tick. Bots process
  // sequentially; the first to target an item reserves it so later bots pick a
  // different target, spreading the lobby across loot instead of piling on one
  // chest/weapon.
  // PERSISTENT CLAIMS (bot-ai-v2 ticket 09, DEC-010.5): the check ALSO honors
  // the cross-tick claim store — a bot that claimed the item on a previous
  // tick (and keeps refreshing while en route) holds it, so two bots can no
  // longer alternate-claim one item across ticks (the audited loot ping-pong).
  const isClaimed = (id: string): boolean =>
    bb.claimedItems.has(id) ||
    itemClaimedBy(system.itemClaims, id, ctx.playerId, ctx.tick) !== null;
  // HEALTH-PACK FULL-HP GATE: mirror PickupPowerUpCommand's server-side
  // rejection (player.health.current >= max → "Already at full health").
  // The walkover loop (GameSimulationWalkovers) silently swallows the
  // failure, so a full-HP bot that targets a health pack would walk on it,
  // fail to pick it up, re-perceive it as nearestHealth next tick, and
  // re-walk forever (the bot IS moving, so anti-stall never fires). Blacklist
  // the unneeded pack briefly so the bot moves on to other candidates.
  // DEC-006 fix 3: the expiry is TICK-converted (3s), not raw milliseconds.
  const isFullHp = ctx.health >= ctx.maxHealth;
  if (ctx.nearestHealth) {
    if (isFullHp && !isBlacklisted(ctx.nearestHealth.id)) {
      ctx.blacklistedItems.set(ctx.nearestHealth.id, ctx.tick + HEALTH_FULL_BLACKLIST_TICKS);
    } else if (!isBlacklisted(ctx.nearestHealth.id)) {
      candidates.push(ctx.nearestHealth);
    }
  }
  if (
    ctx.nearestBarrier &&
    !ctx.selfBarrierActive &&
    !isBlacklisted(ctx.nearestBarrier.id) &&
    !isClaimed(ctx.nearestBarrier.id)
  )
    candidates.push(ctx.nearestBarrier);
  if (
    ctx.nearestSpeedBoost &&
    !isBlacklisted(ctx.nearestSpeedBoost.id) &&
    !isClaimed(ctx.nearestSpeedBoost.id)
  )
    candidates.push(ctx.nearestSpeedBoost);
  // WEAPON NOMINATION GATE: only nominate a floor weapon if it's a genuine
  // upgrade (tier or role-filling) AND not the bot's own just-dropped weapon.
  // Without this, a full-inventory bot picks up an equal-tier weapon, the
  // server swaps + drops the old one at the bot's feet, and the bot
  // immediately re-targets the drop → infinite A↔B swap-grab loop.
  if (
    ctx.nearestWeapon &&
    !isBlacklisted(ctx.nearestWeapon.id) &&
    !isClaimed(ctx.nearestWeapon.id) &&
    !isAtDropSite(ctx, ctx.nearestWeapon) &&
    isWeaponUpgrade(ctx, ctx.nearestWeapon)
  ) {
    candidates.push(ctx.nearestWeapon);
  }
  if (ctx.nearestChest && !isBlacklisted(ctx.nearestChest.id) && !isClaimed(ctx.nearestChest.id))
    candidates.push(ctx.nearestChest);
  // MACRO-GOAL BINDING (bot-ai-v2 ticket 07, DEC-008): no actionable pickup
  // in scan → follow the active macro-goal. A LOOT_CLUSTER goal routes to
  // remembered loot (heard chest seat / tier-sector route) BEYOND scan
  // range — arriving re-perceives it; other goal kinds route through
  // executeWander (the goal-driven roam). Pure goal-driven movement either
  // way: the random barrel-sparse fallback is retired.
  if (candidates.length === 0) {
    const goalNav = goalNavTarget(system, ctx, bb, ['LOOT_CLUSTER']);
    if (goalNav) {
      const goalInput = navigateTo(
        ctx,
        goalNav.x,
        goalNav.y,
        system.pathfinder,
        120,
        system.destructibleMap,
      );
      if (goalInput === null && ctx.demolitionGridX >= 0) {
        ctx.preDemolitionState = BotState.LOOT;
        ctx.state = BotState.DEMOLITION;
        return null;
      }
      if (goalInput === null && ctx.demolitionGridX < 0) {
        // Arrived at the remembered loot ground — consume the goal (the
        // generator re-scores next tick; perception has already picked up
        // whatever is actually here).
        const goalState = system.macroGoals?.get(ctx.playerId);
        if (goalState) consumeGoal(goalState, ctx.tick);
        ctx.setPath(null);
      }
      if (checkStuck(ctx)) {
        ctx.setPath(null);
        ctx.pathRepathTick = 0;
      }
      return goalInput;
    }
    return executeWander(system, ctx, bb);
  }
  // Pick the closest actionable pickup among the candidates (closest-first
  // with a health/barrier priority tiebreak). The pathfinder's navigateTo
  // handles routing around walls; the goal-stall escape below handles any
  // geometry wedges. (Earlier reachability/LOS filters were removed — they
  // either consumed the per-tick A* budget [24 searches across ALL bots],
  // starving real navigation, or sent bots to worse targets. The straight-
  // line-nearest + stall-escape combo is simpler and doesn't regress.)
  candidates.sort((a, b) => {
    const aPrio = a.type === 'powerup' ? -20 : 0;
    const bPrio = b.type === 'powerup' ? -20 : 0;
    return a.distance + aPrio - (b.distance + bPrio);
  });
  const target = candidates[0]!;
  // Claim the chosen item so other bots spread to other loot. Health packs are
  // exempt — multiple damaged bots may need the same pack (proximity resolves).
  // PERSISTENT CLAIM (DEC-010.5): the claim ALSO goes to the cross-tick store
  // (refreshed every tick while this bot keeps targeting the item; lazily
  // expires when it moves on).
  if (target.powerUpType !== 'health_pack') {
    bb.claimedItems.add(target.id);
    claimItem(system.itemClaims, target.id, ctx.playerId, ctx.tick);
  }
  if (isWalkOverPickup(target)) {
    // Powerups auto-collect on walk-over — keep moving toward/over the item.
    // Never emit PICKUP for a powerup (it's a no-op and halts movement,
    // stranding the bot at the edge of pickup range). Walk toward it through
    // the WALL-VALIDATED straight move (DEC-005.1 guarantee); the server
    // grabs it the moment the bot crosses PICKUP_RADIUS.
    return validatedMoveToward(ctx, target.x, target.y, system.pathfinder);
  }
  if (target.distance < PICKUP_RADIUS) {
    // Record the pickup site if the bot's inventory is full — the server will
    // swap + drop the old weapon here, and isAtDropSite() uses this to skip
    // the just-dropped weapon next tick (breaks the swap-grab loop).
    if (target.type === 'weapon') {
      let hasEmptySlot = false;
      for (let i = 1; i < ctx.weapons.length; i++) {
        if (ctx.weapons[i] === null) {
          hasEmptySlot = true;
          break;
        }
      }
      if (!hasEmptySlot) {
        ctx.lastFullPickupTick = ctx.tick;
        ctx.lastFullPickupX = ctx.x;
        ctx.lastFullPickupY = ctx.y;
      }
    }
    return makePickupInput(ctx.playerId, target.id, ctx.tick);
  }
  // BUDGET-SAFE PATH-DISTANCE CHECK: if the closest loot is far (>250px), do a
  // SINGLE findPath to check whether it's a pathological detour (path > 2.5×
  // straight-line = across a solid wall). If so, the bot would stall against
  // the geometry trying to shortcut — fall to WANDER (local roam) instead,
  // which picks a target it can actually reach. This uses at most ONE A*
  // search per LOOT bot per tick (not per-candidate), so it won't starve the
  // 24-search-per-tick budget the way the earlier per-candidate filter did.
  // Cached pathfinding makes this cheap when the bot is already en route.
  if (target.distance > 250) {
    const clamped = clampToWalkable(system.pathfinder, target.x, target.y);
    // ctx.lodTier = the A* search-priority class (ticket 11, DEC-012.3).
    const path = system.pathfinder.findPath(
      { x: ctx.x, y: ctx.y },
      { x: clamped.x, y: clamped.y },
      ctx.lodTier,
    );
    if (path && path.length >= 2) {
      let pathLen = 0;
      for (let i = 1; i < path.length; i++) {
        pathLen += distance(path[i - 1]!.x, path[i - 1]!.y, path[i]!.x, path[i]!.y);
      }
      if (pathLen / Math.max(1, target.distance) > 2.5) {
        // Pathological detour — the loot is across a wall. Wander locally
        // instead of stalling; the bot will re-acquire loot when it's closer.
        return executeWander(system, ctx, bb);
      }
    } else if (!path && !system.pathfinder.lastFindDeferred) {
      // No path at all — unreachable. Wander. (A*-CAP SENTINEL, DEC-005.5: a
      // DEFERRED search — shared budget exhausted — is NOT unreachable: fall
      // through to navigateTo, which retries next tick and keeps the target.)
      return executeWander(system, ctx, bb);
    }
  }
  // Mobility dash: sprint to distant loot instead of strolling.
  const mobDash = checkMobilityDash(system, ctx, target.x, target.y);
  if (mobDash) return mobDash;
  // Goal-stall escape (same as SEEK_WEAPON): if we haven't moved meaningfully,
  // we're geometry-stuck. Force a wander to break free. ALSO blacklist all
  // visible items so the bot doesn't immediately re-select the same unreachable
  // target and re-stall (the LOOT→WANDER→LOOT oscillation that produced 100s+
  // stalls). This catches the stall at 2s (checkGoalStall) before the 5s
  // universal anti-stall, so the bot abandons unreachable items fast.
  if (checkGoalStall(system, ctx)) {
    const BL = 1800; // 30s blacklist
    if (ctx.nearestWeapon) ctx.blacklistedItems.set(ctx.nearestWeapon.id, ctx.tick + BL);
    if (ctx.nearestChest) ctx.blacklistedItems.set(ctx.nearestChest.id, ctx.tick + BL);
    if (ctx.nearestHealth) ctx.blacklistedItems.set(ctx.nearestHealth.id, ctx.tick + BL);
    if (ctx.nearestBarrier) ctx.blacklistedItems.set(ctx.nearestBarrier.id, ctx.tick + BL);
    if (ctx.nearestSpeedBoost) ctx.blacklistedItems.set(ctx.nearestSpeedBoost.id, ctx.tick + BL);
    return executeWander(system, ctx, bb);
  }
  // Chests have a much larger interaction range (192px) than weapon pickups
  // (64px), and their tile is non-walkable so the bot can't physically reach
  // PICKUP_RADIUS. Emit the open as soon as we're inside the chest's range,
  // and record it so we HOLD STILL through the 0.5s channel (see top of fn).
  if (target.tier === CHEST_TIER_SENTINEL && target.distance < CHEST_OPEN_RADIUS) {
    ctx.openingChestId = target.id;
    ctx.openingChestX = target.x;
    ctx.openingChestY = target.y;
    return makePickupInput(ctx.playerId, target.id, ctx.tick);
  }
  const arrivalRadius = target.tier === CHEST_TIER_SENTINEL ? CHEST_OPEN_RADIUS : PICKUP_RADIUS;
  // INTERCEPT PATHING (bot-ai-v2 ticket 09, DEC-010.5): while racing for the
  // contested item, route to the INTERCEPT POINT on the enemy's approach side
  // (inside the item's interaction reach, on the enemy→item line) — arriving
  // first on the racer's line is the tense human loot-race move. Non-contested
  // looting routes to the item itself, exactly as before.
  let navX = target.x;
  let navY = target.y;
  const cc = ctx.combat;
  if (cc && cc.contestedItemId === target.id) {
    const reach = target.tier === CHEST_TIER_SENTINEL ? CHEST_OPEN_RADIUS : PICKUP_RADIUS;
    const intercept = contestInterceptPoint(
      target.x,
      target.y,
      cc.contestedEnemyX,
      cc.contestedEnemyY,
      reach,
    );
    navX = intercept.x;
    navY = intercept.y;
  }
  const input = navigateTo(
    ctx,
    navX,
    navY,
    system.pathfinder,
    arrivalRadius,
    system.destructibleMap,
  );
  if (input === null && ctx.demolitionGridX >= 0) {
    ctx.preDemolitionState = BotState.LOOT;
    ctx.state = BotState.DEMOLITION;
    return null;
  }
  // UNIFIED ARRIVAL MODEL (bot-ai-v2 ticket 06, DEC-005.6): same one model
  // as SEEK_WEAPON — navigateTo arrived at the nearest-walkable approach of
  // the target tile; PICKUP when the server's proximity radius is already
  // satisfied, otherwise a WALL-VALIDATED straight closing walk (walk-over
  // items auto-collect on the way in). REPLACES the two old ad-hoc
  // <120/<160px LOOT arrival patches. (Chests are excluded — their channeled
  // open is handled above by the chest-channel block with its own range.)
  if (input === null && target.tier !== CHEST_TIER_SENTINEL) {
    if (target.distance <= PICKUP_RADIUS) {
      return makePickupInput(ctx.playerId, target.id, ctx.tick);
    }
    return validatedMoveToward(ctx, target.x, target.y, system.pathfinder);
  }
  if (checkStuck(ctx)) {
    ctx.setPath(null);
    ctx.pathRepathTick = 0;
  }
  return input;
}

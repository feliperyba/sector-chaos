/**
 * Named phase functions of the per-bot tick pipeline, extracted verbatim from
 * the original monolithic tickBot (BotTickDriver.ts, ticket 34). Each phase
 * body is byte-identical to the corresponding slice of the original function
 * — the ONLY edits are the function signatures and the demolition guard's
 * `return;` → `return true;` (modeled as a boolean the thin driver checks at
 * the exact original early-return point).
 *
 * The phase ORDER is load-bearing and documented on the thin driver
 * (BotTickDriver.tickBot) — do not call these in any other order.
 *
 * `executeState` also lives here: it is called only from these phases, and
 * keeping it out of BotTickDriver.ts avoids a runtime circular import
 * between the two modules. (The stall machinery — the anti-stall window +
 * currentPursuitDistance + the ladder-relocation consumption — moved to
 * BotTickStall.ts in bot-ai-v2 ticket 06 for the length gate; the
 * runAntiStall phase below delegates there.)
 *
 * Phases/executors that read or write per-tick COORDINATION state take the
 * TickBlackboard explicitly (`bb`) — threaded from BotSystem.tick through
 * tickBot (ticket 35). Phases with no coordination dependency keep their
 * original signatures.
 */

import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { PlayerDTO } from './WorldSnapshot.ts';
import { ZONE } from '@sector-battle/shared';
import type { BotSystem } from './BotSystem.ts';
import { BotState } from './BotContext.ts';
import type { BotContext } from './BotContext.ts';
import { scanWorld } from './BotPerception.ts';
import { intentIdToBotState, botStateToIntentFamily } from './intent/intents.ts';
import type { IntentContext } from './intent/Intent.ts';
import type { PersonalityProfile } from './intent/PersonalityProfile.ts';
import type { IntentSelector } from './intent/IntentSelector.ts';
import type { TickBlackboard } from './TickBlackboard.ts';
import { getBarrelDensityAt } from './BotSpatialIndex.ts';
import { rescanHazards } from './BotSelfState.ts';
import { tallyExecutorInputs, noteGoalSuspension } from './BotTelemetry.ts';
import { runBeliefScan } from './belief/BeliefUpdate.ts';
import { executeFleeZone, executeHunt, executeWander } from './BotRoamExecutors.ts';
import {
  executeEngageState,
  executeRetreatState,
  executeDemolitionState,
} from './BotCombatExecutors.ts';
import { executeSeekWeapon, executeLoot } from './BotEconomyExecutors.ts';
import { pickZoneSafePoint, type ZoneInfo } from './BotZoneSafety.ts';
import { GOAL_SUSPEND_TICKS, DEMO_TIMEOUT } from './BotSystemConstants.ts';
import { lodDeliberationSuspended, scanPhaseForStride, scanStrideForTier } from './lod/LodTiers.ts';
import { consumeLadderRelocation, runAntiStallWindow } from './BotTickStall.ts';
import { buildGoalInputs } from './goal/GoalBinding.ts';
import { updateMacroGoal } from './goal/GoalGenerator.ts';
import { MACRO_GOAL_KIND_LABELS } from './goal/GoalTypes.ts';
import { msToTicks } from './goal/ZoneTiming.ts';

/**
 * Perception phase: staggered enemy/item scan dispatch plus the perception-
 * derived ctx refreshes (local barrel density, HUNT arrival-escape reset)
 * and the stimulus→perception merge (bot-ai-v2 ticket 03).
 * @param system the shared BotSystem (world snapshot + stimulus router).
 * @param ctx the bot's blackboard.
 * @param dto this tick's read-only player view.
 * @param profile the bot's personality profile (drives the per-difficulty
 *  belief tables — bot-ai-v2 ticket 05, DEC-003).
 */
export function runPerception(
  system: BotSystem,
  ctx: BotContext,
  dto: PlayerDTO,
  profile: PersonalityProfile,
): void {
  // Stagger the ENEMY/ITEM perception scans across ticks via a per-bot phase
  // so ~1/3 of bots scan each tick instead of all 60+ on the same tick (which
  // spikes the 16ms budget). Tracked target positions stay real-time (read
  // from the snapshot updated every tick); only fresh-threat/item discovery
  // is delayed ≤50ms.
  //
  // HAZARD scanning (barrels/traps) runs EVERY tick — it's a single cheap
  // spatial-grid query per bot and is safety-critical. A bot that walks into
  // a barrel between staggered scans dies instantly, which feels broken to
  // players. The cost is small (no enemy iteration, just nearby destructibles)
  // and keeps hazard avoidance reactive at all times.
  //
  // LOD STRIDE (bot-ai-v2 ticket 11, DEC-012): T0/T1 keep the 3-tick scan;
  // T2 stretches the FULL scan to 9 ticks (coarse perception — the stride
  // applies while enemies are in view, i.e. exactly the expensive scan: an
  // all-bot T2 bot by definition has no other player within perception
  // range). The hazard rescan below is NOT cadenced. A tier whose
  // deliberation is budget-relief-suspended skips its cadenced full scan
  // this tick too (the relief valve trims the expensive pass first). The
  // pre-existing empty-enemies force-scan keeps running at every tier — with
  // no players in range it is a cheap empty query and it is the bot's
  // item/economy discovery mechanism. Relief never fires under the bench
  // harness's virtual clock, so cadence stays deterministic there.
  const stride = scanStrideForTier(ctx.lodTier);
  const suspended = lodDeliberationSuspended(ctx.lodTier, ctx.lodCombatTier, ctx.lodRelief);
  const stridePhase = scanPhaseForStride(stride, ctx.perceptionPhase, ctx.perceptionPhase9);
  if ((!suspended && ctx.tick % stride === stridePhase % stride) || ctx.enemies.length === 0) {
    scanWorld(ctx, system.worldSnapshot, dto);
    // BELIEVED-STATE SCAN (bot-ai-v2 ticket 05, DEC-003): write foveated
    // seen-beliefs for this scan's enemies (GDD §14.2 detection-range fade +
    // §14.3 LOS-halving as confidence modifiers, position noise scaled by
    // facing/distance/difficulty), decay + expire stale beliefs, and enforce
    // the search-failure bound on investigations (belief drop + intent-family
    // cooldown). Runs AFTER scanWorld + the stimulus refresh so the seen
    // writes see this scan's ground truth and the re-acquisition closes fire
    // before the search-failure check.
    runBeliefScan(system, ctx, profile);
  } else {
    rescanHazards(system, ctx, dto);
  }

  // STIMULUS→PERCEPTION MERGE — EVERY tick at EVERY tier (ticket 11, was
  // scan-ticks only): decode the bot's bounded stimulus queue (≤8 entries —
  // cheap) into the published view. The Reactor runs every tick for every
  // tier (reactions are the visible thing), so its input view must refresh
  // every tick too — a T2 bot's 9-tick scan stride must NOT delay flinching
  // on an explosion by up to 8 ticks. Deterministic (tick-stamped decay).
  system.stimulusRouter.refreshScanFor(ctx.playerId, ctx.tick);

  // Set the bot's local barrel density from the shared grid. Used by
  // BotCombat to decide whether to reposition out of barrel-dense areas.
  ctx.localBarrelDensity = getBarrelDensityAt(system, ctx.x, ctx.y);

  // FIGHT-MEMORY VIEW (bot-ai-v2 ticket 08): mirror the shared combat
  // hotspot onto the ctx so the movement signature's hotspot-avoidance blend
  // (BotMovementSignature.applyHotspotAvoidance) can read it without
  // navigateTo needing a system reference. Freshness is judged by the reader
  // (HOTSPOT_FRESH_TICKS) against fightMemoryTick. Deterministic — the
  // hotspot itself is stimulus-written.
  ctx.fightMemoryX = system.combatHotspot.x;
  ctx.fightMemoryY = system.combatHotspot.y;
  ctx.fightMemoryTick = system.combatHotspot.tick;

  // Clear the HUNT arrival-escape flag whenever we have a live enemy in sight
  // — re-engagement invalidates "I arrived and found nothing." This lets a
  // bot that spread out from a dead hotspot immediately re-converge on a real
  // fight without waiting out HUNT_ARRIVAL_ESCAPE_TICKS.
  if (ctx.nearestEnemy) {
    ctx.huntArrivalTick = -9999;
  }
}

/**
 * Zone-safety phase: sync the current zone geometry into ctx and compute the
 * safe point (target/next center during a shrink) so FLEE_ZONE pre-positions
 * the bot inside the next ring instead of chasing the shrinking current edge.
 * @param ctx the bot's blackboard (zone fields written here).
 * @param zoneInfo this tick's zone geometry.
 */
export function syncZoneState(ctx: BotContext, zoneInfo: ZoneInfo): void {
  ctx.zoneCenterX = zoneInfo.centerX;
  ctx.zoneCenterY = zoneInfo.centerY;
  ctx.zoneRadius = zoneInfo.radius;
  ctx.zoneIsShrinking = zoneInfo.isShrinking;
  ctx.siegeWarnings = zoneInfo.siegeWarnings;
  // Zone-as-cost arithmetic input (bot-ai-v2 ticket 07): mirrors
  // ZoneService.getTickDamage exactly (phase 1 drop = 0, phase 6 on =
  // sudden-death damage, otherwise the standard per-tick damage) — reads the
  // shared constants so a balance tuning moves the bots' zone model with it
  // (the pre-canon 5/10 literals silently understated the tuned 8/15).
  ctx.zoneDamagePerTick =
    zoneInfo.currentPhase <= 1
      ? 0
      : zoneInfo.currentPhase >= 6
        ? ZONE.ZONE_DAMAGE_SUDDEN_DEATH
        : ZONE.ZONE_DAMAGE_PER_TICK;
  const safe = pickZoneSafePoint(
    zoneInfo.centerX,
    zoneInfo.centerY,
    zoneInfo.targetCenterX,
    zoneInfo.targetCenterY,
    zoneInfo.radius,
    zoneInfo.targetRadius,
    zoneInfo.isShrinking,
    zoneInfo.nextPreview,
  );
  ctx.zoneSafeX = safe.x;
  ctx.zoneSafeY = safe.y;
  ctx.zoneSafeRadius = safe.radius;
}

/**
 * MACRO-GOAL phase (bot-ai-v2 ticket 07, DEC-008): advance the per-bot
 * strategic-goal generator. Runs after perception + zone sync (fresh inputs)
 * and BEFORE the Reactor + intent selection — the goal layer sits ABOVE the
 * intents (the committed goal SURVIVES intent churn beneath it; WANDER/LOOT/
 * HUNT executors bind to it later in the tick). Between rescore passes this
 * is a single tick-compare; the scoring inputs are assembled ONLY on the
 * cadence tick (staggered per bot). A reaction owning the tick does NOT
 * rewind the cadence — goals are memory, not actions, and the cadence is
 * pure tick arithmetic (determinism preserved).
 * @param system the shared BotSystem (macro-goal states, stimulus, identity).
 * @param ctx the bot's blackboard.
 * @param zoneInfo this tick's zone geometry (carries msUntilShrink).
 * @param bb the per-tick coordination blackboard (fight hotspot, stalkers).
 * @param profile the bot's personality profile (archetype data tables).
 */
export function runMacroGoal(
  system: BotSystem,
  ctx: BotContext,
  zoneInfo: ZoneInfo,
  bb: TickBlackboard,
  profile: PersonalityProfile,
): void {
  const state = system.macroGoals.get(ctx.playerId);
  if (!state) return; // unregister race — executors fall back to their anchors
  const inputs =
    ctx.tick >= state.nextRescoreTick ? buildGoalInputs(system, ctx, zoneInfo, bb, profile) : null;
  const result = updateMacroGoal(state, ctx.playerId, ctx.tick, inputs);
  if (result.committed && result.kind) {
    // Observation-only telemetry (DEC-013 surface): the goal-mix per
    // archetype + the pre-position samples (ticks-ahead-of-shrink at commit
    // — the "rotation timing spread" distribution; directional gates are
    // assessed at the orchestrator's sweep over the bench JSON).
    const tracker = system.skillTrackers.get(ctx.playerId);
    if (tracker) {
      tracker.believability.goals.noteMacroGoal(MACRO_GOAL_KIND_LABELS[result.kind]);
      if (result.kind === 'PRE_POSITION' && zoneInfo.msUntilShrink >= 0) {
        tracker.believability.goals.notePrePosition(msToTicks(zoneInfo.msUntilShrink));
      }
    }
  }
}

/**
 * Demolition-yield guard phase: if a navigateTo call last tick set a
 * demolition target (ctx.demolitionGridX >= 0), the bot is mid-breach and the
 * intent selector must NOT override the state this tick.
 * @param system the shared BotSystem (selector lookup, skill trackers).
 * @param ctx the bot's blackboard.
 * @param bb the per-tick coordination blackboard (passed to the demolition
 *  executor via executeState).
 * @param inputs the tick's input accumulator (demolition inputs pushed here).
 * @returns true when the tick is DONE (mid-breach executor ran and its inputs
 *  were pushed — the driver must skip every later phase, reproducing the
 *  original early `return`), false to fall through to anti-stall + intent
 *  selection.
 */
export function runDemolitionYieldGuard(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
  inputs: QueuedInput[],
): boolean {
  // DEMOLITION YIELD: if a navigateTo call last tick set a demolition target
  // (ctx.demolitionGridX >= 0), the bot is mid-breach. The intent selector
  // must NOT override the state this tick — executeDemolitionState needs to
  // run uninterrupted until it destroys the target or aborts. Without this
  // guard, the selector re-picks SEEK_WEAPON/ENGAGE every tick, clobbering
  // the DEMOLITION the executor just entered → the bot never actually swings
  // at the wall (clear rate was 2%). The demolition executor self-exits when
  // the target is gone or out of range, returning to preDemolitionState.
  if (ctx.demolitionGridX >= 0) {
    // DEMOLITION TIMEOUT: if a bot has been in DEMOLITION for >300 ticks (5s)
    // without clearing the tile, bail out — it's stuck (wrong aim, unreachable
    // tile, stale target, or the SAT polygon isn't connecting). Without this,
    // the yield guard re-enters DEMOLITION every tick indefinitely (the
    // diagnostic found a bot stuck in DEMOLITION for 114 seconds). Track the
    // start via demolitionTick: when demolitionGridX is first set, demolitionTick
    // was -9999; we set it to the current tick in executeDemolitionState. If the
    // gap between the first-set and now exceeds the timeout, bail.
    if (ctx.demolitionTick > 0 && ctx.tick - ctx.demolitionTick > DEMO_TIMEOUT) {
      // Stuck in demolition too long — bail to pre-demolition state.
      ctx.demolitionGridX = -1;
      ctx.demolitionGridY = -1;
      ctx.demolitionTick = -9999;
      ctx.setPath(null);
      ctx.state = ctx.preDemolitionState;
      // SUSPEND the pre-demolition goal so the bot RELOCATES instead of
      // re-entering demolition on a nearby tile. Without this, a bot that
      // fails to clear a wall (bad aim, out of range) bails after 5s, the
      // pathfinder routes it through the same destructible-dense area, and
      // it enters demolition on the NEXT tile — cycling 5s episodes forever
      // (the diagnostic found a 91s DEMOLITION stall from exactly this).
      // Suspend the family + record the epicenter so WANDER moves the bot
      // out of the destructible cluster entirely.
      const suspendFamily = botStateToIntentFamily(ctx.preDemolitionState);
      const selector = system.selectors.get(ctx.playerId);
      if (selector) {
        selector.suspend(suspendFamily, ctx.tick + GOAL_SUSPEND_TICKS);
        selector.forceReevaluate();
      }
      noteGoalSuspension(system, ctx.playerId, suspendFamily);
      ctx.stallEpicenterX = ctx.x;
      ctx.stallEpicenterY = ctx.y;
      ctx.stallEpicenterTick = ctx.tick;
      // Fall through to normal intent selection below (don't return).
    } else {
      // Record the demolition start tick on first entry (demolitionTick < 0
      // means we just entered; executeDemolitionState no longer updates it).
      if (ctx.demolitionTick < 0) ctx.demolitionTick = ctx.tick;
      ctx.state = BotState.DEMOLITION;
      const botInputs = executeState(system, ctx, bb);
      if (botInputs) {
        const arr = Array.isArray(botInputs) ? botInputs : [botInputs];
        const tracker = system.skillTrackers.get(ctx.playerId);
        if (tracker) tallyExecutorInputs(tracker, ctx.tick, arr);
        inputs.push(...arr);
      }
      return true;
    }
  }
  return false;
}

/**
 * Universal anti-stall phase (bot-ai-v2 ticket 06: the body moved verbatim to
 * BotTickStall.ts to hold the module-length gate while the stuck-ladder
 * relocation consumption joined the stall machinery). Must run BEFORE intent
 * selection + the executor — see driver order docs.
 * @param system the shared BotSystem (selector lookup).
 * @param ctx the bot's blackboard.
 */
export function runAntiStall(system: BotSystem, ctx: BotContext): void {
  consumeLadderRelocation(system, ctx);
  runAntiStallWindow(system, ctx);
}

/**
 * Intent-selection phase — the canonical decision system (ADR-0030/0031/
 * ADR-0036). Scores all intents weighted by the bot's personality, honors the
 * commit window, and assigns ctx.state for executor dispatch. Early-returns
 * (holding the current intent) while the bot is startled — the Reactor's
 * confusion window (bot-ai-v2 ticket 04, DEC-007: no intent switching while
 * startled).
 * @param system the shared BotSystem (world snapshot + reactor).
 * @param ctx the bot's blackboard (ctx.state assigned here).
 * @param bb the per-tick coordination blackboard (zone-lethal flag).
 * @param profile the bot's personality profile (invariant-guaranteed).
 * @param selector the bot's intent selector (invariant-guaranteed).
 * @param oldState the state captured at TICK ENTRY (before the demolition
 *  guard's timeout branch could rewrite ctx.state) — the transition cleanup
 *  compares against this, not the possibly-bailed-out current state.
 */
export function runIntentSelection(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
  profile: PersonalityProfile,
  selector: IntentSelector,
  oldState: BotState,
): void {
  // STARTLE CONFUSION (DEC-007): while startled the bot does NOT switch
  // intents — the selector is skipped entirely this tick, so the current
  // committed intent + ctx.state stand and its executor runs next. The
  // window is short (startle reaction window + a small tail); the Reactor's
  // imminent-death reaction stays ABOVE this hold because it owns its ticks
  // before this phase is ever reached (see BotTickDriver phase order).
  if (system.reactor.isConfused(ctx.playerId, ctx.tick)) return;

  // INTENT SELECTION — the canonical decision system (ADR-0030/0031/0036).
  // The selector scores all intents weighted by the bot's personality, honors
  // a per-intent commit window (hysteresis), hard-invalidates dead intents,
  // and allows preemption when a much-higher-scoring intent emerges. This is
  // the ONE place state transitions happen, killing the scattered ctx.state =
  // ... assignments that caused per-tick flip-flopping. The selected Intent's
  // execute() returns the legacy BotState for executor dispatch (evolve-in-
  // place: the movement/attack executors stay untouched in Phase 2). This also
  // lets an intent reroute within execute (e.g. SURVIVE_ZONE → ENGAGE via the
  // combat-override that breaks the endgame stall).
  //
  // The profile/selector lookup was hoisted to tickBot entry; the structural
  // invariant throw above guarantees both are present (no `if` guard needed).
  let newState: BotState;
  const myRange = ctx.getWeaponRange(ctx.getActiveWeapon().weaponType);
  const enemyInFightRange = ctx.nearestEnemy !== null && ctx.nearestEnemy.distance < myRange * 1.4;
  const ic: IntentContext = {
    ctx,
    profile,
    aliveBotCount: system.worldSnapshot.aliveBotCount,
    enemyInFightRange,
    zoneIsLethal: bb.zoneIsLethal,
    // DEC-006 fix 4: shared demolition routing for intents that plant
    // demolition targets (BARREL_TRAP) — same pathfinder tile-size accessor
    // and SAT-centroid map every executor path uses. Existing-object
    // references (no per-tick allocation).
    pathfinder: system.pathfinder,
    destructibleCentroidMap: system.destructibleCentroidMap,
    // Ticket 09 (DEC-010.3): the engagement-discretion triggers read the
    // fight-density channel off the bot's published stimulus scan view.
    stimulusScan: system.stimulusRouter.getState(ctx.playerId)?.scan,
    // MATCH ARC (ticket 10, DEC-011): this tick's GDD §14.3 phase-weight
    // state — the combat/looting/positioning intent families shape their
    // scores with it (arc/MatchArc.ts). One shared object per tick.
    arc: system.matchArc,
  };
  const result = selector.select(ic);
  // Find the chosen intent and call execute() — the intent owns the routing
  // decision (e.g. SURVIVE_ZONE may route to ENGAGE via combat-override).
  const chosen = selector.intentsById(result.intentId);
  newState = chosen ? chosen.execute(ic).nextState : intentIdToBotState(result.intentId);
  ctx.stateCommittedUntilTick = result.committedUntilTick;
  if (result.changed && oldState !== newState) {
    if (oldState === BotState.ENGAGE) {
      ctx.targetId = null;
      ctx.setPath(null);
    }
    // Leaving LOOT abandons any in-progress chest channel.
    if (oldState === BotState.LOOT) {
      ctx.openingChestId = null;
    }
    ctx.strafeUntilTick = 0;
    ctx.demolitionGridX = -1;
    ctx.demolitionGridY = -1;
    // RESET stall trackers on a genuine state transition: the new goal
    // deserves a fresh stall window. Without this, a bot that stalled in
    // LOOT (short window at 90 ticks) carries the stale timestamp into
    // HUNT, where checkGoalStall immediately fires again (elapsed > 90),
    // suspending HUNT too — cascading suspessions that paralyze the bot.
    ctx.goalStartTick = -9999;
    ctx.longStallStartTick = -9999;
    ctx.stateEnterTick = ctx.tick;
  }
  ctx.state = newState;
}

/**
 * Executor-dispatch + telemetry phase: run the legacy state executor, count
 * pickup/attack attempts, update anti-stall progress tracking, and push this
 * tick's inputs. (Executor dispatch and telemetry are interleaved per-input
 * in the original code — kept together to preserve statement order.)
 * @param system the shared BotSystem (skill trackers).
 * @param ctx the bot's blackboard.
 * @param bb the per-tick coordination blackboard (passed to the executors).
 * @param inputs the tick's input accumulator.
 */
export function runExecutorAndTelemetry(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
  inputs: QueuedInput[],
): void {
  const botInputs = executeState(system, ctx, bb);
  if (botInputs) {
    const arr = Array.isArray(botInputs) ? botInputs : [botInputs];
    // Telemetry: count pickup attempts and attacks from this tick's inputs.
    // Pickup grabs are confirmed via the domain itemsCollected stat delta at
    // scoring time, but attempt volume is a useful engagement signal here.
    const tracker = system.skillTrackers.get(ctx.playerId);
    if (tracker) tallyExecutorInputs(tracker, ctx.tick, arr);
    // PROGRESS-MASK FIX (bot-ai-v2 ticket 06, DEC-005.3): ATTACK emission NO
    // LONGER counts as anti-stall progress — a wedged-but-whiffing bot read
    // as "making progress" and was never relocated. The old per-input loop
    // (`ATTACK → lastProgressTick = tick`) is gone; progress is now ONLY
    // displacement-toward-goal (the stall windows themselves), completed
    // pickups (BotSelfState) and kills (StimulusRouter noteKillScored).
    inputs.push(...arr);
  }
}

export function executeState(
  system: BotSystem,
  ctx: BotContext,
  bb: TickBlackboard,
): QueuedInput | QueuedInput[] | null {
  switch (ctx.state) {
    case BotState.FLEE_ZONE:
      return executeFleeZone(system, ctx);
    case BotState.SEEK_WEAPON:
      return executeSeekWeapon(system, ctx);
    case BotState.ENGAGE:
      return executeEngageState(system, ctx, bb);
    case BotState.RETREAT:
      return executeRetreatState(system, ctx);
    case BotState.LOOT:
      return executeLoot(system, ctx, bb);
    case BotState.HUNT:
      return executeHunt(system, ctx, bb);
    case BotState.DEMOLITION:
      return executeDemolitionState(system, ctx);
    case BotState.WANDER:
    default:
      return executeWander(system, ctx, bb);
  }
}

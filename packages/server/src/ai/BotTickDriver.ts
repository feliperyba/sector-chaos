/**
 * Thin per-bot tick driver (ticket 34). The original ~370-line monolithic
 * tickBot was split into named phase functions (BotTickPhases.ts); this driver
 * calls them in the EXACT original order. Each phase body is verbatim from the
 * original — behavior is preserved by construction, with one modeled control
 * flow: the demolition guard's early `return` is now a boolean the driver
 * checks at the identical position.
 *
 * updateSelfState/rescanHazards live in BotSelfState.ts; the phase bodies and
 * executeState live in BotTickPhases.ts.
 *
 * The per-tick coordination blackboard (`bb`, ticket 35) is constructed once
 * in BotSystem.tick() before the per-bot loop and forwarded here per bot, in
 * map order — the phases/executors that need coordination state receive it
 * explicitly. It is shared by reference across all bots of the tick, so a
 * later bot sees earlier bots' writes (sequential semantics preserved).
 *
 * LOD THINK GATING (bot-ai-v2 ticket 11, DEC-012): the `thinkTick` flag is
 * computed ONCE per bot in BotSystem.tick (pure tier + cadence + relief
 * arithmetic — lod/LodTiers.isThinkTick) and gates ONLY the deliberative
 * phases (macro-goal rescore + intent selection). The ALWAYS-ON surfaces —
 * perception/hazards, the stimulus view refresh, the REACTOR, the demolition
 * yield guard, anti-stall, and the executor's input submission — run every
 * tick at every tier: bots are players, and reactions are the visible thing.
 */

import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { PlayerDTO } from './WorldSnapshot.ts';
import type { BotSystem } from './BotSystem.ts';
import type { BotContext } from './BotContext.ts';
import { updateSelfState } from './BotSelfState.ts';
import { tallyExecutorInputs } from './BotTelemetry.ts';
import type { ZoneInfo } from './BotZoneSafety.ts';
import type { TickBlackboard } from './TickBlackboard.ts';
import {
  runPerception,
  syncZoneState,
  runMacroGoal,
  runDemolitionYieldGuard,
  runAntiStall,
  runIntentSelection,
  runExecutorAndTelemetry,
} from './BotTickPhases.ts';

export function tickBot(
  system: BotSystem,
  ctx: BotContext,
  dto: PlayerDTO,
  zoneInfo: ZoneInfo,
  bb: TickBlackboard,
  inputs: QueuedInput[],
  thinkTick: boolean,
): void {
  // STRUCTURAL INVARIANT (defense-in-depth): a bot reaching tickBot must have
  // its profile + selector populated by registerBot. registerBot/unregisterBot
  // are the ONLY writers and they mutate bots+profiles+selectors atomically, so
  // any bot in `this.bots` has its profile+selector. If a future bot-spawn path
  // bypasses registerBot, this throws LOUD at the tick boundary instead of
  // silently falling back to a legacy decision cascade. There is no fallback —
  // the intent layer is the single canonical decision system (ADR-0036).
  const profile = system.profiles.get(ctx.playerId);
  const selector = system.selectors.get(ctx.playerId);
  if (!profile || !selector) {
    throw new Error(
      'BotSystem invariant violated: bot ' +
        ctx.playerId +
        ' has no profile/selector — registerBot must have been bypassed',
    );
  }

  // Self-state sync FIRST: refreshes the ctx weapon/HP/position fields that
  // every later phase reads.
  updateSelfState(system, ctx, dto);

  // ── PHASE ORDER IS LOAD-BEARING ──────────────────────────────────────────
  // The phases below run in the exact order the original monolithic tickBot
  // ran them. Do NOT reorder — each constraint is a behavior dependency:
  //
  // 1. runPerception before everything that reads its outputs: the intent
  //    selection and the executors all consume this tick's
  //    ctx.nearestEnemy / ctx.localBarrelDensity. (The stimulus→perception
  //    view refresh — bot-ai-v2 ticket 03, every tick at every tier since
  //    ticket 11 — runs at the end of this phase; the shared fight memory
  //    has no per-bot write phase — the StimulusRouter owns it, fed by the
  //    domain-event stream.)
  // 2. syncZoneState before intent selection (SURVIVE_ZONE/FLEE_ZONE score
  //    ctx.zoneSafe*/zoneIsShrinking/siegeWarnings).
  // 3. REACTOR (bot-ai-v2 ticket 04, DEC-004) after perception + zone sync,
  //    before EVERYTHING deliberative (demolition guard, anti-stall, intent
  //    selection, executors): the prioritized interrupt layer. It reads this
  //    tick's perception + the bot's stimulus scan view; when a reaction
  //    owns the tick it emits the tick's inputs here and the driver RETURNS —
  //    movement/aim belong to the reaction for its bounded window. Bypasses
  //    the selector's commit windows by construction (reactions are not
  //    intents). Runs in ALL intent states — that is what retired the three
  //    executor under-fire special cases. ALWAYS-ON under LOD (ticket 11):
  //    never think-gated, at any tier or relief level.
  // 4. `oldState` is captured BEFORE runDemolitionYieldGuard on purpose: the
  //    guard's timeout branch REWRITES ctx.state (= preDemolitionState), and
  //    the intent-selection transition cleanup must compare against the
  //    tick-ENTRY state, not the bailout state.
  // 5. runDemolitionYieldGuard BEFORE intent selection — a mid-breach bot
  //    (demolitionGridX >= 0) must not have its DEMOLITION re-scored away by
  //    the selector. Its `true` return short-circuits the REST of the tick
  //    (anti-stall, selection, executor) — reproducing the original early
  //    `return` inside the guard. ALWAYS-ON under LOD: a mid-breach episode
  //    must not stall on a think-cadence tick.
  // 6. runAntiStall BEFORE intent selection and the executor — its snapshot
  //    and currentPursuitDistance read the PRE-selection BotState
  //    (ENGAGE/HUNT pursuit distance) and the PRE-executor position; running
  //    it after either would misjudge stalls. ALWAYS-ON under LOD (cheap,
  //    keeps far bots from wedging while thinking slowly).
  // 7. runIntentSelection BEFORE runExecutorAndTelemetry — it assigns
  //    ctx.state, which executeState dispatches on. LOD-GATED (ticket 11):
  //    skipped on off-think ticks — the committed intent + state stand and
  //    the executor still runs (T1/T2 bots hold their decision between
  //    thinks; combat entry upgrades the tier — and thus the think cadence —
  //    the same tick it happens).
  // ──────────────────────────────────────────────────────────────────────────
  runPerception(system, ctx, dto, profile);
  syncZoneState(ctx, zoneInfo);

  // MACRO-GOAL (bot-ai-v2 ticket 07, DEC-008): the committed strategic-goal
  // layer above intents — scored candidates every ~2-3 s staggered per bot,
  // committed 3-6 s (commit-sticky). Between cadence passes this is one tick
  // compare. Runs before the Reactor + intent selection so this tick's
  // executors can already bind to the committed goal. LOD-GATED (ticket 11):
  // on off-think ticks the goal state machine simply advances on the next
  // think tick (its cadence is internal tick arithmetic — deterministic).
  if (thinkTick) runMacroGoal(system, ctx, zoneInfo, bb, profile);

  // REACTOR — the interrupt layer (see phase-order note 3). The scan view is
  // the bot's last published stimulus view — refreshed EVERY tick by
  // runPerception's stimulus→perception merge (ticket 11 made the merge
  // every-tick at every LOD tier; only the enemy/item scan above it is
  // cadenced), so the Reactor's input view is never stale.
  const reactionInputs = system.reactor.runReactionTick(
    ctx,
    dto,
    system.stimulusRouter.getState(ctx.playerId)?.scan,
    bb.zoneIsLethal,
    profile,
  );
  if (reactionInputs !== null) {
    // VISIBILITY INVARIANT, enforced loudly: a reaction that owns a tick
    // must have emitted at least one observable input (turn/move/dash). The
    // emit path constructs this by construction (the MOVE is unconditional);
    // this is the runtime tripwire that makes a violated invariant FAIL
    // instead of silently no-op'ing (same defense-in-depth style as the
    // profile/selector invariant at tickBot entry).
    if (reactionInputs.length === 0) {
      throw new Error(
        'Reactor invariant violated: bot ' +
          ctx.playerId +
          ' reaction owned tick ' +
          ctx.tick +
          ' with zero emitted inputs',
      );
    }
    // Same tally the executor path uses: believability reason tags (reaction
    // dashes read 'react-<type>') + the attack/pickup counters (reaction
    // ticks emit MOVE/DASH only, so those counters are untouched here).
    const tracker = system.skillTrackers.get(ctx.playerId);
    if (tracker) tallyExecutorInputs(tracker, ctx.tick, reactionInputs);
    inputs.push(...reactionInputs);
    return;
  }

  const oldState = ctx.state;

  if (runDemolitionYieldGuard(system, ctx, bb, inputs)) return;

  runAntiStall(system, ctx);
  if (thinkTick) runIntentSelection(system, ctx, bb, profile, selector, oldState);
  runExecutorAndTelemetry(system, ctx, bb, inputs);
}

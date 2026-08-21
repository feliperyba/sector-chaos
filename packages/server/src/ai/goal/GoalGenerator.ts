/**
 * Macro-goal generator cadence — bot-ai-v2 ticket 07 (DEC-008).
 *
 * The per-bot state machine that OWNS commitment:
 *  - RE-SCORE every ~2-3 s, STAGGERED per bot (hashPhase on the rescore
 *    spread — no RNG draws, no clock reads).
 *  - COMMIT the winner for 3-6 s (data-table window × profile commit
 *    multiplier, clamped back into the range, staggered per bot).
 *  - COMMIT-STICKY (the "memory + commitment" point): a committed goal is
 *    held for its FULL window — the scoring cadence refreshes scores but a
 *    pass inside the window never switches the goal. This is what makes the
 *    goal survive intent churn beneath it (ENGAGE↔HUNT flips mid-rotation
 *    do not reroll the strategy).
 *  - ARRIVAL: executors that reach the goal point consume it (consumeGoal)
 *    so the next tick regenerates — a goal is a destination, not a home.
 *
 * Pure with respect to the outside world: mutates only the passed state.
 */

import { hashPhase } from '../BotContext.ts';
import {
  MACRO_GOAL_COMMIT_MAX_TICKS,
  MACRO_GOAL_COMMIT_MIN_TICKS,
  MACRO_GOAL_COMMIT_STAGGER_TICKS,
  MACRO_GOAL_RESCORE_BASE_TICKS,
  MACRO_GOAL_RESCORE_STAGGER_TICKS,
} from './GoalTables.ts';
import { scoreMacroGoals, type ScoredCandidate } from './GoalScoring.ts';
import {
  MACRO_GOAL_KIND_LABELS,
  mapIdentitySectorIndex,
  type MacroGoal,
  type MacroGoalInputs,
  type MacroGoalKind,
  type MacroGoalState,
} from './GoalTypes.ts';

export type { MacroGoalState } from './GoalTypes.ts';

/** Build a fresh per-bot generator state (BotSystem.registerBot). The first
 *  rescore is staggered across the base cadence so the lobby's goal passes
 *  spread over ticks instead of spiking one. */
export function createMacroGoalState(playerId: string): MacroGoalState {
  const sectorCount = 16; // 4×4 identity grid; identity-less maps use flat 0
  return {
    current: null,
    nextRescoreTick:
      MACRO_GOAL_RESCORE_BASE_TICKS + hashPhase(playerId, MACRO_GOAL_RESCORE_STAGGER_TICKS),
    commitsByKind: {},
    sectorVisits: new Float64Array(sectorCount),
    currentSector: -1,
  };
}

/** The commit window for a newly committed goal (ticks), from the data
 *  table range × the profile's commit discipline, clamped back into the
 *  range and staggered per bot (hashPhase — deterministic). */
export function commitWindowTicks(
  playerId: string,
  commitMultiplier: number,
  tick: number,
): number {
  const span = MACRO_GOAL_COMMIT_MAX_TICKS - MACRO_GOAL_COMMIT_MIN_TICKS;
  const stagger =
    (hashPhase(playerId, MACRO_GOAL_COMMIT_STAGGER_TICKS) / MACRO_GOAL_COMMIT_STAGGER_TICKS) * span;
  const scaled =
    (MACRO_GOAL_COMMIT_MIN_TICKS + stagger) * Math.max(0.5, Math.min(2, commitMultiplier));
  const clamped = Math.max(
    MACRO_GOAL_COMMIT_MIN_TICKS,
    Math.min(MACRO_GOAL_COMMIT_MAX_TICKS, scaled),
  );
  return tick + Math.round(clamped);
}

/** The next rescore tick after a pass at `tick` (staggered per bot). */
export function nextRescoreTick(playerId: string, tick: number): number {
  return (
    tick + MACRO_GOAL_RESCORE_BASE_TICKS + hashPhase(playerId, MACRO_GOAL_RESCORE_STAGGER_TICKS)
  );
}

export interface GoalUpdateResult {
  /** The goal in force after this call (committed incumbent or new winner).
   *  Null only before the first commit (the very first cadence ticks). */
  readonly goal: MacroGoal | null;
  /** True when a commit pass ran this call (telemetry edge — true on BOTH
   *  fresh commits and incumbent re-commits; see reCommitted). */
  readonly committed: boolean;
  /** The kind committed (set iff committed). */
  readonly kind?: MacroGoalKind;
  /** True when the committed kind is the incumbent kind (a re-commit at a
   *  possibly refreshed point, not a strategy switch). */
  readonly reCommitted?: boolean;
}

/**
 * Advance the generator one tick. Cheap between passes (a tick compare +
 * sector-visit stamp); the scoring pass runs only when the cadence elapses.
 * `inputs` may be omitted on non-rescore ticks (the caller avoids building
 * it — see GoalBinding, which only assembles inputs on rescore ticks).
 */
export function updateMacroGoal(
  state: MacroGoalState,
  playerId: string,
  tick: number,
  inputs: MacroGoalInputs | null,
): GoalUpdateResult {
  stampSectorVisit(state, inputs, tick);
  if (tick < state.nextRescoreTick) {
    return { goal: state.current, committed: false };
  }
  state.nextRescoreTick = nextRescoreTick(playerId, tick);
  // COMMIT-STICKY (DEC-008): a committed goal is held for its FULL 3-6 s
  // window — the ~2-3 s scoring cadence REFRESHES scores but never bounces a
  // goal that is still inside its window. This is the "memory + commitment"
  // point: a mid-rotation bot finishes the rotation through ENGAGE↔HUNT
  // intent churn beneath it. Hard-invalidations bypass this in the
  // executors (arrival → consumeGoal; SURVIVE_ZONE ignores goals entirely).
  if (state.current !== null && tick < state.current.commitUntilTick) {
    return { goal: state.current, committed: false };
  }
  if (!inputs) {
    // Cadence elapsed but the caller supplied no inputs (e.g. dead bot /
    // missing context) — hold the incumbent, retry next cadence.
    return { goal: state.current, committed: false };
  }
  const candidates = scoreMacroGoals(inputs);
  let winner: ScoredCandidate | null = null;
  let winnerScore = -Infinity;
  for (const c of candidates) {
    // Fixed-order iteration = the deterministic tie-break (the earlier kind
    // in MACRO_GOAL_KIND_KEYS order wins exact ties — no RNG anywhere).
    if (c.score > winnerScore) {
      winnerScore = c.score;
      winner = c;
    }
  }
  if (!winner) {
    // No candidate scored (e.g. no identity map, no fights, no loot memory,
    // no timing data): fall back to the zone-safe anchor as a PRE_POSITION
    // goal so the bot always HAS a destination (never idle, never random).
    const fallback: ScoredCandidate = {
      kind: 'PRE_POSITION',
      score: 0.2,
      x: inputs.zone.safeX,
      y: inputs.zone.safeY,
      poiTier: -1,
    };
    const goal = commit(state, fallback, playerId, inputs, tick);
    return { goal, committed: true, kind: goal.kind };
  }
  const winnerIsIncumbent = state.current !== null && state.current.kind === winner.kind;
  const goal = commit(state, winner, playerId, inputs, tick);
  return { goal, committed: true, kind: goal.kind, reCommitted: winnerIsIncumbent };
}

/** Commit a scored candidate (or re-commit the incumbent kind at a fresh
 *  point) as the state's current goal. */
function commit(
  state: MacroGoalState,
  winner: ScoredCandidate,
  playerId: string,
  inputs: MacroGoalInputs,
  tick: number,
): MacroGoal {
  const goal: MacroGoal = {
    kind: winner.kind,
    x: winner.x,
    y: winner.y,
    bornTick: tick,
    commitUntilTick: commitWindowTicks(playerId, inputs.commitMultiplier, tick),
    poiName: winner.poiName,
    poiTier: winner.poiTier,
  };
  state.current = goal;
  const label = MACRO_GOAL_KIND_LABELS[goal.kind];
  state.commitsByKind[label] = (state.commitsByKind[label] ?? 0) + 1;
  return goal;
}

/** Arrival consumption: expire + force the next rescore on the FOLLOWING
 *  tick (arrived goals must not strand the bot idle for the rest of the
 *  cadence window). */
export function consumeGoal(state: MacroGoalState, tick: number): void {
  state.current = null;
  state.nextRescoreTick = tick + 1;
}

/** Stamp the sector-visit memory (exploration input). Only writes when the
 *  sector changes (cheap) or on the first stamp. Runs on rescore-tick inputs
 *  (the only ticks the caller assembles inputs) — 2-3 s granularity is well
 *  inside the 60 s age normalization. */
function stampSectorVisit(
  state: MacroGoalState,
  inputs: MacroGoalInputs | null,
  tick: number,
): void {
  if (!inputs || !inputs.mapIdentity) return;
  const flat = mapIdentitySectorIndex(inputs.mapIdentity, inputs.x, inputs.y);
  if (flat !== state.currentSector) {
    state.currentSector = flat;
    if (flat >= 0 && flat < state.sectorVisits.length) {
      state.sectorVisits[flat] = tick;
    }
  }
}

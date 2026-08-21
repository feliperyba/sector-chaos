/**
 * Believability summary read model — verbatim extraction from
 * BotBelievability.ts (bot-ai-v2 ticket 04), extended with the Reactor
 * reaction fields. The counters class stays in BotBelievability.ts; this
 * partial carries the pure summarize math so both files stay under the
 * module-length gate. BotBelievability.ts re-exports both names, so the
 * historical import path keeps working (BotSkillTracker + the benchmark
 * harness).
 */

import type {
  BotBelievabilityCounters,
  LatencyHistogram,
  LatencyHistogramSummary,
} from './BotBelievability.ts';

/** Shannon entropy of an intent-mix count vector, normalized to 0..1 by
 *  dividing by ln(k) where k is the number of NON-ZERO buckets. A bot that
 *  spent its whole life in one intent scores 0; one that spread time evenly
 *  over all observed intents scores 1. Deterministic pure function. (Moved
 *  here verbatim from BotBelievability.ts in bot-ai-v2 ticket 06 for the
 *  module-length gate; re-exported from there for the historical path.) */
export function intentFamilyEntropy(counts: number[]): number {
  let total = 0;
  let nonzero = 0;
  for (const c of counts) {
    if (c > 0) {
      total += c;
      nonzero++;
    }
  }
  if (total <= 0 || nonzero <= 1) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h / Math.log(nonzero);
}

/** Per-bot believability read model (what SkillProfile.believability carries
 *  and the benchmark aggregates). Ratios use ticksAlive as denominator. */
export interface BelievabilitySummary {
  intentEntropy: number;
  intentFamilyTicks: number[];
  dashByReason: Record<string, number>;
  throwByReason: Record<string, number>;
  switchByReason: Record<string, number>;
  dashTotal: number;
  throwTotal: number;
  switchTotal: number;
  suspensions: number;
  suspensionsByFamily: Record<string, number>;
  /** Suspensions by reason tag ('stall' | 'search-failure' — bot-ai-v2
   *  ticket 05 extended the suspension mechanism from goals to targets). */
  suspensionsByReason: Record<string, number>;
  forcedWanderActivations: number;
  stuckTimeRatio: number;
  idleRatio: number;
  pathEfficiency: number;
  damageResponse: LatencyHistogramSummary;
  seenToAttack: LatencyHistogramSummary;
  /** Fired-reaction counts by Reactor type (bot-ai-v2 ticket 04) — the
   *  per-type cut the benchmark joins per-archetype/per-difficulty. */
  reactionsByType: Record<string, number>;
  /** Total fired reactions (Σ reactionsByType values). */
  reactionsTotal: number;
  /** TRUE stimulus→activation latency of fired reactions (the ex-Gaussian
   *  spread — non-degenerate by construction; see BotBelievability docs). */
  reactionLatency: LatencyHistogramSummary;
  /** Belief writes by source ('seen' | 'heard' | 'damage') — the belief-
   *  source mix (bot-ai-v2 ticket 05, DEC-003). */
  beliefWritesBySource: Record<string, number>;
  /** Total belief writes (Σ beliefWritesBySource values). */
  beliefWritesTotal: number;
  /** Investigation outcomes (bot-ai-v2 ticket 05: revenge pursuits terminate
   *  on re-acquire or drop — no pursuit exceeds the search-failure bound). */
  pursuitsStarted: number;
  pursuitsReacquired: number;
  pursuitsDropped: number;
  /** Stuck-ladder rung entries by key (bot-ai-v2 ticket 06, DEC-005.2 —
   *  'sidestep'|'backUp'|'replan'|'smash'|'relocate'). */
  ladderRungsByRung: Record<string, number>;
  /** Total ladder rung entries (Σ ladderRungsByRung values). */
  ladderRungsTotal: number;
  /** Deaths at low HP adjacent to a wall tile (DEC-005.4 wall-death
   *  telemetry — the navigated retreat's directional gate). */
  wallAdjacentLowHpDeaths: number;
  /** Macro-goal commits by kind label (bot-ai-v2 ticket 07, DEC-008) — the
   *  goal-mix distribution; the per-archetype cut is the bench gate. */
  macroGoalsByKind: Record<string, number>;
  /** Total macro-goal commits (Σ macroGoalsByKind values). */
  macroGoalsTotal: number;
  /** PRE_POSITION rotation-timing samples (bot-ai-v2 ticket 07): count,
   *  mean ticks-ahead and the ticks-ahead histogram — the early-mover vs
   *  late-cutter distribution per archetype (margin data table). */
  prePositionSamples: number;
  prePositionAvgTicksAhead: number;
  prePositionBuckets: number[];
  /** MOVEMENT FEATURES (bot-ai-v2 ticket 08, DEC-009.2): the measurable
   *  surface of the archetype movement-signature profiles. speedCv = per-bot
   *  coefficient of variation of the tick speed trace (micro-pauses and
   *  dawdle raise it); stoppedTickRatio = fraction of observed ticks at
   *  near-zero speed (anchor loiters). The per-archetype cuts are the
   *  "signature movement is visible" bench gate. */
  speedCv: number;
  stoppedTickRatio: number;
  speedSamples: number;
  /** COMBAT BELIEVABILITY (bot-ai-v2 ticket 09, DEC-010): sticky-weave
   *  commitment counts + mean window (the NOT-per-tick-flips gate),
   *  disengage triggers by cause, loot-contest outcomes, weapon-break
   *  reactions — the ticket's bench-cut surface. */
  weaveCommits: number;
  weaveAvgCommitTicks: number;
  disengageByCause: Record<string, number>;
  disengagesTotal: number;
  contestWins: number;
  contestLosses: number;
  contestBreakOffs: number;
  weaponBreakByReaction: Record<string, number>;
}

export function summarizeHistogram(h: LatencyHistogram, tickSum: number): LatencyHistogramSummary {
  return {
    buckets: [...h.buckets],
    stimuli: h.stimuli,
    responded: h.responded,
    censored: h.censored,
    avgTicks: h.responded > 0 ? tickSum / h.responded : -1,
  };
}

/** Derive the per-bot summary. Pure; unit-testable without a room. */
export function summarizeBelievability(
  c: BotBelievabilityCounters,
  ticksAlive: number,
): BelievabilitySummary {
  const denom = ticksAlive > 0 ? ticksAlive : 1;
  return {
    intentEntropy: intentFamilyEntropy(c.intentFamilyTicks),
    intentFamilyTicks: [...c.intentFamilyTicks],
    dashByReason: { ...c.dashByReason },
    throwByReason: { ...c.throwByReason },
    switchByReason: { ...c.switchByReason },
    dashTotal: c.dashTotal,
    throwTotal: c.throwTotal,
    switchTotal: c.switchTotal,
    suspensions: c.suspensions,
    suspensionsByFamily: { ...c.suspensionsByFamily },
    suspensionsByReason: { ...c.suspensionsByReason },
    forcedWanderActivations: c.forcedWanderActivations,
    stuckTimeRatio: c.stuckTicks / denom,
    idleRatio: c.movement.idleTicks / denom,
    pathEfficiency: c.traveledPx > 0 ? c.straightPx / c.traveledPx : 1,
    damageResponse: summarizeHistogram(c.damageResponse, c.damageResponseTickSum),
    seenToAttack: summarizeHistogram(c.seenToAttack, c.seenToAttackTickSum),
    reactionsByType: { ...c.reactionsByType },
    reactionsTotal: c.reactionsTotal,
    reactionLatency: summarizeHistogram(c.reactionLatency, c.reactionLatencyTickSum),
    beliefWritesBySource: { ...c.beliefs.writesBySource },
    beliefWritesTotal: c.beliefs.writesTotal,
    pursuitsStarted: c.beliefs.pursuitsStarted,
    pursuitsReacquired: c.beliefs.pursuitsReacquired,
    pursuitsDropped: c.beliefs.pursuitsDropped,
    ladderRungsByRung: { ...c.ladderRungsByRung },
    ladderRungsTotal: c.ladderRungsTotal,
    wallAdjacentLowHpDeaths: c.wallAdjacentLowHpDeaths,
    macroGoalsByKind: { ...c.goals.commitsByKind },
    macroGoalsTotal: c.goals.commitsTotal,
    prePositionSamples: c.goals.prePositionSamples,
    prePositionAvgTicksAhead:
      c.goals.prePositionSamples > 0
        ? c.goals.prePositionTicksAheadSum / c.goals.prePositionSamples
        : -1,
    prePositionBuckets: [...c.goals.prePositionBuckets],
    speedCv:
      c.movement.speedSamples > 1 && c.movement.speedSum > 0
        ? Math.sqrt(
            Math.max(
              0,
              c.movement.speedSqSum / c.movement.speedSamples -
                (c.movement.speedSum / c.movement.speedSamples) ** 2,
            ),
          ) /
          (c.movement.speedSum / c.movement.speedSamples)
        : 0,
    stoppedTickRatio:
      c.movement.speedSamples > 0 ? c.movement.stoppedTicks / c.movement.speedSamples : 0,
    speedSamples: c.movement.speedSamples,
    weaveCommits: c.combat.weaveCommits,
    weaveAvgCommitTicks:
      c.combat.weaveCommits > 0 ? c.combat.weaveCommitTicksSum / c.combat.weaveCommits : -1,
    disengageByCause: { ...c.combat.disengageByCause },
    disengagesTotal: c.combat.disengagesTotal,
    contestWins: c.combat.contestWins,
    contestLosses: c.combat.contestLosses,
    contestBreakOffs: c.combat.contestBreakOffs,
    weaponBreakByReaction: { ...c.combat.weaponBreakByReaction },
  };
}

/**
 * ENFORCED GLOBAL AI BUDGET — bot-ai-v2 ticket 11 (DEC-012.2).
 *
 * GDD §15.3.1b allocates the Bot-AI share of the 16.67 ms server tick at
 * ≤4 ms ACROSS ALL BOTS (shared, not per-bot — the stale "8 ms per-bot
 * budget" comments never existed as code; this module is the first actual
 * enforcement). Two clocks, two contracts:
 *
 *  - GUARD CLOCK — `performance.now()` (aiClockNow below). This is the ONE
 *    sanctioned wall-clock read in the AI pass, chosen for Wei's DEC-012
 *    dissent resolution: it is the SAME clock abstraction the benchmark
 *    harness virtualizes, so under the fast-forward harness every
 *    within-tick delta is exactly 0 — the guard NEVER trips, LOD relief
 *    never fires, and the bench measures a deterministic budget (same-seed
 *    byte-identity preserved; the harness header documents this contract as
 *    load-bearing). In production it is real time and the guard actually
 *    enforces.
 *  - METRIC CLOCK — process.hrtime (BotSystem's aiTime samples). Never
 *    virtualized, read-only observation, never feeds behavior. The bench
 *    percentiles + the sustained-overrun FAIL surface come from THIS clock,
 *    so the bench can still fail on real budget overruns even though its
 *    guard is (deterministically) inert. Wall-clock values → masked in the
 *    bench determinism contract (harness header + capture-bot-baseline
 *    maskOnDiff).
 *
 * Relief valve (DEC-012: "LOD as the relief valve, T2 downgrades first"):
 * as the elapsed guard time approaches/exceeds the 4 ms target, tier
 * deliberation is suspended in ladder order — T2 at 3.2 ms, T1 at 3.6 ms,
 * non-combat T0 at 4.0 ms. Combat-tier T0 is never suspended. Sustained
 * metric-clock overrun (≥ AI_SUSTAINED_OVERRUN_TICKS consecutive ticks over
 * target) raises `sustainedOverrun` in the bench JSON — a FAIL gate, not a
 * silent degradation.
 */

import { LodReliefLevel } from './LodTiers.ts';

/** GDD §15.3.1b Bot-AI budget: ≤4 ms across ALL bots per tick. */
export const AI_BUDGET_TARGET_MS = 4;

/** Relief ladder (guard-clock thresholds, ms into the tick's bot pass). */
export const AI_RELIEF_SUSPEND_T2_MS = 3.2;
export const AI_RELIEF_SUSPEND_T1_MS = 3.6;
export const AI_RELIEF_SUSPEND_T0_MS = 4.0;

/** Sustained-overrun FAIL threshold: this many CONSECUTIVE metric-clock
 *  ticks over {@linkcode AI_BUDGET_TARGET_MS} = bench FAIL (1 s of game
 *  time at 60 Hz). */
export const AI_SUSTAINED_OVERRUN_TICKS = 60;

/**
 * THE guard clock — the only sanctioned wall-clock read in the AI pass.
 * `performance.now` (not hrtime) on purpose: the bench harness virtualizes
 * exactly this function, which is what makes relief deterministic under the
 * harness (within-tick delta is always 0 → relief NEVER fires → behavior is
 * a pure function of the tick stream).
 */
export const aiClockNow = (): number => performance.now();

/** Relief level for a guard-clock elapsed time (PURE). */
export function reliefLevelForElapsed(elapsedMs: number): LodReliefLevel {
  if (elapsedMs >= AI_RELIEF_SUSPEND_T0_MS) return LodReliefLevel.SUSPEND_T0;
  if (elapsedMs >= AI_RELIEF_SUSPEND_T1_MS) return LodReliefLevel.SUSPEND_T1;
  if (elapsedMs >= AI_RELIEF_SUSPEND_T2_MS) return LodReliefLevel.SUSPEND_T2;
  return LodReliefLevel.NONE;
}

/** Percentile summary of the per-tick BotSystem wall-clock slice (the DEC-013
 *  ticket-01 aiTime surface, now also the budget's metric percentiles).
 *  WALL-CLOCK values: masked in the bench byte-identity contract. */
export interface AiTimePercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Ticks measured (one sample per BotSystem.tick call). */
  samples: number;
}

/** Monotonic process clock in ms — never stubbed by test setup's virtual
 *  performance.now override (same pattern as the harness's hrtimeMs). */
export const hrtimeMs = (): number => {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
};

/** P50/P95/P99/max of raw per-tick samples (PURE). */
export function computePercentilesFromSamples(samples: readonly number[]): AiTimePercentiles {
  const len = samples.length;
  if (len === 0) return { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(len - 1, Math.floor(p * len))]!;
  return {
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted[len - 1]!,
    samples: len,
  };
}

/** Per-match guard + LOD observation state (owned by BotSystem). */
export interface AiBudgetGuardState {
  /** Metric-clock ticks over {@linkcode AI_BUDGET_TARGET_MS}. */
  ticksOverBudget: number;
  /** Current run of consecutive over-target ticks. */
  consecutiveOverrunTicks: number;
  /** Longest such run. */
  maxConsecutiveOverrunTicks: number;
  /** Per-tick relief ticks by level index (NONE/SUSPEND_T2/SUSPEND_T1/
   *  SUSPEND_T0). Guard-clock derived — deterministic zeros beyond level 0
   *  under the bench harness's virtual clock. */
  reliefTicksByLevel: number[];
  /** Max relief level applied to any bot THIS tick (reset by
   *  {@linkcode beginAiTick}, consumed by {@linkcode recordAiTickEnd}). */
  tickMaxRelief: LodReliefLevel;
  /** LOD observation (pure, deterministic): bot-ticks per tier [T0, T1, T2]. */
  tierBotTicks: number[];
  /** Think ticks executed / skipped-by-cadence-or-relief (bot-ticks). */
  thinkTicksExecuted: number;
  thinkTicksSkipped: number;
  /** Transitions into combat-tier T0 (the immediate-upgrade counter). */
  combatTierUpgrades: number;
}

export function createAiBudgetGuardState(): AiBudgetGuardState {
  return {
    ticksOverBudget: 0,
    consecutiveOverrunTicks: 0,
    maxConsecutiveOverrunTicks: 0,
    reliefTicksByLevel: [0, 0, 0, 0],
    tickMaxRelief: LodReliefLevel.NONE,
    tierBotTicks: [0, 0, 0],
    thinkTicksExecuted: 0,
    thinkTicksSkipped: 0,
    combatTierUpgrades: 0,
  };
}

/** Start a tick's relief aggregation (called once before the per-bot loop). */
export function beginAiTick(state: AiBudgetGuardState): void {
  state.tickMaxRelief = LodReliefLevel.NONE;
}

/** Record the relief level applied to one bot this tick (max-aggregated). */
export function noteReliefApplied(state: AiBudgetGuardState, level: LodReliefLevel): void {
  if (level > state.tickMaxRelief) state.tickMaxRelief = level;
}

/** Record one bot's LOD observation (pure counters — byte-identity covered).
 *  @param combatEntry the bot transitioned into combat-tier T0 this tick. */
export function noteLodTick(
  state: AiBudgetGuardState,
  tier: number,
  combatEntry: boolean,
  think: boolean,
): void {
  state.tierBotTicks[tier] = (state.tierBotTicks[tier] ?? 0) + 1;
  if (combatEntry) state.combatTierUpgrades++;
  if (think) state.thinkTicksExecuted++;
  else state.thinkTicksSkipped++;
}

/** End-of-tick bookkeeping from the METRIC clock (never feeds behavior). */
export function recordAiTickEnd(state: AiBudgetGuardState, elapsedMs: number): void {
  if (elapsedMs > AI_BUDGET_TARGET_MS) {
    state.ticksOverBudget++;
    state.consecutiveOverrunTicks++;
    if (state.consecutiveOverrunTicks > state.maxConsecutiveOverrunTicks) {
      state.maxConsecutiveOverrunTicks = state.consecutiveOverrunTicks;
    }
  } else {
    state.consecutiveOverrunTicks = 0;
  }
  state.reliefTicksByLevel[state.tickMaxRelief] =
    (state.reliefTicksByLevel[state.tickMaxRelief] ?? 0) + 1;
}

/** The bench-JSON AI-budget block. WALL-CLOCK values (percentiles, overrun
 *  counters) — the whole block is masked in the determinism contract. */
export interface AiBudgetSummary {
  /** The enforced target (ms) — GDD §15.3.1b. */
  targetMs: number;
  /** Metric-clock percentiles (same samples as the aiTime block). */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  samples: number;
  /** Metric-clock ticks over target. */
  ticksOverBudget: number;
  /** Longest consecutive over-target run. */
  maxConsecutiveOverrunTicks: number;
  /** The FAIL threshold (consecutive ticks). */
  sustainedOverrunTicks: number;
  /** SUSTAINED OVERRUN = bench FAIL (not a silent degradation). */
  sustainedOverrun: boolean;
  /** Guard-clock relief ticks by level [none, t2, t1, t0]. */
  reliefTicksByLevel: number[];
}

/** Build the bench-JSON AI-budget block from the guard state + the metric
 *  percentiles (PURE). */
export function buildAiBudgetSummary(
  state: AiBudgetGuardState,
  percentiles: AiTimePercentiles,
): AiBudgetSummary {
  return {
    targetMs: AI_BUDGET_TARGET_MS,
    p50Ms: percentiles.p50Ms,
    p95Ms: percentiles.p95Ms,
    p99Ms: percentiles.p99Ms,
    maxMs: percentiles.maxMs,
    samples: percentiles.samples,
    ticksOverBudget: state.ticksOverBudget,
    maxConsecutiveOverrunTicks: state.maxConsecutiveOverrunTicks,
    sustainedOverrunTicks: AI_SUSTAINED_OVERRUN_TICKS,
    sustainedOverrun: state.maxConsecutiveOverrunTicks >= AI_SUSTAINED_OVERRUN_TICKS,
    reliefTicksByLevel: [...state.reliefTicksByLevel],
  };
}

/** The bench-JSON LOD block — PURE observation of the deterministic tick
 *  stream (tier is a pure function of positions/engagement), so it is
 *  covered by the same-seed byte-identity gate (NOT masked). */
export interface LodTelemetry {
  /** Bot-ticks per tier [T0, T1, T2]. */
  tierBotTicks: number[];
  /** Fraction of bot-ticks per tier (sums to 1 when any tick ran). */
  tierShare: number[];
  /** Think ticks executed / skipped (cadence + relief). */
  thinkTicksExecuted: number;
  thinkTicksSkipped: number;
  /** Transitions into combat-tier T0 (immediate upgrades on combat entry). */
  combatTierUpgrades: number;
}

/** Build the bench-JSON LOD block (PURE). */
export function buildLodTelemetry(state: AiBudgetGuardState): LodTelemetry {
  const total = state.tierBotTicks.reduce((a, b) => a + b, 0);
  const share = total > 0 ? state.tierBotTicks.map((n) => n / total) : [0, 0, 0];
  return {
    tierBotTicks: [...state.tierBotTicks],
    tierShare: share,
    thinkTicksExecuted: state.thinkTicksExecuted,
    thinkTicksSkipped: state.thinkTicksSkipped,
    combatTierUpgrades: state.combatTierUpgrades,
  };
}

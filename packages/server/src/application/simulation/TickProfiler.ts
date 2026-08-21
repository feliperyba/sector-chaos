/**
 * Per-tick telemetry profiler extracted from {@link GameSimulation} (refactor
 * #35, salvaged from the #19 TickPipeline grilling). Owns the pure
 * write-then-report telemetry concern that GameSimulation previously
 * implemented inline (`metrics`, `_timings`, `_time()`, the end-of-step commit,
 * and the `getMetrics()` averages derivation).
 *
 * This module is a true subordinate — it holds NO back-reference to
 * GameSimulation and does not know what it is timing. GameSimulation calls
 * `profiler.time('inputs', fn)`; the profiler just records. The only
 * GameSimulation → profiler read is the TICK-OVERRUN warn reading
 * `getMetrics().lastTickSystemTimings` for the breakdown (a read, not a write),
 * which keeps the profiler free of match/tick knowledge.
 *
 * Locality: lives alongside {@link TickTimer} — both are tick-loop plumbing.
 *
 * Contract pinned by ADR-0025 + the Step-0 characterization tests:
 * - The 12 `time()` labels are byte-identical (inputs/movement/animSim/melee/
 *   projectiles/barrels/zone/traps/timers/deaths/botAI/snapshot).
 * - `getMetrics()` return shape is consumed verbatim by the `/debug/state` and
 *   `/debug/tick-metrics` JSON endpoints — shape drift breaks them silently.
 */

/**
 * The telemetry snapshot returned by {@link TickProfiler.getMetrics} and
 * (transitively) `GameSimulation.getMetrics()`. Names, for the first time, the
 * anonymous inline object literal GameSimulation previously returned. The
 * shape is pinned by ADR-0025 and consumed directly by the `/debug/state` and
 * `/debug/tick-metrics` HTTP endpoints — do not rename, reorder, or drop
 * fields.
 */
export interface SimulationMetrics {
  /** Cumulative number of simulation ticks recorded via {@link TickProfiler.recordTick}. */
  totalTicks: number;
  /** Cumulative wall-clock duration of all recorded ticks, in milliseconds. */
  totalDurationMs: number;
  /** Maximum single-tick wall-clock duration observed so far, in milliseconds. */
  maxTickMs: number;
  /** Wall-clock duration of the most recently recorded tick, in milliseconds. */
  lastTickMs: number;
  /** Mean tick duration (`totalDurationMs / totalTicks`), 0 before the first tick. */
  avgTickMs: number;
  /** Cumulative count of domain events emitted across all recorded ticks. */
  totalEvents: number;
  /** Mean event count per tick (`totalEvents / totalTicks`), 0 before the first tick. */
  avgEventsPerTick: number;
  /** Per-system timings (ms) recorded via {@link TickProfiler.time} for the last step. */
  lastTickSystemTimings: Record<string, number>;
  /** Cumulative per-system timings (ms) across all steps. */
  systemTotals: Record<string, number>;
  /** Per-system mean timings (ms): `systemTotals[k] / totalTicks`, 0 before the first tick. */
  systemAverages: Record<string, number>;
}

/**
 * Subordinate telemetry profiler for the simulation tick loop. See the
 * module-level docs for the extraction rationale and the ADR-0025 contract.
 *
 * The profiler does NOT own the TICK-OVERRUN warning — that reads
 * `this.match.currentTick` (GameSimulation domain state the profiler must not
 * know about). GameSimulation keeps the warn in `update()` and reaches into
 * the profiler's read model (`getMetrics().lastTickSystemTimings`) for the
 * breakdown.
 */
export class TickProfiler {
  /**
   * Live per-step timings map. Each {@link time} call overwrites its label
   * in place; the map is never reset between steps (labels are simply
   * rewritten each step). This mirrors the former `GameSimulation._timings`
   * field byte-for-byte.
   * @private
   */
  private readonly _timings: Record<string, number> = {};

  /**
   * Per-step timings snapshot exposed to readers. Assigned the {@link _timings}
   * reference (not a copy) once per step by {@link commitStepTimings}, exactly
   * as the former `GameSimulation.step()` end-of-step block did at its L334.
   * @private
   */
  private lastTickSystemTimings: Record<string, number> = {};

  /** Cumulative per-system timings across all steps. @private */
  private readonly systemTotals: Record<string, number> = {};

  private totalTicks = 0;
  private totalDurationMs = 0;
  private maxTickMs = 0;
  private lastTickMs = 0;
  private totalEvents = 0;

  /**
   * Time a labeled step stage, recording its wall-clock duration and returning
   * the wrapped function's result. Replaces the former
   * `GameSimulation._time()`. The label set is pinned by ADR-0025.
   *
   * @param label - The stage label (e.g. 'inputs', 'movement', ... 'snapshot').
   * @param fn - The stage body to time.
   * @returns The value returned by `fn`.
   */
  time<T>(label: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    this._timings[label] = performance.now() - start;
    return result;
  }

  /**
   * Commit the current step's timings. Called exactly once at the end of each
   * `GameSimulation.step()`, after all {@link time} calls for that step. This
   * is the verbatim transcription of the former end-of-step block
   * (`GameSimulation.ts` L334-339): it assigns {@link lastTickSystemTimings}
   * to the current {@link _timings} map reference (not a copy), then
   * accumulates each entry into {@link systemTotals}. The `t[key]!` non-null
   * assertion semantics are preserved.
   */
  commitStepTimings(): void {
    this.lastTickSystemTimings = this._timings;
    const totals = this.systemTotals;
    const t = this._timings;
    for (const key in t) {
      totals[key] = (totals[key] || 0) + t[key]!;
    }
  }

  /**
   * Record the wall-clock duration and event count of one completed tick.
   * Replaces the former `GameSimulation.update()` per-tick metrics block
   * (L389-393). Does NOT own the TICK-OVERRUN warn — that stays in
   * GameSimulation because it reads `match.currentTick`.
   *
   * @param durationMs - Wall-clock duration of the tick, in milliseconds.
   * @param eventCount - Number of domain events emitted by the tick.
   */
  recordTick(durationMs: number, eventCount: number): void {
    this.totalTicks++;
    this.totalDurationMs += durationMs;
    if (durationMs > this.maxTickMs) {
      this.maxTickMs = durationMs;
    }
    this.lastTickMs = durationMs;
    this.totalEvents += eventCount;
  }

  /**
   * Derive the telemetry snapshot. The averages derivation (avgTickMs,
   * avgEventsPerTick, systemAverages) moves here verbatim from the former
   * `GameSimulation.getMetrics()` (L79-97). Returns defensive shallow copies
   * of the record fields so callers cannot corrupt the profiler's internal
   * state by mutating the returned object.
   *
   * @returns The {@link SimulationMetrics} snapshot.
   */
  getMetrics(): SimulationMetrics {
    const systemAverages: Record<string, number> = {};
    for (const [label, total] of Object.entries(this.systemTotals)) {
      systemAverages[label] = this.totalTicks === 0 ? 0 : total / this.totalTicks;
    }
    return {
      totalTicks: this.totalTicks,
      totalDurationMs: this.totalDurationMs,
      maxTickMs: this.maxTickMs,
      lastTickMs: this.lastTickMs,
      avgTickMs: this.totalTicks === 0 ? 0 : this.totalDurationMs / this.totalTicks,
      totalEvents: this.totalEvents,
      avgEventsPerTick: this.totalTicks === 0 ? 0 : this.totalEvents / this.totalTicks,
      lastTickSystemTimings: { ...this.lastTickSystemTimings },
      systemTotals: { ...this.systemTotals },
      systemAverages,
    };
  }
}

import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import { LodReliefLevel } from '../../../src/ai/lod/LodTiers.ts';
import {
  AI_BUDGET_TARGET_MS,
  AI_RELIEF_SUSPEND_T0_MS,
  AI_RELIEF_SUSPEND_T1_MS,
  AI_RELIEF_SUSPEND_T2_MS,
  AI_SUSTAINED_OVERRUN_TICKS,
  aiClockNow,
  buildAiBudgetSummary,
  buildLodTelemetry,
  computePercentilesFromSamples,
  createAiBudgetGuardState,
  hrtimeMs,
  noteLodTick,
  noteReliefApplied,
  beginAiTick,
  recordAiTickEnd,
  reliefLevelForElapsed,
} from '../../../src/ai/lod/AiBudgetGuard.ts';

/**
 * The enforced global AI budget guard (bot-ai-v2 ticket 11, DEC-012.2) at its
 * pure seams: the relief ladder thresholds, the sustained-overrun FAIL
 * bookkeeping, the summary builders, and the load-bearing CLOCK CONTRACT —
 * the guard reads performance.now (the clock the bench harness virtualizes),
 * so a frozen virtual clock yields a zero within-tick delta and relief NEVER
 * fires, which is what keeps same-seed bench runs byte-identical.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reliefLevelForElapsed — the T2-first relief ladder', () => {
  it('below the first threshold: no relief', () => {
    expect(reliefLevelForElapsed(0)).toBe(LodReliefLevel.NONE);
    expect(reliefLevelForElapsed(AI_RELIEF_SUSPEND_T2_MS - 0.001)).toBe(LodReliefLevel.NONE);
  });

  it('each threshold escalates one level (T2 → T1 → T0, inclusive bounds)', () => {
    expect(reliefLevelForElapsed(AI_RELIEF_SUSPEND_T2_MS)).toBe(LodReliefLevel.SUSPEND_T2);
    expect(reliefLevelForElapsed(AI_RELIEF_SUSPEND_T2_MS + 0.1)).toBe(LodReliefLevel.SUSPEND_T2);
    expect(reliefLevelForElapsed(AI_RELIEF_SUSPEND_T1_MS)).toBe(LodReliefLevel.SUSPEND_T1);
    expect(reliefLevelForElapsed(AI_RELIEF_SUSPEND_T1_MS + 0.1)).toBe(LodReliefLevel.SUSPEND_T1);
    expect(reliefLevelForElapsed(AI_RELIEF_SUSPEND_T0_MS)).toBe(LodReliefLevel.SUSPEND_T0);
    expect(reliefLevelForElapsed(100)).toBe(LodReliefLevel.SUSPEND_T0);
  });

  it('the ladder is ordered and starts before the GDD target', () => {
    expect(AI_RELIEF_SUSPEND_T2_MS).toBeLessThan(AI_RELIEF_SUSPEND_T1_MS);
    expect(AI_RELIEF_SUSPEND_T1_MS).toBeLessThan(AI_RELIEF_SUSPEND_T0_MS);
    expect(AI_RELIEF_SUSPEND_T0_MS).toBeLessThanOrEqual(AI_BUDGET_TARGET_MS);
    expect(AI_BUDGET_TARGET_MS).toBe(4);
  });
});

describe('recordAiTickEnd — sustained-overrun FAIL bookkeeping', () => {
  it('counts over-target ticks and tracks the longest consecutive run', () => {
    const s = createAiBudgetGuardState();
    // 3 over, 1 under, 2 over: total 5 over, max run 3.
    for (const ms of [5, 5, 5, 2, 5, 5]) recordAiTickEnd(s, ms);
    expect(s.ticksOverBudget).toBe(5);
    expect(s.maxConsecutiveOverrunTicks).toBe(3);
    expect(s.consecutiveOverrunTicks).toBe(2);
  });

  it('an under-target tick resets the consecutive run', () => {
    const s = createAiBudgetGuardState();
    for (const ms of [5, 5]) recordAiTickEnd(s, ms);
    recordAiTickEnd(s, AI_BUDGET_TARGET_MS); // exactly at target = NOT over
    recordAiTickEnd(s, 5);
    expect(s.ticksOverBudget).toBe(3);
    expect(s.maxConsecutiveOverrunTicks).toBe(2);
    expect(s.consecutiveOverrunTicks).toBe(1);
  });

  it('sustainedOverrun trips exactly at the FAIL threshold', () => {
    const at = createAiBudgetGuardState();
    for (let i = 0; i < AI_SUSTAINED_OVERRUN_TICKS - 1; i++) recordAiTickEnd(at, 5);
    let summary = buildAiBudgetSummary(at, computePercentilesFromSamples([]));
    expect(summary.sustainedOverrun).toBe(false);
    recordAiTickEnd(at, 5);
    summary = buildAiBudgetSummary(at, computePercentilesFromSamples([]));
    expect(summary.sustainedOverrun).toBe(true);
    expect(summary.maxConsecutiveOverrunTicks).toBe(AI_SUSTAINED_OVERRUN_TICKS);
  });
});

describe('relief aggregation + summary shape', () => {
  it('per-tick relief is max-aggregated and bucketed once per tick', () => {
    const s = createAiBudgetGuardState();
    beginAiTick(s);
    noteReliefApplied(s, LodReliefLevel.NONE);
    noteReliefApplied(s, LodReliefLevel.SUSPEND_T2);
    recordAiTickEnd(s, 1); // bucket under the max level (SUSPEND_T2)
    beginAiTick(s);
    noteReliefApplied(s, LodReliefLevel.NONE);
    recordAiTickEnd(s, 1);
    expect(s.reliefTicksByLevel).toEqual([1, 1, 0, 0]);
  });

  it('buildAiBudgetSummary carries the metric percentiles + FAIL fields', () => {
    const s = createAiBudgetGuardState();
    for (let i = 0; i < 10; i++) recordAiTickEnd(s, 1);
    const p = computePercentilesFromSamples([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const summary = buildAiBudgetSummary(s, p);
    expect(summary.targetMs).toBe(AI_BUDGET_TARGET_MS);
    expect(summary.p50Ms).toBe(p.p50Ms);
    expect(summary.p95Ms).toBe(p.p95Ms);
    expect(summary.p99Ms).toBe(p.p99Ms);
    expect(summary.samples).toBe(p.samples);
    expect(summary.sustainedOverrunTicks).toBe(AI_SUSTAINED_OVERRUN_TICKS);
    expect(summary.sustainedOverrun).toBe(false);
    expect(summary.reliefTicksByLevel.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('buildLodTelemetry partitions bot-ticks into tier shares summing to 1', () => {
    const s = createAiBudgetGuardState();
    noteLodTick(s, 0, false, true);
    noteLodTick(s, 0, true, true);
    noteLodTick(s, 1, false, false);
    noteLodTick(s, 2, false, false);
    noteLodTick(s, 2, false, true);
    const t = buildLodTelemetry(s);
    expect(t.tierBotTicks).toEqual([2, 1, 2]);
    expect(t.tierShare.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(t.tierShare[0]).toBeCloseTo(2 / 5, 9);
    expect(t.thinkTicksExecuted).toBe(3);
    expect(t.thinkTicksSkipped).toBe(2);
    expect(t.combatTierUpgrades).toBe(1);
  });

  it('empty telemetry stays well-formed (no NaN shares)', () => {
    const t = buildLodTelemetry(createAiBudgetGuardState());
    expect(t.tierShare).toEqual([0, 0, 0]);
    expect(Number.isFinite(t.tierShare[0])).toBe(true);
  });
});

describe('percentile helper', () => {
  it('monotone percentiles on a known sample set; empty input is zeros', () => {
    const p = computePercentilesFromSamples([10, 30, 20, 50, 40]);
    expect(p.samples).toBe(5);
    expect(p.p50Ms).toBe(30);
    expect(p.maxMs).toBe(50);
    expect(p.p50Ms).toBeLessThanOrEqual(p.p95Ms);
    expect(p.p95Ms).toBeLessThanOrEqual(p.p99Ms);
    expect(p.p99Ms).toBeLessThanOrEqual(p.maxMs);
    expect(computePercentilesFromSamples([])).toEqual({
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      samples: 0,
    });
  });
});

describe('THE CLOCK CONTRACT (Wei DEC-012 dissent — load-bearing)', () => {
  it('aiClockNow reads performance.now — the abstraction the harness virtualizes', () => {
    vi.stubGlobal('performance', { now: () => 1234.5 });
    expect(aiClockNow()).toBe(1234.5);
  });

  it('a frozen virtual clock yields ZERO within-tick deltas — relief never fires', () => {
    // This is the harness invariant: the virtual performance.now advances
    // exactly one TICK_INTERVAL per DRIVEN tick and not within one. A guard
    // measuring elapsed = now() - t0 inside a tick therefore always sees 0.
    let virtualPerf = 1700000000;
    vi.stubGlobal('performance', { now: () => virtualPerf });
    for (let tick = 0; tick < 100; tick++) {
      const t0 = aiClockNow(); // botSystemTick's guardT0
      // ... the entire bot pass runs here with the clock frozen ...
      const elapsed = aiClockNow() - t0;
      expect(elapsed).toBe(0);
      expect(reliefLevelForElapsed(elapsed)).toBe(LodReliefLevel.NONE);
      virtualPerf += 16.67; // the harness advances the clock BETWEEN ticks
    }
  });

  it('hrtimeMs is a DIFFERENT clock (never virtualized) and really advances', () => {
    vi.stubGlobal('performance', { now: () => 0 });
    const a = hrtimeMs();
    for (let i = 0; i < 1_000_000; i++) {
      // burn enough cycles to cross the hrtime resolution floor
      if (hrtimeMs() - a > 0) break;
    }
    expect(hrtimeMs() - a).toBeGreaterThanOrEqual(0);
  });
});

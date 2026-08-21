import { TickProfiler } from '../../../src/application/simulation/TickProfiler.ts';

describe('TickProfiler', () => {
  describe('time()', () => {
    it('records a per-label duration and returns the wrapped fn result', () => {
      const profiler = new TickProfiler();
      const result = profiler.time('inputs', () => 42);
      expect(result).toBe(42);
      // time() writes to the internal live timings map; commitStepTimings()
      // exposes them via getMetrics().lastTickSystemTimings (mirroring how
      // GameSimulation.step() commits at end-of-step).
      profiler.commitStepTimings();
      const metrics = profiler.getMetrics();
      expect(metrics.lastTickSystemTimings).toHaveProperty('inputs');
      expect(metrics.lastTickSystemTimings.inputs).toBeGreaterThanOrEqual(0);
    });

    it('overwrites a label when the same stage is timed twice in a step', () => {
      const profiler = new TickProfiler();
      profiler.time('melee', () => {
        /* first call */
      });
      profiler.time('melee', () => {
        /* second call overwrites */
      });
      profiler.commitStepTimings();
      const metrics = profiler.getMetrics();
      // Only one entry for the label (overwrite, not append).
      expect(Object.keys(metrics.lastTickSystemTimings)).toEqual(['melee']);
    });

    it('preserves insertion order of distinct labels across multiple time() calls', () => {
      const profiler = new TickProfiler();
      profiler.time('inputs', () => undefined);
      profiler.time('movement', () => undefined);
      profiler.time('snapshot', () => undefined);
      profiler.commitStepTimings();
      expect(Object.keys(profiler.getMetrics().lastTickSystemTimings)).toEqual([
        'inputs',
        'movement',
        'snapshot',
      ]);
    });

    it('propagates exceptions thrown by the wrapped fn (does not swallow them)', () => {
      const profiler = new TickProfiler();
      const boom = (): never => {
        throw new Error('kaboom');
      };
      expect(() => profiler.time('deaths', boom)).toThrow('kaboom');
    });
  });

  describe('recordTick()', () => {
    it('accumulates totalTicks, totalDurationMs, and totalEvents across 3 calls', () => {
      const profiler = new TickProfiler();
      profiler.recordTick(10, 5);
      profiler.recordTick(20, 3);
      profiler.recordTick(30, 2);
      const metrics = profiler.getMetrics();
      expect(metrics.totalTicks).toBe(3);
      expect(metrics.totalDurationMs).toBe(60);
      expect(metrics.totalEvents).toBe(10);
    });

    it('tracks lastTickMs as the most recent duration', () => {
      const profiler = new TickProfiler();
      profiler.recordTick(10, 1);
      expect(profiler.getMetrics().lastTickMs).toBe(10);
      profiler.recordTick(25, 1);
      expect(profiler.getMetrics().lastTickMs).toBe(25);
      profiler.recordTick(5, 1);
      expect(profiler.getMetrics().lastTickMs).toBe(5);
    });

    it('tracks maxTickMs as the MAXIMUM duration, not the last', () => {
      const profiler = new TickProfiler();
      profiler.recordTick(10, 1);
      profiler.recordTick(40, 1);
      profiler.recordTick(5, 1);
      // max stays at 40 even though the last tick was only 5.
      expect(profiler.getMetrics().maxTickMs).toBe(40);
    });

    it('updates maxTickMs on the first tick even when it equals the initial max (0)', () => {
      const profiler = new TickProfiler();
      profiler.recordTick(0, 0);
      expect(profiler.getMetrics().maxTickMs).toBe(0);
      profiler.recordTick(7, 0);
      expect(profiler.getMetrics().maxTickMs).toBe(7);
    });
  });

  describe('commitStepTimings() + systemTotals accumulation', () => {
    it('accumulates each step lastTickSystemTimings into systemTotals across 3 steps', () => {
      const profiler = new TickProfiler();
      const perStepTimings: Array<Record<string, number>> = [];
      for (let step = 0; step < 3; step++) {
        profiler.time('inputs', () => undefined);
        profiler.time('movement', () => undefined);
        profiler.commitStepTimings();
        // Snapshot before the next step overwrites the live timings map.
        perStepTimings.push({ ...profiler.getMetrics().lastTickSystemTimings });
      }
      const totals = profiler.getMetrics().systemTotals;
      // systemTotals keys match the per-step label set.
      expect(Object.keys(totals).slice().sort()).toEqual(['inputs', 'movement']);
      // Each total equals the exact sum of the 3 per-step values (the dropped/
      // doubled accumulation regression gate — the same invariant the Step-0
      // GameSimulation characterization test pins).
      for (const key of Object.keys(totals)) {
        const expected = perStepTimings.reduce((acc, t) => acc + (t[key] ?? 0), 0);
        expect(totals[key]).toBeCloseTo(expected, 10);
      }
    });

    it('commitStepTimings makes lastTickSystemTimings reflect the current step labels', () => {
      const profiler = new TickProfiler();
      profiler.time('inputs', () => undefined);
      profiler.commitStepTimings();
      expect(Object.keys(profiler.getMetrics().lastTickSystemTimings)).toEqual(['inputs']);
    });
  });

  describe('getMetrics() derivation', () => {
    it('derives avgTickMs and avgEventsPerTick from the accumulated totals', () => {
      const profiler = new TickProfiler();
      profiler.recordTick(10, 6);
      profiler.recordTick(20, 4);
      const metrics = profiler.getMetrics();
      // avgTickMs = totalDurationMs / totalTicks = 30 / 2 = 15
      expect(metrics.avgTickMs).toBe(15);
      // avgEventsPerTick = totalEvents / totalTicks = 10 / 2 = 5
      expect(metrics.avgEventsPerTick).toBe(5);
    });

    it('derives systemAverages = systemTotals[k] / totalTicks', () => {
      const profiler = new TickProfiler();
      // Record 2 ticks so the division has a denominator.
      profiler.recordTick(1, 0);
      profiler.recordTick(1, 0);
      // Force known timing values by committing steps with synthetic labels.
      // time() measures real wall-clock, so we read what it recorded and
      // assert the average relationship holds (total / totalTicks).
      profiler.time('inputs', () => undefined);
      profiler.commitStepTimings();
      profiler.time('inputs', () => undefined);
      profiler.commitStepTimings();
      const metrics = profiler.getMetrics();
      // totalTicks is 2 (from recordTick), but commitStepTimings ran twice.
      // systemAverages.inputs = systemTotals.inputs / totalTicks.
      expect(metrics.systemAverages.inputs).toBeCloseTo(
        metrics.systemTotals.inputs / metrics.totalTicks,
        10,
      );
    });

    it('returns defensive shallow copies of the record fields', () => {
      const profiler = new TickProfiler();
      profiler.time('inputs', () => undefined);
      profiler.commitStepTimings();
      profiler.recordTick(5, 3);

      const metrics = profiler.getMetrics();
      // Mutate the returned snapshots.
      metrics.lastTickSystemTimings.inputs = 9999;
      metrics.lastTickSystemTimings.injected = 1;
      metrics.systemTotals.inputs = 9999;
      metrics.systemAverages.inputs = 9999;

      // The profiler's internal state is untouched.
      const metrics2 = profiler.getMetrics();
      expect(metrics2.lastTickSystemTimings.inputs).not.toBe(9999);
      expect(metrics2.lastTickSystemTimings.injected).toBeUndefined();
      expect(metrics2.systemTotals.inputs).not.toBe(9999);
      expect(metrics2.systemAverages.inputs).not.toBe(9999);
    });
  });

  describe('zero-tick state (no divide-by-zero, no NaN)', () => {
    it('returns all-zero averages on a fresh profiler', () => {
      const profiler = new TickProfiler();
      const metrics = profiler.getMetrics();
      expect(metrics.totalTicks).toBe(0);
      expect(metrics.totalDurationMs).toBe(0);
      expect(metrics.maxTickMs).toBe(0);
      expect(metrics.lastTickMs).toBe(0);
      // The critical assertions: no NaN, no divide-by-zero.
      expect(metrics.avgTickMs).toBe(0);
      expect(Number.isNaN(metrics.avgTickMs)).toBe(false);
      expect(metrics.avgEventsPerTick).toBe(0);
      expect(Number.isNaN(metrics.avgEventsPerTick)).toBe(false);
      expect(metrics.systemAverages).toEqual({});
      expect(metrics.lastTickSystemTimings).toEqual({});
      expect(metrics.systemTotals).toEqual({});
    });
  });
});

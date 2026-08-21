import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelemetrySampler } from '../../telemetry/TelemetrySampler.js';
import type { TelemetrySamplerDeps } from '../../telemetry/TelemetrySampler.js';
import {
  TIMESTAMP_RATE_CEILING_PER_SECOND,
  TIMESTAMP_CAP_SLACK,
} from '../../telemetry/TelemetrySampler.js';

/** Read a private field off the sampler (precedent: GC pooling tests above). */
function priv<T>(sampler: TelemetrySampler, field: string): T {
  return (sampler as unknown as Record<string, T>)[field] as T;
}

function makeDeps(overrides: Partial<TelemetrySamplerDeps> = {}): TelemetrySamplerDeps {
  return {
    localPos: { x: 100, y: 200 },
    localVelocity: { x: 50, y: -30 },
    renderOffset: { x: 0, y: 0 },
    rtt: { value: 23 },
    getServerPos: (out) => {
      out.x = 100;
      out.y = 200;
    },
    getServerVelocity: (out) => {
      out.x = 48;
      out.y = -28;
    },
    getPredictionBufferSize: () => 3,
    getReconciliationCount: () => 0,
    getLastReconciliationError: () => 0,
    getLastReconciliationSeq: () => 0,
    getIsMoving: () => true,
    getAnimationState: () => 0,
    ...overrides,
  };
}

describe('TelemetrySampler', () => {
  let deps: TelemetrySamplerDeps;
  let sampler: TelemetrySampler;

  beforeEach(() => {
    deps = makeDeps();
    sampler = new TelemetrySampler(deps);
  });

  describe('construction', () => {
    it('uses default windowMs', () => {
      const s = new TelemetrySampler(deps);
      s.sampleFrame(16.67);
      const m = s.snapshot();
      expect(m.windowSeconds).toBe(1.0);
    });

    it('accepts custom windowMs', () => {
      const s = new TelemetrySampler(deps, 500);
      s.recordInput();
      const m = s.snapshot();
      expect(m.inputRate).toBeGreaterThan(0);
    });
  });

  describe('sampleFrame', () => {
    it('writes prediction error from localPos vs serverPos', () => {
      const d = makeDeps({
        localPos: { x: 110, y: 200 },
        getServerPos: (out) => {
          out.x = 100;
          out.y = 200;
        },
      });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      const m = s.snapshot();
      expect(m.predictionError).toBeCloseTo(10, 1);
    });

    it('computes zero prediction error when positions match', () => {
      sampler.sampleFrame(16.67);
      expect(sampler.snapshot().predictionError).toBe(0);
    });

    it('computes diagonal prediction error', () => {
      const d = makeDeps({
        localPos: { x: 103, y: 204 },
        getServerPos: (out) => {
          out.x = 100;
          out.y = 200;
        },
      });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      const m = s.snapshot();
      expect(m.predictionError).toBeCloseTo(5, 1);
    });

    it('writes render offset magnitude from refs', () => {
      const d = makeDeps({ renderOffset: { x: 3, y: 4 } });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      expect(s.snapshot().renderOffsetMagnitude).toBeCloseTo(5, 1);
    });

    it('writes dt for jank detection', () => {
      sampler.sampleFrame(16.67);
      sampler.sampleFrame(35);
      const m = sampler.snapshot();
      expect(m.jankFrames).toBe(1);
    });

    it('accumulates totalFrames', () => {
      sampler.sampleFrame(16.67);
      sampler.sampleFrame(16.67);
      sampler.sampleFrame(16.67);
      expect(sampler.snapshot().totalFrames).toBe(3);
    });

    it('reads rtt from refs at snapshot time', () => {
      const d = makeDeps({ rtt: { value: 42.7 } });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      expect(s.snapshot().rttMs).toBe(43);
    });

    it('propagates reconciliationCount from deps', () => {
      let count = 5;
      const d = makeDeps({ getReconciliationCount: () => count });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      expect(s.snapshot().reconciliationCount).toBe(5);
    });

    it('propagates predictionBufferSize from deps', () => {
      const d = makeDeps({ getPredictionBufferSize: () => 12 });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      // Exposed via ring snapshot's latestPredictionBufferSize
      expect(s.ringSnapshot().latestPredictionBufferSize).toBe(12);
    });

    it('computes maxCorrection from reconciliation errors', () => {
      let error = 0;
      const d = makeDeps({ getLastReconciliationError: () => error });
      const s = new TelemetrySampler(d);
      error = 0;
      s.sampleFrame(16.67);
      error = 7.5;
      s.sampleFrame(16.67);
      error = 2;
      s.sampleFrame(16.67);
      expect(s.snapshot().maxCorrection).toBeCloseTo(7.5, 1);
    });

    it('reflects live ref mutations across frames', () => {
      const pos = { x: 100, y: 200 };
      const d = makeDeps({
        localPos: pos,
        getServerPos: (out) => {
          out.x = 100;
          out.y = 200;
        },
      });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      pos.x = 110;
      s.sampleFrame(16.67);
      pos.x = 120;
      s.sampleFrame(16.67);
      const m = s.snapshot();
      expect(m.predictionError).toBeCloseTo(10, 0);
    });
  });

  describe('recordInput', () => {
    it('produces inputRate > 0 after calls', () => {
      for (let i = 0; i < 60; i++) sampler.recordInput();
      const m = sampler.snapshot();
      expect(m.inputRate).toBeGreaterThan(0);
    });

    it('produces inputRate 0 when no calls', () => {
      sampler.sampleFrame(16.67);
      expect(sampler.snapshot().inputRate).toBe(0);
    });
  });

  describe('patchRate (from server position changes)', () => {
    it('detects patch rate from server position changes', () => {
      let callCount = 0;
      const d = makeDeps({
        getServerPos: (out) => {
          // Change position every other call to simulate patches
          if (callCount % 2 === 1) {
            out.x = 100 + callCount;
            out.y = 200;
          } else {
            out.x = 100;
            out.y = 200;
          }
          callCount++;
        },
      });
      const s = new TelemetrySampler(d);
      for (let i = 0; i < 10; i++) s.sampleFrame(16.67);
      const m = s.snapshot();
      expect(m.patchRate).toBeGreaterThan(0);
    });

    it('produces patchRate 0 when server pos never changes', () => {
      sampler.sampleFrame(16.67);
      sampler.sampleFrame(16.67);
      expect(sampler.snapshot().patchRate).toBe(0);
    });
  });

  describe('snapshot', () => {
    it('returns zeros when no frames sampled', () => {
      const m = sampler.snapshot();
      expect(m.predictionError).toBe(0);
      expect(m.maxCorrection).toBe(0);
      expect(m.jankFrames).toBe(0);
      expect(m.totalFrames).toBe(0);
      expect(m.rttMs).toBe(23);
      expect(m.patchRate).toBe(0);
      expect(m.inputRate).toBe(0);
      expect(m.timestamp).toBeGreaterThan(0);
    });

    it('includes timestamp from Date.now', () => {
      const before = Date.now();
      sampler.sampleFrame(16.67);
      const m = sampler.snapshot();
      const after = Date.now();
      expect(m.timestamp).toBeGreaterThanOrEqual(before);
      expect(m.timestamp).toBeLessThanOrEqual(after);
    });

    it('rounds rttMs to integer', () => {
      const d = makeDeps({ rtt: { value: 23.7 } });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      expect(s.snapshot().rttMs).toBe(24);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      sampler.sampleFrame(30);
      sampler.recordInput();

      sampler.reset();

      const m = sampler.snapshot();
      expect(m.totalFrames).toBe(0);
      expect(m.inputRate).toBe(0);
      expect(m.patchRate).toBe(0);
    });

    it('allows sampling after reset', () => {
      sampler.sampleFrame(16.67);
      sampler.reset();
      sampler.sampleFrame(16.67);
      expect(sampler.snapshot().totalFrames).toBe(1);
    });
  });

  describe('multiple samples aggregation', () => {
    it('computes correct averages over multiple frames', () => {
      const pos = { x: 110, y: 200 };
      const d = makeDeps({
        localPos: pos,
        getServerPos: (out) => {
          out.x = 100;
          out.y = 200;
        },
      });
      const s = new TelemetrySampler(d);
      s.sampleFrame(16.67);
      pos.x = 120;
      s.sampleFrame(16.67);
      pos.x = 130;
      s.sampleFrame(16.67);
      const ringSnap = s.ringSnapshot();
      expect(ringSnap.avgPredictionError).toBeCloseTo(20, 0);
      expect(ringSnap.maxPredictionError).toBeCloseTo(30, 0);
    });

    it('tracks input rate alongside frames', () => {
      for (let i = 0; i < 60; i++) sampler.recordInput();
      sampler.sampleFrame(16.67);
      const m = sampler.snapshot();
      expect(m.inputRate).toBeGreaterThan(0);
      expect(m.totalFrames).toBe(1);
    });
  });

  describe('timestamp history bounding (perf H-5)', () => {
    /**
     * Perf H-5: `snapshot()` (the only age-pruner before the fix) is dev-only
     * (prediction overlay + DebugBridge console), so production builds
     * accumulated unbounded timestamp history. The push paths now maintain a
     * rolling window + hard cap. These tests pin both the bound and the
     * overlay's window math.
     */
    it('sizes the cap from windowMs at the documented rate ceiling (cap ≥ windowMs + slack)', () => {
      const s1 = new TelemetrySampler(deps); // default 1000 ms window
      const s2 = new TelemetrySampler(deps, 500);
      // 1000 entries/s ceiling = 1 entry/ms → cap entries ≥ windowMs ms + slack.
      expect(priv<number>(s1, 'timestampCap')).toBe(
        Math.ceil((1000 / 1000) * TIMESTAMP_RATE_CEILING_PER_SECOND) + TIMESTAMP_CAP_SLACK,
      );
      expect(priv<number>(s2, 'timestampCap')).toBe(
        Math.ceil((500 / 1000) * TIMESTAMP_RATE_CEILING_PER_SECOND) + TIMESTAMP_CAP_SLACK,
      );
    });

    it('hard-caps input timestamps under a burst faster than the ceiling', () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      try {
        const s = new TelemetrySampler(deps);
        // 3000 pushes with a frozen clock: all entries are age-fresh, so only
        // the hard cap can bound the array.
        for (let i = 0; i < 3000; i++) s.recordInput();
        const ts = priv<number[]>(s, 'inputTimestamps');
        expect(ts.length).toBe(priv<number>(s, 'timestampCap'));
        expect(ts.length).toBeLessThan(3000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a full rate window after long sustained input (bounded memory, overlay math intact)', () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      try {
        const s = new TelemetrySampler(deps);
        // 120 s at 60 inputs/s = 7200 pushes — the pre-fix unbounded case.
        for (let i = 0; i < 7200; i++) {
          s.recordInput();
          vi.advanceTimersByTime(1000 / 60);
        }
        const ts = priv<number[]>(s, 'inputTimestamps');
        expect(ts.length).toBeLessThanOrEqual(65); // ~window content, not 7200
        expect(ts[0]).toBeLessThanOrEqual(ts[ts.length - 1] ?? 0); // order preserved
        const m = s.snapshot();
        expect(m.inputRate).toBeGreaterThanOrEqual(59);
        expect(m.inputRate).toBeLessThanOrEqual(61);
      } finally {
        vi.useRealTimers();
      }
    });

    it('bounds patch timestamps across a long match of server position changes', () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      try {
        let flip = false;
        const d = makeDeps({
          getServerPos: (out) => {
            flip = !flip;
            out.x = flip ? 100 : 101;
            out.y = 200;
          },
        });
        const s = new TelemetrySampler(d);
        // 120 s at 60 fps with a server patch every frame.
        for (let i = 0; i < 7200; i++) {
          s.sampleFrame(16.67);
          vi.advanceTimersByTime(1000 / 60);
        }
        const ts = priv<number[]>(s, 'patchTimestamps');
        expect(ts.length).toBeLessThanOrEqual(65);
        const m = s.snapshot();
        expect(m.patchRate).toBeGreaterThanOrEqual(59);
        expect(m.patchRate).toBeLessThanOrEqual(61);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('GC pooling (C4b)', () => {
    /**
     * C4b: sampleFrame must reuse a single scratch TelemetrySample object
     * across frames (mutate-in-place then copy into the Float64Array ring).
     * Asserts reference equality on the private scratch buffer — proves zero
     * allocation in steady state.
     */
    it('reuses the same scratch TelemetrySample across frames (reference equality)', () => {
      const s = new TelemetrySampler(makeDeps());
      // Access the private scratch via cast (production class never exposes it).
      const scratchOf = (svc: TelemetrySampler) =>
        (svc as unknown as { sampleBuf: { dt: number } }).sampleBuf;

      s.sampleFrame(16.67);
      const ref1 = scratchOf(s);

      s.sampleFrame(33.3);
      const ref2 = scratchOf(s);

      s.sampleFrame(16.67);
      const ref3 = scratchOf(s);

      expect(ref2).toBe(ref1); // same object reference — zero alloc
      expect(ref3).toBe(ref1);
    });

    it('scratch carries the latest frame values (mutation visible, not stale)', () => {
      const s = new TelemetrySampler(makeDeps());
      const scratchOf = (svc: TelemetrySampler) =>
        (svc as unknown as { sampleBuf: { dt: number } }).sampleBuf;

      s.sampleFrame(16.67);
      s.sampleFrame(50);
      const scratch = scratchOf(s);
      // The scratch holds the LAST written dt (the ring copied earlier
      // values away, so mutating scratch never corrupted history).
      expect(scratch.dt).toBe(50);

      // And the history in the ring still has both frames intact.
      expect(s.ringSnapshot().totalFrames).toBe(2);
      expect(s.ringSnapshot().jankFrames).toBe(1); // only the 50ms frame is jank (>20ms)
    });
  });
});

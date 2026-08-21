import { describe, it, expect } from 'vitest';
import {
  InputRingBuffer,
  INPUT_FRAME_STRIDE,
  MAX_SUBSTEPS_PER_RECORD,
} from '../InputRingBuffer.js';
import type { RingBufferFrame } from '../InputRingBuffer.js';

function makeFrame(sequence: number, overrides?: Partial<RingBufferFrame>): RingBufferFrame {
  return {
    sequence,
    actionBitmask: sequence * 2,
    dx: sequence * 0.1,
    dy: sequence * -0.1,
    aimAngle: sequence * 0.01,
    timestamp: 1000 + sequence,
    predictedX: sequence * 10,
    predictedY: sequence * -10,
    velocityX: sequence * 0.5,
    velocityY: sequence * -0.5,
    speed: sequence * 2,
    dt: 16.67,
    subSteps: 1,
    ...overrides,
  };
}

/** Compare a RingBufferFrame against a Float64Array view/copy. */
function expectFrameToMatch(frame: RingBufferFrame, view: Float64Array): void {
  expect(view[0]).toBe(frame.sequence);
  expect(view[1]).toBe(frame.actionBitmask);
  expect(view[2]).toBe(frame.dx);
  expect(view[3]).toBe(frame.dy);
  expect(view[4]).toBe(frame.aimAngle);
  expect(view[5]).toBe(frame.timestamp);
  expect(view[6]).toBe(frame.predictedX);
  expect(view[7]).toBe(frame.predictedY);
  expect(view[8]).toBe(frame.velocityX);
  expect(view[9]).toBe(frame.velocityY);
  expect(view[10]).toBe(frame.speed);
  expect(view[11]).toBe(frame.dt);
  expect(view[12]).toBe(frame.subSteps);
}

describe('InputRingBuffer', () => {
  it('writes 1 frame and reads all 13 fields by sequence', () => {
    const buf = new InputRingBuffer(120);
    const frame = makeFrame(0);
    buf.write(frame);
    const view = buf.read(0);
    expect(view).toBeDefined();
    expectFrameToMatch(frame, view!);
  });

  it('writes 5 frames and reads each by sequence', () => {
    const buf = new InputRingBuffer(120);
    const frames = Array.from({ length: 5 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    expect(buf.count).toBe(5);
    for (const f of frames) {
      const view = buf.read(f.sequence);
      expect(view).toBeDefined();
      expectFrameToMatch(f, view!);
    }
  });

  it('writes 120 frames (full capacity) and reads all by sequence', () => {
    const buf = new InputRingBuffer(120);
    const frames = Array.from({ length: 120 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    expect(buf.count).toBe(120);
    expect(buf.oldestSequence).toBe(0);
    expect(buf.newestSequence).toBe(119);

    for (const f of frames) {
      const view = buf.read(f.sequence);
      expect(view).toBeDefined();
      expectFrameToMatch(f, view!);
    }
  });

  it('handles wraparound: 150 frames into 120-capacity buffer', () => {
    const buf = new InputRingBuffer(120);
    const frames = Array.from({ length: 150 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    expect(buf.count).toBe(120);
    expect(buf.oldestSequence).toBe(30);
    expect(buf.newestSequence).toBe(149);

    // Oldest 30 should be gone
    for (let seq = 0; seq < 30; seq++) {
      expect(buf.read(seq)).toBeUndefined();
    }

    // Frames 30-149 should be readable
    for (let seq = 30; seq < 150; seq++) {
      const view = buf.read(seq);
      expect(view).toBeDefined();
      expectFrameToMatch(frames[seq]!, view!);
    }
  });

  it('slice(100, 110) returns 10 contiguous frames in sequence order', () => {
    const buf = new InputRingBuffer(120);
    const frames = Array.from({ length: 150 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    const sliced = buf.slice(100, 110);
    expect(sliced.length).toBe(10 * INPUT_FRAME_STRIDE);

    for (let i = 0; i < 10; i++) {
      const seq = 100 + i;
      const offset = i * INPUT_FRAME_STRIDE;
      expectFrameToMatch(frames[seq]!, sliced.subarray(offset, offset + INPUT_FRAME_STRIDE));
    }
  });

  it('slice handles wraparound boundary correctly', () => {
    // 120-capacity buffer with frames 30-149 (wraps at slot 120)
    const buf = new InputRingBuffer(120);
    const frames = Array.from({ length: 150 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    // Slice that crosses the wraparound point
    // Slots: seq 30 at slot 0, seq 149 at slot 119
    // Wraparound happens at slot boundary (seq 119→120 crosses from slot 89→90)
    // Let's slice from seq 100 to 140 (40 frames crossing the ring boundary)
    const sliced = buf.slice(100, 140);
    expect(sliced.length).toBe(40 * INPUT_FRAME_STRIDE);

    for (let i = 0; i < 40; i++) {
      const seq = 100 + i;
      const offset = i * INPUT_FRAME_STRIDE;
      expectFrameToMatch(frames[seq]!, sliced.subarray(offset, offset + INPUT_FRAME_STRIDE));
    }
  });

  it('read returns undefined for overwritten sequence', () => {
    const buf = new InputRingBuffer(120);
    for (let i = 0; i < 150; i++) buf.write(makeFrame(i));
    expect(buf.read(0)).toBeUndefined();
    expect(buf.read(29)).toBeUndefined();
  });

  it('read returns undefined for never-written sequence', () => {
    const buf = new InputRingBuffer(120);
    buf.write(makeFrame(0));
    expect(buf.read(1)).toBeUndefined();
    expect(buf.read(999)).toBeUndefined();
    expect(buf.read(-1)).toBeUndefined();
  });

  it('reset clears everything', () => {
    const buf = new InputRingBuffer(120);
    for (let i = 0; i < 50; i++) buf.write(makeFrame(i));

    expect(buf.count).toBe(50);
    buf.reset();
    expect(buf.count).toBe(0);
    expect(buf.oldestSequence).toBeUndefined();
    expect(buf.newestSequence).toBeUndefined();
    expect(buf.read(0)).toBeUndefined();
  });

  it('non-zero starting sequence: frames are addressable by their real sequence', () => {
    const buf = new InputRingBuffer(120);
    // Write frames with sequences 5, 6, 7 (non-zero start)
    buf.write(makeFrame(5));
    buf.write(makeFrame(6));
    buf.write(makeFrame(7));

    expect(buf.count).toBe(3);
    expect(buf.oldestSequence).toBe(5);
    expect(buf.newestSequence).toBe(7);

    // Each frame must be readable by its actual sequence
    expectFrameToMatch(makeFrame(5), buf.read(5)!);
    expectFrameToMatch(makeFrame(6), buf.read(6)!);
    expectFrameToMatch(makeFrame(7), buf.read(7)!);

    // Negative/out-of-range still return undefined
    expect(buf.read(4)).toBeUndefined();
    expect(buf.read(8)).toBeUndefined();
  });

  it('non-zero starting sequence: copyRangeInto returns correct data', () => {
    const buf = new InputRingBuffer(120);
    buf.write(makeFrame(10));
    buf.write(makeFrame(11));
    buf.write(makeFrame(12));

    const target = new Float64Array(2 * INPUT_FRAME_STRIDE);
    buf.copyRangeInto(target, 11, 2);

    expectFrameToMatch(makeFrame(11), target.subarray(0, INPUT_FRAME_STRIDE));
    expectFrameToMatch(makeFrame(12), target.subarray(INPUT_FRAME_STRIDE, 2 * INPUT_FRAME_STRIDE));
  });

  it('non-zero starting sequence: wraparound preserves sequence identity', () => {
    // Capacity 5, write 7 frames starting at sequence 100
    const buf = new InputRingBuffer(5);
    const frames = Array.from({ length: 7 }, (_, i) => makeFrame(100 + i));
    for (const f of frames) buf.write(f);

    expect(buf.count).toBe(5);
    expect(buf.oldestSequence).toBe(102);
    expect(buf.newestSequence).toBe(106);

    // Overwritten frames are gone
    expect(buf.read(100)).toBeUndefined();
    expect(buf.read(101)).toBeUndefined();

    // Surviving frames are correct
    for (let i = 102; i <= 106; i++) {
      const view = buf.read(i);
      expect(view).toBeDefined();
      expectFrameToMatch(frames[i - 100]!, view!);
    }
  });

  it('count tracks correctly through wraparound', () => {
    const buf = new InputRingBuffer(10);
    expect(buf.count).toBe(0);

    for (let i = 0; i < 10; i++) buf.write(makeFrame(i));
    expect(buf.count).toBe(10);

    buf.write(makeFrame(10));
    expect(buf.count).toBe(10); // still 10, oldest overwritten

    for (let i = 11; i < 25; i++) buf.write(makeFrame(i));
    expect(buf.count).toBe(10);
    expect(buf.oldestSequence).toBe(15);
    expect(buf.newestSequence).toBe(24);
  });

  it('toDebugView returns correct objects for all valid frames', () => {
    const buf = new InputRingBuffer(120);
    const frames = Array.from({ length: 150 }, (_, i) => makeFrame(i));
    for (const f of frames) buf.write(f);

    const debugView = buf.toDebugView();
    expect(debugView.length).toBe(120);

    for (let i = 0; i < 120; i++) {
      const seq = 30 + i;
      const frame = frames[seq]!;
      const entry = debugView[i]!;
      expect(entry.sequence).toBe(frame.sequence);
      expect(entry.actionBitmask).toBe(frame.actionBitmask);
      expect(entry.dx).toBe(frame.dx);
      expect(entry.dy).toBe(frame.dy);
      expect(entry.aimAngle).toBe(frame.aimAngle);
      expect(entry.timestamp).toBe(frame.timestamp);
      expect(entry.predictedX).toBe(frame.predictedX);
      expect(entry.predictedY).toBe(frame.predictedY);
      expect(entry.velocityX).toBe(frame.velocityX);
      expect(entry.velocityY).toBe(frame.velocityY);
      expect(entry.speed).toBe(frame.speed);
      expect(entry.dt).toBe(frame.dt);
      expect(entry.subSteps).toBe(frame.subSteps);
    }
  });

  it('read returns a VIEW — writing after read changes the view', () => {
    const buf = new InputRingBuffer(5);
    buf.write(makeFrame(0, { dx: 42.0 }));
    const view = buf.read(0);
    expect(view).toBeDefined();
    expect(view![2]).toBe(42.0);

    // Overwrite the same slot by filling the buffer and wrapping
    for (let i = 1; i <= 5; i++) buf.write(makeFrame(i));
    // Now seq 0 is overwritten. The view we held should reflect new data.
    // Frame at the slot where seq 0 was is now seq 5.
    expect(view![0]).toBe(5); // sequence changed from 0 to 5
  });
});

// ── Ticket 04: bulk-copy (TypedArray.set) equivalence + micro-benchmark ────
//
// The range copy in copyRangeInto was switched from an element-wise loop to a
// bulk set() of subarray views (non-wrapping: one segment; wrapping: two
// segments). These tests pin byte-identical behavior against a verbatim port
// of the OLD implementation, and benchmark both.

/** Substep-dir slot layout (mirrors InputRingBuffer internals). */
const LEGACY_X_OFFSET = 13;
const LEGACY_Y_OFFSET = 13 + MAX_SUBSTEPS_PER_RECORD;

/**
 * Verbatim port of the pre-ticket InputRingBuffer write/slotFor/copyRangeInto
 * (element-wise loop). Serves as (a) the equivalence oracle — fed the same
 * writes, its backing holds the same bytes, so its copy output must match the
 * new bulk-copy implementation exactly — and (b) the micro-benchmark baseline.
 */
class LegacyLoopRingBuffer {
  private readonly backing: Float64Array;
  private readonly _capacity: number;
  private head = 0;
  private _count = 0;
  private baseSeq = 0;

  constructor(capacity: number) {
    this._capacity = capacity;
    this.backing = new Float64Array(capacity * INPUT_FRAME_STRIDE);
  }

  write(frame: RingBufferFrame): void {
    const offset = this.head;
    if (this._count === 0) this.baseSeq = frame.sequence;
    this.backing[offset] = frame.sequence;
    this.backing[offset + 1] = frame.actionBitmask;
    this.backing[offset + 2] = frame.dx;
    this.backing[offset + 3] = frame.dy;
    this.backing[offset + 4] = frame.aimAngle;
    this.backing[offset + 5] = frame.timestamp;
    this.backing[offset + 6] = frame.predictedX;
    this.backing[offset + 7] = frame.predictedY;
    this.backing[offset + 8] = frame.velocityX;
    this.backing[offset + 9] = frame.velocityY;
    this.backing[offset + 10] = frame.speed;
    this.backing[offset + 11] = frame.dt;
    this.backing[offset + 12] = frame.subSteps;
    const dirsX = frame.subStepDirsX;
    const dirsY = frame.subStepDirsY;
    for (let i = 0; i < MAX_SUBSTEPS_PER_RECORD; i++) {
      this.backing[offset + LEGACY_X_OFFSET + i] = dirsX ? (dirsX[i] ?? 0) : 0;
      this.backing[offset + LEGACY_Y_OFFSET + i] = dirsY ? (dirsY[i] ?? 0) : 0;
    }
    this.head = (this.head + INPUT_FRAME_STRIDE) % (this._capacity * INPUT_FRAME_STRIDE);
    if (this._count < this._capacity) this._count++;
    else this.baseSeq++;
  }

  private slotFor(sequence: number): number {
    const baseSlot = this._count === this._capacity ? this.head / INPUT_FRAME_STRIDE : 0;
    return (sequence - this.baseSeq + baseSlot) % this._capacity;
  }

  /** The pre-ticket element-wise range copy (the code this ticket replaced). */
  copyRangeInto(target: Float64Array, fromSeq: number, count: number): void {
    if (this._count === 0) return;
    if (count <= 0) return;
    if (fromSeq < this.baseSeq || fromSeq + count > this.baseSeq + this._count + 1) return;

    for (let i = 0; i < count; i++) {
      const seq = fromSeq + i;
      const slot = this.slotFor(seq);
      const srcOffset = slot * INPUT_FRAME_STRIDE;
      const dstOffset = i * INPUT_FRAME_STRIDE;
      for (let j = 0; j < INPUT_FRAME_STRIDE; j++) {
        target[dstOffset + j] = this.backing[srcOffset + j]!;
      }
    }
  }
}

/** Element-wise equality using Object.is — distinguishes -0 vs 0 and NaN. */
function expectIdenticalBytes(actual: Float64Array, expected: Float64Array, label: string): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (!Object.is(actual[i], expected[i])) {
      expect.fail(
        `${label}: mismatch at float64 ${i}: got ${actual[i]}, expected ${expected[i]}`,
      );
    }
  }
}

describe('InputRingBuffer.copyRangeInto bulk copy (ticket 04)', () => {
  /**
   * Writes the same frames into a real (set-based) and a legacy (loop-based)
   * buffer, then verifies both copies produce identical bytes for
   * (fromSeq, count).
   */
  function expectCopyEquivalence(
    capacity: number,
    numWrites: number,
    startSeq: number,
    fromSeq: number,
    count: number,
    label: string,
  ): void {
    const real = new InputRingBuffer(capacity);
    const legacy = new LegacyLoopRingBuffer(capacity);
    for (let i = 0; i < numWrites; i++) {
      // Inject -0 / NaN / substep dirs so bit-fidelity (not just ==) is proven.
      const frame = makeFrame(startSeq + i, {
        dx: i % 3 === 0 ? -0 : i * 0.25,
        dy: i % 5 === 0 ? Number.NaN : -(i * 0.25),
        subSteps: 1 + (i % MAX_SUBSTEPS_PER_RECORD),
        subStepDirsX: Float64Array.from([0.1 * i, -0.2 * i, 0.3, -0.4]),
        subStepDirsY: Float64Array.from([-0.4, 0.3 * i, -0.2, 0.1 * i]),
      });
      real.write(frame);
      legacy.write(frame);
    }

    const realTarget = new Float64Array(count * INPUT_FRAME_STRIDE).fill(7.7);
    const legacyTarget = new Float64Array(count * INPUT_FRAME_STRIDE).fill(7.7);
    real.copyRangeInto(realTarget, fromSeq, count);
    legacy.copyRangeInto(legacyTarget, fromSeq, count);
    expectIdenticalBytes(realTarget, legacyTarget, label);

    // Cross-check the real implementation against per-frame read() views for
    // every in-range sequence (independent oracle for the bulk path).
    const oldest = real.oldestSequence;
    const newest = real.newestSequence;
    if (oldest !== undefined && newest !== undefined) {
      for (let i = 0; i < count; i++) {
        const seq = fromSeq + i;
        if (seq < oldest || seq > newest) continue; // stale-slot territory (only the lenient +1 edge)
        const view = real.read(seq);
        expect(view).toBeDefined();
        for (let j = 0; j < INPUT_FRAME_STRIDE; j++) {
          if (!Object.is(realTarget[i * INPUT_FRAME_STRIDE + j], view![j])) {
            expect.fail(`${label}: frame ${seq} slot ${j} differs from read() view`);
          }
        }
      }
    }
  }

  it('non-wrapping ranges: bulk set is byte-identical to the element-wise loop', () => {
    expectCopyEquivalence(8, 3, 100, 100, 1, 'single frame, fresh partial buffer');
    expectCopyEquivalence(8, 5, 10, 10, 3, 'multi-frame, fresh partial buffer');
    expectCopyEquivalence(8, 8, 0, 0, 8, 'full-buffer range, exactly filled (starts at slot 0)');
    expectCopyEquivalence(
      120,
      200,
      0,
      90,
      30,
      'multi-frame, wrapped steady state, range before the ring boundary',
    );
  });

  it('wrapping ranges: two-segment copy is byte-identical to the element-wise loop', () => {
    expectCopyEquivalence(
      8,
      20,
      0,
      14,
      6,
      'range crossing the ring boundary',
    );
    expectCopyEquivalence(
      8,
      20,
      0,
      12,
      8,
      'full-buffer range in wrapped steady state',
    );
    expectCopyEquivalence(
      120,
      200,
      0,
      110,
      30,
      'multi-frame, wrapped steady state, range crossing the ring boundary',
    );
  });

  it('lenient +1 bound (count = count+1) copies the same stale slot bytes as the loop', () => {
    // Full buffer: the one-past-newest frame re-reads the oldest live slot.
    expectCopyEquivalence(8, 20, 0, 12, 9, 'lenient +1, full wrapped buffer');
    // Fresh partial buffer: the one-past-newest frame reads untouched (zero) backing.
    expectCopyEquivalence(8, 3, 100, 100, 4, 'lenient +1, fresh partial buffer');
  });

  it('guard clauses leave the target untouched, exactly like the loop', () => {
    const real = new InputRingBuffer(8);
    const legacy = new LegacyLoopRingBuffer(8);
    for (let i = 0; i < 10; i++) {
      real.write(makeFrame(i));
      legacy.write(makeFrame(i));
    }

    const cases: Array<[fromSeq: number, count: number, label: string]> = [
      [3, 0, 'count <= 0'],
      [1, 2, 'fromSeq below oldest'],
      [0, 11, 'range beyond lenient +1 bound'],
      [-5, 3, 'negative fromSeq'],
    ];
    for (const [fromSeq, count, label] of cases) {
      const realTarget = new Float64Array(4 * INPUT_FRAME_STRIDE).fill(7.7);
      const legacyTarget = new Float64Array(4 * INPUT_FRAME_STRIDE).fill(7.7);
      real.copyRangeInto(realTarget, fromSeq, count);
      legacy.copyRangeInto(legacyTarget, fromSeq, count);
      expectIdenticalBytes(realTarget, legacyTarget, `guard: ${label}`);
      // Both must be no-ops (sentinel intact).
      for (let i = 0; i < realTarget.length; i++) {
        if (realTarget[i] !== 7.7) expect.fail(`guard: ${label} wrote to the target`);
      }
    }

    // Empty buffer: no-op on both.
    const emptyReal = new InputRingBuffer(8);
    const emptyLegacy = new LegacyLoopRingBuffer(8);
    const t1 = new Float64Array(INPUT_FRAME_STRIDE).fill(7.7);
    const t2 = new Float64Array(INPUT_FRAME_STRIDE).fill(7.7);
    emptyReal.copyRangeInto(t1, 0, 1);
    emptyLegacy.copyRangeInto(t2, 0, 1);
    expectIdenticalBytes(t1, t2, 'empty buffer');
    expect(t1[0]).toBe(7.7);
  });

  it('micro-benchmark: set() not slower for stride-sized range, clearly faster for multi-record', () => {
    const CAP = 120; // production capacity
    const real = new InputRingBuffer(CAP);
    const legacy = new LegacyLoopRingBuffer(CAP);
    for (let i = 0; i < 200; i++) {
      const frame = makeFrame(i, {
        subSteps: 2,
        subStepDirsX: Float64Array.from([1, 0, 0, 0]),
        subStepDirsY: Float64Array.from([0, -1, 0, 0]),
      });
      real.write(frame);
      legacy.write(frame);
    }
    // Steady state: baseSeq=80, head slot = 200 % 120 = 80.
    // slot(90) = 90 (90+30 <= 120 → non-wrapping), slot(110) = 110 (wraps).

    function measure(fromSeq: number, count: number, iters: number): {
      loopNs: number;
      setNs: number;
    } {
      const loopTarget = new Float64Array(count * INPUT_FRAME_STRIDE);
      const setTarget = new Float64Array(count * INPUT_FRAME_STRIDE);
      const loopCopy = () => legacy.copyRangeInto(loopTarget, fromSeq, count);
      const setCopy = () => real.copyRangeInto(setTarget, fromSeq, count);
      // Warmup both paths (JIT + inline caches) before timing.
      for (let i = 0; i < 2000; i++) {
        loopCopy();
        setCopy();
      }
      const loopBatches: number[] = [];
      const setBatches: number[] = [];
      const BATCHES = 9;
      for (let b = 0; b < BATCHES; b++) {
        // Alternate order per batch to cancel drift (thermal/JIT) bias.
        // hrtime.bigint gives ns resolution — performance.now() quantized to
        // ~1ms inside the vitest worker, far too coarse for ~50ns ops.
        const first = b % 2 === 0;
        const runLoop = () => {
          const t0 = process.hrtime.bigint();
          for (let i = 0; i < iters; i++) loopCopy();
          loopBatches.push(Number(process.hrtime.bigint() - t0) / iters);
        };
        const runSet = () => {
          const t0 = process.hrtime.bigint();
          for (let i = 0; i < iters; i++) setCopy();
          setBatches.push(Number(process.hrtime.bigint() - t0) / iters);
        };
        if (first) {
          runLoop();
          runSet();
        } else {
          runSet();
          runLoop();
        }
      }
      const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      return { loopNs: median(loopBatches), setNs: median(setBatches) };
    }

    const single = measure(105, 1, 20000); // smallest realistic range: 1 record (21 float64s)
    const multiNonWrap = measure(90, 30, 5000); // 30 records, contiguous
    const multiWrap = measure(110, 30, 5000); // 30 records across the ring boundary

    const fmt = (ns: number) => `${ns.toFixed(1)}ns`;
    console.log(
      `[ticket-04 bench] copyRangeInto loop → set:\n` +
        `  1 record  (non-wrap): ${fmt(single.loopNs)} → ${fmt(single.setNs)}` +
        ` (${(single.loopNs / single.setNs).toFixed(2)}x)\n` +
        `  30 records (non-wrap): ${fmt(multiNonWrap.loopNs)} → ${fmt(multiNonWrap.setNs)}` +
        ` (${(multiNonWrap.loopNs / multiNonWrap.setNs).toFixed(2)}x)\n` +
        `  30 records (wrap):     ${fmt(multiWrap.loopNs)} → ${fmt(multiWrap.setNs)}` +
        ` (${(multiWrap.loopNs / multiWrap.setNs).toFixed(2)}x)`,
    );

    // Stride-sized: must not be meaningfully slower (generous CI-noise margin).
    expect(single.setNs).toBeLessThanOrEqual(single.loopNs * 1.5);
    // Multi-record: must be clearly faster.
    expect(multiNonWrap.setNs).toBeLessThanOrEqual(multiNonWrap.loopNs * 0.8);
    expect(multiWrap.setNs).toBeLessThanOrEqual(multiWrap.loopNs * 0.8);
  });
});

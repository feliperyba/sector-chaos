import { describe, it, expect } from 'vitest';
import { InputBuffer } from '../InputBuffer.js';
import { MAX_SUBSTEPS_PER_RECORD } from '@sector-battle/shared';
import type { InputRecord } from '../../types.js';

/**
 * Characterization tests for `InputBuffer` — the input-history ring buffer
 * used by client prediction (ADR-0014, ADR-0026 zero-alloc). These pin the
 * public surface (`push`, `getUnacknowledged`, `clear`) so future refactors of
 * the buffer/pooling layer cannot silently regress the contract.
 *
 * `getUnacknowledged(lastServerSeq)` returns records whose `sequence >
 * lastServerSeq`. It returns a `PooledInputRecords` view whose `records` array
 * is a long-lived pool mutated in place on every call; only the `[0, count)`
 * slice is valid and the view is invalidated by the next call.
 *
 * IMPORTANT: the underlying ring buffer now correctly handles non-zero starting
 * sequences (baseSeq is adopted from the first frame's sequence field, not
 * assumed to be 0 — fix for the 0-based-sequence footgun from #30). Tests below
 * use 0-based sequences for production parity; see InputRingBuffer.test.ts for
 * non-zero-sequence characterization tests.
 *
 * NOTE: there is no `discardBefore` method on this class (the ticket's planned
 * case 4 was based on a stale assumption — the actual API is
 * `push` / `getUnacknowledged` / `clear`). Case 4 is substituted with a test
 * of the "acknowledged-up-to-newest returns nothing" boundary; the wraparound
 * case covers the ring-buffer fixed-capacity behavior that case 5 was after.
 */

function makeRecord(overrides: Partial<InputRecord> & { sequence: number }): InputRecord {
  // NET-02: default per-substep direction is +x for substep 0 (matches the
  // default movementX: 1). Callers can override via the spread.
  const subStepDirsX = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  const subStepDirsY = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  subStepDirsX[0] = 1;
  return {
    frame: {
      movementX: 1,
      movementY: 0,
      aimAngle: 0,
      sequence: overrides.sequence,
      actions: [],
    },
    predictedX: 0,
    predictedY: 0,
    timestamp: overrides.sequence * 100,
    speed: 430,
    dt: 1 / 60,
    velocityX: 0,
    velocityY: 0,
    subSteps: 1,
    subStepDirsX,
    subStepDirsY,
    ...overrides,
  };
}

describe('InputBuffer — characterization', () => {
  it('push + getUnacknowledged: returns only records with sequence > lastServerSeq', () => {
    const buf = new InputBuffer();
    buf.push(makeRecord({ sequence: 0 }));
    buf.push(makeRecord({ sequence: 1 }));
    buf.push(makeRecord({ sequence: 2 }));

    // lastServerSeq = 0 → server has acknowledged seq 0; only 1 + 2 remain.
    const result = buf.getUnacknowledged(0);

    expect(result.count).toBe(2);
    expect(result.records[0]!.frame.sequence).toBe(1);
    expect(result.records[1]!.frame.sequence).toBe(2);

    // Pooled records preserve the other pushed fields.
    expect(result.records[0]!.speed).toBe(430);
    expect(result.records[0]!.frame.movementX).toBe(1);
    expect(result.records[0]!.timestamp).toBe(100);
  });

  it('getUnacknowledged with lastServerSeq = -1: returns all records (nothing acknowledged)', () => {
    const buf = new InputBuffer();
    buf.push(makeRecord({ sequence: 0 }));
    buf.push(makeRecord({ sequence: 1 }));
    buf.push(makeRecord({ sequence: 2 }));

    // -1 means "no frame has been server-acknowledged yet", so every pushed
    // frame (seq > -1) is unacked.
    const result = buf.getUnacknowledged(-1);

    expect(result.count).toBe(3);
    expect(result.records[0]!.frame.sequence).toBe(0);
    expect(result.records[1]!.frame.sequence).toBe(1);
    expect(result.records[2]!.frame.sequence).toBe(2);
  });

  it('clear: empties the buffer so subsequent reads return count 0', () => {
    const buf = new InputBuffer();
    buf.push(makeRecord({ sequence: 0 }));
    buf.push(makeRecord({ sequence: 1 }));
    buf.push(makeRecord({ sequence: 2 }));

    buf.clear();

    const result = buf.getUnacknowledged(-1);
    expect(result.count).toBe(0);
  });

  it('getUnacknowledged: returns count 0 when lastServerSeq >= newest sequence', () => {
    const buf = new InputBuffer();
    buf.push(makeRecord({ sequence: 0 }));
    buf.push(makeRecord({ sequence: 1 }));
    buf.push(makeRecord({ sequence: 2 }));

    // Server has acknowledged up to and including the newest frame.
    expect(buf.getUnacknowledged(2).count).toBe(0);
    // An acknowledged-past-newest seq also yields nothing.
    expect(buf.getUnacknowledged(99).count).toBe(0);
  });

  it('ring-buffer wraparound: an overfilled fixed-capacity buffer still serves the recent window', () => {
    // The ring is fixed-capacity. When more frames than `capacity` are pushed,
    // the oldest are evicted. Querying the still-valid recent window must
    // return the correct surviving frames in order — this characterizes the
    // wraparound read path used by reconciliation after long input bursts.
    const capacity = 5;
    const buf = new InputBuffer(capacity);

    // Push 7 records (2 more than capacity). Seqs 0 and 1 are evicted.
    for (let seq = 0; seq < 7; seq++) {
      buf.push(makeRecord({ sequence: seq }));
    }

    // Query a window entirely inside the surviving range [2..6].
    const result = buf.getUnacknowledged(4);

    expect(result.count).toBe(2);
    expect(result.records[0]!.frame.sequence).toBe(5);
    expect(result.records[1]!.frame.sequence).toBe(6);
    // Contents are intact after wraparound, not garbled.
    expect(result.records[1]!.speed).toBe(430);
    expect(result.records[1]!.frame.movementX).toBe(1);
  });

  it('getUnacknowledged: pooled records array is reused across calls (zero-alloc after warmup)', () => {
    // The PooledInputRecords view is documented as a long-lived pool mutated
    // in place on every call. Each call snapshots its own count up-front, and
    // two consecutive calls must return the same `records` array identity.
    const buf = new InputBuffer();
    buf.push(makeRecord({ sequence: 0 }));
    buf.push(makeRecord({ sequence: 1 }));

    const firstRecords = buf.getUnacknowledged(-1).records;
    const second = buf.getUnacknowledged(-1);

    expect(second.records).toBe(firstRecords);
    expect(second.count).toBe(2);
    expect(second.records[0]!.frame.sequence).toBe(0);
    expect(second.records[1]!.frame.sequence).toBe(1);
  });

  it('getCount: O(1) count of stored frames without decoding the ring (H2 regression)', () => {
    // `getCount()` is the O(1) hot-path read used by telemetry
    // (InputBuffer.getCount → TelemetrySampler.sampleFrame,
    // called every frame). The prior implementation called the full O(N)
    // getUnacknowledged(0) copy+decode purely to read `.count` — wasted per-frame
    // CPU that contributed to frame drops under 64-player load. getCount reads
    // the ring's existing count field directly (no copy, no decode).
    const buf = new InputBuffer();
    expect(buf.getCount()).toBe(0);

    buf.push(makeRecord({ sequence: 0 }));
    expect(buf.getCount()).toBe(1);
    buf.push(makeRecord({ sequence: 1 }));
    buf.push(makeRecord({ sequence: 2 }));
    expect(buf.getCount()).toBe(3);

    buf.clear();
    expect(buf.getCount()).toBe(0);
  });

  it('getCount: does NOT mutate the pooled records (no decode side-effects)', () => {
    // Regression guard for the H2 fix: getCount must be a pure read. If it ever
    // falls back to getUnacknowledged it would overwrite the pooled records
    // array — so a subsequent getUnacknowledged must still see untouched pool
    // slots. Push two frames, call getCount, then read back via
    // getUnacknowledged and confirm the decoded contents are correct.
    const buf = new InputBuffer();
    buf.push(makeRecord({ sequence: 10 }));
    buf.push(makeRecord({ sequence: 11 }));

    const countViaO1 = buf.getCount();
    expect(countViaO1).toBe(2);

    const decoded = buf.getUnacknowledged(9);
    expect(decoded.count).toBe(2);
    expect(decoded.records[0]!.frame.sequence).toBe(10);
    expect(decoded.records[1]!.frame.sequence).toBe(11);
  });

  it('getUnacknowledged: clamps to oldest available when server falls behind (overflow)', () => {
    // When the server is overloaded and falls behind real-time, its
    // lastProcessedInput can be below the buffer's oldest sequence — older
    // records have been overwritten by newer ones. Without clamping,
    // copyRangeInto silently no-ops (returns early on bounds check), leaving
    // the scratch slice with stale data → the reconciler replays garbage →
    // spurious corrections → the "periodic rollback" stutter.
    //
    // The fix clamps fromSeq to the oldest available record so the replay
    // only covers what's actually in the buffer.
    const buf = new InputBuffer(5); // small capacity to force overflow easily
    // Push records 0-4 (fills the buffer)
    for (let i = 0; i < 5; i++) {
      buf.push(makeRecord({ sequence: i }));
    }
    // Push records 5-9 (overwrites 0-4; oldest is now 5)
    for (let i = 5; i < 10; i++) {
      buf.push(makeRecord({ sequence: i }));
    }
    // Buffer now holds [5,6,7,8,9]. Oldest = 5, newest = 9.
    // Server says lastProcessedInput = 2 (way below oldest = 5).
    // Without the clamp: fromSeq = 3, copyRangeInto no-ops, garbage results.
    // With the clamp: fromSeq = 5 (oldest), replay returns records [5,6,7,8,9].
    const result = buf.getUnacknowledged(2);
    expect(result.count).toBe(5);
    expect(result.records[0]!.frame.sequence).toBe(5);
    expect(result.records[4]!.frame.sequence).toBe(9);

    // Each record should have VALID data (the actual pushed values, not zeros
    // or stale data from a previous call).
    for (let i = 0; i < result.count; i++) {
      expect(result.records[i]!.frame.sequence).toBe(5 + i);
      expect(result.records[i]!.subSteps).toBe(1);
    }
  });
});

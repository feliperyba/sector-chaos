import {
  InputRingBuffer,
  INPUT_FIELD_OFFSET,
  INPUT_FRAME_STRIDE,
  MAX_SUBSTEPS_PER_RECORD,
  PLAYER,
  SUBSTEP_DIR_X_OFFSET,
  SUBSTEP_DIR_Y_OFFSET,
  actionsToBitmask,
  bitmaskToActionsInto,
  hasAction,
} from '@sector-battle/shared';
import type { InputRecord } from '../types.js';

export interface PooledInputRecords {
  records: InputRecord[];
  count: number;
}

export class InputBuffer {
  private ring: InputRingBuffer;
  private readonly scratchSlice: Float64Array;
  private readonly recordPool: InputRecord[];
  private poolCount = 0;
  private readonly _scratchResult: PooledInputRecords;

  constructor(capacity = 120) {
    this.ring = new InputRingBuffer(capacity);
    this.scratchSlice = new Float64Array(capacity * INPUT_FRAME_STRIDE);
    this.recordPool = [];
    this._scratchResult = { records: this.recordPool, count: 0 };
  }

  push(record: InputRecord): void {
    const frame = record.frame;
    this.ring.write({
      sequence: frame.sequence,
      actionBitmask: actionsToBitmask(frame.actions),
      dx: frame.movementX,
      dy: frame.movementY,
      aimAngle: frame.aimAngle,
      timestamp: record.timestamp,
      predictedX: record.predictedX,
      predictedY: record.predictedY,
      velocityX: record.velocityX,
      velocityY: record.velocityY,
      speed: record.speed,
      dt: record.dt,
      subSteps: record.subSteps,
      // NET-02: per-substep movement directions. Float64Array is indexable
      // like number[] for the ring's write() (it indexes via [i]); the
      // trailing zero slots beyond subSteps are inert.
      subStepDirsX: record.subStepDirsX,
      subStepDirsY: record.subStepDirsY,
    });
  }

  /**
   * Returns the unacknowledged input records (those with sequence > lastServerSeq).
   *
   * Returns a {@link PooledInputRecords} view: `records` is a long-lived pool
   * array (mutated in place on every call) and `count` is the valid range
   * `[0, count)`. Callers MUST only read `[0, count)` from `records` and MUST
   * NOT retain the array past the next `getUnacknowledged` call.
   *
   * Zero-allocation after warmup: pooled InputRecord/InputFrame/objects and a
   * pre-allocated Float64Array scratch slice are reused across calls.
   */
  getUnacknowledged(lastServerSeq: number): PooledInputRecords {
    this.poolCount = 0;

    const newest = this.ring.newestSequence;
    if (newest === undefined) return this.emptyResult();
    const oldest = this.ring.oldestSequence;
    let fromSeq = lastServerSeq + 1;
    if (fromSeq > newest) return this.emptyResult();
    // Clamp to the oldest available record. When the server falls behind
    // (overloaded tick, network stall), lastServerSeq can be below the
    // buffer's oldest sequence — older records have been overwritten.
    // Without this clamp, copyRangeInto silently no-ops (its own bounds
    // check returns early), leaving the scratch slice with stale data from
    // a previous call. The reconciler then replays garbage → wrong position
    // → spurious correction → the "periodic rollback" stutter.
    if (oldest !== undefined && fromSeq < oldest) {
      fromSeq = oldest;
    }

    const numFrames = newest - fromSeq + 1;
    const slice = this.scratchSlice.subarray(0, numFrames * INPUT_FRAME_STRIDE);
    this.ring.copyRangeInto(slice, fromSeq, numFrames);

    for (let i = 0; i < numFrames; i++) {
      const offset = i * INPUT_FRAME_STRIDE;
      const record = this.acquirePooledRecord(i);

      const frame = record.frame;
      // Slot addresses come from the ring's published stride layout
      // (INPUT_FIELD_OFFSET) — no hand-derived magic indexes (ticket 14).
      frame.sequence = slice[offset + INPUT_FIELD_OFFSET.sequence]!;
      const actionBitmask = slice[offset + INPUT_FIELD_OFFSET.actionBitmask]!;
      frame.movementX = slice[offset + INPUT_FIELD_OFFSET.dx]!;
      frame.movementY = slice[offset + INPUT_FIELD_OFFSET.dy]!;
      frame.aimAngle = slice[offset + INPUT_FIELD_OFFSET.aimAngle]!;
      record.timestamp = slice[offset + INPUT_FIELD_OFFSET.timestamp]!;
      record.predictedX = slice[offset + INPUT_FIELD_OFFSET.predictedX]!;
      record.predictedY = slice[offset + INPUT_FIELD_OFFSET.predictedY]!;
      record.velocityX = slice[offset + INPUT_FIELD_OFFSET.velocityX]!;
      record.velocityY = slice[offset + INPUT_FIELD_OFFSET.velocityY]!;
      record.speed = slice[offset + INPUT_FIELD_OFFSET.speed]!;
      record.dt = slice[offset + INPUT_FIELD_OFFSET.dt]!;
      record.subSteps = slice[offset + INPUT_FIELD_OFFSET.subSteps]!;

      // NET-02: decode the per-substep movement directions from the trailing
      // stride slots into the pooled record's pre-allocated arrays.
      const dirsX = record.subStepDirsX;
      const dirsY = record.subStepDirsY;
      for (let j = 0; j < MAX_SUBSTEPS_PER_RECORD; j++) {
        dirsX[j] = slice[offset + SUBSTEP_DIR_X_OFFSET + j]!;
        dirsY[j] = slice[offset + SUBSTEP_DIR_Y_OFFSET + j]!;
      }

      bitmaskToActionsInto(actionBitmask, frame.actions);
      this.poolCount++;
    }

    this._scratchResult.count = this.poolCount;
    return this._scratchResult;
  }

  /**
   * O(1) read of the wall-clock send timestamp (`performance.now()` at push
   * time) for a stored input sequence, or `undefined` if `seq` is no longer in
   * the ring (overwritten / pre-start). Used by the client-side RTT estimator
   * (`RttSmoother`, via `PlayerReconciler`) to measure the real input round-trip
   * on server ack — the send half of `ackReceivedTime - inputSendTime`. This is
   * a direct view read (offset = INPUT_FIELD_OFFSET.timestamp), no copy/decode.
   */
  getSendTimeMs(seq: number): number | undefined {
    const view = this.ring.read(seq);
    return view === undefined ? undefined : view[INPUT_FIELD_OFFSET.timestamp];
  }

  /**
   * O(1) count of frames currently stored in the ring (the ring's own `count`
   * field, no copy/decode). Used by the per-frame telemetry hot path
   * (`InputBuffer.getCount` → `TelemetrySampler.sampleFrame`,
   * called every frame). The prior implementation called the full O(N)
   * `getUnacknowledged(0)` copy+decode purely to read `.count` — wasted
   * per-frame CPU that contributed to frame drops under 64-player load (B4
   * perf regression, H2). This is a pure read; it does not touch the pooled
   * records array.
   *
   * NOTE: this is the TOTAL stored-frame count, not the unacknowledged count
   * (which depends on the server's last-acked seq). Telemetry uses it as a
   * ring-health proxy; callers needing the unacked count for reconciliation
   * must still use `getUnacknowledged(lastServerSeq).count`.
   */
  getCount(): number {
    return this.ring.count;
  }

  clear(): void {
    this.ring.reset();
    this.poolCount = 0;
  }

  /**
   * Find the most recent input sequence ≤ `upToSeq` that contains the DASH
   * action, or `undefined` if none exists in the retained history. Used by
   * the reconciler to reconstruct dash state at a server-acked tick: a dash
   * is continuous (carries across ticks via dashRemaining), so a correction
   * arriving mid-dash must seed isDashing/dashRemaining to replay correctly.
   *
   * Searches backward from `upToSeq` (inclusive) through the ring buffer.
   * Bounds the search to the dash window (DASH_DURATION_TICKS) — anything
   * older cannot still be in progress.
   */
  findLastDashBefore(upToSeq: number): number | undefined {
    const oldest = this.ring.oldestSequence;
    if (oldest === undefined) return undefined;
    // Cap the backward search at the dash window — a dash older than this
    // cannot still be in progress, so there's no point scanning further.
    const searchFloor = Math.max(oldest, upToSeq - this.dashWindowTicks);
    for (let seq = upToSeq; seq >= searchFloor; seq--) {
      const view = this.ring.read(seq);
      if (view === undefined) continue;
      const actionBitmask = view[INPUT_FIELD_OFFSET.actionBitmask]!;
      if (hasAction(actionBitmask, 'DASH')) return seq;
    }
    return undefined;
  }

  private readonly dashWindowTicks = PLAYER.DASH_DURATION_TICKS;

  private acquirePooledRecord(index: number): InputRecord {
    let record = this.recordPool[index];
    if (!record) {
      record = {
        frame: {
          movementX: 0,
          movementY: 0,
          aimAngle: 0,
          sequence: 0,
          actions: [],
        },
        predictedX: 0,
        predictedY: 0,
        timestamp: 0,
        speed: 0,
        dt: 0,
        velocityX: 0,
        velocityY: 0,
        subSteps: 0,
        // NET-02: pre-allocated per-substep direction arrays. Boxed on the
        // pooled record so getUnacknowledged() never allocates (ADR-0026).
        subStepDirsX: new Float64Array(MAX_SUBSTEPS_PER_RECORD),
        subStepDirsY: new Float64Array(MAX_SUBSTEPS_PER_RECORD),
      };
      this.recordPool[index] = record;
    }
    return record;
  }

  private emptyResult(): PooledInputRecords {
    this.poolCount = 0;
    this._scratchResult.count = 0;
    return this._scratchResult;
  }
}

/**
 * Hard cap on the number of per-substep directions carried by a single input
 * record (NET-02 faithful rewind-replay). A record's `subSteps` (frame substeps
 * + coasted substeps merged from prior `step(null)` calls) is bounded by the
 * wall-clock time between two sends (~`INPUT_SEND_INTERVAL_MS` = 16ms ≈ 1
 * substep) plus any accumulator residual (< `SIM_TICK_DT`). Under the GameScene
 * 50ms dt clamp the theoretical max is 3 substeps per record; this constant
 * matches `MAX_PREDICTION_SUBSTEPS` (the per-`step()` cap) to cover any
 * residual-carry edge with margin. The cost is 2 × 4 = 8 extra float64s per
 * record (~64 bytes at 120 capacity ≈ 7.7KB total) — negligible, and the
 * hot-path stays zero-alloc (the slots are part of the pre-allocated backing
 * array, ADR-0026). If a record ever exceeds this (shouldn't happen under the
 * dt clamp), the reconciler falls back to the record's frame direction for the
 * excess substeps — no worse than the pre-NET-02 behavior.
 */
export const MAX_SUBSTEPS_PER_RECORD = 4;

/**
 * Stride layout of a single input frame — the single source of truth for every
 * slot address in the ring. Published so consumers stop re-deriving offsets by
 * hand (magic indexes like `view[5]`); `write()`, `toDebugView()`, and
 * `decodeFrameInto()` all address slots through these names.
 *
 *   [0..12]                        — the 13 original scalar fields
 *   [13..13+MAX-1]                 — subStepDirsX[0..MAX-1]
 *   [13+MAX..13+2*MAX-1]           — subStepDirsY[0..MAX-1]
 *
 * Frozen: the layout is wire-adjacent (ADR-0007 pointer arithmetic is keyed to
 * it) — a change here changes `INPUT_FRAME_STRIDE` and every stored record.
 */
export const INPUT_FIELD_OFFSET = Object.freeze({
  sequence: 0,
  actionBitmask: 1,
  dx: 2,
  dy: 3,
  aimAngle: 4,
  timestamp: 5,
  predictedX: 6,
  predictedY: 7,
  velocityX: 8,
  velocityY: 9,
  speed: 10,
  dt: 11,
  subSteps: 12,
  subStepDirsX: 13,
  subStepDirsY: 13 + MAX_SUBSTEPS_PER_RECORD,
} as const);

/** Offset of `subStepDirsX[0]` within a frame's stride (first slot after the 13 scalars). */
export const SUBSTEP_DIR_X_OFFSET = INPUT_FIELD_OFFSET.subStepDirsX;
/** Offset of `subStepDirsY[0]` within a frame's stride. */
export const SUBSTEP_DIR_Y_OFFSET = INPUT_FIELD_OFFSET.subStepDirsY;

/** Number of float64 values per input frame. */
export const INPUT_FRAME_STRIDE = INPUT_FIELD_OFFSET.subStepDirsY + MAX_SUBSTEPS_PER_RECORD;

/** Object representation of a single input frame (used for write/debug only). */
export interface RingBufferFrame {
  sequence: number;
  actionBitmask: number;
  dx: number;
  dy: number;
  aimAngle: number;
  timestamp: number;
  predictedX: number;
  predictedY: number;
  velocityX: number;
  velocityY: number;
  speed: number;
  dt: number;
  subSteps: number;
  /**
   * Per-substep movement direction X (NET-02). Entry `[i]` is the normalized
   * dx the prediction integrated for substep `i` of this record. Trailing
   * entries beyond `subSteps` are 0. Optional: callers that don't care about
   * per-substep direction (e.g. unit-test frames) omit it and `write()` stores
   * 0 for every slot — the reconciler then falls back to the frame direction.
   * Typed `ArrayLike<number>` so both `number[]` (debug/test) and `Float64Array`
   * (zero-alloc hot path, ADR-0026) are accepted.
   */
  subStepDirsX?: ArrayLike<number>;
  /** Per-substep movement direction Y (NET-02). See {@link subStepDirsX}. */
  subStepDirsY?: ArrayLike<number>;
}

/**
 * Typed ring buffer backed by a single Float64Array.
 *
 * Each frame occupies `INPUT_FRAME_STRIDE` consecutive float64 slots (the 13
 * scalars + 2 × substep-direction arrays — see {@link INPUT_FIELD_OFFSET}).
 * `read()` returns a **view** into the backing buffer — callers must NOT hold
 * the reference past the next `write()` call.
 */
export class InputRingBuffer {
  private readonly backing: Float64Array;
  private readonly _capacity: number;
  private head = 0; // next write position (float64 index)
  private _count = 0; // number of valid frames
  private baseSeq = 0; // sequence number of oldest frame

  constructor(capacity = 120) {
    this._capacity = capacity;
    this.backing = new Float64Array(capacity * INPUT_FRAME_STRIDE);
  }

  // ── Write ──────────────────────────────────────────────────────────

  write(frame: RingBufferFrame): void {
    const offset = this.head;

    // First write into an empty buffer: adopt the frame's sequence as baseSeq
    // instead of assuming 0. This fixes the footgun where non-zero starting
    // sequences silently broke getUnacknowledged/copyRangeInto/slotFor
    // (all of which key off baseSeq — ADR-0007).
    if (this._count === 0) {
      this.baseSeq = frame.sequence;
    }

    this.backing[offset + INPUT_FIELD_OFFSET.sequence] = frame.sequence;
    this.backing[offset + INPUT_FIELD_OFFSET.actionBitmask] = frame.actionBitmask;
    this.backing[offset + INPUT_FIELD_OFFSET.dx] = frame.dx;
    this.backing[offset + INPUT_FIELD_OFFSET.dy] = frame.dy;
    this.backing[offset + INPUT_FIELD_OFFSET.aimAngle] = frame.aimAngle;
    this.backing[offset + INPUT_FIELD_OFFSET.timestamp] = frame.timestamp;
    this.backing[offset + INPUT_FIELD_OFFSET.predictedX] = frame.predictedX;
    this.backing[offset + INPUT_FIELD_OFFSET.predictedY] = frame.predictedY;
    this.backing[offset + INPUT_FIELD_OFFSET.velocityX] = frame.velocityX;
    this.backing[offset + INPUT_FIELD_OFFSET.velocityY] = frame.velocityY;
    this.backing[offset + INPUT_FIELD_OFFSET.speed] = frame.speed;
    this.backing[offset + INPUT_FIELD_OFFSET.dt] = frame.dt;
    this.backing[offset + INPUT_FIELD_OFFSET.subSteps] = frame.subSteps;

    // NET-02 per-substep directions. Always write all MAX slots so wraparound
    // reuse never leaks a previous record's directions into a new one. Callers
    // that don't supply the arrays (subStepDirsX/Y undefined) get all-zero
    // slots → the reconciler falls back to the frame direction for every
    // substep (the pre-NET-02 behavior).
    const dirsX = frame.subStepDirsX;
    const dirsY = frame.subStepDirsY;
    for (let i = 0; i < MAX_SUBSTEPS_PER_RECORD; i++) {
      this.backing[offset + SUBSTEP_DIR_X_OFFSET + i] = dirsX ? (dirsX[i] ?? 0) : 0;
      this.backing[offset + SUBSTEP_DIR_Y_OFFSET + i] = dirsY ? (dirsY[i] ?? 0) : 0;
    }

    // Advance head with wraparound
    this.head = (this.head + INPUT_FRAME_STRIDE) % (this._capacity * INPUT_FRAME_STRIDE);

    if (this._count < this._capacity) {
      this._count++;
    } else {
      // Buffer full — oldest frame overwritten, advance baseSeq
      this.baseSeq++;
    }
  }

  // ── Read ───────────────────────────────────────────────────────────

  /**
   * Returns a **view** (zero-allocation) of the `INPUT_FRAME_STRIDE` float64s
   * for `sequence`, or `undefined` if the sequence is out of the valid range.
   * Decode the view's scalars via {@link decodeFrameInto} or address slots via
   * {@link INPUT_FIELD_OFFSET}.
   *
   * **WARNING:** The view is invalidated by the next `write()`.
   */
  /**
   * Maps a sequence number to its physical slot index.
   * When the buffer is not full, baseSeq lives at slot 0.
   * When full, baseSeq lives at head/STRIDE (the slot about to be overwritten).
   */
  private slotFor(sequence: number): number {
    const baseSlot = this._count === this._capacity ? this.head / INPUT_FRAME_STRIDE : 0;
    return (sequence - this.baseSeq + baseSlot) % this._capacity;
  }

  read(sequence: number): Float64Array | undefined {
    if (this._count === 0) return undefined;
    if (sequence < this.baseSeq || sequence > this.baseSeq + this._count - 1) return undefined;

    const slot = this.slotFor(sequence);
    const byteOffset = slot * INPUT_FRAME_STRIDE * Float64Array.BYTES_PER_ELEMENT;
    return new Float64Array(this.backing.buffer, byteOffset, INPUT_FRAME_STRIDE);
  }

  /**
   * Returns a **copy** of frames from `fromSeq` to `toSeq` (exclusive end)
   * as a contiguous Float64Array. Handles wraparound.
   * Returns an empty Float64Array if the range is invalid or out of bounds.
   *
   * Allocates a new Float64Array per call — prefer {@link copyRangeInto} with a
   * pre-allocated buffer on hot paths.
   */
  slice(fromSeq: number, toSeq: number): Float64Array {
    if (this._count === 0) return new Float64Array(0);
    if (fromSeq < this.baseSeq || toSeq > this.baseSeq + this._count + 1) {
      return new Float64Array(0);
    }
    if (fromSeq >= toSeq) return new Float64Array(0);

    const numFrames = toSeq - fromSeq;
    const result = new Float64Array(numFrames * INPUT_FRAME_STRIDE);
    this.copyRangeInto(result, fromSeq, numFrames);
    return result;
  }

  /**
   * Copies `count` frames starting at `fromSeq` into the pre-allocated
   * `target` Float64Array (zero-allocation path). Handles wraparound.
   *
   * The caller must size `target` to at least `count * INPUT_FRAME_STRIDE`
   * float64s. No bounds checking on the target — only on the source range.
   * Does nothing if the range is invalid or out of bounds.
   */
  copyRangeInto(target: Float64Array, fromSeq: number, count: number): void {
    if (this._count === 0) return;
    if (count <= 0) return;
    if (fromSeq < this.baseSeq || fromSeq + count > this.baseSeq + this._count + 1) return;

    // Bulk-copy path (ticket 04): consecutive sequences occupy consecutive
    // physical slots, so the source frames are one (or, across the ring
    // boundary, two) contiguous runs of `backing`. TypedArray.set on a
    // subarray view is a memcpy-class copy vs the former element-wise loop —
    // same bytes, same slots, same order (including the lenient `+1` bound
    // above, where the final frame re-reads the oldest live slot exactly as
    // the per-frame slot mapping did).
    const stride = INPUT_FRAME_STRIDE;
    const srcStart = this.slotFor(fromSeq) * stride;
    const totalFloats = count * stride;

    if (srcStart + totalFloats <= this.backing.length) {
      // Non-wrapping range: single contiguous segment.
      target.set(this.backing.subarray(srcStart, srcStart + totalFloats), 0);
      return;
    }

    // Wrapping range: tail of the backing array, then the remainder from the
    // front. Two segments preserve the exact frame order: frame i lives at
    // backing[(srcStart + i*stride) % backing.length].
    const tailFloats = this.backing.length - srcStart;
    target.set(this.backing.subarray(srcStart), 0);
    target.set(this.backing.subarray(0, totalFloats - tailFloats), tailFloats);
  }

  // ── Reset ──────────────────────────────────────────────────────────

  reset(): void {
    this.head = 0;
    this._count = 0;
    this.baseSeq = 0;
  }

  // ── Properties ─────────────────────────────────────────────────────

  get count(): number {
    return this._count;
  }

  get capacity(): number {
    return this._capacity;
  }

  get oldestSequence(): number | undefined {
    return this._count > 0 ? this.baseSeq : undefined;
  }

  get newestSequence(): number | undefined {
    return this._count > 0 ? this.baseSeq + this._count - 1 : undefined;
  }

  // ── Debug ──────────────────────────────────────────────────────────

  toDebugView(): RingBufferFrame[] {
    const frames: RingBufferFrame[] = [];
    if (this._count === 0) return frames;

    for (let i = 0; i < this._count; i++) {
      const seq = this.baseSeq + i;
      const slot = this.slotFor(seq);
      const offset = slot * INPUT_FRAME_STRIDE;
      const subStepDirsX: number[] = [];
      const subStepDirsY: number[] = [];
      for (let j = 0; j < MAX_SUBSTEPS_PER_RECORD; j++) {
        subStepDirsX.push(this.backing[offset + SUBSTEP_DIR_X_OFFSET + j]!);
        subStepDirsY.push(this.backing[offset + SUBSTEP_DIR_Y_OFFSET + j]!);
      }
      frames.push({
        sequence: this.backing[offset + INPUT_FIELD_OFFSET.sequence]!,
        actionBitmask: this.backing[offset + INPUT_FIELD_OFFSET.actionBitmask]!,
        dx: this.backing[offset + INPUT_FIELD_OFFSET.dx]!,
        dy: this.backing[offset + INPUT_FIELD_OFFSET.dy]!,
        aimAngle: this.backing[offset + INPUT_FIELD_OFFSET.aimAngle]!,
        timestamp: this.backing[offset + INPUT_FIELD_OFFSET.timestamp]!,
        predictedX: this.backing[offset + INPUT_FIELD_OFFSET.predictedX]!,
        predictedY: this.backing[offset + INPUT_FIELD_OFFSET.predictedY]!,
        velocityX: this.backing[offset + INPUT_FIELD_OFFSET.velocityX]!,
        velocityY: this.backing[offset + INPUT_FIELD_OFFSET.velocityY]!,
        speed: this.backing[offset + INPUT_FIELD_OFFSET.speed]!,
        dt: this.backing[offset + INPUT_FIELD_OFFSET.dt]!,
        subSteps: this.backing[offset + INPUT_FIELD_OFFSET.subSteps]!,
        subStepDirsX,
        subStepDirsY,
      });
    }
    return frames;
  }
}

/**
 * Zero-allocation single-frame decoder: writes the 13 scalar fields of a frame
 * view (from `read()`, or any frame-aligned offset into a `copyRangeInto`
 * slice) into the caller-owned `target` — the same `Into` idiom as
 * `applyAccelerationInto` (ADR-0026: no allocating accessors; ADR-0007: the
 * pointer arithmetic stays, it just gets named). `target` may be a full
 * `RingBufferFrame` or any receptacle carrying the 13 scalar fields; it is
 * mutated in place, so callers reuse one object across a decode loop.
 *
 * The per-substep-direction slots are NOT decoded here: `subStepDirsX/Y` are
 * read-only `ArrayLike`s (not safely index-writable through the interface).
 * Address them directly on the view — `view[SUBSTEP_DIR_X_OFFSET + i]` —
 * trailing slots beyond `subSteps` are 0.
 */
export function decodeFrameInto(view: Float64Array, target: RingBufferFrame): void {
  target.sequence = view[INPUT_FIELD_OFFSET.sequence]!;
  target.actionBitmask = view[INPUT_FIELD_OFFSET.actionBitmask]!;
  target.dx = view[INPUT_FIELD_OFFSET.dx]!;
  target.dy = view[INPUT_FIELD_OFFSET.dy]!;
  target.aimAngle = view[INPUT_FIELD_OFFSET.aimAngle]!;
  target.timestamp = view[INPUT_FIELD_OFFSET.timestamp]!;
  target.predictedX = view[INPUT_FIELD_OFFSET.predictedX]!;
  target.predictedY = view[INPUT_FIELD_OFFSET.predictedY]!;
  target.velocityX = view[INPUT_FIELD_OFFSET.velocityX]!;
  target.velocityY = view[INPUT_FIELD_OFFSET.velocityY]!;
  target.speed = view[INPUT_FIELD_OFFSET.speed]!;
  target.dt = view[INPUT_FIELD_OFFSET.dt]!;
  target.subSteps = view[INPUT_FIELD_OFFSET.subSteps]!;
}

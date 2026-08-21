import {
  TelemetryRing,
  type TelemetrySample,
  type TelemetrySnapshot,
} from '../debug/TelemetryRing.js';

export interface TelemetryMetrics {
  predictionError: number;
  rttMs: number;
  reconciliationCount: number;
  maxCorrection: number;
  renderOffsetMagnitude: number;
  patchRate: number;
  inputRate: number;
  jankFrames: number;
  totalFrames: number;
  windowSeconds: number;
  timestamp: number;
}

export interface TelemetrySamplerDeps {
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
  renderOffset: { x: number; y: number };
  rtt: { value: number };
  getServerPos: (out: { x: number; y: number }) => void;
  getServerVelocity: (out: { x: number; y: number }) => void;
  getPredictionBufferSize: () => number;
  getReconciliationCount: () => number;
  getLastReconciliationError: () => number;
  getLastReconciliationSeq: () => number;
  getIsMoving: () => boolean;
  getAnimationState: () => number;
}

const DEFAULT_WINDOW_MS = 1000;

/**
 * Hard-cap sizing for the rolling input/patch timestamp histories (perf H-5).
 *
 * Each timestamp is pushed at most once per call site: `recordInput` fires
 * once per sent input frame and patch detection fires at most once per
 * `sampleFrame` — both bounded by the render loop rate. Even a 360 Hz display
 * therefore produces at most ~360 entries inside the default 1000 ms rate
 * window, so a ceiling of 1000 entries/s (= 1 entry/ms) keeps
 * `cap = windowMs × ceiling + slack ≥ windowMs + slack` entries — comfortably
 * above the overlay's worst-case window need (rate × windowMs ≤ 360 at the
 * default window), meaning cap eviction can never remove an entry that is
 * still inside the window `snapshot()` measures: overlay/dev-console rate
 * readouts stay exact.
 *
 * Before this bound, `snapshot()` was the only pruner and is dev-only
 * (prediction overlay `GameScene` gate + DebugBridge console), so production
 * builds accumulated ~36k entries per array per 600 s match at 60 fps with
 * repeated doubling reallocations.
 */
export const TIMESTAMP_RATE_CEILING_PER_SECOND = 1000;
export const TIMESTAMP_CAP_SLACK = 16;
const TIMESTAMP_CAP_FLOOR = 64;

export class TelemetrySampler {
  private readonly ring: TelemetryRing;
  private readonly deps: TelemetrySamplerDeps;
  private readonly windowMs: number;

  private readonly serverPosBuf = { x: 0, y: 0 };
  private readonly serverVelBuf = { x: 0, y: 0 };
  /**
   * Scratch sample mutated in place each frame then copied into the
   * Float64Array ring via {@link TelemetryRing.write}. Zero-alloc steady
   * state. Never aliased: `TelemetryRing.write` copies every field into the
   * backing array synchronously and never stores the reference.
   */
  private readonly sampleBuf: TelemetrySample = {
    predictionError: 0,
    renderOffsetMagnitude: 0,
    velocityX: 0,
    velocityY: 0,
    serverVelocityX: 0,
    serverVelocityY: 0,
    predictionBufferSize: 0,
    reconciliationCount: 0,
    lastReconciliationError: 0,
    lastReconciliationSeq: 0,
    isMoving: 0,
    animationState: 0,
    dt: 0,
  };

  private inputCount = 0;
  private patchCount = 0;
  private lastServerX = 0;
  private lastServerY = 0;
  private prevReconCount = 0;

  private inputTimestamps: number[] = [];
  private patchTimestamps: number[] = [];

  /** Absolute per-array entry cap (see {@link TIMESTAMP_RATE_CEILING_PER_SECOND}). */
  private readonly timestampCap: number;

  constructor(deps: TelemetrySamplerDeps, windowMs = DEFAULT_WINDOW_MS) {
    this.deps = deps;
    this.windowMs = windowMs;
    this.ring = new TelemetryRing();
    this.timestampCap = Math.max(
      TIMESTAMP_CAP_FLOOR,
      Math.ceil((windowMs / 1000) * TIMESTAMP_RATE_CEILING_PER_SECOND) + TIMESTAMP_CAP_SLACK,
    );
  }

  /**
   * Push a timestamp and evict from the head. Timestamps are monotonic
   * (`performance.now()`), so the head is always the oldest entry — evicting
   * from the front preserves ascending order. Age eviction drops exactly the
   * entries `snapshot()`'s cutoff filter drops (`t < now - windowMs`), so the
   * observable window content is unchanged; the hard cap is a safety valve
   * that only engages above the documented rate ceiling. `shift()` keeps the
   * steady state allocation-free (V8 packed-array fast path, unlike `splice`
   * which allocates a result array per call).
   */
  private pushTimestamp(arr: number[], now: number): void {
    arr.push(now);
    const cutoff = now - this.windowMs;
    while (arr.length > this.timestampCap || (arr[0] !== undefined && arr[0] < cutoff)) {
      arr.shift();
    }
  }

  sampleFrame(dt: number): void {
    const now = performance.now();

    this.deps.getServerPos(this.serverPosBuf);
    this.deps.getServerVelocity(this.serverVelBuf);

    const dx = this.deps.localPos.x - this.serverPosBuf.x;
    const dy = this.deps.localPos.y - this.serverPosBuf.y;
    const predictionError = Math.sqrt(dx * dx + dy * dy);

    if (this.serverPosBuf.x !== this.lastServerX || this.serverPosBuf.y !== this.lastServerY) {
      if (this.lastServerX !== 0 || this.lastServerY !== 0) {
        this.patchCount++;
        this.pushTimestamp(this.patchTimestamps, now);
      }
      this.lastServerX = this.serverPosBuf.x;
      this.lastServerY = this.serverPosBuf.y;
    }

    const renderOffsetMag = Math.sqrt(
      this.deps.renderOffset.x ** 2 + this.deps.renderOffset.y ** 2,
    );

    const reconCount = this.deps.getReconciliationCount();
    const lastReconError = this.deps.getLastReconciliationError();
    const lastReconSeq = this.deps.getLastReconciliationSeq();

    // Mutate the scratch sample in place — zero-alloc steady state. The ring
    // copies every field into the backing Float64Array synchronously.
    const sample = this.sampleBuf;
    sample.predictionError = predictionError;
    sample.renderOffsetMagnitude = renderOffsetMag;
    sample.velocityX = this.deps.localVelocity.x;
    sample.velocityY = this.deps.localVelocity.y;
    sample.serverVelocityX = this.serverVelBuf.x;
    sample.serverVelocityY = this.serverVelBuf.y;
    sample.predictionBufferSize = this.deps.getPredictionBufferSize();
    sample.reconciliationCount = reconCount;
    sample.lastReconciliationError = lastReconError;
    sample.lastReconciliationSeq = lastReconSeq;
    sample.isMoving = this.deps.getIsMoving() ? 1 : 0;
    sample.animationState = this.deps.getAnimationState();
    sample.dt = dt;

    this.ring.write(sample);
    this.prevReconCount = reconCount;
  }

  recordInput(): void {
    this.inputCount++;
    this.pushTimestamp(this.inputTimestamps, performance.now());
  }

  snapshot(): TelemetryMetrics {
    const now = performance.now();
    const cutoff = now - this.windowMs;

    // Age-filter is a no-op in steady state (pushTimestamp already prunes
    // with the same cutoff) — kept as a cheap safety net; it reassigns the
    // arrays only when it actually drops entries.
    this.inputTimestamps = this.inputTimestamps.filter((t) => t >= cutoff);
    this.patchTimestamps = this.patchTimestamps.filter((t) => t >= cutoff);

    const ringSnap = this.ring.snapshot();

    const metrics: TelemetryMetrics = {
      predictionError: ringSnap.avgPredictionError,
      rttMs: Math.round(this.deps.rtt.value),
      reconciliationCount: ringSnap.latestReconciliationCount,
      maxCorrection: ringSnap.maxCorrection,
      renderOffsetMagnitude: ringSnap.avgRenderOffset,
      patchRate:
        this.patchTimestamps.length > 1
          ? Math.round((this.patchTimestamps.length / this.windowMs) * 1000)
          : 0,
      inputRate:
        this.inputTimestamps.length > 0
          ? Math.round((this.inputTimestamps.length / this.windowMs) * 1000)
          : 0,
      jankFrames: ringSnap.jankFrames,
      totalFrames: ringSnap.totalFrames,
      windowSeconds: Math.round((this.windowMs / 1000) * 10) / 10,
      timestamp: Date.now(),
    };

    return metrics;
  }

  ringSnapshot(): TelemetrySnapshot {
    return this.ring.snapshot();
  }

  reset(): void {
    this.ring.clear();
    this.inputCount = 0;
    this.patchCount = 0;
    this.lastServerX = 0;
    this.lastServerY = 0;
    this.prevReconCount = 0;
    this.inputTimestamps = [];
    this.patchTimestamps = [];
  }
}

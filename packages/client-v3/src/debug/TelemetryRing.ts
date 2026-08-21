export const TELEMETRY_STRIDE = 13;
export const TELEMETRY_CAPACITY = 600;
export const TELEMETRY_JANK_THRESHOLD_MS = 20;

export enum TelemetryOffset {
  PREDICTION_ERROR = 0,
  RENDER_OFFSET_MAG = 1,
  VELOCITY_X = 2,
  VELOCITY_Y = 3,
  SERVER_VELOCITY_X = 4,
  SERVER_VELOCITY_Y = 5,
  PREDICTION_BUFFER_SIZE = 6,
  RECONCILIATION_COUNT = 7,
  LAST_RECONCILIATION_ERROR = 8,
  LAST_RECONCILIATION_SEQ = 9,
  IS_MOVING = 10,
  ANIMATION_STATE = 11,
  DT = 12,
}

export interface TelemetrySample {
  predictionError: number;
  renderOffsetMagnitude: number;
  velocityX: number;
  velocityY: number;
  serverVelocityX: number;
  serverVelocityY: number;
  predictionBufferSize: number;
  reconciliationCount: number;
  lastReconciliationError: number;
  lastReconciliationSeq: number;
  isMoving: number;
  animationState: number;
  dt: number;
}

export interface TelemetrySnapshot {
  avgPredictionError: number;
  maxPredictionError: number;
  maxCorrection: number;
  avgRenderOffset: number;
  avgVelocityMagnitude: number;
  jankFrames: number;
  totalFrames: number;
  latestReconciliationCount: number;
  latestPredictionBufferSize: number;
}

export class TelemetryRing {
  private readonly buf: Float64Array;
  private head = 0;
  private count = 0;
  private totalWritten = 0;

  private f(index: number): number {
    return this.buf[index] ?? 0;
  }

  constructor(
    private readonly capacity: number = TELEMETRY_CAPACITY,
    private readonly stride: number = TELEMETRY_STRIDE,
  ) {
    this.buf = new Float64Array(capacity * stride);
  }

  write(sample: TelemetrySample): void {
    const base = this.head * this.stride;
    this.buf[base + TelemetryOffset.PREDICTION_ERROR] = sample.predictionError;
    this.buf[base + TelemetryOffset.RENDER_OFFSET_MAG] = sample.renderOffsetMagnitude;
    this.buf[base + TelemetryOffset.VELOCITY_X] = sample.velocityX;
    this.buf[base + TelemetryOffset.VELOCITY_Y] = sample.velocityY;
    this.buf[base + TelemetryOffset.SERVER_VELOCITY_X] = sample.serverVelocityX;
    this.buf[base + TelemetryOffset.SERVER_VELOCITY_Y] = sample.serverVelocityY;
    this.buf[base + TelemetryOffset.PREDICTION_BUFFER_SIZE] = sample.predictionBufferSize;
    this.buf[base + TelemetryOffset.RECONCILIATION_COUNT] = sample.reconciliationCount;
    this.buf[base + TelemetryOffset.LAST_RECONCILIATION_ERROR] = sample.lastReconciliationError;
    this.buf[base + TelemetryOffset.LAST_RECONCILIATION_SEQ] = sample.lastReconciliationSeq;
    this.buf[base + TelemetryOffset.IS_MOVING] = sample.isMoving;
    this.buf[base + TelemetryOffset.ANIMATION_STATE] = sample.animationState;
    this.buf[base + TelemetryOffset.DT] = sample.dt;

    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
    this.totalWritten++;
  }

  readRange(from: number, to: number): Float64Array {
    if (from > to || from < 0) {
      return new Float64Array(0);
    }
    const len = to - from;
    if (len > this.count) {
      return new Float64Array(0);
    }
    const out = new Float64Array(len * this.stride);
    for (let i = 0; i < len; i++) {
      const srcIdx =
        (((this.head - this.count + from + i) % this.capacity) + this.capacity) % this.capacity;
      const srcBase = srcIdx * this.stride;
      const dstBase = i * this.stride;
      for (let s = 0; s < this.stride; s++) {
        out[dstBase + s] = this.f(srcBase + s);
      }
    }
    return out;
  }

  snapshot(): TelemetrySnapshot {
    if (this.count === 0) {
      return {
        avgPredictionError: 0,
        maxPredictionError: 0,
        maxCorrection: 0,
        avgRenderOffset: 0,
        avgVelocityMagnitude: 0,
        jankFrames: 0,
        totalFrames: 0,
        latestReconciliationCount: 0,
        latestPredictionBufferSize: 0,
      };
    }

    let sumPredErr = 0;
    let maxPredErr = 0;
    let maxCorrection = 0;
    let sumRenderOff = 0;
    let sumVelMag = 0;
    let jankFrames = 0;

    const newestIdx = ((this.head - 1 + this.capacity) % this.capacity) * this.stride;
    const latestReconCount = this.f(newestIdx + TelemetryOffset.RECONCILIATION_COUNT);
    const latestBufSize = this.f(newestIdx + TelemetryOffset.PREDICTION_BUFFER_SIZE);

    const startIdx = (this.head - this.count + this.capacity) % this.capacity;

    for (let i = 0; i < this.count; i++) {
      const idx = ((startIdx + i) % this.capacity) * this.stride;
      const predErr = this.f(idx + TelemetryOffset.PREDICTION_ERROR);
      const correction = this.f(idx + TelemetryOffset.LAST_RECONCILIATION_ERROR);
      const renderOff = this.f(idx + TelemetryOffset.RENDER_OFFSET_MAG);
      const vx = this.f(idx + TelemetryOffset.VELOCITY_X);
      const vy = this.f(idx + TelemetryOffset.VELOCITY_Y);
      const dt = this.f(idx + TelemetryOffset.DT);

      sumPredErr += predErr;
      if (predErr > maxPredErr) maxPredErr = predErr;
      if (correction > maxCorrection) maxCorrection = correction;
      sumRenderOff += renderOff;
      sumVelMag += Math.sqrt(vx * vx + vy * vy);
      if (dt > TELEMETRY_JANK_THRESHOLD_MS) jankFrames++;
    }

    return {
      avgPredictionError: Math.round((sumPredErr / this.count) * 100) / 100,
      maxPredictionError: Math.round(maxPredErr * 100) / 100,
      maxCorrection: Math.round(maxCorrection * 100) / 100,
      avgRenderOffset: Math.round((sumRenderOff / this.count) * 100) / 100,
      avgVelocityMagnitude: Math.round((sumVelMag / this.count) * 100) / 100,
      jankFrames,
      totalFrames: this.count,
      latestReconciliationCount: latestReconCount,
      latestPredictionBufferSize: latestBufSize,
    };
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  get totalWrites(): number {
    return this.totalWritten;
  }

  getStride(): number {
    return this.stride;
  }

  getCapacity(): number {
    return this.capacity;
  }
}

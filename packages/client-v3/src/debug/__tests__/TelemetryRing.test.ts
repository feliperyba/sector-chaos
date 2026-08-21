import { describe, it, expect, beforeEach } from 'vitest';
import {
  TelemetryRing,
  TELEMETRY_STRIDE,
  TELEMETRY_CAPACITY,
  TelemetryOffset,
} from '../TelemetryRing.js';
import type { TelemetrySample } from '../TelemetryRing.js';

function makeSample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
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
    dt: 16.67,
    ...overrides,
  };
}

describe('TelemetryRing', () => {
  let ring: TelemetryRing;

  beforeEach(() => {
    ring = new TelemetryRing();
  });

  describe('construction', () => {
    it('has correct defaults', () => {
      expect(ring.getCapacity()).toBe(TELEMETRY_CAPACITY);
      expect(ring.getStride()).toBe(TELEMETRY_STRIDE);
      expect(ring.size).toBe(0);
      expect(ring.totalWrites).toBe(0);
    });

    it('accepts custom capacity and stride', () => {
      const r = new TelemetryRing(10, 3);
      expect(r.getCapacity()).toBe(10);
      expect(r.getStride()).toBe(3);
    });
  });

  describe('write', () => {
    it('increments size on write', () => {
      ring.write(makeSample());
      expect(ring.size).toBe(1);
      expect(ring.totalWrites).toBe(1);
    });

    it('writes all 13 fields at correct stride offsets', () => {
      const r = new TelemetryRing(600, TELEMETRY_STRIDE);
      expect(r.size).toBe(0);
      const sample = makeSample({
        predictionError: 5.5,
        renderOffsetMagnitude: 2.2,
        velocityX: 100,
        velocityY: -50,
        serverVelocityX: 90,
        serverVelocityY: -45,
        predictionBufferSize: 3,
        reconciliationCount: 7,
        lastReconciliationError: 1.5,
        lastReconciliationSeq: 42,
        isMoving: 1,
        animationState: 2,
        dt: 16.67,
      });
      r.write(sample);
      expect(r.size).toBe(1);
      const data = r.readRange(0, 1);
      expect(data.length).toBe(TELEMETRY_STRIDE);
      expect(data[TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(5.5);
      expect(data[TelemetryOffset.RENDER_OFFSET_MAG]).toBeCloseTo(2.2);
      expect(data[TelemetryOffset.VELOCITY_X]).toBeCloseTo(100);
      expect(data[TelemetryOffset.VELOCITY_Y]).toBeCloseTo(-50);
      expect(data[TelemetryOffset.SERVER_VELOCITY_X]).toBeCloseTo(90);
      expect(data[TelemetryOffset.SERVER_VELOCITY_Y]).toBeCloseTo(-45);
      expect(data[TelemetryOffset.PREDICTION_BUFFER_SIZE]).toBeCloseTo(3);
      expect(data[TelemetryOffset.RECONCILIATION_COUNT]).toBeCloseTo(7);
      expect(data[TelemetryOffset.LAST_RECONCILIATION_ERROR]).toBeCloseTo(1.5);
      expect(data[TelemetryOffset.LAST_RECONCILIATION_SEQ]).toBeCloseTo(42);
      expect(data[TelemetryOffset.IS_MOVING]).toBeCloseTo(1);
      expect(data[TelemetryOffset.ANIMATION_STATE]).toBeCloseTo(2);
      expect(data[TelemetryOffset.DT]).toBeCloseTo(16.67);
    });

    it('caps size at capacity', () => {
      const r = new TelemetryRing(5, TELEMETRY_STRIDE);
      for (let i = 0; i < 10; i++) {
        r.write(makeSample({ predictionError: i }));
      }
      expect(r.size).toBe(5);
      expect(r.totalWrites).toBe(10);
    });
  });

  describe('readRange', () => {
    it('returns empty for invalid range', () => {
      ring.write(makeSample());
      const result = ring.readRange(1, 0);
      expect(result.length).toBe(0);
    });

    it('returns empty for negative from', () => {
      ring.write(makeSample());
      const result = ring.readRange(-1, 1);
      expect(result.length).toBe(0);
    });

    it('returns empty when requesting more entries than stored', () => {
      ring.write(makeSample());
      ring.write(makeSample());
      const result = ring.readRange(0, 3);
      expect(result.length).toBe(0);
    });

    it('returns empty when ring is empty', () => {
      const result = ring.readRange(0, 1);
      expect(result.length).toBe(0);
    });

    it('returns correct range of entries', () => {
      const r = new TelemetryRing(5, TELEMETRY_STRIDE);
      for (let i = 0; i < 5; i++) {
        r.write(makeSample({ predictionError: i * 10 }));
      }
      const result = r.readRange(1, 4);
      expect(result.length).toBe(3 * TELEMETRY_STRIDE);
      expect(result[TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(10);
      expect(result[TELEMETRY_STRIDE + TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(20);
      expect(result[2 * TELEMETRY_STRIDE + TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(30);
    });

    it('handles wrap-around correctly', () => {
      const r = new TelemetryRing(4, TELEMETRY_STRIDE);
      for (let i = 0; i < 6; i++) {
        r.write(makeSample({ predictionError: i * 10 }));
      }
      expect(r.size).toBe(4);
      const result = r.readRange(0, 4);
      expect(result.length).toBe(4 * TELEMETRY_STRIDE);
      expect(result[TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(20);
      expect(result[3 * TELEMETRY_STRIDE + TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(50);
    });
  });

  describe('snapshot', () => {
    it('returns zeros when empty', () => {
      const snap = ring.snapshot();
      expect(snap.avgPredictionError).toBe(0);
      expect(snap.maxPredictionError).toBe(0);
      expect(snap.maxCorrection).toBe(0);
      expect(snap.avgRenderOffset).toBe(0);
      expect(snap.avgVelocityMagnitude).toBe(0);
      expect(snap.jankFrames).toBe(0);
      expect(snap.totalFrames).toBe(0);
      expect(snap.latestReconciliationCount).toBe(0);
      expect(snap.latestPredictionBufferSize).toBe(0);
    });

    it('computes avg prediction error', () => {
      ring.write(makeSample({ predictionError: 10 }));
      ring.write(makeSample({ predictionError: 20 }));
      ring.write(makeSample({ predictionError: 30 }));
      const snap = ring.snapshot();
      expect(snap.avgPredictionError).toBe(20);
    });

    it('computes max prediction error', () => {
      ring.write(makeSample({ predictionError: 5 }));
      ring.write(makeSample({ predictionError: 25 }));
      ring.write(makeSample({ predictionError: 10 }));
      const snap = ring.snapshot();
      expect(snap.maxPredictionError).toBe(25);
    });

    it('computes max correction from lastReconciliationError', () => {
      ring.write(makeSample({ lastReconciliationError: 3 }));
      ring.write(makeSample({ lastReconciliationError: 8 }));
      ring.write(makeSample({ lastReconciliationError: 1 }));
      const snap = ring.snapshot();
      expect(snap.maxCorrection).toBe(8);
    });

    it('computes avg render offset', () => {
      ring.write(makeSample({ renderOffsetMagnitude: 4 }));
      ring.write(makeSample({ renderOffsetMagnitude: 6 }));
      const snap = ring.snapshot();
      expect(snap.avgRenderOffset).toBe(5);
    });

    it('computes avg velocity magnitude', () => {
      ring.write(makeSample({ velocityX: 3, velocityY: 4 }));
      ring.write(makeSample({ velocityX: 0, velocityY: 0 }));
      const snap = ring.snapshot();
      expect(snap.avgVelocityMagnitude).toBe(2.5);
    });

    it('counts jank frames (dt > 20ms)', () => {
      ring.write(makeSample({ dt: 16 }));
      ring.write(makeSample({ dt: 25 }));
      ring.write(makeSample({ dt: 16 }));
      ring.write(makeSample({ dt: 33 }));
      ring.write(makeSample({ dt: 16 }));
      const snap = ring.snapshot();
      expect(snap.jankFrames).toBe(2);
    });

    it('returns totalFrames equal to ring size', () => {
      for (let i = 0; i < 7; i++) ring.write(makeSample());
      expect(ring.snapshot().totalFrames).toBe(7);
    });

    it('reads latest reconciliation count from newest entry', () => {
      ring.write(makeSample({ reconciliationCount: 5 }));
      ring.write(makeSample({ reconciliationCount: 12 }));
      const snap = ring.snapshot();
      expect(snap.latestReconciliationCount).toBe(12);
    });

    it('reads latest prediction buffer size from newest entry', () => {
      ring.write(makeSample({ predictionBufferSize: 2 }));
      ring.write(makeSample({ predictionBufferSize: 7 }));
      const snap = ring.snapshot();
      expect(snap.latestPredictionBufferSize).toBe(7);
    });

    it('rounds avg values to 2 decimal places', () => {
      ring.write(makeSample({ predictionError: 1.111 }));
      ring.write(makeSample({ predictionError: 2.222 }));
      ring.write(makeSample({ predictionError: 3.333 }));
      const snap = ring.snapshot();
      expect(snap.avgPredictionError).toBe(2.22);
    });

    it('snapshot over wrap-around still aggregates correctly', () => {
      const r = new TelemetryRing(3, TELEMETRY_STRIDE);
      r.write(makeSample({ predictionError: 100 }));
      r.write(makeSample({ predictionError: 200 }));
      r.write(makeSample({ predictionError: 300 }));
      r.write(makeSample({ predictionError: 400 }));
      const snap = r.snapshot();
      expect(snap.totalFrames).toBe(3);
      expect(snap.avgPredictionError).toBeCloseTo(300, 1);
      expect(snap.maxPredictionError).toBe(400);
    });
  });

  describe('clear', () => {
    it('resets size and count', () => {
      ring.write(makeSample());
      ring.write(makeSample());
      ring.clear();
      expect(ring.size).toBe(0);
      expect(ring.readRange(0, 1).length).toBe(0);
    });

    it('does not reset totalWrites', () => {
      ring.write(makeSample());
      ring.write(makeSample());
      ring.clear();
      expect(ring.totalWrites).toBe(2);
    });
  });

  describe('stride arithmetic', () => {
    it('total memory = capacity * stride * 8 bytes', () => {
      const _r = new TelemetryRing(TELEMETRY_CAPACITY, TELEMETRY_STRIDE);
      expect(TELEMETRY_CAPACITY * TELEMETRY_STRIDE * 8).toBeLessThan(65_536);
    });

    it('each write advances head by 1 modulo capacity', () => {
      const r = new TelemetryRing(3, TELEMETRY_STRIDE);
      r.write(makeSample({ predictionError: 1 }));
      r.write(makeSample({ predictionError: 2 }));
      r.write(makeSample({ predictionError: 3 }));
      r.write(makeSample({ predictionError: 4 }));
      const data = r.readRange(0, 3);
      expect(data[TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(2);
      expect(data[TELEMETRY_STRIDE + TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(3);
      expect(data[2 * TELEMETRY_STRIDE + TelemetryOffset.PREDICTION_ERROR]).toBeCloseTo(4);
    });
  });
});

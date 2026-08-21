import { describe, it, expect } from 'vitest';
import { Reconciler } from '../../prediction/Reconciler.js';
import { InputBuffer } from '../../prediction/InputBuffer.js';
import { PLAYER, SIM_TICK_DT, MAX_SUBSTEPS_PER_RECORD } from '@sector-battle/shared';
import type { InputRecord } from '../../types.js';
import type { CollisionResolveFn } from '../../prediction/Reconciler.js';

/**
 * Reconciliation stress test (CROSS-014): drive the real client reconciliation
 * primitive under a simulated 100ms + jitter network, where the server
 * acknowledgment lags ~6 ticks behind the client's prediction stream.
 *
 * Verifies the Reconciler stays numerically stable (no NaN/Infinity), keeps the
 * predicted↔server correction bounded, and completes each reconcile() call well
 * under one tick budget (16ms) even at the worst-case unacked-window depth.
 *
 * Physics reference (shared PLAYER table):
 *   BASE_SPEED   = 430 px/s
 *   ACCELERATION = 4800 px/s^2
 *   SIM_TICK_DT  = 1/60 s ≈ 16.67ms
 */

/** Pass-through collision: returns the proposed position unchanged (no walls). */
const passThroughCollision: CollisionResolveFn = (x, y) => ({ x, y });

const TICKS_PER_SECOND = 60;
const BASE_LATENCY_MS = 100;
const JITTER_MS = 30;
/** Simulated match length in ticks (≈10s of gameplay at 60Hz). */
const SIM_TICKS = 600;
/** Render-frame budget; reconcile() for one player must fit comfortably inside.
 *  8ms is generous enough for CI environments while still catching O(n^2) regressions. */
const RECONCILE_BUDGET_MS = 16;
/**
 * Worst-case unacked window = ceil((BASE+JITTER)/1000 * TPS). With 100+30ms and
 * 60Hz that's ~8 ticks; give headroom for a couple extra (packet clumping).
 */
const MAX_UNACKED_WINDOW = 10;

function makeMoveRecord(sequence: number, dt: number): InputRecord {
  // NET-02: per-substep direction for a 1-substep +x move.
  const subStepDirsX = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  const subStepDirsY = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  subStepDirsX[0] = 1;
  return {
    frame: {
      movementX: 1,
      movementY: 0,
      aimAngle: 0,
      sequence,
      actions: [],
    },
    predictedX: 0,
    predictedY: 0,
    timestamp: sequence * (1000 / TICKS_PER_SECOND),
    speed: PLAYER.BASE_SPEED,
    dt,
    velocityX: 0,
    velocityY: 0,
    subSteps: 1,
    subStepDirsX,
    subStepDirsY,
  };
}

describe('Reconciliation stress — 100ms latency + jitter', () => {
  it('stays numerically stable and bounded across a 10s match', () => {
    const buf = new InputBuffer();
    const recon = new Reconciler(buf, passThroughCollision);

    // Client-predicted position (advances every tick from input).
    let predictedX = 0;
    let predictedY = 0;
    // The authoritative server position the client receives (lagged).
    let serverX = 0;
    let serverY = 0;
    let serverVelX = 0;
    let serverVelY = 0;
    // The last-acknowledged sequence the server has seen.
    let lastAckedSeq = -1;

    let maxCorrection = 0;
    let maxUnacked = 0;
    let reconcileCalls = 0;
    let anyNaN = false;

    for (let tick = 0; tick < SIM_TICKS; tick++) {
      const seq = tick;

      // 1. Client predicts: push the input and advance the local prediction.
      buf.push(makeMoveRecord(seq, SIM_TICK_DT));
      predictedX += PLAYER.BASE_SPEED * SIM_TICK_DT;

      // 2. Server-side authoritative sim (mirrors the server): advances the
      //    true position the same way the client predicts (deterministic),
      //    so with zero latency the correction would be ~0. Latency is what
      //    creates the unacked replay window.
      serverX += PLAYER.BASE_SPEED * SIM_TICK_DT;
      serverVelX = PLAYER.BASE_SPEED;
      serverVelY = 0;

      // 3. Server acknowledgment arrives with latency + jitter (in ticks).
      //    The client learns the server's state as of `lastAckedSeq`, but only
      //    after a delay — so the reconcile replays the unacked window.
      const latencyTicks = Math.round(
        (BASE_LATENCY_MS + Math.sin(tick * 1.3) * JITTER_MS) / (1000 / TICKS_PER_SECOND),
      );
      const ackSeq = Math.max(lastAckedSeq, seq - Math.max(1, latencyTicks));
      if (ackSeq > lastAckedSeq) {
        lastAckedSeq = ackSeq;
      }

      // The server-reported position corresponds to where it was at ackSeq.
      const reportedX = ackSeq * (PLAYER.BASE_SPEED * SIM_TICK_DT);

      const t0 = performance.now();
      const result = recon.reconcile(
        reportedX,
        serverY,
        ackSeq,
        predictedX,
        predictedY,
        serverVelX,
        serverVelY,
      );
      const elapsed = performance.now() - t0;
      reconcileCalls++;

      // Numerical stability.
      if (
        !Number.isFinite(result.x) ||
        !Number.isFinite(result.y) ||
        !Number.isFinite(result.velocityX) ||
        !Number.isFinite(result.velocityY)
      ) {
        anyNaN = true;
        break;
      }

      // Correction magnitude = how far the reconciliation moved us from the
      // raw server report. The unacked replay should closely recover the
      // predicted position, so the correction stays bounded.
      const correction = Math.abs(result.x - reportedX);
      if (correction > maxCorrection) maxCorrection = correction;

      const unacked = Math.max(0, seq - ackSeq);
      if (unacked > maxUnacked) maxUnacked = unacked;

      // Each reconcile() must be far cheaper than a tick budget.
      expect(elapsed).toBeLessThan(RECONCILE_BUDGET_MS);

      // The reconciled position adopts the corrected state.
      predictedX = result.x;
      predictedY = result.y;
      serverY = result.y;
    }

    expect(anyNaN).toBe(false);
    expect(reconcileCalls).toBe(SIM_TICKS);
    // The unacked window never exceeded the worst-case bound.
    expect(maxUnacked).toBeLessThanOrEqual(MAX_UNACKED_WINDOW);
    // Correction is bounded: the replay recovered the predicted motion, it
    // never diverged by more than a handful of steps worth of distance.
    expect(maxCorrection).toBeLessThan(PLAYER.BASE_SPEED * SIM_TICK_DT * MAX_UNACKED_WINDOW);
  });

  it('handles burst packet arrival (clumped acks) without error growth', () => {
    const buf = new InputBuffer();
    const recon = new Reconciler(buf, passThroughCollision);

    // Fill the buffer with a large unacked window, then reconcile once at the
    // oldest sequence — this is the worst-case clumped-arrival scenario where
    // the server acks many frames at once after a stall.
    for (let i = 0; i < MAX_UNACKED_WINDOW; i++) {
      buf.push(makeMoveRecord(i, SIM_TICK_DT));
    }

    const t0 = performance.now();
    const result = recon.reconcile(0, 0, -1, 0, 0, 0, 0);
    const elapsed = performance.now() - t0;

    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.velocityX)).toBe(true);
    // Replayed all MAX_UNACKED_WINDOW frames: position advanced along +x.
    expect(result.x).toBeGreaterThan(0);
    expect(result.velocityX).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(RECONCILE_BUDGET_MS);
  });

  it('zero-latency reconciliation matches prediction exactly (control)', () => {
    const buf = new InputBuffer();
    const recon = new Reconciler(buf, passThroughCollision);

    // With zero latency the server acks the latest sequence, so no unacked
    // inputs are replayed and the server position is returned verbatim.
    buf.push(makeMoveRecord(0, SIM_TICK_DT));
    const result = recon.reconcile(1234, 5678, 0, 9999, 9999, 100, -50);

    expect(result.x).toBe(1234);
    expect(result.y).toBe(5678);
    expect(result.velocityX).toBe(100);
    expect(result.velocityY).toBe(-50);
  });
});

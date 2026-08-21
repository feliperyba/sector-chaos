import { describe, it, expect } from 'vitest';
import { PLAYER, SIM_TICK_DT } from '@sector-battle/shared';
import type { CollisionFn } from '@sector-battle/shared';
import { GameState } from '../../controllers/GameState.js';
import { PredictionService } from '../PredictionService.js';
import { InputBuffer } from '../InputBuffer.js';
import { Reconciler } from '../Reconciler.js';
import type { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { InputFrame } from '../../types.js';

/**
 * NET-03 REGRESSION TEST — substeps run on EVERY render frame are recorded
 * for reconciliation, even when no InputFrame is sent that frame.
 *
 * Legacy context (NET-02 era): PredictionService.step(null) was the no-frame
 * coasting branch that fired at render rates higher than the input send rate.
 * It ran physics substeps WITHOUT pushing an InputRecord, and the fix was to
 * accumulate coasted substeps in `pendingCoastSubsteps` and merge them into
 * the next pushed record's `subSteps`. The reconciler's rewind-and-replay
 * only saw pushed records, so it would otherwise undercount substeps → under
 * latency, replay position drifted behind prediction → snap-back ("stutter").
 *
 * NET-03 removed the `step(null)` coasting branch entirely. Every render
 * frame now integrates with a LIVE direction the caller supplies. Substeps
 * still accumulate across throttle frames (no send) via the per-substep
 * accumulator (`pendingSubStepDirsX/Y`), and flush into the next pushed
 * record. This test pins the post-NET-03 invariant: at 144fps with held
 * input, pushed records still account for ALL prediction substeps (the
 * replay reconstructs the prediction exactly) — now expressed through the
 * new step signature.
 *
 * The harness models the production cadence: input is sent at
 * INPUT_SEND_INTERVAL_MS=16ms; the prediction runs every render frame with
 * the live direction (held +X throughout). Throttle frames (no send) still
 * advance localPos and contribute substeps to the next record.
 */
function makeStubCollisionService(): ClientCollisionService {
  return {
    resolveCollision: (x: number, y: number) => ({ x, y }),
    // Ticket 21: PredictionService's hot path uses the pooled seam; the
    // stub mirrors the real contract (writes the out box, returns it).
    resolveCollisionInto: (
      x: number,
      y: number,
      _hw: number,
      _hh: number,
      out: { x: number; y: number },
    ) => {
      out.x = x;
      out.y = y;
      return out;
    },
  } as unknown as ClientCollisionService;
}

describe('REGRESSION (NET-03): substeps from throttle frames recorded for reconciliation', () => {
  /**
   * Direct test: at 144fps with held +x input, the total subSteps across all
   * pushed records must equal the total substeps the prediction actually ran.
   * NET-03 ensures this via the per-substep accumulator — every render frame
   * appends its substeps, and the next send-boundary record flushes them.
   */
  it('at 144fps, pushed records account for ALL prediction substeps (no loss on throttle frames)', () => {
    const gameState = new GameState();
    gameState.localPos = { x: 0, y: 0 };
    gameState.localVelocity = { x: 0, y: 0 };

    const passthrough: CollisionFn = (x: number, y: number) => ({ x, y });
    const collisionService = {
      resolveCollision: (x: number, y: number) => ({ x, y }),
      // Ticket 21: pooled seam twin (writes the out box, returns it).
      resolveCollisionInto: (
        x: number,
        y: number,
        _hw: number,
        _hh: number,
        out: { x: number; y: number },
      ) => {
        out.x = x;
        out.y = y;
        return out;
      },
    } as unknown as ClientCollisionService;
    const inputBuffer = new InputBuffer();
    const reconciler = new Reconciler(inputBuffer, passthrough);
    const predictionService = new PredictionService(collisionService, inputBuffer, gameState);

    const renderDt = 1 / 144; // 144fps
    const inputSendIntervalMs = 16;
    const durationSec = 1.0;

    let nowMs = 0;
    let lastSendMs = -inputSendIntervalMs;
    let seq = 0;

    // Track the TOTAL subSteps across all pushed records.
    let totalRecordedSubsteps = 0;

    // Wrap push to intercept records
    const originalPush = inputBuffer.push.bind(inputBuffer);
    inputBuffer.push = (rec) => {
      totalRecordedSubsteps += rec.subSteps;
      originalPush(rec);
    };

    for (let elapsed = 0; elapsed < durationSec; elapsed += renderDt) {
      nowMs += renderDt * 1000;

      // NET-03 seam: live direction (held +X) every render frame; send frame
      // only at the 16ms boundary.
      let sendFrame: InputFrame | null = null;
      if (nowMs - lastSendMs >= inputSendIntervalMs) {
        lastSendMs = nowMs;
        seq++;
        sendFrame = { movementX: 1, movementY: 0, aimAngle: 0, sequence: seq, actions: [] };
      }

      predictionService.step(1, 0, renderDt, PLAYER.BASE_SPEED, false, [], sendFrame);
    }

    // The prediction runs SIM_TICK_DT substeps. Over durationSec at 144fps,
    // the accumulator fires exactly durationSec / SIM_TICK_DT = 60 substeps.
    const expectedSubsteps = Math.round(durationSec / SIM_TICK_DT);

    console.log(
      `[DEBUG-regression] expected=${expectedSubsteps} recorded=${totalRecordedSubsteps} ` +
        `finalPos=${gameState.localPos.x.toFixed(1)} finalVel=${gameState.localVelocity.x.toFixed(1)}`,
    );

    // The recorded substeps must account for ALL prediction substeps. A small
    // tolerance (±2) accounts for accumulator residual at the edges.
    expect(totalRecordedSubsteps).toBeGreaterThanOrEqual(expectedSubsteps - 2);
  });

  /**
   * The end-to-end test: at 144fps with held input, the reconciler's replay
   * must produce a position matching the prediction. We run the prediction,
   * capture the state at an early seq (simulating the server's acked
   * position), then continue predicting. The reconciler replays from that
   * early state through unacked records and must reproduce the current
   * prediction position.
   */
  it('at 144fps with held input, reconciler replay matches prediction (no divergence)', () => {
    const gameState = new GameState();
    gameState.localPos = { x: 0, y: 0 };
    gameState.localVelocity = { x: 0, y: 0 };

    const passthrough: CollisionFn = (x: number, y: number) => ({ x, y });
    const collisionService = {
      resolveCollision: (x: number, y: number) => ({ x, y }),
      // Ticket 21: pooled seam twin (writes the out box, returns it).
      resolveCollisionInto: (
        x: number,
        y: number,
        _hw: number,
        _hh: number,
        out: { x: number; y: number },
      ) => {
        out.x = x;
        out.y = y;
        return out;
      },
    } as unknown as ClientCollisionService;
    const inputBuffer = new InputBuffer();
    const reconciler = new Reconciler(inputBuffer, passthrough);
    const predictionService = new PredictionService(collisionService, inputBuffer, gameState);

    const renderDt = 1 / 144;
    const inputSendIntervalMs = 16;
    let nowMs = 0;
    let lastSendMs = -inputSendIntervalMs;
    let seq = 0;

    // Phase 1: run for a short time to establish an early "server-acked" state.
    // We'll capture the position at seq=3 (after 3 inputs sent).
    const checkpointSeq = 3;
    let checkpointX = 0;
    let checkpointY = 0;
    let checkpointVx = 0;
    let checkpointVy = 0;
    let phase1Done = false;

    for (let elapsed = 0; elapsed < 0.5; elapsed += renderDt) {
      nowMs += renderDt * 1000;
      let sendFrame: InputFrame | null = null;
      if (nowMs - lastSendMs >= inputSendIntervalMs) {
        lastSendMs = nowMs;
        seq++;
        sendFrame = { movementX: 1, movementY: 0, aimAngle: 0, sequence: seq, actions: [] };
      }
      predictionService.step(1, 0, renderDt, PLAYER.BASE_SPEED, false, [], sendFrame);

      // Capture the state right AFTER seq=checkpointSeq was pushed — this is
      // the "server position at tick where it processed seq=checkpointSeq".
      if (!phase1Done && seq === checkpointSeq && sendFrame) {
        checkpointX = gameState.localPos.x;
        checkpointY = gameState.localPos.y;
        checkpointVx = gameState.localVelocity.x;
        checkpointVy = gameState.localVelocity.y;
        phase1Done = true;
      }
    }

    expect(phase1Done).toBe(true);

    // Phase 2: replay from the checkpoint. The reconciler seeds from
    // (checkpointX, checkpointY) at seq=checkpointSeq and replays all
    // records with sequence > checkpointSeq. The result must match the
    // current prediction.
    const replayResult = reconciler.reconcile(
      checkpointX,
      checkpointY,
      checkpointSeq,
      gameState.localPos.x,
      gameState.localPos.y,
      checkpointVx,
      checkpointVy,
    );

    const replayError = Math.hypot(
      replayResult.x - gameState.localPos.x,
      replayResult.y - gameState.localPos.y,
    );

    console.log(
      `[DEBUG-regression] replay: result=${replayResult.x.toFixed(2)} predicted=${gameState.localPos.x.toFixed(2)} ` +
        `error=${replayError.toFixed(3)}px seq=${seq}`,
    );

    // NET-03 (building on NET-02's per-substep capture): the per-record
    // replay reconstructs the prediction exactly even with throttle frames
    // between sends, because each record carries the per-substep directions
    // for every substep run since the last push.
    expect(replayError).toBeLessThan(1.0); // < 1px — effectively exact
  });
});

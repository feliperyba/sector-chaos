import { describe, it, expect } from 'vitest';
import { SIM_TICK_DT } from '@sector-battle/shared';
import { PlayerReconciler } from '../../bridges/state-sync/PlayerReconciler.js';
import type { PlayerReconcilerDeps } from '../../bridges/state-sync/PlayerReconciler.js';
import { GameState } from '../GameState.js';
import { InputBuffer } from '../../prediction/InputBuffer.js';
import type { Reconciler } from '../../prediction/Reconciler.js';
import type { ReconciliationLog } from '../../debug/ReconciliationLog.js';
import type { StateSync } from '../../network/StateSync.js';

/**
 * Characterization tests for the reconciliation write block formerly
 * at PlayerReconciler.ts:60-80 (now encapsulated in
 * GameState.applyReconciledPosition). Pins the threshold-gated snap
 * + correctionOffset decision (ADR-0005/0010/0033) so a mis-move
 * cannot silently regress the offset/snap logic or re-introduce the
 * "flash raw server position" bug. The test exercises
 * PlayerReconciler end-to-end with a real GameState instance; after
 * the Option-α threading (Step 3), only the stub-setup helper
 * changed — assertions stay identical.
 *
 * Threshold values (do NOT change — gameplay perception tuning):
 *   RECONCILIATION_THRESHOLD       = 1.0
 *   VELOCITY_SNAP_THRESHOLD        = 0.5
 *   RENDER_OFFSET_SNAP_THRESHOLD   = 16 (ADR-0014 adaptive snap — revised,
 *                                see ADR-0014 §"Revised tuning")
 */

interface StubRefs {
  gameState: GameState;
  localPos: { x: number; y: number };
  localVelocity: { x: number; y: number };
  correctionOffset: { x: number; y: number };
  rtt: { value: number };
}

/**
 * Build PlayerReconcilerDeps with a stubbed Reconciler (echoes server
 * position + velocity back as the reconciled result), stubbed
 * stateSync/reconciliationLog/isSpectating, and a real GameState.
 * `refs.localPos` / `localVelocity` / `correctionOffset` are
 * GameState's own fields (live references); the caller seeds them
 * via `refs` BEFORE invoking the handler.
 */
function makeReconciler(refs: StubRefs): PlayerReconciler {
  const reconciler = {
    reconcile: (
      serverX: number,
      serverY: number,
      _seq: number,
      _localX: number,
      _localY: number,
      serverVelocityX: number,
      serverVelocityY: number,
    ) => ({
      x: serverX,
      y: serverY,
      velocityX: serverVelocityX,
      velocityY: serverVelocityY,
    }),
  } as unknown as Reconciler;

  const deps: PlayerReconcilerDeps = {
    gameState: refs.gameState,
    rtt: refs.rtt,
    inputBuffer: new InputBuffer(),
    reconciler,
    stateSync: { value: null as StateSync | null },
    reconciliationLog: { value: undefined as ReconciliationLog | undefined },
    isSpectating: { value: false },
  };
  return new PlayerReconciler(deps);
}

function makeRefs(): StubRefs {
  const gameState = new GameState();
  gameState.localPos = { x: 100, y: 100 };
  gameState.localVelocity = { x: 0, y: 0 };
  gameState.correctionOffset = { x: 0, y: 0 };
  return {
    gameState,
    localPos: gameState.localPos,
    localVelocity: gameState.localVelocity,
    correctionOffset: gameState.correctionOffset,
    rtt: { value: 0 },
  };
}

describe('PlayerReconciler — reconciliation write block (characterization)', () => {
  it('Case A (IGNORE): posError below snap threshold → NO WRITE, prediction authoritative', () => {
    // The client's predicted position is AUTHORITATIVE for feel. During normal
    // play the server's acked position is 1-2 ticks stale (7-14px), below the
    // 16px threshold. No correction fires — prediction runs uninterrupted.
    const refs = makeRefs();
    refs.localVelocity.x = 430;
    const reconciler = makeReconciler(refs);
    // posError = 10 < 16 (snap threshold at rtt=0) → IGNORED.
    reconciler.handleLocalPlayerPositionChange(110, 100, 120, 0, 42, 33);

    expect(refs.localPos).toEqual({ x: 100, y: 100 }); // unchanged
    expect(refs.localVelocity).toEqual({ x: 430, y: 0 }); // preserved
    expect(refs.correctionOffset).toEqual({ x: 0, y: 0 }); // no offset created
  });

  it('Case A boundary: at rtt=0, posError just below 16px → IGNORED', () => {
    const refs = makeRefs();
    const reconciler = makeReconciler(refs);
    reconciler.handleLocalPlayerPositionChange(115.9, 100, 0, 0, 42, 0);
    expect(refs.localPos).toEqual({ x: 100, y: 100 });
    expect(refs.correctionOffset).toEqual({ x: 0, y: 0 });
  });

  it('Case B (SMOOTH SNAP): posError ≥ snap threshold → snap localPos, adopt reconciled velocity, absorb delta into offset for visual glide', () => {
    // Genuine desync (≥16px — rare). Snap localPos to resync the sim, adopt
    // the reconciled velocity into localVelocity (NET-04 — the velocity is no
    // longer silently dropped), and absorb the delta into correctionOffset so
    // the VISUAL glides smoothly instead of teleporting. The offset decays at
    // ERROR_DECAY_RATE=30 (~100ms). Because this fires rarely, the offset can
    // never accumulate into drag.
    const refs = makeRefs();
    refs.localVelocity.x = 430;
    const reconciler = makeReconciler(refs);
    // posError = 20 ≥ 16 → smooth snap. Reconciled velocity = (200, 50) — the
    // server's authoritative velocity at the snapped position (echoed by the
    // stub prediction.reconcile). This MUST replace the stale (430, 0).
    reconciler.handleLocalPlayerPositionChange(120, 100, 200, 50, 42, 33);

    expect(refs.localPos).toEqual({ x: 120, y: 100 }); // snapped
    expect(refs.localVelocity).toEqual({ x: 200, y: 50 }); // reconciled velocity adopted (NET-04)
    expect(refs.correctionOffset).toEqual({ x: -20, y: 0 }); // delta absorbed for glide
  });

  it('Case B boundary: at rtt=0, posError exactly == 16px → smooth snap (>=), reconciled velocity adopted', () => {
    const refs = makeRefs();
    const reconciler = makeReconciler(refs);
    reconciler.handleLocalPlayerPositionChange(116, 100, 150, 80, 42, 0);
    expect(refs.localPos).toEqual({ x: 116, y: 100 });
    expect(refs.localVelocity).toEqual({ x: 150, y: 80 }); // reconciled velocity adopted (NET-04)
    expect(refs.correctionOffset).toEqual({ x: -16, y: 0 });
  });

  it('H3: RTT-aware threshold — 20px error IGNORED at rtt=200ms, smooth-snaps (velocity adopted) at rtt=0', () => {
    // rtt = 0ms → threshold 16px → 20px error ≥ 16 → smooth snap + velocity adoption.
    const refs0 = makeRefs();
    const reconciler0 = makeReconciler(refs0);
    reconciler0.handleLocalPlayerPositionChange(120, 100, 210, 60, 42, 0);
    expect(refs0.localPos).toEqual({ x: 120, y: 100 });
    expect(refs0.localVelocity).toEqual({ x: 210, y: 60 }); // reconciled velocity adopted (NET-04)
    expect(refs0.correctionOffset).toEqual({ x: -20, y: 0 }); // glide

    // rtt = 200ms → threshold 32px → same 20px error < 32 → IGNORED. The
    // below-threshold "prediction authoritative, NO write" path is unchanged
    // (ADR-0005/0010) — localPos, localVelocity, and correctionOffset all
    // untouched.
    const refs200 = makeRefs();
    refs200.localVelocity.x = 430;
    const reconciler200 = makeReconciler(refs200);
    reconciler200.handleLocalPlayerPositionChange(120, 100, 210, 60, 42, 200);
    expect(refs200.localPos).toEqual({ x: 100, y: 100 }); // unchanged
    expect(refs200.localVelocity).toEqual({ x: 430, y: 0 }); // unchanged (prediction authoritative)
    expect(refs200.correctionOffset).toEqual({ x: 0, y: 0 }); // no offset
  });

  it('H3: very high RTT (600ms+) still smooth-snaps genuine large desync (>64px) + adopts reconciled velocity', () => {
    const refs = makeRefs();
    const reconciler = makeReconciler(refs);
    reconciler.handleLocalPlayerPositionChange(200, 100, 320, -40, 42, 600);
    expect(refs.localPos).toEqual({ x: 200, y: 100 });
    expect(refs.localVelocity).toEqual({ x: 320, y: -40 }); // reconciled velocity adopted (NET-04)
    expect(refs.correctionOffset).toEqual({ x: -100, y: 0 }); // glide (decays fast)
  });

  it('does not correct while spectating (rtt still recorded)', () => {
    const refs = makeRefs();
    const reconciler = {
      reconcile: () => ({ x: 999, y: 999, velocityX: 0, velocityY: 0 }),
    } as unknown as Reconciler;
    const deps: PlayerReconcilerDeps = {
      gameState: refs.gameState,
      rtt: refs.rtt,
      inputBuffer: new InputBuffer(),
      reconciler,
      stateSync: { value: null },
      reconciliationLog: { value: undefined },
      isSpectating: { value: true },
    };
    const reconcilerUnderTest = new PlayerReconciler(deps);

    reconcilerUnderTest.handleLocalPlayerPositionChange(500, 500, 5, 5, 42, 99);

    expect(refs.localPos).toEqual({ x: 100, y: 100 });
    expect(refs.localVelocity).toEqual({ x: 0, y: 0 });
    expect(refs.correctionOffset).toEqual({ x: 0, y: 0 });
    expect(refs.rtt.value).toBe(99);
  });
});

/**
 * NET-04 regression — the reconciled velocity is no longer silently dropped
 * on the ≥ snap-threshold correction path. Today's defect: a correction snaps
 * localPos but leaves localVelocity at the prediction's value → the
 * post-correction pos/vel pair is inconsistent and the visual glides forward
 * on a stale velocity (the "ghost after correction" amplifier from NET-01
 * Cause 3).
 *
 * Per the NET-04 spec Method, this block ALSO captures and reports (via
 * console.log, for the live-gate's reading) the measured per-correction
 * behavior: the reconciled velocity vs the pre-correction localVelocity
 * delta (the magnitude that used to be silently dropped), and the
 * post-correction visual-position extrapolation consistency check
 * (predictionAccumulator forward-extrapolation using the NEW localVelocity).
 * The measurement is informational — it informs whether a velocity-aware
 * smoothing follow-up is warranted. The assertion gates only that the
 * velocity is no longer dropped (direct-set).
 */
describe('NET-04 — applyReconciledPosition adopts reconciled velocity on the snap path (direct-set)', () => {
  /**
   * Mirror of PredictionService.getVisualPosition's extrapolation formula:
 the visual position the renderer snaps to is
   *   localPos + localVelocity * predictionAccumulator + correctionOffset.
   * `predictionAccumulator` is the residual sub-tick time (bounded by
   * SIM_TICK_DT); we evaluate at the upper bound (a full SIM_TICK_DT of
   * residual) as the worst-case forward extrapolation, which is the
   * direction the visual will drift immediately after the correction.
   */
  function extrapolateVisual(
    pos: { x: number; y: number },
    vel: { x: number; y: number },
    offset: { x: number; y: number },
    accumulator: number,
  ): { x: number; y: number } {
    return {
      x: pos.x + vel.x * accumulator + offset.x,
      y: pos.y + vel.y * accumulator + offset.y,
    };
  }

  it('a forced ≥ threshold correction adopts the reconciled velocity (pre-fix: it did not)', () => {
    // SCENARIO: the prediction was gliding right at full speed (430, 0) when a
    // genuine ≥16px desync fires (respawn / collision mismatch / real drift).
    // The server's authoritative velocity at the reconciled position is much
    // smaller (100, 50) — e.g. the player was stopped/slowed server-side by a
    // collision the prediction didn't see. Before NET-04, localVelocity stayed
    // at (430, 0) after the snap → the visual kept gliding right at full speed
    // from the snapped position. After NET-04, localVelocity becomes (100, 50)
    // → consistent with the snapped localPos.
    const gameState = new GameState();
    gameState.localPos = { x: 100, y: 100 };
    const staleVelX = 430;
    const staleVelY = 0;
    gameState.localVelocity = { x: staleVelX, y: staleVelY };
    gameState.correctionOffset = { x: 0, y: 0 };

    const reconciledX = 140; // posError = 40 ≥ 16 → snaps
    const reconciledY = 100;
    const reconciledVelX = 100;
    const reconciledVelY = 50;

    const wasCorrected = gameState.applyReconciledPosition(
      reconciledX,
      reconciledY,
      reconciledVelX,
      reconciledVelY,
      0, // rttMs = 0 → snap threshold = 16
    );

    expect(wasCorrected).toBe(true);

    // THE NET-04 ASSERTION: localVelocity is the reconciled velocity (direct-set).
    // PRE-FIX this was { x: 430, y: 0 } (the stale prediction velocity,
    // silently left unchanged — the defect).
    expect(gameState.localVelocity).toEqual({ x: reconciledVelX, y: reconciledVelY });

    // --- Measurement (informational, reported for the live gate) ---
    const droppedDx = staleVelX - reconciledVelX; // what used to be silently dropped
    const droppedDy = staleVelY - reconciledVelY;
    const droppedMag = Math.hypot(droppedDx, droppedDy);

    // Velocity-direction consistency: the post-correction localVelocity must
    // point in the RECONCILED direction (the server's authoritative direction
    // of travel at the snapped position). We measure the cosine of the angle
    // between the post-correction velocity and the reconciled velocity — with
    // the fix it is exactly 1 (identical vectors); under the old code it was
    // cos(angle between stale and reconciled) < 1.
    const reconciledMag = Math.hypot(reconciledVelX, reconciledVelY);
    const staleMag = Math.hypot(staleVelX, staleVelY);
    const fixCos =
      reconciledMag > 0
        ? (gameState.localVelocity.x * reconciledVelX +
            gameState.localVelocity.y * reconciledVelY) /
          (Math.hypot(gameState.localVelocity.x, gameState.localVelocity.y) * reconciledMag)
        : 1;
    const staleCos =
      reconciledMag > 0 && staleMag > 0
        ? (staleVelX * reconciledVelX + staleVelY * reconciledVelY) / (staleMag * reconciledMag)
        : 1;

    // Visual extrapolation (predictionAccumulator upper bound = one SIM_TICK_DT).
    // Reported for the live gate. NOTE: the correctionOffset (-deltaX) is
    // identical in both the fix and stale counterfactual (it depends only on
    // the position delta, not velocity) per ADR-0005/0010 — so the visual
    // ENDPOINT difference between fix and stale is exactly the velocity-term
    // difference (reconciledVel - staleVel) * accumulator. The offset's job is
    // the visual glide; NET-04's job is making the underlying velocity
    // consistent so subsequent prediction steps move in the reconciled
    // direction.
    const accumulator = SIM_TICK_DT; // worst-case residual
    const visualWithFix = extrapolateVisual(
      gameState.localPos,
      gameState.localVelocity,
      gameState.correctionOffset,
      accumulator,
    );
    const visualWithStale = extrapolateVisual(
      gameState.localPos,
      { x: staleVelX, y: staleVelY },
      gameState.correctionOffset,
      accumulator,
    );

    console.log('[NET-04] forced correction measurement:', {
      staleLocalVelocity: { x: staleVelX, y: staleVelY },
      reconciledVelocity: { x: reconciledVelX, y: reconciledVelY },
      silentlyDroppedDelta: { dx: droppedDx, dy: droppedDy, magnitude: +droppedMag.toFixed(2) },
      postCorrectionLocalVelocity: { ...gameState.localVelocity },
      postCorrectionPosVelConsistent:
        gameState.localVelocity.x === reconciledVelX &&
        gameState.localVelocity.y === reconciledVelY,
      directionConsistencyCosine: {
        withFix: +fixCos.toFixed(4), // 1.0 — identical direction
        withStalePreFix: +staleCos.toFixed(4), // < 1 — stale direction
      },
      visualExtrapolationOneTick: {
        withFix: { x: +visualWithFix.x.toFixed(2), y: +visualWithFix.y.toFixed(2) },
        withStalePreFix: { x: +visualWithStale.x.toFixed(2), y: +visualWithStale.y.toFixed(2) },
        note: 'offset is identical in both (position-delta only); endpoint diff == (reconciledVel - staleVel) * accumulator',
      },
    });

    // The fix's post-correction velocity is direction-identical to the
    // reconciled velocity (cosine == 1). The stale counterfactual is strictly
    // less aligned (cosine < 1) — this is the consistency gain NET-04
    // delivers: the prediction's next step moves in the server's authoritative
    // direction, not the stale one.
    expect(fixCos).toBeCloseTo(1, 6);
    expect(staleCos).toBeLessThan(1);
  });

  it('below-threshold path: NO velocity write (prediction authoritative — ADR-0005/0010 preserved)', () => {
    // The below-threshold "prediction authoritative, NO write" path is
    // UNCHANGED by NET-04 (criterion 2). localPos, localVelocity, AND
    // correctionOffset are all untouched when posError < snapThreshold.
    const gameState = new GameState();
    gameState.localPos = { x: 100, y: 100 };
    gameState.localVelocity = { x: 430, y: 0 };
    gameState.correctionOffset = { x: 0, y: 0 };

    const wasCorrected = gameState.applyReconciledPosition(
      108, // posError = 8 < 16 → IGNORED
      100,
      100,
      50,
      0,
    );

    expect(wasCorrected).toBe(false);
    expect(gameState.localPos).toEqual({ x: 100, y: 100 }); // unchanged
    expect(gameState.localVelocity).toEqual({ x: 430, y: 0 }); // unchanged — NO velocity write
    expect(gameState.correctionOffset).toEqual({ x: 0, y: 0 }); // unchanged
  });

  it('zero reconciled velocity (server says stopped) is faithfully adopted — no residual glide', () => {
    // The classic ghost-after-correction case: prediction was gliding at full
    // speed (430, 0); the server says the player actually stopped (collision
    // / stagger / dash-end). A ≥ threshold correction fires. Before NET-04,
    // localVelocity stayed at (430, 0) → the visual kept gliding forward off
    // the snapped position. After NET-04, localVelocity becomes (0, 0) → the
    // visual stops at the snapped position (modulo the correctionOffset
    // glide, which decays in ~100ms).
    const gameState = new GameState();
    gameState.localPos = { x: 100, y: 100 };
    gameState.localVelocity = { x: 430, y: 0 };
    gameState.correctionOffset = { x: 0, y: 0 };

    const wasCorrected = gameState.applyReconciledPosition(140, 100, 0, 0, 0);

    expect(wasCorrected).toBe(true);
    expect(gameState.localPos).toEqual({ x: 140, y: 100 });
    expect(gameState.localVelocity).toEqual({ x: 0, y: 0 }); // stopped — no residual glide
    expect(gameState.correctionOffset).toEqual({ x: -40, y: 0 }); // glide delta absorbed
  });
});

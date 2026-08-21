import { describe, it, expect } from 'vitest';
import { PredictionService } from '../PredictionService.js';
import { GameState } from '../../controllers/GameState.js';
import type { InputBuffer } from '../InputBuffer.js';
import type { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { InputFrame } from '../../types.js';
import { ERROR_DECAY_RATE } from '../../types.js';
import { PLAYER, SIM_TICK_DT } from '@sector-battle/shared';

/**
 * Characterization tests for PredictionService — the client prediction hot
 * path (ADR-0014/0015, ADR-0026 zero-alloc, ADR-0033 reconciliation). These
 * PIN today's behavior.
 *
 * PredictionService owns its internal simulation memory privately
 * (`predictionAccumulator` — moved off GameState per ADR-0037 two-gate model:
 * sole consumer + complexity concentrates). These tests therefore observe
 * prediction BEHAVIOR through the public surface (step +
 * getVisualPosition + GameState's shared fields), not by poking
 * PredictionService's private internals. The regression guard is preserved
 * because every assertion still pins an observable consequence of the
 * prediction loop.
 *
 * NET-03 — `step()` now consumes a LIVE movement direction every render
 * frame (no `step(null)` coasting branch). Tests pass `(dirX, dirY, dt,
 * mySpeed, isStaggered, edges, sendFrame)`; a record is pushed only when
 * `sendFrame` is non-null.
 *
 * Pass-through collision (no walls) is used throughout so the battery
 * isolates the prediction loop + accumulator + visual-position math from map
 * geometry. Physics constants pulled from the shared PLAYER table:
 *   BASE_SPEED   = 430 px/s
 *   ACCELERATION = 4800 px/s^2
 *   SIM_TICK_DT  = 1/60 s  (~0.0166667)
 *
 * First-frame kinematics (no input prior):
 *   velocity after 1 step  = ACCELERATION * DT = 80
 *   displacement after 1 step = ACCELERATION * DT * DT = 4800 / 3600 ~= 1.3333
 */

/** Pass-through collision: returns the proposed position unchanged (no walls). */
function makeStubCollisionService(): ClientCollisionService {
  return {
    resolveCollision: (x: number, y: number) => ({ x, y }),
    // Ticket 21: the service's hot path consumes the pooled seam — the stub
    // mirrors the real contract (writes into the caller-owned out box,
    // returns it) so the pins stay on the real call shape.
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

/** Stub InputBuffer — captures pushed records without storing them. */
function makeStubInputBuffer(capture?: { records: unknown[] }): InputBuffer {
  return {
    push: (rec: unknown) => {
      capture?.records.push(rec);
    },
  } as unknown as InputBuffer;
}

function makeInput(overrides: Partial<InputFrame> = {}): InputFrame {
  return {
    movementX: 0,
    movementY: 0,
    aimAngle: 0,
    sequence: 0,
    actions: [],
    ...overrides,
  };
}

function makeService(state: GameState): PredictionService {
  return new PredictionService(makeStubCollisionService(), makeStubInputBuffer(), state);
}

describe('PredictionService — characterization (hot-path regression pins)', () => {
  it('step() with input advances localPos by the predicted delta', () => {
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    const service = makeService(state);

    const frame = makeInput({ movementX: 1, movementY: 0, sequence: 1 });
    // NET-03: step(dirX, dirY, dt, mySpeed, isStaggered, edges, sendFrame).
    // Live direction = +X from the frame; push a record for seq=1.
    service.step(1, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], frame);

    // First-step displacement = ACCELERATION * DT * DT (input direction +x).
    expect(state.localVelocity.x).toBeCloseTo(PLAYER.ACCELERATION * SIM_TICK_DT, 5);
    expect(state.localVelocity.y).toBe(0);
    expect(state.localPos.x).toBeCloseTo(PLAYER.ACCELERATION * SIM_TICK_DT * SIM_TICK_DT, 7);
    expect(state.localPos.y).toBe(0);
  });

  it('NET-03: NO coasting — step() with dir=(0,0) decelerates even right after a +X step (ghost is gone)', () => {
    // NET-03 removes the step(null) stale-coasting branch. Today the caller
    // supplies the LIVE direction every render frame, so a release is captured
    // immediately — there is no internal `lastInputDirection` memory coasting
    // the old direction. This test pins that: after a +X step that establishes
    // a non-zero velocity, a follow-up step with dir=(0,0) must DECELERATE
    // (velocity drops toward zero), NOT coast at the prior velocity.
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    const service = makeService(state);

    // Establish +X velocity (one acceleration step).
    service.step(1, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], null);
    const velocityAfterAccel = state.localVelocity.x;
    expect(velocityAfterAccel).toBeGreaterThan(0);

    // Follow-up frame: live direction is (0,0) — keys released. The prediction
    // must decelerate immediately, NOT coast on the prior +X direction.
    service.step(0, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], null);
    expect(state.localVelocity.x).toBeLessThan(velocityAfterAccel);
    // Deceleration rate is PLAYER.DECELERATION (6400 px/s^2); after one tick
    // from velocityAfterAccel (80 px/s), the velocity would drop by
    // DECELERATION * DT = 6400/60 ≈ 106.67 px/s. Since 80 < 106.67, the
    // velocity clamps to ZERO (deceleration doesn't reverse direction).
    expect(state.localVelocity.x).toBe(0);
  });

  it('getVisualPosition() returns localPos + velocity*accumulator + correctionOffset', () => {
    const state = new GameState();
    state.localPos = { x: 100, y: 200 };
    state.localVelocity = { x: 50, y: -25 };
    // correctionOffset stays on GameState (shared, boxed-ref) — seed it
    // directly. Mutate in place; reassigning would break box identity.
    state.correctionOffset.x = 7;
    state.correctionOffset.y = -3;
    const service = makeService(state);

    // Drive a real step that leaves a KNOWN residual accumulator, so we can
    // verify the interpolation formula without poking the now-private
    // predictionAccumulator. dt = SIM_TICK_DT * 1.5 runs exactly one substep
    // (draining SIM_TICK_DT) and leaves a residual of 0.5 * SIM_TICK_DT.
    const halfTickResidual = SIM_TICK_DT * 0.5;
    service.step(0, 0, SIM_TICK_DT * 1.5, PLAYER.BASE_SPEED, false, [], null);

    // Read the POST-step localPos/localVelocity/correctionOffset (step
    // mutated all three — velocity decelerated under zero input, and
    // correctionOffset was decayed by decayCorrectionOffset(dt)). Assert
    // getVisualPosition matches the interpolation formula evaluated against
    // that post-step state + the known residual. Reading the post-step
    // correctionOffset accounts for the decay without hardcoding the rate.
    const visual = service.getVisualPosition();

    expect(visual.x).toBeCloseTo(
      state.localPos.x + state.localVelocity.x * halfTickResidual + state.correctionOffset.x,
      5,
    );
    expect(visual.y).toBeCloseTo(
      state.localPos.y + state.localVelocity.y * halfTickResidual + state.correctionOffset.y,
      5,
    );
  });

  it('substep loop drains the accumulator correctly (multiple fixed steps in one call)', () => {
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    const service = makeService(state);

    // Feed 2 ticks worth of dt in a single step() call. We pass exactly
    // 2 * SIM_TICK_DT and expect both substeps to drain (residual 0).
    const twoTicksDt = SIM_TICK_DT * 2;
    service.step(1, 0, twoTicksDt, PLAYER.BASE_SPEED, false, [], null);

    // The accumulator is now private; we verify the drain behaviorally: a
    // FOLLOWING step with exactly one tick of dt must produce the single-step
    // velocity increment (if the first step had under-drained, the residual
    // would trigger an extra substep here and the velocity would jump by ~2x).
    const singleStepVelocity = PLAYER.ACCELERATION * SIM_TICK_DT;
    state.localVelocity = { x: 0, y: 0 };
    service.step(1, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], null);
    expect(state.localVelocity.x).toBeCloseTo(singleStepVelocity, 5);

    // And the first step's two substeps advanced velocity further than a
    // single step would have (recorded before the reset above by reading the
    // displacement — two accel increments beat one).
    // (The displacement check is implicit: the reset + single-step above
    // would fail if the prior step had not drained cleanly, because a
    // residual would compound into this step.)
  });

  it('decayCorrectionOffset shrinks the offset toward zero', () => {
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    state.correctionOffset.x = 10;
    state.correctionOffset.y = -10;
    const service = makeService(state);

    // step() invokes decayCorrectionOffset(dt) at the top of every call.
    // decay = exp(-ERROR_DECAY_RATE * dt); the rate is the production value
    // (currently 30 — fast enough to clear the offset within one patch
    // interval at 60Hz). Import the constant so this test tracks production.
    const expectedDecay = Math.exp(-ERROR_DECAY_RATE * SIM_TICK_DT);
    // NET-03: any direction (zero here) works — the test only exercises decay.
    service.step(0, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], null);

    expect(state.correctionOffset.x).toBeCloseTo(10 * expectedDecay, 5);
    expect(state.correctionOffset.y).toBeCloseTo(-10 * expectedDecay, 5);
  });

  it('does NOT drop sim time when a single frame exceeds 2 ticks (H1 regression)', () => {
    // ROOT CAUSE of snapbacks (B4 perf regression H1): the accumulator
    // previously capped at SIM_TICK_DT * 2 (≈33ms). Any frame slower than that
    // had its excess time PERMANENTLY discarded — the client sim fell behind
    // the server's wall-clock 60Hz tick, the next reconciliation error blew
    // past the 16px snap threshold, and the player teleported backward. The
    // [anim] phase-clock drift warnings are the same dropped-time symptom in
    // the animation loop.
    //
    // After the fix, dt > SIM_TICK_DT * 2 is no longer clamped: the loop runs
    // every substep that fits (bounded by a MAX_PREDICTION_SUBSTEPS guard) and
    // carries any residual forward. GameScene's dt clamp (Math.min(delta, 50))
    // remains the real spiral-of-death guard.
    //
    // Behavioral proof: feed dt = SIM_TICK_DT * 2.5 (40ms — above the old
    // 33ms cap). That must run TWO full substeps (SIM_TICK_DT each) and leave
    // a 0.5-tick residual in the accumulator. We verify the residual behaviorally
    // by following with a dt that's SHORT of one tick: the carried residual
    // pushes the next call over the threshold and runs a substep it otherwise
    // would not.
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    const service = makeService(state);

    // 40ms = 2.4 ticks at 60Hz. Old cap dropped this to 2.0 ticks (33ms),
    // discarding ~7ms of real time. Fix carries all 2.4 ticks: 2 substeps +
    // 0.4-tick residual.
    service.step(1, 0, SIM_TICK_DT * 2.4, PLAYER.BASE_SPEED, false, [], null);

    // After two acceleration substeps the x-velocity is 2 * ACCEL * DT
    // (each substep adds ACCEL * DT). The OLD behavior (capped to 2 substeps
    // with zero residual) would produce the SAME velocity here, so this alone
    // doesn't distinguish — the residual is the discriminator (next assertion).
    expect(state.localVelocity.x).toBeCloseTo(2 * PLAYER.ACCELERATION * SIM_TICK_DT, 5);

    // Now feed dt = 0.7 tick (well under one tick). With the OLD cap, the
    // accumulator started this call at 0 → 0.7 tick → no substep runs →
    // velocity unchanged. With the FIX, the carried ~0.4-tick residual +
    // 0.7 = 1.1 ticks → ONE substep runs → velocity grows by another
    // ACCEL * DT increment. That growth proves the residual was carried.
    const velocityBefore = state.localVelocity.x;
    service.step(1, 0, SIM_TICK_DT * 0.7, PLAYER.BASE_SPEED, false, [], null);
    expect(state.localVelocity.x).toBeCloseTo(
      velocityBefore + PLAYER.ACCELERATION * SIM_TICK_DT,
      5,
    );
  });

  it('NET-03: sendFrame=null does NOT push a record; sendFrame!=null does (records stay per-send)', () => {
    // NET-03 — records stay per-send (16ms, keyed by seq). The prediction
    // pushes a record ONLY when sendFrame is non-null; throttle frames
    // (sendFrame=null) advance localPos but push nothing. This pins the
    // server-acked seq identity invariant.
    const captured: unknown[] = [];
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    const service = new PredictionService(
      makeStubCollisionService(),
      makeStubInputBuffer({ records: captured }),
      state,
    );

    // Throttle frame (no send): no record pushed.
    service.step(1, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], null);
    expect(captured.length).toBe(0);

    // Send frame: record pushed.
    const sendFrame = makeInput({ movementX: 1, movementY: 0, sequence: 7 });
    service.step(1, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, [], sendFrame);
    expect(captured.length).toBe(1);
    const rec = captured[0] as { frame: { sequence: number }; subSteps: number };
    expect(rec.frame.sequence).toBe(7);
    // The record carries substeps from BOTH the prior throttle frame AND this
    // send frame (per-substep accumulator flushed at push time).
    expect(rec.subSteps).toBeGreaterThanOrEqual(1);
  });

  it('NET-03: DASH edge applies on the detection frame (dash starts on press)', () => {
    // NET-03 criterion 3 — edge actions apply to the prediction on the
    // DETECTION frame, so dash starts the instant the key is pressed (not on
    // the next 16ms send boundary). This test pins that: a step call with
    // edges=['DASH'] enters the dash state immediately (velocity boosted to
    // dash speed after one tick), even when sendFrame is null.
    const state = new GameState();
    state.localPos = { x: 0, y: 0 };
    state.localVelocity = { x: 0, y: 0 };
    const service = makeService(state);

    // Detection frame: DASH edge fires. No send frame (the send may happen
    // on a later frame — the dash still starts NOW).
    service.step(1, 0, SIM_TICK_DT, PLAYER.BASE_SPEED, false, ['DASH'], null);
    // After one dash tick the player is dashing at dash speed (2× BASE_SPEED).
    expect(state.localIsDashing).toBe(true);
    expect(state.localVelocity.x).toBeCloseTo(PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER, 4);
  });
});

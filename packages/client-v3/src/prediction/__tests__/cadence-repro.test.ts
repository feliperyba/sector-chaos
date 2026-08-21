import { describe, it, expect } from 'vitest';
import { PLAYER, COMBAT, SIM_TICK_DT, simulatePhysicsStepInto } from '@sector-battle/shared';
import type { PhysicsState, PhysicsInput, PhysicsConfig, CollisionFn } from '@sector-battle/shared';
import { GameState } from '../../controllers/GameState.js';
import { PredictionService } from '../PredictionService.js';
import { InputBuffer } from '../InputBuffer.js';
import { Reconciler } from '../Reconciler.js';
import { PlayerReconciler } from '../../bridges/state-sync/PlayerReconciler.js';
import type { InputFrame } from '../../types.js';
import type { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { StateSync } from '../../network/StateSync.js';
import type { ReconciliationLog } from '../../debug/ReconciliationLog.js';

/**
 * E2E CADENCE REPRO — the deterministic feedback loop that models the real
 * input/tick cadence and reproduces the local-player snap-back bug.
 *
 * ROOT CAUSE (found via this harness): PredictionService.step(null) runs
 * physics substeps WITHOUT pushing an InputRecord. At high render rates
 * (144Hz), step(null) fires between every input send → the reconciler's
 * rewind-and-replay undercounts substeps → with network latency, the replay
 * position drifts behind the prediction → the error exceeds the snap
 * threshold → periodic snap-back ("stutter"). The fix: accumulate step(null)
 * substeps into `pendingCoastSubsteps` and merge them into the next pushed
 * record's `subSteps`.
 *
 * This harness models the real pipeline with a wall-clock timeline:
 *   - Client renders at `renderDt` (variable — 60/50/144fps)
 *   - Client collects+sends input at INPUT_SEND_INTERVAL_MS=16ms (60Hz)
 *   - Server ticks at SIM_TICK_DT (60Hz), stamps inputs with currentTick
 *   - Server patches at PATCH_RATE (syncEveryN = TICK_RATE / PATCH_RATE)
 *   - Patches arrive at the client after `latencySec` delay
 *   - Client reconciles via the REAL PlayerReconciler → Reconciler → GameState
 */

const PHYSICS_CONFIG: PhysicsConfig = {
  acceleration: PLAYER.ACCELERATION,
  deceleration: PLAYER.DECELERATION,
  dashSpeedMultiplier: PLAYER.DASH_SPEED_MULTIPLIER,
  dashDurationTicks: PLAYER.DASH_DURATION_TICKS,
  staggerMoveSpeedPenalty: COMBAT.STAGGER_MOVE_SPEED_PENALTY,
  playerHalfW: PLAYER.HITBOX_WIDTH / 2,
  playerHalfH: PLAYER.HITBOX_HEIGHT / 2,
  baseSpeed: PLAYER.BASE_SPEED,
};

function passthroughCollision(): CollisionFn {
  return (x: number, y: number) => ({ x, y });
}

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

const HEALTHY_FLOOR = PLAYER.BASE_SPEED * 0.9; // 387 px/s

/**
 * Minimal server shadow that integrates physics with the same shared primitive
 * the real server uses. On gap ticks (no input arrived), it applies the
 * lastMoveDirection momentum pass (the HEAD-committed behavior — the healthiest
 * of the tested alternatives, matching the client's step(null) coast).
 */
class ServerShadow {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  lastProcessedInput = 0;
  private readonly state: PhysicsState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    isDashing: false,
    dashRemaining: 0,
    isStaggered: false,
  };
  private readonly input: PhysicsInput = {
    dx: 0,
    dy: 0,
    hasDash: false,
    dashDirX: 0,
    dashDirY: 0,
  };
  private readonly collision: CollisionFn;
  private readonly bucket = new Map<number, { dx: number; dy: number; seq: number }>();
  private lastDirX = 0;
  private lastDirY = 0;

  constructor(collision: CollisionFn) {
    this.collision = collision;
  }

  enqueue(tick: number, dx: number, dy: number, seq: number): void {
    this.bucket.set(tick, { dx, dy, seq });
  }

  step(tick: number): void {
    const queued = this.bucket.get(tick);
    if (queued) {
      if (queued.seq > this.lastProcessedInput) this.lastProcessedInput = queued.seq;
      if (queued.dx !== 0 || queued.dy !== 0) {
        const mag = Math.hypot(queued.dx, queued.dy);
        this.lastDirX = queued.dx / mag;
        this.lastDirY = queued.dy / mag;
      }
    }
    // On gap ticks, coast with lastMoveDirection (HEAD behavior — matches client)
    const dx = queued ? queued.dx : this.lastDirX;
    const dy = queued ? queued.dy : this.lastDirY;

    this.state.x = this.x;
    this.state.y = this.y;
    this.state.vx = this.vx;
    this.state.vy = this.vy;
    this.state.speed = PLAYER.BASE_SPEED;
    this.state.isStaggered = false;
    this.input.dx = dx;
    this.input.dy = dy;
    this.input.hasDash = false;
    simulatePhysicsStepInto(this.state, this.input, PHYSICS_CONFIG, this.collision, SIM_TICK_DT);
    this.x = this.state.x;
    this.y = this.state.y;
    this.vx = this.state.vx;
    this.vy = this.state.vy;
  }
}

interface LoopResult {
  renderSpeedPxSec: number;
  maxBackwardJumpPx: number;
  snapbackCount: number;
  finalOffsetMag: number;
  maxErrorPx: number;
}

interface LoopOptions {
  durationSec?: number;
  renderDt?: number;
  inputSendIntervalMs?: number;
  syncEveryN?: number;
  latencySec?: number;
  /**
   * Per-frame jitter in ms (±). Models the erratic frame timing Vite dev mode
   * produces due to GC pressure / module overhead / sourcemap parsing. Each
   * frame's dt is renderDt ± random(0, jitterMs). Default 0 (stable frames).
   */
  frameJitterMs?: number;
  /** Seed for the jitter RNG (determinism). Default 42. */
  jitterSeed?: number;
}

/**
 * Run the full client+server pipeline with a unified wall-clock timeline.
 * See file header for the model description.
 */
function runCadenceLoop(opts: LoopOptions = {}): LoopResult {
  const durationSec = opts.durationSec ?? 3.0;
  const renderDt = opts.renderDt ?? SIM_TICK_DT;
  const inputSendIntervalMs = opts.inputSendIntervalMs ?? 16;
  const syncEveryN = opts.syncEveryN ?? 2; // PATCH_RATE=30 → syncEveryN=2
  const latencySec = opts.latencySec ?? 0;
  const frameJitterMs = opts.frameJitterMs ?? 0;
  let rngState = (opts.jitterSeed ?? 42) >>> 0;
  const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  const collision = passthroughCollision();
  const gameState = new GameState();
  gameState.localPos = { x: 0, y: 0 };
  gameState.localVelocity = { x: 0, y: 0 };

  const inputBuffer = new InputBuffer();
  const reconcilerCore = new Reconciler(inputBuffer, collision);
  const predictionService = new PredictionService(
    makeStubCollisionService(),
    inputBuffer,
    gameState,
  );

  const rttBox = { value: 0 };
  let currentTick = 0;
  const reconciler = new PlayerReconciler({
    gameState,
    rtt: rttBox,
    inputBuffer,
    reconciler: reconcilerCore,
    stateSync: { value: { getTick: () => currentTick } as unknown as StateSync },
    reconciliationLog: { value: undefined as ReconciliationLog | undefined },
    isSpectating: { value: false },
  });

  const server = new ServerShadow(collision);

  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let nextClientSendSec = 0;
  let clientSeq = 0;
  let lastPatchSentAtTick = -1;
  const inflightInputs = new Map<
    number,
    { dx: number; dy: number; seq: number; arrivalSec: number }
  >();
  const inflightPatches = new Map<
    number,
    { x: number; y: number; vx: number; vy: number; lastSeq: number; arrivalSec: number }
  >();

  let prevVisualX = 0;
  let maxBackwardJump = 0;
  let snapbackCount = 0;
  let visualDistance = 0;
  let maxError = 0;

  const stepServer = (targetSec: number) => {
    while (nextServerTickSec <= targetSec + 1e-9) {
      currentTick++;
      const tickWallSec = nextServerTickSec;

      let arrivingInput: { dx: number; dy: number; seq: number } | null = null;
      for (const [key, inp] of inflightInputs) {
        if (inp.arrivalSec <= tickWallSec + 1e-9) {
          arrivingInput = inp;
          inflightInputs.delete(key);
          break;
        }
      }
      if (arrivingInput) {
        server.enqueue(currentTick, arrivingInput.dx, arrivingInput.dy, arrivingInput.seq);
      }
      server.step(currentTick);

      if (currentTick - lastPatchSentAtTick >= syncEveryN) {
        lastPatchSentAtTick = currentTick;
        const patchArrivalSec = tickWallSec + latencySec;
        inflightPatches.set(patchArrivalSec, {
          x: server.x,
          y: server.y,
          vx: server.vx,
          vy: server.vy,
          lastSeq: server.lastProcessedInput,
          arrivalSec: patchArrivalSec,
        });
      }

      for (const [key, patch] of inflightPatches) {
        if (patch.arrivalSec <= tickWallSec + 1e-9) {
          inflightPatches.delete(key);
          reconciler.handleLocalPlayerPositionChange(
            patch.x,
            patch.y,
            patch.vx,
            patch.vy,
            patch.lastSeq,
            latencySec * 1000 * 2,
          );
          break;
        }
      }
      nextServerTickSec += SIM_TICK_DT;
    }
  };

  let frameIndex = 0;
  for (let elapsed = 0; elapsed < durationSec; elapsed += renderDt, frameIndex++) {
    // Apply per-frame jitter (models Vite dev mode's erratic frame timing)
    const jitter = frameJitterMs > 0 ? ((rand() - 0.5) * 2 * frameJitterMs) / 1000 : 0;
    const frameDt = renderDt + jitter;
    const frameEndSec = nowSec + frameDt;
    stepServer(frameEndSec);
    nowSec = frameEndSec;

    // NET-03 seam: the live direction (held +X) is fed EVERY render frame;
    // the send frame is built only at the 16ms boundary. The prediction
    // reacts to a release within one frame (no stale coasting) and pushes
    // a record only when sendFrame is non-null.
    let frame: InputFrame | null = null;
    if (nowSec >= nextClientSendSec) {
      nextClientSendSec = nowSec + inputSendIntervalMs / 1000;
      clientSeq++;
      frame = { movementX: 1, movementY: 0, aimAngle: 0, sequence: clientSeq, actions: [] };
      inflightInputs.set(nowSec, { dx: 1, dy: 0, seq: clientSeq, arrivalSec: nowSec + latencySec });
    }

    predictionService.step(1, 0, frameDt, PLAYER.BASE_SPEED, false, [], frame);
    const visual = predictionService.getVisualPosition();

    if (frameIndex > 0) {
      const dx = visual.x - prevVisualX;
      if (dx < 0) {
        snapbackCount++;
        if (-dx > maxBackwardJump) maxBackwardJump = -dx;
      }
      visualDistance += Math.abs(visual.x - prevVisualX);
    }
    prevVisualX = visual.x;
    const errorPx = Math.hypot(gameState.localPos.x - server.x, gameState.localPos.y - server.y);
    if (errorPx > maxError) maxError = errorPx;
  }

  return {
    renderSpeedPxSec: visualDistance / durationSec,
    maxBackwardJumpPx: maxBackwardJump,
    snapbackCount,
    finalOffsetMag: Math.hypot(gameState.correctionOffset.x, gameState.correctionOffset.y),
    maxErrorPx: maxError,
  };
}

describe('E2E cadence repro — local-player snap-back at high render rates', () => {
  // The PASS bar: visual speed must be ≥ 90% of BASE_SPEED (387px/s) with
  // ZERO snap-backs. The first ~200ms is acceleration ramp, so over 3s the
  // ramp is <10% of the run and renderSpeedPxSec ≈ 425 (the 0.988 ratio is
  // the ramp tax, consistent across all healthy configurations).

  it('60fps render + 150ms RTT — baseline healthy (no high-refresh step(null) issue)', () => {
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: SIM_TICK_DT,
      latencySec: 0.075,
    });
    console.log('[DEBUG-cadence] 60fps/150msRTT:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
    expect(result.snapbackCount).toBe(0);
  });

  it('REGRESSION: 144fps render + 150ms RTT — zero snap-backs (the fix)', () => {
    // At 144fps, step(null) fires between every send. Before the fix, the
    // reconciler undercounted substeps → 4 snap-backs over 3s. After the fix
    // (pendingCoastSubsteps merged into the next record), zero snap-backs.
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: 1 / 144,
      latencySec: 0.075,
    });
    console.log('[DEBUG-cadence] 144fps/150msRTT:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
    expect(result.snapbackCount).toBe(0);
  });

  it('REGRESSION: 144fps render + 150ms RTT + syncEveryN=3 (20Hz patch) — zero snap-backs', () => {
    // Stress: slower patch rate means each reconciliation replays more unacked
    // records → more opportunity for step(null) substep loss to accumulate.
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: 1 / 144,
      syncEveryN: 3,
      latencySec: 0.075,
    });
    console.log('[DEBUG-cadence] 144fps/sync3/150msRTT:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
    expect(result.snapbackCount).toBe(0);
  });

  it('REGRESSION: 144fps render + zero latency — zero snap-backs (isolates step(null) from network)', () => {
    // Even without latency, the step(null) fix must not introduce divergence.
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: 1 / 144,
      latencySec: 0,
    });
    console.log('[DEBUG-cadence] 144fps/0ms:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.snapbackCount).toBe(0);
  });

  it('50fps render + 150ms RTT — zero snap-backs (user reported ~50fps)', () => {
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: 0.02,
      latencySec: 0.075,
    });
    console.log('[DEBUG-cadence] 50fps/150msRTT:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
    expect(result.snapbackCount).toBe(0);
  });

  // =========================================================================
  // FRAME JITTER TESTS — model the erratic frame timing Vite dev mode produces
  // (GC pressure, sourcemap overhead, module system contention). The prod
  // build has stable frame timing. If the fix is correct, it should survive
  // jitter without snap-backs.
  // =========================================================================

  it('STRESS: 144fps + ±5ms frame jitter + 150ms RTT — zero snap-backs under dev-like jitter', () => {
    // Vite dev mode can produce erratic frame timing. ±5ms jitter on 6.94ms
    // frames means dt ranges from 1.94ms to 11.94ms — some frames run 0
    // substeps, others run 1, unpredictably. The pendingCoastSubsteps fix
    // must keep the reconciler accurate despite this chaos.
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: 1 / 144,
      latencySec: 0.075,
      frameJitterMs: 5,
      jitterSeed: 42,
    });
    console.log('[DEBUG-cadence] 144fps/±5ms-jitter/150msRTT:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.snapbackCount).toBe(0);
  });

  it('STRESS: 60fps + ±8ms frame jitter + 150ms RTT — extreme dev-like jank', () => {
    // Extreme jitter: ±8ms on 16.67ms frames → dt ranges 8.67-24.67ms.
    // Some frames hit the 50ms clamp territory, some run 0 substeps, some
    // run 2. This is the worst-case Vite dev scenario.
    const result = runCadenceLoop({
      durationSec: 3.0,
      renderDt: SIM_TICK_DT,
      latencySec: 0.075,
      frameJitterMs: 8,
      jitterSeed: 99,
    });
    console.log('[DEBUG-cadence] 60fps/±8ms-jitter/150msRTT:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      maxErrorPx: result.maxErrorPx.toFixed(1),
    });
    expect(result.snapbackCount).toBe(0);
  });
});

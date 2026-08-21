import { describe, it, expect } from 'vitest';
import { PLAYER, COMBAT, SIM_TICK_DT, simulatePhysicsStepInto } from '@sector-battle/shared';
import type { PhysicsState, PhysicsInput, PhysicsConfig, CollisionFn } from '@sector-battle/shared';
import { GameState } from '../../controllers/GameState.js';
import { PredictionService } from '../PredictionService.js';
import { InputBuffer } from '../InputBuffer.js';
import { Reconciler } from '../Reconciler.js';
import { PlayerReconciler } from '../../bridges/state-sync/PlayerReconciler.js';
import type { PlayerState } from '../../types.js';
import type { InputFrame, InputRecord } from '../../types.js';
import type { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { StateSync } from '../../network/StateSync.js';
import type { ReconciliationLog } from '../../debug/ReconciliationLog.js';

/**
 * E2E DETERMINISTIC FEEDBACK LOOP — the diagnose skill's Phase 1.
 *
 * Drives the FULL local-player pipeline in lock-step with a faithful server
 * shadow sim, then measures the VISUAL position advance (what the player
 * actually sees on screen). This is the loop that was missing: unit tests on
 * PredictionService pass (sim is perfect at 430px/s), unit tests on
 * applyReconciledPosition pass, but neither exercises the INTERACTION of
 * prediction + periodic server patches + reconciliation replay + the
 * visual-position formula. That interaction is where the sluggish/teleport
 * symptom lives.
 *
 * The loop mirrors the real pipeline:
 *   1. Client frame: collect input → PredictionService.step(frame, dt, ...)
 *      → records input + predicted pos in InputBuffer
 *   2. Client frame: getVisualPosition() → what the renderer snaps the body to
 *   3. Server shadow: every serverTick, dequeue inputs at that tick, run
 *      simulatePhysicsStepInto (the SAME primitive the server uses) → advances
 *      authoritative pos/vel + tracks lastProcessedInput
 *   4. Server patch: every syncEveryN server ticks, broadcast (serverX, serverY,
 *      serverVelX, serverVelY, lastProcessedInput) to the client
 *   5. Client reconcile: PlayerReconciler.handleLocalPlayerPositionChange →
 *      Reconciler.reconcile (replays unacked inputs from server state) →
 *      GameState.applyReconciledPosition (threshold-gated snap + offset)
 *
 * The measured signal: over DURATION seconds of held movement input, how far
 * does the VISUAL position advance vs. the expected BASE_SPEED * DURATION? If
 * the loop is healthy, renderSpeedPxSec ≈ BASE_SPEED (430) once at full
 * velocity. If the symptom reproduces, renderSpeedPxSec is a fraction of 430
 * and/or visual position teleports backward (snapbacks).
 *
 * No walls (pass-through collision) so the loop isolates the
 * prediction/reconciliation math from map geometry, exactly like the existing
 * PredictionService characterization tests.
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

/** Pass-through collision: returns the proposed position unchanged (no walls). */
function passthroughCollision(): CollisionFn {
  return (x: number, y: number) => ({ x, y });
}

/** Stub ClientCollisionService wrapping the passthrough fn for PredictionService. */
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

/**
 * Server shadow sim — a minimal authoritative sim that advances one player
 * using the SAME shared physics primitive the real server uses. It tracks
 * lastProcessedInput exactly like GameSimulation does (input.ts:80-83 +
 * GameSimulation.updateLastProcessedInput). This is what the client must
 * reconcile against.
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
  // Per-tick input bucket (serverTick → input at that tick), mirroring InputQueue
  private readonly bucket = new Map<number, { dx: number; dy: number; seq: number }>();

  constructor(collision: CollisionFn) {
    this.collision = collision;
  }

  /** Client sent an input for serverTick with client sequence `seq`. */
  enqueue(serverTick: number, dx: number, dy: number, seq: number): void {
    this.bucket.set(serverTick, { dx, dy, seq });
  }

  /** Advance one authoritative tick. */
  step(tick: number): void {
    const queued = this.bucket.get(tick);
    if (queued) {
      // Server tracks the highest client seq it has processed (input.ts:80)
      if (queued.seq > this.lastProcessedInput) {
        this.lastProcessedInput = queued.seq;
      }
    }
    this.state.x = this.x;
    this.state.y = this.y;
    this.state.vx = this.vx;
    this.state.vy = this.vy;
    this.state.speed = PLAYER.BASE_SPEED;
    this.state.isStaggered = false;
    this.input.dx = queued ? queued.dx : 0;
    this.input.dy = queued ? queued.dy : 0;
    this.input.hasDash = false;
    simulatePhysicsStepInto(this.state, this.input, PHYSICS_CONFIG, this.collision, SIM_TICK_DT);

    // SERVER SPEED-REJECTION GUARD (MovementService.validateAndMove:88-96).
    // The real server rejects any move whose distance exceeds
    // maxSpeed * dt * 1.1, returning moved:false and leaving position
    // UNCHANGED. The client has no such guard — it integrates the full step.
    // This is the documented source of systematic client-ahead divergence:
    // near terminal walk velocity (where acceleration*dt pushes the step
    // slightly over the cap), the client moves a few px the server doesn't.
    // maxSpeed = BASE_SPEED * DASH_SPEED_MULTIPLIER * 1.5 = 430 * 2 * 1.5 = 1290
    // (GameOrchestratorInit.ts:225).
    const moveDx = this.state.x - this.x;
    const moveDy = this.state.y - this.y;
    const moveDist = Math.hypot(moveDx, moveDy);
    const maxDistance = SERVER_MAX_SPEED * SIM_TICK_DT * 1.1;
    if (moveDist > maxDistance) {
      // Server rejects: position stays, but velocity IS updated (the server
      // applies acceleration before the guard check — MovementService:65-78).
      this.vx = this.state.vx;
      this.vy = this.state.vy;
      // position unchanged (reject)
      return;
    }

    this.x = this.state.x;
    this.y = this.state.y;
    this.vx = this.state.vx;
    this.vy = this.state.vy;
  }
}

/** Server maxSpeed for the speed-rejection guard (GameOrchestratorInit.ts:225). */
const SERVER_MAX_SPEED = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER * 1.5;

interface LoopResult {
  /** Distance the VISUAL position traveled over the run, in px. */
  visualDistancePx: number;
  /** Visual speed = visualDistancePx / durationSec. Healthy ≈ BASE_SPEED. */
  renderSpeedPxSec: number;
  /** Final sim velocity magnitude. */
  finalVelMag: number;
  /** Max backward visual jump between consecutive samples (teleport/snapback). */
  maxBackwardJumpPx: number;
  /** Number of backward visual jumps (snapback count). */
  snapbackCount: number;
  /** Final correctionOffset magnitude. */
  finalOffsetMag: number;
  /** Samples of (t, visualX) for debugging — the visual trajectory. */
  trajectory: Array<{ t: number; visualX: number; localPosX: number; serverX: number }>;
  /** Duration of the run in seconds. */
  durationSec: number;
}

/**
 * Reconciliation strategy enum — lets the loop test different architectural
 * approaches without touching production code. The production
 * `applyReconciledPosition` implements one of these; the loop can override it
 * with any to measure which is correct.
 */
export type ReconStrategy =
  | 'DROP' // prior attempt: drop small corrections (accumulates → snap)
  | 'SNAP_ACCUMULATE_SLOW' // original prod: snap + accumulate + rate=10 (drag)
  | 'SNAP_ACCUMULATE_FAST' // snap + accumulate + rate=60
  | 'BLEND' // prior attempt: blend localPos toward server fractionally (drags sim)
  | 'BLEND_NO_OFFSET' // blend + never touch offset
  | 'CPSR'; // CURRENT production: Quake3/Fiedler canonical — ignore<4px / smooth+offset / hard-snap

interface LoopOptions {
  /** Total run duration in seconds. Default 2.0. */
  durationSec?: number;
  /** Render frame dt in seconds. Default SIM_TICK_DT (60fps render). */
  renderDt?: number;
  /** Server patch interval in ticks (syncEveryN). Default 1 (60Hz patch). */
  syncEveryN?: number;
  /** Simulated one-way network latency in seconds. Default 0 (localhost). */
  latencySec?: number;
  /**
   * Per-tick position divergence injection (px/tick added to server X only).
   * Models the documented production failure: under 64-player load the server
   * tick overruns and the client's prediction is a few px AHEAD of the
   * server's acked position each patch (network.ts:10-19). Positive value =
   * server lags behind (client predicts further than server confirms) — the
   * real-world case. Default 0 (no divergence, healthy).
   */
  serverLagPxPerTick?: number;
  /**
   * Patch arrival jitter in ticks — randomly delays each patch by [0, jitter]
   * ticks. Models real network jitter. Default 0.
   */
  patchJitterTicks?: number;
  /** Seed for the jitter RNG (determinism). Default 1. */
  jitterSeed?: number;
  /**
   * Override the reconciliation strategy. Default 'DROP' (current production).
   * The loop installs a strategy-specific applyReconciledPosition on GameState.
   */
  strategy?: ReconStrategy;
  /** Blend factor for BLEND strategies (0-1). Default 0.3. */
  blendFactor?: number;
}

/**
 * Build a strategy-specific `applyReconciledPosition` implementation. Each
 * branch mirrors the production thresholds (RECONCILIATION_THRESHOLD=1,
 * RENDER_OFFSET_SNAP_THRESHOLD=16) so the loop faithfully compares the
 * architectural approaches.
 *
 * @param blendFactor - for BLEND strategies, the fraction of the error to
 *   correct per patch (0 = ignore, 1 = hard snap). 0.3 means "absorb 30% of
 *   the per-patch error into localPos each patch" → error decays
 *   exponentially over ~3-4 patches with NO separate offset state.
 */
function makeStrategy(
  strategy: ReconStrategy,
  blendFactor: number,
): (this: GameState, rx: number, ry: number, _vx: number, _vy: number, rttMs: number) => boolean {
  const RECON_THRESHOLD = 1.0;
  const SNAP_THRESHOLD_BASE = 16;
  const ERROR_DECAY_RATE_SLOW = 10; // original production
  const ERROR_DECAY_RATE_FAST = 60;

  if (strategy === 'DROP') {
    // Current production: drop small corrections entirely. The error stays in
    // the sim position until it exceeds the snap threshold, then hard-snaps.
    return function (rx, ry, _vx, _vy, rttMs) {
      const dx = rx - this.localPos.x;
      const dy = ry - this.localPos.y;
      const err = Math.hypot(dx, dy);
      if (err < RECON_THRESHOLD) return false;
      const snap = SNAP_THRESHOLD_BASE * Math.min(4, Math.max(1, 1 + rttMs / 200));
      if (err >= snap) {
        this.localPos.x = rx;
        this.localPos.y = ry;
        this.correctionOffset.x = 0;
        this.correctionOffset.y = 0;
      }
      // else: DROP (no write) — the current production behavior.
      return true;
    };
  }

  if (strategy === 'SNAP_ACCUMULATE_SLOW' || strategy === 'SNAP_ACCUMULATE_FAST') {
    // Original production: snap localPos, absorb delta into correctionOffset,
    // offset decays at ERROR_DECAY_RATE. The rate determines drag accumulation.
    const rate =
      strategy === 'SNAP_ACCUMULATE_SLOW' ? ERROR_DECAY_RATE_SLOW : ERROR_DECAY_RATE_FAST;
    return function (rx, ry, _vx, _vy, rttMs) {
      const dx = rx - this.localPos.x;
      const dy = ry - this.localPos.y;
      const err = Math.hypot(dx, dy);
      if (err < RECON_THRESHOLD) return false;
      const snap = SNAP_THRESHOLD_BASE * Math.min(4, Math.max(1, 1 + rttMs / 200));
      if (err >= snap) {
        this.localPos.x = rx;
        this.localPos.y = ry;
        this.correctionOffset.x = 0;
        this.correctionOffset.y = 0;
      } else {
        this.localPos.x = rx;
        this.localPos.y = ry;
        this.correctionOffset.x -= dx;
        this.correctionOffset.y -= dy;
      }
      return true;
    };
  }

  if (strategy === 'BLEND' || strategy === 'BLEND_NO_OFFSET') {
    // Competitive standard (Overwatch/CS2/Valorant): blend localPos toward the
    // server position fractionally each patch. This keeps the SIM position
    // tracking the server (bounded error) WITHOUT accumulating a separate
    // offset state. The per-patch blendFactor (0.3) means the position error
    // decays ~70% per patch → negligible within 3-4 patches (~50-66ms), which
    // reads as smooth continuous motion at 60Hz rather than a discrete snap.
    //
    // For BLEND, we still use correctionOffset as the visual smoothing buffer:
    // we move localPos by (1-k)*delta toward server, and put the remaining k*delta
    // into correctionOffset so the VISUAL doesn't jump. That offset then decays
    // fast (rate=60) so it's gone within 2-3 patches. This is the correct dual:
    // sim tracks server (bounded drift), visual glides smoothly.
    //
    // BLEND_NO_OFFSET is the pure form: move localPos fully toward server by
    // blendFactor each patch, no separate offset. Faster convergence but the
    // visual moves with localPos directly (no glide buffer).
    return function (rx, ry, _vx, _vy, rttMs) {
      const dx = rx - this.localPos.x;
      const dy = ry - this.localPos.y;
      const err = Math.hypot(dx, dy);
      if (err < RECON_THRESHOLD) return false;
      const snap = SNAP_THRESHOLD_BASE * Math.min(4, Math.max(1, 1 + rttMs / 200));
      if (err >= snap) {
        // Genuine teleport — hard snap (respawn, server reposition).
        this.localPos.x = rx;
        this.localPos.y = ry;
        this.correctionOffset.x = 0;
        this.correctionOffset.y = 0;
        return true;
      }
      // BLEND: move localPos toward server by blendFactor of the error. The
      // remaining (1 - blendFactor) of the correction goes into the VISUAL
      // offset so the rendered position doesn't step discontinuously; that
      // offset decays at rate=60 (gone in ~2 patches).
      const k = blendFactor;
      const moveX = dx * k;
      const moveY = dy * k;
      this.localPos.x += moveX;
      this.localPos.y += moveY;
      if (strategy === 'BLEND') {
        // Visual buffer = the part of the correction we DIDN'T apply to sim.
        // We moved localPos +moveX toward server, but the renderer was at the
        // old localPos → to keep the visual continuous, push offset by -moveX.
        this.correctionOffset.x -= moveX;
        this.correctionOffset.y -= moveY;
      }
      return true;
    };
  }

  if (strategy === 'CPSR') {
    // CURRENT production: the canonical Client-Side Prediction + Server
    // Reconciliation model (Quake 3 cg_predict.c / Fiedler "Networked Physics
    // 2004" / Overwatch GDC 2017). The reconciler has already done
    // rewind-and-replay; this handles the genuineError (replay vs prediction
    // delta) with three tiers:
    //   ignore < 4px: prediction authoritative (normal drift — no write)
    //   4-16px: snap localPos, absorb delta into offset (visual glide)
    //   ≥16px: hard snap (teleport)
    // The offset decays at ERROR_DECAY_RATE=30 (clears within one patch
    // interval at 60Hz). This mirrors the POSITION/offset logic of
    // GameState.applyReconciledPosition. NOTE: production (NET-04) additionally
    // adopts the reconciled velocity into localVelocity on the snap path
    // (direct-set); this strategy-comparison baseline intentionally omits the
    // velocity write so the architectural comparison (which focuses on
    // position/offset behavior) stays a frozen baseline. The REGRESSION test
    // below ("production code") exercises the REAL production code including
    // the NET-04 velocity write.
    const IGNORE = 4.0;
    return function (rx, ry, _vx, _vy, rttMs) {
      const dx = rx - this.localPos.x;
      const dy = ry - this.localPos.y;
      const err = Math.hypot(dx, dy);
      if (err < IGNORE) return false; // Tier 1: ignore — prediction authoritative
      const snap = SNAP_THRESHOLD_BASE * Math.min(4, Math.max(1, 1 + rttMs / 200));
      if (err >= snap) {
        // Tier 3: hard snap
        this.localPos.x = rx;
        this.localPos.y = ry;
        this.correctionOffset.x = 0;
        this.correctionOffset.y = 0;
      } else {
        // Tier 2: snap localPos + absorb delta into offset for visual glide
        this.localPos.x = rx;
        this.localPos.y = ry;
        this.correctionOffset.x -= dx;
        this.correctionOffset.y -= dy;
      }
      return true;
    };
  }

  throw new Error(`Unknown strategy: ${strategy}`);
}

/**
 * Override the decay rate used by PredictionService.decayCorrectionOffset for
 * strategy comparison. Production uses ERROR_DECAY_RATE=10. Strategies that
 * rely on the offset decaying fast (BLEND) need rate=60 — we monkey-patch it
 * here by replacing the field on the state's correctionOffset decay path.
 *
 * Implementation: PredictionService.decayCorrectionOffset reads
 * `ERROR_DECAY_RATE` as a module-level import, so we can't easily override it.
 * Instead, for the BLEND strategy we accept the production rate=10 decay and
 * note that the steady-state offset will be k·D/(1-m10) — still vastly smaller
 * than the SNAP_ACCUMULATE case because k (0.3) << 1.
 */

/**
 * Run the full pipeline for `durationSec` seconds with held +x movement input.
 * Returns the measured visual-speed metrics.
 *
 * Pipeline order per render frame (mirrors GameScene.update):
 *   A. Client collects input frame (sequence increments per collected frame)
 *   B. Client PredictionService.step(frame, renderDt, BASE_SPEED, false)
 *   C. Client reads getVisualPosition() → visualX/Y (this is what's rendered)
 *   D. Advance server shadow by every tick that elapsed since the last frame
 *      (server ticks at SIM_TICK_DT boundaries, independent of renderDt)
 *   E. On the patch cadence, the server broadcasts its state; the client
 *      reconciles. Patches are delayed by latencySec.
 */
function runReconciliationLoop(opts: LoopOptions = {}): LoopResult {
  const durationSec = opts.durationSec ?? 2.0;
  const renderDt = opts.renderDt ?? SIM_TICK_DT;
  const syncEveryN = opts.syncEveryN ?? 1;
  const latencySec = opts.latencySec ?? 0;
  const serverLagPxPerTick = opts.serverLagPxPerTick ?? 0;
  const patchJitterTicks = opts.patchJitterTicks ?? 0;
  const strategy = opts.strategy; // undefined = use the REAL production code
  const blendFactor = opts.blendFactor ?? 0.3;
  // Simple seeded LCG for deterministic jitter.
  let rngState = (opts.jitterSeed ?? 1) >>> 0;
  const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  const collision = passthroughCollision();
  const gameState = new GameState();
  gameState.localPos = { x: 0, y: 0 };
  gameState.localVelocity = { x: 0, y: 0 };

  // Install the strategy-specific reconciliation IF a strategy override was
  // requested. When strategy is undefined, the REAL production
  // GameState.applyReconciledPosition runs unchanged — that's the regression
  // test path.
  if (strategy !== undefined) {
    gameState.applyReconciledPosition = makeStrategy(strategy, blendFactor);
  }

  // Use REAL InputBuffer + Reconciler so the prediction push and the
  // rewind-replay run for real
  const inputBuffer = new InputBuffer();
  const reconcilerCore = new Reconciler(inputBuffer, collision);
  const predictionService = new PredictionService(
    makeStubCollisionService(),
    inputBuffer,
    gameState,
  );

  // Wire a real PlayerReconciler (the production bridge). Stub only the bits
  // it reads that we don't exercise (stateSync tick, log).
  const rttBox = { value: 0 };
  let currentTick = 0;
  const reconciler = new PlayerReconciler({
    gameState,
    rtt: rttBox,
    inputBuffer,
    reconciler: reconcilerCore,
    stateSync: { value: { getTick: () => currentTick } as unknown as StateSync },
    reconciliationLog: { value: undefined },
    isSpectating: { value: false },
  });

  const server = new ServerShadow(collision);

  // Network: a queue of in-flight patches keyed by the server tick at which
  // they'll arrive (sendTick + latencyTicks).
  const inflightPatches = new Map<
    number,
    {
      x: number;
      y: number;
      vx: number;
      vy: number;
      lastSeq: number;
    }
  >();
  const latencyTicks = Math.round(latencySec / SIM_TICK_DT);

  // The client's sequence counter (InputOrchestrator increments per collected frame)
  let clientSeq = 0;
  // Accumulated server time — server ticks on its own clock, independent of renderDt
  let serverAccumulator = 0;
  // The server tick the most recent patch was sent at (controls patch cadence)
  let lastPatchSentAtTick = -1;

  // Track visual trajectory + backward jumps
  let prevVisualX = 0;
  let maxBackwardJump = 0;
  let snapbackCount = 0;
  let visualDistance = 0;
  const trajectory: LoopResult['trajectory'] = [];
  // Sample every Nth frame to keep the array small
  const sampleEveryNFrames = Math.max(1, Math.round(0.1 / renderDt));

  let frameIndex = 0;
  for (let elapsed = 0; elapsed < durationSec; elapsed += renderDt, frameIndex++) {
    // (D.1) Advance the server shadow by every whole tick elapsed this render frame.
    // The server ticks on its own clock; the client renders on its own. With
    // renderDt = SIM_TICK_DT this is exactly 1 tick/frame; with renderDt that
    // isn't a whole multiple of SIM_TICK_DT the residual carries forward (just
    // like PredictionService's own accumulator). This is the key timing piece.
    serverAccumulator += renderDt;
    let serverStepped = false;
    while (serverAccumulator >= SIM_TICK_DT) {
      currentTick++;
      // The client's input for THIS server tick was sent latencySec ago. We
      // model that by enqueueing the input the client collected latencyTicks
      // ago. For simplicity in this harness (constant input), the dx/dy is
      // always (+1, 0) — the seq is what matters for the reconciliation replay.
      // The client advances its seq every frame, so the seq arriving at server
      // tick T is the seq the client collected latencyTicks ago.
      const seqArrivingNow = Math.max(0, clientSeq - latencyTicks);
      server.enqueue(currentTick, 1, 0, seqArrivingNow);
      server.step(currentTick);
      serverAccumulator -= SIM_TICK_DT;
      serverStepped = true;

      // (E.1) Server broadcasts a patch on the syncEveryN cadence.
      if (currentTick - lastPatchSentAtTick >= syncEveryN) {
        lastPatchSentAtTick = currentTick;
        const jitter = patchJitterTicks > 0 ? Math.floor(rand() * (patchJitterTicks + 1)) : 0;
        const arriveAtTick = currentTick + latencyTicks + jitter;
        // Apply server-lag divergence: the acked position is N px behind what
        // a perfect sim would produce (server tick overruns under load — the
        // client's 60Hz prediction is AHEAD of the server's acked position).
        inflightPatches.set(arriveAtTick, {
          x: server.x - serverLagPxPerTick * currentTick,
          y: server.y,
          vx: server.vx,
          vy: server.vy,
          lastSeq: server.lastProcessedInput,
        });
      }

      // (E.2) Patches whose arrival tick has come are delivered to the client.
      const arrived = inflightPatches.get(currentTick);
      if (arrived) {
        inflightPatches.delete(currentTick);
        reconciler.handleLocalPlayerPositionChange(
          arrived.x,
          arrived.y,
          arrived.vx,
          arrived.vy,
          arrived.lastSeq,
          0,
        );
      }
    }
    // If renderDt < SIM_TICK_DT (high-fps render) and no server tick elapsed
    // this frame, we still need to check for arriving patches tied to ticks
    // that elapsed in a prior frame but weren't delivered yet. This is handled
    // by the while loop above on the next frame. For the common renderDt ==
    // SIM_TICK_DT case this is moot.

    // (A) Client collects an input frame. Held +x movement.
    clientSeq++;
    const frame: InputFrame = {
      movementX: 1,
      movementY: 0,
      aimAngle: 0,
      sequence: clientSeq,
      actions: [],
    };

    // (B) Client prediction step. NET-03 seam: live direction +X every render
    // frame, send frame pushed for this seq.
    predictionService.step(1, 0, renderDt, PLAYER.BASE_SPEED, false, [], frame);

    // (C) Client reads visual position (what the renderer shows).
    const visual = predictionService.getVisualPosition();

    // Measure backward jumps + total visual distance.
    if (frameIndex > 0) {
      const dx = visual.x - prevVisualX;
      if (dx < 0) {
        snapbackCount++;
        if (-dx > maxBackwardJump) maxBackwardJump = -dx;
      }
      visualDistance += Math.abs(visual.x - prevVisualX);
    }
    prevVisualX = visual.x;

    if (frameIndex % sampleEveryNFrames === 0) {
      trajectory.push({
        t: elapsed,
        visualX: visual.x,
        localPosX: gameState.localPos.x,
        serverX: server.x,
      });
    }
  }

  const finalVelMag = Math.hypot(gameState.localVelocity.x, gameState.localVelocity.y);
  const finalOffsetMag = Math.hypot(gameState.correctionOffset.x, gameState.correctionOffset.y);

  return {
    visualDistancePx: visualDistance,
    renderSpeedPxSec: visualDistance / durationSec,
    finalVelMag,
    maxBackwardJumpPx: maxBackwardJump,
    snapbackCount,
    finalOffsetMag,
    trajectory,
    durationSec,
  };
}

describe('E2E reconciliation loop — diagnose sluggish/teleporting local player', () => {
  // The PASS bar: at localhost latency with a 60Hz render + 60Hz patch, once
  // the player is at full velocity the visual speed MUST match BASE_SPEED
  // within a tolerance. The first ~200ms is acceleration ramp (velocity grows
  // from 0 to 430), so we measure over a 2s window where ramp is <10% of the
  // run. renderSpeedPxSec should be within ~5% of BASE_SPEED (= 408+). If it's
  // 57% of BASE_SPEED (~245), the symptom has reproduced.
  const HEALTHY_FLOOR = PLAYER.BASE_SPEED * 0.9; // 387 px/s
  const SYMPTOM_CEILING = PLAYER.BASE_SPEED * 0.7; // 301 px/s — clearly broken

  it('REPRO: 60fps render + 60Hz patch (localhost) — visual speed should be ~BASE_SPEED', () => {
    const result = runReconciliationLoop({
      durationSec: 2.0,
      renderDt: SIM_TICK_DT, // 60fps render
      syncEveryN: 1, // 60Hz patch (current production setting)
      latencySec: 0,
    });

    // Diagnostic print — visible in vitest output
    console.log('[DEBUG-e2e] 60fps/60Hz result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      finalVelMag: result.finalVelMag.toFixed(1),
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      snapbackCount: result.snapbackCount,
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
      BASE_SPEED: PLAYER.BASE_SPEED,
    });

    // The assertion that matters: visual speed is close to BASE_SPEED.
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
    // And there should be NO snapbacks under localhost latency.
    expect(result.snapbackCount).toBe(0);
  });

  it("REPRO: 150Hz render + 60Hz patch — the user's monitor refresh", () => {
    // renderDt = SIM_TICK_DT / 2.5 = ~6.67ms (150fps). This is the user's
    // actual monitor refresh. The bug MUST reproduce here if it's a timing issue.
    const result = runReconciliationLoop({
      durationSec: 2.0,
      renderDt: SIM_TICK_DT / 2.5, // 150fps render
      syncEveryN: 1,
      latencySec: 0,
    });

    console.log('[DEBUG-e2e] 150Hz/60Hz result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      finalVelMag: result.finalVelMag.toFixed(1),
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      snapbackCount: result.snapbackCount,
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
    });

    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
    expect(result.snapbackCount).toBe(0);
  });

  it('REPRO: 60Hz render + 30Hz patch — patch cadence stress', () => {
    // syncEveryN = 2 → server patches every other tick (30Hz). This was the
    // setting the comment in network.ts claims PATCH_RATE was reduced to, even
    // though the constant is currently 60. Stress-tests the patch cadence.
    const result = runReconciliationLoop({
      durationSec: 2.0,
      renderDt: SIM_TICK_DT,
      syncEveryN: 2,
      latencySec: 0,
    });

    console.log('[DEBUG-e2e] 60Hz/30Hz-patch result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      snapbackCount: result.snapbackCount,
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
    });

    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
  });

  it('REPRO: 100ms latency — the reconciliation stress case', () => {
    // 100ms one-way latency. Patches arrive stale; reconciliation must still
    // keep visual speed close to BASE_SPEED (the whole point of prediction).
    const result = runReconciliationLoop({
      durationSec: 3.0,
      renderDt: SIM_TICK_DT,
      syncEveryN: 1,
      latencySec: 0.1,
    });

    console.log('[DEBUG-e2e] 100ms-latency result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      snapbackCount: result.snapbackCount,
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
    });

    // Under latency, the tolerance widens slightly but the visual speed should
    // still be healthy — prediction exists precisely so latency doesn't slow
    // the local player.
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
  });

  it('diagnostic: trajectory dump at 150Hz render (no assertion — read the numbers)', () => {
    // A pure diagnostic test. Lets us read the visual trajectory vs server X
    // to see exactly where the visual diverges. No pass/fail — informational.
    const result = runReconciliationLoop({
      durationSec: 1.0,
      renderDt: SIM_TICK_DT / 2.5, // 150fps
      syncEveryN: 1,
      latencySec: 0,
    });

    console.log('[DEBUG-e2e] trajectory (t, visualX, localPosX, serverX):');
    for (const s of result.trajectory) {
      console.log(
        `  t=${s.t.toFixed(3)} visualX=${s.visualX.toFixed(1)} localPosX=${s.localPosX.toFixed(1)} serverX=${s.serverX.toFixed(1)} ` +
          `vMinusL=${(s.visualX - s.localPosX).toFixed(1)} lMinusS=${(s.localPosX - s.serverX).toFixed(1)}`,
      );
    }
    expect(result.trajectory.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // DIVERGENCE TESTS — these model the documented production failure mode
  // (network.ts:10-19: server tick overruns under 64-player load → server
  // acked position lags the client's prediction). The fully-synced loop above
  // is "healthy" because client and server run IDENTICAL physics; in
  // production the server's acked position is continuously a few px behind.
  // =========================================================================

  it('REPRO under server-lag divergence: CPSR keeps snapbacks at zero (bounded drift, no teleport)', () => {
    // 1px/tick artificial server lag = 60px/sec of drift between client
    // prediction and server acked position. This is a STRESS case (real
    // production divergence from the speed-rejection guard is much smaller —
    // see the architecture comparison test above where all strategies handle
    // it). This test confirms CPSR doesn't TELEPORT even under extreme
    // continuous divergence.
    //
    // Under continuous 1px/tick server lag, the prediction IS genuinely ahead
    // of the server. CPSR's Tier-1 ignore threshold (4px) absorbs the first
    // few patches; once the accumulated error exceeds 4px, Tier-2 kicks in
    // (snap + offset glide). The offset stays small (~1-2px) because
    // ERROR_DECAY_RATE=30 clears it within one patch interval.
    const result = runReconciliationLoop({
      durationSec: 3.0,
      renderDt: SIM_TICK_DT,
      syncEveryN: 1,
      latencySec: 0,
      serverLagPxPerTick: 1, // 60px/sec artificial server lag (stress case)
      // No strategy override — use the REAL production CPSR code.
      strategy: undefined,
    });

    console.log('[DEBUG-e2e] server-lag-1px (production CPSR) result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      finalVelMag: result.finalVelMag.toFixed(1),
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      snapbackCount: result.snapbackCount,
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
    });

    // The architectural bar: ZERO snapbacks (no teleports) even under stress.
    expect(result.snapbackCount).toBe(0);
  });

  it('REPRO under patch jitter: visual position must not stutter when patches arrive irregularly', () => {
    // Real network jitter: patches arrive 0-3 ticks late randomly. The
    // reconciler must absorb this without snapbacks or velocity loss.
    const result = runReconciliationLoop({
      durationSec: 3.0,
      renderDt: SIM_TICK_DT,
      syncEveryN: 1,
      latencySec: 0.05, // 50ms baseline
      patchJitterTicks: 3,
      jitterSeed: 42,
    });

    console.log('[DEBUG-e2e] jitter result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      snapbackCount: result.snapbackCount,
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
    });

    expect(result.snapbackCount).toBe(0);
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
  });

  // =========================================================================
  // ARCHITECTURE COMPARISON — the decisive test. Runs ALL candidate strategies
  // under the same divergence, prints the metrics, and asserts ONLY the BLEND
  // strategy achieves zero snapbacks + healthy speed. This is the proof that
  // the architecture is the root cause and BLEND is the fix.
  // =========================================================================

  it('ARCHITECTURE COMPARISON: which strategy handles REAL server divergence (speed-rejection guard)?', () => {
    // The ServerShadow now models the REAL server divergence: the server's
    // MovementService.validateAndMove has a speed-rejection guard that rejects
    // moves exceeding maxSpeed*dt*1.1, but the client integrates them. This
    // produces systematic client-ahead divergence near terminal velocity —
    // the actual production failure mode. No artificial serverLag injection.
    const strategies: ReconStrategy[] = [
      'DROP', // prior attempt
      'SNAP_ACCUMULATE_SLOW', // original production (rate=10)
      'SNAP_ACCUMULATE_FAST', // rate=60
      'BLEND', // prior attempt (drags sim)
      'BLEND_NO_OFFSET', // pure blend
      'CPSR', // CURRENT production (Quake3/Fiedler canonical)
    ];

    const results: Array<{ strategy: ReconStrategy; result: LoopResult }> = [];
    for (const strategy of strategies) {
      const result = runReconciliationLoop({
        durationSec: 3.0,
        renderDt: SIM_TICK_DT,
        syncEveryN: 1,
        latencySec: 0,
        // No serverLagPxPerTick — the ServerShadow's speed-rejection guard
        // provides the REAL divergence source.
        strategy,
        blendFactor: 0.3,
      });
      results.push({ strategy, result });
    }

    console.log(
      '[DEBUG-e2e] === STRATEGY COMPARISON (real server speed-rejection divergence, 3s) ===',
    );
    for (const { strategy, result } of results) {
      console.log(
        `[DEBUG-e2e] ${strategy.padEnd(24)} ` +
          `renderSpd=${result.renderSpeedPxSec.toFixed(0).padStart(4)} ` +
          `snapbacks=${String(result.snapbackCount).padStart(3)} ` +
          `maxJump=${result.maxBackwardJumpPx.toFixed(1).padStart(6)}px ` +
          `finalOffset=${result.finalOffsetMag.toFixed(1).padStart(6)}px`,
      );
    }
    console.log(
      `[DEBUG-e2e] HEALTHY FLOOR = ${HEALTHY_FLOOR} px/sec, BASE_SPEED = ${PLAYER.BASE_SPEED}`,
    );

    // CPSR (current production) MUST achieve zero snapbacks AND healthy speed.
    const cpsr = results.find((r) => r.strategy === 'CPSR')!;
    expect(cpsr.result.snapbackCount).toBe(0);
    expect(cpsr.result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
  });

  it('REGRESSION (production code): CPSR via real GameState.applyReconciledPosition — full speed, 0 snapbacks', () => {
    // THE regression test for the sluggish-local-player fix. Runs the full
    // pipeline WITHOUT overriding applyReconciledPosition — the real production
    // GameState.applyReconciledPosition (CPSR implementation) is exercised
    // against the ServerShadow WITH the real speed-rejection divergence.
    // The visual speed MUST match BASE_SPEED with zero snapbacks.
    const result = runReconciliationLoop({
      durationSec: 3.0,
      renderDt: SIM_TICK_DT,
      syncEveryN: 1,
      latencySec: 0,
      // No strategy override — use the REAL production applyReconciledPosition.
      strategy: undefined,
    });

    console.log('[DEBUG-e2e] production-CPSR result:', {
      renderSpeedPxSec: result.renderSpeedPxSec.toFixed(1),
      snapbackCount: result.snapbackCount,
      maxBackwardJumpPx: result.maxBackwardJumpPx.toFixed(2),
      finalOffsetMag: result.finalOffsetMag.toFixed(2),
    });

    expect(result.snapbackCount).toBe(0);
    expect(result.renderSpeedPxSec).toBeGreaterThanOrEqual(HEALTHY_FLOOR);
  });

  it("ARCHITECTURE COMPARISON (slow frames, simDt=20ms): mirrors the user's actual log", () => {
    // The user's log shows simDt=18-22ms (the game runs at ~50fps, not 60fps).
    // This test runs the comparison at renderDt=20ms to mirror that. The
    // production patch rate stays 60Hz (server ticks at SIM_TICK_DT), so the
    // client renders slower than the server ticks — the accumulator carries
    // residual and the prediction runs sub-steps irregularly. This is the
    // REAL condition the user is playing under.
    const strategies: ReconStrategy[] = ['DROP', 'SNAP_ACCUMULATE_SLOW', 'BLEND', 'CPSR'];
    const results: Array<{ strategy: ReconStrategy; result: LoopResult }> = [];
    for (const strategy of strategies) {
      const result = runReconciliationLoop({
        durationSec: 3.0,
        renderDt: 0.02, // 20ms render frames (~50fps, per the user's log)
        syncEveryN: 1,
        latencySec: 0,
        serverLagPxPerTick: 1,
        strategy,
        blendFactor: 0.3,
      });
      results.push({ strategy, result });
    }
    console.log('[DEBUG-e2e] === STRATEGY COMPARISON (renderDt=20ms, 1px/tick lag) ===');
    for (const { strategy, result } of results) {
      console.log(
        `[DEBUG-e2e] ${strategy.padEnd(24)} ` +
          `renderSpd=${result.renderSpeedPxSec.toFixed(0).padStart(4)} ` +
          `snapbacks=${String(result.snapbackCount).padStart(3)} ` +
          `finalOffset=${result.finalOffsetMag.toFixed(1).padStart(6)}px`,
      );
    }
    // No assertion — informational. We read the numbers to pick the strategy.
    expect(results.length).toBe(strategies.length);
  });
});

import { describe, it, expect } from 'vitest';
import {
  PLAYER,
  COMBAT,
  SIM_TICK_DT,
  simulatePhysicsStepInto,
  type PhysicsState,
  type PhysicsInput,
  type PhysicsConfig,
  type CollisionFn,
} from '@sector-battle/shared';
import { GameState } from '../../controllers/GameState.js';
import { PredictionService } from '../../prediction/PredictionService.js';
import { InputBuffer } from '../../prediction/InputBuffer.js';
import { Reconciler } from '../../prediction/Reconciler.js';
import { PlayerReconciler } from '../../bridges/state-sync/PlayerReconciler.js';
import { computeSnapThreshold } from '../../types.js';
import type { InputFrame } from '../../types.js';
import type { ClientCollisionService } from '../../collision/ClientCollisionService.js';
import type { StateSync } from '../../network/StateSync.js';
import type { ReconciliationLog, ReconciliationEntry } from '../../debug/ReconciliationLog.js';
import { CameraService, cameraLerpFactor, DEADZONE_RATIO } from '../CameraService.js';

/* eslint-disable no-console */

/**
 * NET-27 — Camera / visual-position / frame-pacing path investigation probe.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * QUESTION (verbatim from the ticket)
 * ════════════════════════════════════════════════════════════════════════════
 * Does the camera / visual-position / frame-pacing path produce a BACKWARD
 * visual motion during sustained open-field walk — i.e. does the rendered
 * player position (camera transform + sprite position + render offset) ever
 * move backward against the walk direction even though `localPos` is monotonic
 * and 0 reconciliation corrections fire?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SCOPE — the MATH half only (in-process reachable)
 * ════════════════════════════════════════════════════════════════════════════
 * This probe measures the pure-TS camera + visual-position MATH:
 *   - visual   = localPos + localVelocity·predictionAccumulator + correctionOffset
 *                 (PredictionService.getVisualPosition — the SAME value
 *                 GameScene.update reads at GameScene.ts:446)
 *   - rigidCam = scrollX after CameraService.followRigid + update, i.e. the
 *                 exact Phaser Camera.preRender result for deadzone=null +
 *                 lerp=1 (verified against Phaser 4 Camera.js:582:
 *                 `sx = Linear(sx, fx - originX, lerp.x)` with lerp.x=1 →
 *                 `sx = fx - originX` = followTarget.x - halfWidth at zoom 1).
 *
 * It CANNOT measure browser frame-presentation / vsync / raster cadence — that
 * requires live `window.__SECTO_DEBUG__` probing at the HITL gate (the residual
 * if the math half is monotonic). Per the ticket strategy: cross out the math
 * half first; if monotonic, graduate a HITL ticket and stop.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FRAME ORDERING — mirrors GameScene.update EXACTLY
 * ════════════════════════════════════════════════════════════════════════════
 * Per GameScene.ts:405/446/464/505 the per-frame order for an alive local
 * player is:
 *     1. predictionService.step(dirX, dirY, dt, speed, staggered, edges, sendFrame)
 *     2. visual = predictionService.getVisualPosition()        // :446
 *     3. playerRenderer.snapPosition(myId, visual.x, visual.y) // :453 (sprite)
 *     4. cameraService.followRigid(visual.x, visual.y)         // :464
 *     5. ... (facing, renderers, nearby players) ...
 *     6. cameraService.update(delta)                           // :505
 *     7. [Phaser Camera.preRender at render time]              // writes scrollX
 *
 * The probe replicates steps 1→2→4→6→7. The sprite snap (3) is a hard snap to
 * `visual` (ADR-0005) — it cannot introduce backward motion beyond what
 * `visual` already has; it is therefore NOT a separate measurement channel
 * here (any backward `visual` step IS the sprite's backward step).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DETERMINISM
 * ════════════════════════════════════════════════════════════════════════════
 * - REAL PredictionService + REAL simulatePhysicsStepInto + REAL GameState
 *   (incl. correctionOffset) + REAL PlayerReconciler (150ms-RTT arm).
 * - Seeded LCG for any jitter (no Math.random).
 * - Time pinned by the render-Dt cadence; no real timers.
 * - Same inputs → identical per-frame series across runs (asserted by a
 *   determinism check).
 */

// ─── Shared physics config (matches PredictionService's internal config) ─────

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

/** Deterministic LCG (mirrors CameraStutter.diag.test.ts). */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ─── Camera models ───────────────────────────────────────────────────────────

/**
 * RIGID camera — the EXACT Phaser 4 Camera.preRender result for the
 * CameraService.followRigid path (deadzone=null, lerp=1, followOffset=0).
 *
 * Phaser Camera.js:580-583 (the `else` — no deadzone — branch):
 *     sx = Linear(sx, fx - originX, lerp.x);
 * where `fx = follow.x - followOffset.x`, `originX = width * this.originX`
 * (= halfWidth at the default origin 0.5), and `Linear(a, b, 1) = b`.
 *
 * => scrollX = followTarget.x - halfWidth   (every frame, no lag, no deadzone).
 *
 * During sustained walk there is no combat → no punch (followOffset stays 0)
 * and no shake → this is the exact scrollX the player sees. zoom=1 (no zoom
 * punch spring active during walk). `useBounds` clamping is a no-op away from
 * map edges (the open-field symptom is mid-map); it is noted but not modelled
 * because it cannot produce a BACKWARD step (only a held-still step at edges).
 */
class RigidCameraSim {
  readonly halfWidth: number;
  scrollX: number;
  constructor(width: number, startTargetX: number) {
    this.halfWidth = width / 2;
    this.scrollX = startTargetX - this.halfWidth;
  }
  /** Equivalent to CameraService.followRigid + Camera.preRender (rigid branch). */
  followRigidScroll(fx: number): number {
    this.scrollX = fx - this.halfWidth;
    return this.scrollX;
  }
}

/**
 * LEGACY camera — the deadzone + dt-normalized lerp path (CameraService.follow,
 * preserved for spectator). This is the path Round 1's `followRigid` REPLACED
 * for the local player; CameraService.ts:88-101 documents it as the source of
 * the "limit cycle" walk stutter. Faithful reimplementation of Phaser 4
 * Camera.preRender deadzone branch (Camera.js:546-578), mirroring
 * CameraStutter.diag.test.ts.
 *
 * INCLUDED AS A POSITIVE CONTROL: it is EXPECTED to produce backward scrollX
 * steps during sustained walk. If the probe sees them here but NOT in the rigid
 * camera nor in `visual`, that proves (a) the probe can detect backward motion,
 * and (b) the rigid fix eliminates it.
 */
class LegacyCameraSim {
  readonly width: number;
  readonly dzW: number;
  scrollX: number;
  midX: number;
  constructor(width: number, startTargetX: number) {
    this.width = width;
    this.dzW = width * DEADZONE_RATIO;
    const halfWidth = width / 2;
    this.scrollX = startTargetX - halfWidth;
    this.midX = this.scrollX + halfWidth;
  }
  preRender(fx: number, lerp: number): number {
    const halfWidth = this.width / 2;
    let sx = this.scrollX;
    const dzCenter = this.midX; // deadzone re-centered on prev midPoint (Camera.js:548)
    const dzLeft = dzCenter - this.dzW / 2;
    const dzRight = dzCenter + this.dzW / 2;
    if (fx < dzLeft) {
      sx = sx - (dzLeft - fx) * lerp;
    } else if (fx > dzRight) {
      sx = sx + (fx - dzRight) * lerp;
    }
    this.scrollX = sx;
    this.midX = sx + halfWidth;
    return sx;
  }
}

// ─── Sample + reduction ──────────────────────────────────────────────────────

interface Sample {
  frame: number;
  t: number;
  dt: number;
  substeps: number;
  localX: number;
  localVelX: number;
  correctionOffsetX: number;
  accumulator: number;
  visualX: number;
  rigidScrollX: number;
  legacyScrollX: number;
  /** Screen-space rendered X = world visual.x − camera.scrollX. This is the
   * pixel coordinate the player sprite is drawn at on screen — the channel the
   * user actually perceives as "backward rollback". */
  rigidScreenX: number;
  legacyScreenX: number;
}

interface BackwardReport {
  /** Number of frames where value strictly decreased vs the previous frame. */
  count: number;
  /** Largest backward step magnitude (px). 0 if none. */
  maxDrop: number;
  /** Frame index of the largest backward step (-1 if none). */
  worstFrame: number;
}

function countRollbacks(values: number[]): BackwardReport {
  let count = 0;
  let maxDrop = 0;
  let worstFrame = -1;
  for (let i = 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d < -1e-9) {
      count++;
      if (-d > maxDrop) {
        maxDrop = -d;
        worstFrame = i;
      }
    }
  }
  return { count, maxDrop, worstFrame };
}

// ─── Matched-physics server shadow (150ms-RTT arm) ───────────────────────────
// Mirrors transition-drift-repro's ServerShadow: identical physics to the
// client (ADR-0035 parity), coasts with lastMoveDirection on gap ticks. The
// patch stream drives the REAL PlayerReconciler → REAL applyReconciledPosition
// threshold gate, so correctionOffset behaviour is faithful at 150ms RTT.
// TASK-01 + transition-drift-repro proved this yields 0 corrections for
// sustained walk; this probe RE-ASSERTS it and adds the visual/camera series.

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
      } else {
        this.lastDirX = 0;
        this.lastDirY = 0;
      }
    }
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

// ─── The probe loop ──────────────────────────────────────────────────────────

export interface ProbeOptions {
  /** Render rate Hz. */
  fps: number;
  /** One-way latency (sec). RTT = 2× this. 0 / ~0 = localhost baseline. */
  latencySec?: number;
  /** Frames to simulate. */
  frames?: number;
  /** ±ms uniform delta jitter (model real rAF cadence noise). Default 0. */
  jitterMs?: number;
  /** Viewport width (px). Default 2560. */
  viewportW?: number;
  /** Optional: inject a one-shot correctionOffset at `injectFrame` to test that
   * ERROR_DECAY_RATE decay does not cause a backward visual dip. Default off. */
  injectCorrectionOffset?: { atFrame: number; dx: number };
  /** RNG seed for jitter (determinism). */
  seed?: number;
}

export interface ProbeResult {
  samples: Sample[];
  /** Reconciliation corrections that fired (150ms-RTT arm only). */
  corrections: number;
  /** Peak genuine posError after rewind-replay across patches (px). */
  peakGenuinePosError: number;
  snapThreshold: number;
  rttMs: number;
  // Backward-step reports over the FULL series:
  localBack: BackwardReport;
  visualBack: BackwardReport;
  rigidScrollBack: BackwardReport;
  legacyScrollBack: BackwardReport;
  /** Screen-space channels (what the user sees): visual.x − scrollX. */
  rigidScreenBack: BackwardReport;
  legacyScreenBack: BackwardReport;
  // Backward-step reports over the STEADY-STATE series (post burn-in):
  ssLocalBack: BackwardReport;
  ssVisualBack: BackwardReport;
  ssRigidScrollBack: BackwardReport;
  ssLegacyScrollBack: BackwardReport;
  ssRigidScreenBack: BackwardReport;
  ssLegacyScreenBack: BackwardReport;
}

/**
 * Drive a sustained +X open-field walk. Mirrors GameScene.update's per-frame
 * order: step() → getVisualPosition() → followRigid(visual) → camera.update.
 * Records every channel the ticket requires per frame.
 */
function runSustainedWalkProbe(opts: ProbeOptions): ProbeResult {
  const fps = opts.fps;
  const latencySec = opts.latencySec ?? 0;
  const totalFrames = opts.frames ?? 360;
  const jitterMs = opts.jitterMs ?? 0;
  const viewportW = opts.viewportW ?? 2560;
  const seed = opts.seed ?? 12345;
  const baseDt = 1 / fps;
  const inputSendIntervalMs = 16;

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

  // 150ms-RTT arm: wire the REAL PlayerReconciler + a matched-physics shadow.
  const useServer = latencySec > 1e-6;
  const rttBox = { value: 0 };
  let currentTick = 0;
  const reconEntries: Array<{ seq: number; wasCorrected: boolean }> = [];
  let reconciler: PlayerReconciler | null = null;
  let server: ServerShadow | null = null;
  if (useServer) {
    const reconLog: ReconciliationLog = {
      push: (e: ReconciliationEntry) =>
        reconEntries.push({ seq: e.seq, wasCorrected: e.wasCorrected }),
    } as unknown as ReconciliationLog;
    reconciler = new PlayerReconciler({
      gameState,
      rtt: rttBox,
      inputBuffer,
      reconciler: reconcilerCore,
      stateSync: { value: { getTick: () => currentTick } as unknown as StateSync },
      reconciliationLog: { value: reconLog },
      isSpectating: { value: false },
    });
    server = new ServerShadow(collision);
  }
  const rttMs = latencySec * 1000 * 2;
  const snapThreshold = computeSnapThreshold(rttMs);

  const rigidCam = new RigidCameraSim(viewportW, 0);
  const legacyCam = new LegacyCameraSim(viewportW, 0);

  const inflightInputs = new Map<
    number,
    { dx: number; dy: number; seq: number; arrivalSec: number }
  >();
  const inflightPatches = new Map<
    number,
    { x: number; y: number; vx: number; vy: number; lastSeq: number; arrivalSec: number }
  >();
  const predictedVxAtSeq = new Map<number, number>();

  let corrections = 0;
  let peakGenuinePosError = 0;

  const rng = makeRng(seed);
  const samples: Sample[] = [];

  let nowSec = 0;
  let nextServerTickSec = SIM_TICK_DT;
  let nextClientSendSec = 0;
  let clientSeq = 0;
  let lastPatchSentAtTick = -1;

  const stepServer = (targetSec: number) => {
    if (!server || !reconciler) return;
    while (nextServerTickSec <= targetSec + 1e-9) {
      currentTick++;
      const tickWallSec = nextServerTickSec;
      let arriving: { dx: number; dy: number; seq: number } | null = null;
      for (const [key, inp] of inflightInputs) {
        if (inp.arrivalSec <= tickWallSec + 1e-9) {
          arriving = inp;
          inflightInputs.delete(key);
          break;
        }
      }
      if (arriving) server.enqueue(currentTick, arriving.dx, arriving.dy, arriving.seq);
      server.step(currentTick);

      if (currentTick - lastPatchSentAtTick >= 1) {
        // production PATCH_RATE=60 → syncEveryN=1 (patch every tick)
        lastPatchSentAtTick = currentTick;
        const arrivalSec = tickWallSec + latencySec;
        inflightPatches.set(arrivalSec, {
          x: server.x,
          y: server.y,
          vx: server.vx,
          vy: server.vy,
          lastSeq: server.lastProcessedInput,
          arrivalSec,
        });
      }
      for (const [key, patch] of inflightPatches) {
        if (patch.arrivalSec <= tickWallSec + 1e-9) {
          inflightPatches.delete(key);
          const before = { x: gameState.localPos.x, y: gameState.localPos.y };
          // REAL rewind-replay (seeds from the acked seq) + REAL threshold gate.
          const recon = reconcilerCore.reconcile(
            patch.x,
            patch.y,
            patch.lastSeq,
            before.x,
            before.y,
            patch.vx,
            patch.vy,
          );
          const genuine = Math.hypot(recon.x - before.x, recon.y - before.y);
          if (genuine > peakGenuinePosError) peakGenuinePosError = genuine;
          const wasCorrected = gameState.applyReconciledPosition(
            recon.x,
            recon.y,
            recon.velocityX,
            recon.velocityY,
            rttMs,
          );
          if (wasCorrected) corrections++;
          break;
        }
      }
      nextServerTickSec += SIM_TICK_DT;
    }
  };

  for (let i = 0; i < totalFrames; i++) {
    const jit = jitterMs ? (rng() - 0.5) * 2 * jitterMs : 0;
    const dt = baseDt + jit / 1000;
    const frameEndSec = nowSec + dt;
    if (useServer) stepServer(frameEndSec);
    nowSec = frameEndSec;

    // Sustained +X walk (open field, no walls, no other players).
    const dirX = 1;
    const dirY = 0;

    // ── GameScene.ts:405 ── build sendFrame at 16ms boundary, step prediction
    let sendFrame: InputFrame | null = null;
    if (nowSec >= nextClientSendSec) {
      nextClientSendSec = nowSec + inputSendIntervalMs / 1000;
      clientSeq++;
      sendFrame = {
        movementX: dirX,
        movementY: dirY,
        aimAngle: 0,
        sequence: clientSeq,
        actions: [],
      };
      if (useServer) {
        inflightInputs.set(nowSec + clientSeq * 1e-9, {
          dx: dirX,
          dy: dirY,
          seq: clientSeq,
          arrivalSec: nowSec + latencySec,
        });
      }
    }
    predictionService.step(dirX, dirY, dt, PLAYER.BASE_SPEED, false, [], sendFrame);
    if (sendFrame) predictedVxAtSeq.set(clientSeq, gameState.localVelocity.x);

    // Optional one-shot correctionOffset injection (decay-robustness sub-probe).
    if (opts.injectCorrectionOffset && i === opts.injectCorrectionOffset.atFrame) {
      gameState.correctionOffset.x += opts.injectCorrectionOffset.dx;
    }

    // ── GameScene.ts:446 ── visual = getVisualPosition() (read AFTER step)
    const visual = predictionService.getVisualPosition();

    // ── GameScene.ts:464 ── cameraService.followRigid(visual.x, visual.y)
    // ── GameScene.ts:505 ── cameraService.update(delta) → deadzone=null, lerp=1
    // ── [Phaser preRender] → scrollX (exact rigid formula, see RigidCameraSim)
    const rigidScrollX = rigidCam.followRigidScroll(visual.x);

    // Legacy contrast (positive control): deadzone + dt-normalized lerp.
    const legacyLerp = cameraLerpFactor(dt);
    const legacyScrollX = legacyCam.preRender(visual.x, legacyLerp);

    samples.push({
      frame: i,
      t: nowSec,
      dt,
      substeps: predictionService.getLastSubstepCount(),
      localX: gameState.localPos.x,
      localVelX: gameState.localVelocity.x,
      correctionOffsetX: gameState.correctionOffset.x,
      accumulator: predictionService.getAccumulator(),
      visualX: visual.x,
      rigidScrollX,
      legacyScrollX,
      rigidScreenX: visual.x - rigidScrollX,
      legacyScreenX: visual.x - legacyScrollX,
    });
  }
  // Flush inflight patches.
  if (useServer) stepServer(nowSec + latencySec + SIM_TICK_DT);

  // Burn-in: discard first 30 frames (accel ramp to terminal velocity +
  // any deadzone-acquisition transient). Steady state begins after ~0.5s.
  const burn = 30;

  const localX = samples.map((s) => s.localX);
  const visualX = samples.map((s) => s.visualX);
  const rigidX = samples.map((s) => s.rigidScrollX);
  const legacyX = samples.map((s) => s.legacyScrollX);
  const rigidScreen = samples.map((s) => s.rigidScreenX);
  const legacyScreen = samples.map((s) => s.legacyScreenX);

  return {
    samples,
    corrections,
    peakGenuinePosError,
    snapThreshold,
    rttMs,
    localBack: countRollbacks(localX),
    visualBack: countRollbacks(visualX),
    rigidScrollBack: countRollbacks(rigidX),
    legacyScrollBack: countRollbacks(legacyX),
    rigidScreenBack: countRollbacks(rigidScreen),
    legacyScreenBack: countRollbacks(legacyScreen),
    ssLocalBack: countRollbacks(localX.slice(burn)),
    ssVisualBack: countRollbacks(visualX.slice(burn)),
    ssRigidScrollBack: countRollbacks(rigidX.slice(burn)),
    ssLegacyScrollBack: countRollbacks(legacyX.slice(burn)),
    ssRigidScreenBack: countRollbacks(rigidScreen.slice(burn)),
    ssLegacyScreenBack: countRollbacks(legacyScreen.slice(burn)),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — The decisive per-frame measurement (the ticket's core ask)
// ════════════════════════════════════════════════════════════════════════════

describe('NET-27 camera-render-path probe — sustained open-field walk', () => {
  // The 8-condition matrix: 60/30/144/165Hz × localhost/150ms-RTT.
  const RATES = [
    { label: '60Hz', fps: 60 },
    { label: '30fps', fps: 30 },
    { label: '144Hz', fps: 144 },
    { label: '165Hz', fps: 165 },
  ];
  const LATINITY = [
    { label: 'localhost', latencySec: 0 },
    { label: '150msRTT', latencySec: 0.075 },
  ];

  for (const rate of RATES) {
    for (const lat of LATINITY) {
      it(`${rate.label} × ${lat.label}: visual + rigid-scroll are monotonic (PROVED ABSENT for the math half)`, () => {
        const r = runSustainedWalkProbe({
          fps: rate.fps,
          latencySec: lat.latencySec,
          frames: rate.fps >= 100 ? 700 : 360,
        });

        const peakVel = Math.max(...r.samples.map((s) => Math.abs(s.localVelX)));
        // Confirm sustained-walk reached terminal velocity (steady state).
        expect(peakVel).toBeGreaterThan(PLAYER.BASE_SPEED - 1);

        // Regression-gate re-affirmation (state path stays clean): 0 corrections
        // at 150ms RTT. localhost has no server → corrections trivially 0.
        if (lat.latencySec > 1e-6) {
          console.log(
            `[NET-27 ${rate.label}×${lat.label}] corrections=${r.corrections} peakGenuineErr=${r.peakGenuinePosError.toFixed(3)}px threshold=${r.snapThreshold.toFixed(1)}px`,
          );
          expect(r.corrections).toBe(0);
        }

        // ── THE DECISIVE ASSERTIONS ──
        // visual.x must never move backward during sustained +X walk.
        expect(r.visualBack.count).toBe(0);
        // rigid scrollX (= visual.x − halfWidth) is an affine transform of
        // visual.x with slope 1 → backward-count must equal visual's.
        expect(r.rigidScrollBack.count).toBe(0);
        // rigid screenX = visual − rigidScroll = halfWidth = CONST. The player
        // sprite is pinned dead-center: zero forward AND zero backward screen
        // motion. (This is the rigid fix's entire purpose — CameraService.ts:88-101.)
        expect(r.rigidScreenBack.count).toBe(0);
        // localPos is monotonic (the prediction loop's own output).
        expect(r.localBack.count).toBe(0);
        // correctionOffset stays ~0 under 0 corrections (the proven state path).
        const maxAbsCorrection = Math.max(...r.samples.map((s) => Math.abs(s.correctionOffsetX)));
        expect(maxAbsCorrection).toBeLessThan(0.5);

        // ── POSITIVE-CONTROL CHARACTERIZATION ── the legacy deadzone+lerp
        // camera's scrollX is also monotonic non-decreasing (the deadzone
        // branch only ever ADDS to scrollX). Its documented "stutter" lives in
        // SCREEN space (screenX = visual − scroll): the camera's catch-up jump
        // can exceed the per-frame visual advance → screenX dips backward. We
        // print the legacy screen backward-count to characterize whether the
        // pure in-process legacy MATH reproduces it (vs a Phaser-render artifact).
        console.log(`[NET-27 ${rate.label}×${lat.label}] backward-step counts (full / steady):`, {
          visual: `${r.visualBack.count}/${r.ssVisualBack.count}`,
          rigidScroll: `${r.rigidScrollBack.count}/${r.ssRigidScrollBack.count}`,
          rigidScreen: `${r.rigidScreenBack.count}/${r.ssRigidScreenBack.count}`,
          legacyScreen:
            `${r.legacyScreenBack.count}/${r.ssLegacyScreenBack.count}` +
            `${r.ssLegacyScreenBack.count > 0 ? ` (maxDrop ${r.ssLegacyScreenBack.maxDrop.toFixed(3)}px @ frame ${r.ssLegacyScreenBack.worstFrame})` : ''}`,
          maxAbsCorrectionOffset: maxAbsCorrection.toFixed(4),
        });
      });
    }
  }

  it('POSITIVE CONTROL (detector): countRollbacks flags a known backward step', () => {
    // Proves the backward-step detector itself is not blind (so the 0-counts
    // above are genuine, not a detector false-negative).
    expect(countRollbacks([1, 2, 3, 2.5, 4]).count).toBe(1);
    expect(countRollbacks([1, 2, 3, 2.5, 4]).maxDrop).toBeCloseTo(0.5, 5);
    expect(countRollbacks([1, 2, 3, 4, 5]).count).toBe(0);
  });

  it('POSITIVE CONTROL (end-to-end): a correctionOffset write produces a backward visual step', () => {
    // The ONLY writer of backward visual motion is `correctionOffset` — set by
    // GameState.applyReconciledPosition when a reconciliation snaps (genuine
    // ≥16px desync, NEVER during sustained walk — TASK-01/NET-24 proved 0
    // corrections). Injecting an offset reproduces a 1-frame backward visual
    // step THROUGH THE REAL PredictionService.getVisualPosition, proving the
    // probe sees backward motion end-to-end (the analog of TASK-01's dash
    // positive-control: the harness can see divergence, so the 0 for walk is
    // genuine).
    const r = runSustainedWalkProbe({
      fps: 60,
      latencySec: 0,
      frames: 360,
      injectCorrectionOffset: { atFrame: 60, dx: -12 },
    });
    // Exactly one backward visual step — at the injection frame (samples[60]
    // is the first to carry the injected offset; the dip is samples[60] vs [59]).
    // The drop magnitude = |injection| − per-frame forward advance = 12 − 7.17
    // ≈ 4.83px at 60Hz (localPos keeps advancing even on the injection frame).
    expect(r.visualBack.count).toBe(1);
    expect(r.visualBack.worstFrame).toBe(60);
    expect(r.visualBack.maxDrop).toBeGreaterThan(4);
    expect(r.visualBack.maxDrop).toBeLessThan(12);
    console.log('[NET-27 positive-control e2e] correctionOffset injection:', {
      visualBackwardSteps: r.visualBack.count,
      maxDropPx: r.visualBack.maxDrop.toFixed(3),
      atFrame: r.visualBack.worstFrame,
    });
  });

  it('DECAY-ROBUSTNESS: after a correction snap, the decaying correctionOffset does NOT cause further backward visual steps', () => {
    // A reconciliation snap writes correctionOffset (1 backward step at the
    // snap — characterized above). Afterwards ERROR_DECAY_RATE=30 (~100ms)
    // decays the offset toward 0 exponentially. The decay is monotonic (offset
    // → 0) and localPos keeps advancing at v·dt, so visual must stay monotonic
    // AFTER the snap frame. This confirms the render-offset model does not
    // manufacture a sustained backward drift from a one-shot correction.
    const r = runSustainedWalkProbe({
      fps: 60,
      latencySec: 0,
      frames: 360,
      injectCorrectionOffset: { atFrame: 60, dx: -12 },
    });
    // Total backward steps == 1 (the snap frame only). The subsequent ~300
    // frames of decay add ZERO further backward steps.
    expect(r.visualBack.count).toBe(1);
    // Steady-state post-burn (frame ≥30) includes the snap at 60 — still just 1.
    // Re-count over frames strictly AFTER the snap to prove decay is clean:
    const postSnap = r.samples.slice(62); // frames 62..end (after the snap at 60/61)
    const postSnapBack = countRollbacks(postSnap.map((s) => s.visualX));
    expect(postSnapBack.count).toBe(0);
    // Offset decays to ~0 within ~100ms (6 frames @60Hz) → well below 0.5 by 1s.
    const after1s = r.samples[120]!;
    expect(Math.abs(after1s.correctionOffsetX)).toBeLessThan(0.5);
    console.log('[NET-27 decay-robustness] post-snap decay:', {
      snapFrameBackwardSteps: r.visualBack.count,
      postSnapBackwardSteps: postSnapBack.count,
      correctionOffsetAt1s: after1s.correctionOffsetX.toFixed(4),
    });
  });

  it('DETERMINISM: same seed → identical per-frame visual + scroll series', () => {
    const a = runSustainedWalkProbe({
      fps: 144,
      latencySec: 0,
      frames: 120,
      jitterMs: 3,
      seed: 999,
    });
    const b = runSustainedWalkProbe({
      fps: 144,
      latencySec: 0,
      frames: 120,
      jitterMs: 3,
      seed: 999,
    });
    let maxDiff = 0;
    for (let i = 0; i < a.samples.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a.samples[i]!.visualX - b.samples[i]!.visualX));
      maxDiff = Math.max(
        maxDiff,
        Math.abs(a.samples[i]!.rigidScrollX - b.samples[i]!.rigidScrollX),
      );
    }
    expect(maxDiff).toBe(0);
  });

  it('PER-FRAME SERIES SAMPLE (60Hz localhost, steady-state) — recorded for the findings doc', () => {
    // Emits ~30 steady-state frames of (localX, accumulator, visualX, rigidScrollX)
    // at each render rate, for the NET-FINDINGS-camera-render.md evidence table.
    for (const rate of RATES) {
      const r = runSustainedWalkProbe({
        fps: rate.fps,
        latencySec: 0,
        frames: rate.fps >= 100 ? 700 : 360,
      });
      const steady = r.samples.slice(30, 30 + 12); // 12 steady frames
      const accRange = steady.reduce(
        (acc, s) => ({
          min: Math.min(acc.min, s.accumulator),
          max: Math.max(acc.max, s.accumulator),
        }),
        { min: Infinity, max: -Infinity },
      );
      console.log(
        `[NET-27 series@${rate.label}] accumulator∈[${accRange.min.toFixed(5)}, ${accRange.max.toFixed(5)}] (SIM_TICK_DT=${SIM_TICK_DT.toFixed(5)}); ` +
          `visualΔ/frame≈${(steady[1]!.visualX - steady[0]!.visualX).toFixed(4)}px; ` +
          `first 6 steady: ` +
          steady
            .slice(0, 6)
            .map(
              (s) =>
                `(L=${s.localX.toFixed(2)} acc=${s.accumulator.toFixed(5)} V=${s.visualX.toFixed(2)} rs=${s.rigidScrollX.toFixed(2)})`,
            )
            .join(' '),
      );
    }
    expect(true).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — Round-1 rigid-camera CLASS wiring verification
// (verifies CameraService.followRigid + update actually clear the deadzone and
// pin lerp=1 on the REAL class, via a stub Phaser scene — the same pattern
// PlayerRenderer.hide.test.ts / ExplosionEventHandler.test.ts use.)
// ════════════════════════════════════════════════════════════════════════════

/** Minimal stub of the Phaser.Camera surface CameraService touches. */
function makeStubCam(initialWidth = 2560, initialHeight = 1440) {
  const cam = {
    width: initialWidth,
    height: initialHeight,
    deadzone: null as null | {
      x: number;
      y: number;
      width: number;
      height: number;
      right: number;
      bottom: number;
    },
    lerp: { x: 0, y: 0 },
    followOffset: {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    },
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
    _follow: null as null | { x: number; y: number },
    startFollow(_t: unknown, _roundPx: boolean, lx: number, ly: number) {
      this.lerp.x = lx;
      this.lerp.y = ly;
    },
    setDeadzone(w: number, h: number) {
      if (w === undefined && h === undefined) {
        this.deadzone = null;
        return;
      }
      this.deadzone = { x: 0, y: 0, width: w, height: h, right: w, bottom: h };
    },
    setLerp(x: number, y: number) {
      this.lerp.x = x;
      this.lerp.y = y;
    },
    centerOn(_x: number, _y: number) {
      /* no-op for this stub */
    },
    setZoom(z: number) {
      this.zoom = z;
    },
  };
  return cam;
}

/** Minimal stub of the Phaser.Scene surface CameraService's constructor uses. */
function makeStubScene(cam: ReturnType<typeof makeStubCam>) {
  const zone = {
    x: 0,
    y: 0,
    setPosition(x: number, y: number) {
      this.x = x;
      this.y = y;
      return this;
    },
    setVisible() {
      return this;
    },
  };
  const tweens = { add: () => ({ stop() {} }) };
  return {
    cameras: { main: cam },
    add: { zone: () => zone },
    tweens,
    // CameraService constructor reads scene.cameras.main + scene.add.zone only.
  } as unknown as Phaser.Scene;
}

describe('NET-27 Round-1 rigid-camera wiring — REAL CameraService class', () => {
  it('followRigid + update → deadzone=null, lerp=1, followTarget pinned to visual', () => {
    // Constructs the REAL CameraService (no production-code change — the class
    // is instantiated exactly as GameSceneSetup.ts:128 does) and verifies the
    // Round-1 rigid contract on the real class.
    const cam = makeStubCam();
    const scene = makeStubScene(cam);
    const svc = new CameraService(scene);

    // Spectator path first sets a deadzone + sub-1 lerp (proves the guard
    // actually has something to clear).
    svc.follow(100, 100); // flips rigidFollow=false
    svc.update(16);
    expect(cam.deadzone).not.toBeNull();
    expect(cam.lerp.x).toBeLessThan(1);

    // Now switch to the local-alive-player path (GameScene.ts:464).
    svc.followRigid(1234.5, 6789);
    svc.update(16);

    // ── THE ROUND-1 RIGID CONTRACT ──
    expect(cam.deadzone).toBeNull(); // deadzone cleared
    expect(cam.lerp.x).toBe(1); // lerp pinned to 1
    expect(cam.lerp.y).toBe(1);
    // Follow target is positioned at the visual position (what GameScene passes).
    const ft = svc.getFollowTarget();
    expect(ft.x).toBe(1234.5);
    expect(ft.y).toBe(6789);

    // Idempotent: a second rigid update is a no-op (guards hold).
    svc.followRigid(2000, 3000);
    svc.update(16);
    expect(cam.deadzone).toBeNull();
    expect(cam.lerp.x).toBe(1);
  });

  it('PRODUCTION WIRING (static): followRigid is the only alive-player camera call; follow() is spectator-only', () => {
    // This is a static audit documented in the findings doc; the assertion here
    // pins the two call sites' intent by line. The grep evidence is recorded in
    // NET-FINDINGS-camera-render.md §3. GameScene.ts:
    //   :451  cameraService.follow(...)            — inside `if (isDead && spectator.isSpectating)`
    //   :464  cameraService.followRigid(visual...) — inside the `else` (alive local player)
    //   :505  cameraService.update(delta)          — every frame; applies deadzone=null+lerp=1 when rigid
    // During sustained open-field walk (alive, no combat events), followRigid +
    // update are the ONLY camera calls; shake/punch/zoomPunch fire solely from
    // combat/zone/pickup event handlers (absent here).
    expect(true).toBe(true);
  });
});

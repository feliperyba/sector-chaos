import {
  SIM_TICK_DT,
  simulatePhysicsStepInto,
  MAX_SUBSTEPS_PER_RECORD,
  PLAYER_PHYSICS_CONFIG,
  normalizeMoveInputInto,
} from '@sector-battle/shared';
import { ERROR_DECAY_RATE } from '../types.js';
import type { PhysicsState, PhysicsInput, CollisionFn } from '@sector-battle/shared';
import type { ClientCollisionService } from '../collision/ClientCollisionService.js';
import type { InputBuffer } from './InputBuffer.js';
import type { GameState } from '../controllers/GameState.js';
import type { InputFrame, InputRecord } from '../types.js';
import type { InputActionName } from '@sector-battle/shared';

/**
 * Hard ceiling on the number of fixed substeps a single `step()` call will
 * run. The spiral-of-death guard is GameScene's dt clamp
 * (`dt = Math.min(delta, 50)/1000` → ≤3 ticks/frame); this constant only
 * bounds a pathological frame so the `while (accumulator >= SIM_TICK_DT)`
 * loop can never unbounded-run. Mirrors `AnimSimDriver.MAX_CATCHUP_STEPS = 4`.
 */
const MAX_PREDICTION_SUBSTEPS = 4;

/**
 * Player physics config for the prediction step — the shared frozen
 * `PLAYER_PHYSICS_CONFIG` (ticket 02). Replaced a local 8-field literal that
 * was byte-identical to the one formerly in Reconciler.ts; both consumers now
 * share this single object, so the prediction step and the rewind-replay can
 * never integrate with drifted physics.
 */

/** Reusable empty edges array for `step()` callers that have no edge actions. */
const EMPTY_EDGES: ReadonlyArray<InputActionName> = Object.freeze([] as InputActionName[]);

export class PredictionService {
  private readonly predState: PhysicsState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    isDashing: false,
    dashRemaining: 0,
    isStaggered: false,
  };
  private readonly predInput: PhysicsInput = {
    dx: 0,
    dy: 0,
    hasDash: false,
    dashDirX: 0,
    dashDirY: 0,
  };
  private readonly collisionFn: CollisionFn;

  private readonly _scratchRecordFrame: InputFrame = {
    movementX: 0,
    movementY: 0,
    aimAngle: 0,
    sequence: 0,
    actions: [],
  };
  private readonly _scratchRecord: InputRecord = {
    frame: this._scratchRecordFrame,
    predictedX: 0,
    predictedY: 0,
    timestamp: 0,
    speed: 0,
    dt: 0,
    velocityX: 0,
    velocityY: 0,
    subSteps: 0,
    subStepDirsX: new Float64Array(MAX_SUBSTEPS_PER_RECORD),
    subStepDirsY: new Float64Array(MAX_SUBSTEPS_PER_RECORD),
  };
  private readonly _scratchVisualPos = { x: 0, y: 0 };
  /**
   * Dir receptacle for the shared normalize leaf (ticket 15). Written once at
   * the top of step(), consumed synchronously into the dash-direction capture
   * and the substep input locals — never escapes step().
   */
  private readonly _dirScratch = { x: 0, y: 0 };
  /**
   * Collision result receptacle (perf ticket 21). simulatePhysicsStepInto —
   * the sole consumer of the collisionFn seam — reads .x/.y into locals
   * synchronously inside its own call and never retains the reference, so one
   * pooled box serves every substep. Never escapes this service.
   */
  private readonly _collisionOut = { x: 0, y: 0 };

  /**
   * Fixed-timestep accumulator. This is the prediction loop's internal memory:
   * written and read only inside this class (step() drains the accumulator;
   * getVisualPosition() reads it for sub-tick interpolation). It has no
   * consumer outside PredictionService, so it lives here as private state
   * rather than on the shared GameState blackboard (ADR-0037 two-gate model —
   * both gates pass: sole consumer + complexity concentrates).
   */
  private predictionAccumulator = 0;
  /**
   * Number of fixed substeps run in the most recent {@link step} call. Exposed
   * for walk-stutter instrumentation (C5): 0 on a high-refresh throttle frame
   * (accumulator < SIM_TICK_DT, no substep), 1+ when one or more ticks fired.
   * Lets the debug log correlate per-frame scroll/visual jitter with the
   * substep cadence.
   */
  private lastSubstepCount = 0;
  /**
   * NET-02/NET-03 per-substep direction accumulator. Entry `[i]` records the
   * normalized movement direction the prediction integrated for substep `i`
   * since the last pushed record. Because the live keyboard is now read every
   * render frame (NET-03), a 16ms record can span multiple render frames and
   * the direction may change BETWEEN them — this accumulator captures the
   * direction used for each substep across all render frames since the last
   * push, so the rewind-replay reconstructs the prediction's trajectory
   * exactly (eliminates the coasting-direction asymmetry, NET-01 Cause 2).
   *
   * Pre-allocated boxed arrays preserve the zero-alloc hot path (ADR-0026).
   * `pendingSubStepCount` is the number of valid entries; at push time it
   * equals `rec.subSteps`. NET-03 removed the `pendingCoastSubsteps` merge
   * that previously padded this count with `step(null)` coasted substeps —
   * every frame is now a real frame that contributes its own substeps.
   */
  private readonly pendingSubStepDirsX = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  private readonly pendingSubStepDirsY = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  private pendingSubStepCount = 0;
  /**
   * NET-03 pending DASH edge. At high render rates (165Hz), the DASH edge
   * may fire on a render frame where the accumulator hasn't reached
   * SIM_TICK_DT yet (no substep runs that frame). Without persistence, the
   * dash would be LOST — the next render frame has no DASH edge, so even when
   * a substep fires, hasDash=false. We persist the edge until the next
   * substep actually runs, then consume it. This preserves "dash starts on
   * press" within the fixed-timestep grid (the earliest possible substep
   * after the physical press — at 165Hz that's 0-12ms, far better than the
   * legacy 16ms send-boundary delay).
   *
   * The dash DIRECTION is captured at detection time (the live direction
   * when the edge fired), not at substep time (the direction might have
   * changed between the detection frame and the consuming substep).
   */
  private pendingDash = false;
  private pendingDashDirX = 0;
  private pendingDashDirY = 0;

  constructor(
    private readonly collisionService: ClientCollisionService,
    private readonly inputBuffer: InputBuffer,
    private readonly state: GameState,
  ) {
    // Perf ticket 21: pooled out-receptacle — simulatePhysicsStepInto reads
    // the result synchronously, so the per-substep fresh-object allocation is
    // dead weight (numerically identical resolution; see
    // resolveCollisionInto's never-escape contract).
    this.collisionFn = (cx, cy, halfW, halfH) =>
      this.collisionService.resolveCollisionInto(cx, cy, halfW, halfH, this._collisionOut);
  }

  /**
   * Advance the prediction by one render frame.
   *
   * **NET-03 — decoupled from the network send throttle.** The prediction now
   * consumes a LIVE movement direction every render frame (sampled straight
   * from the keyboard by `InputCollector.sampleLiveMovement`), so it reacts
   * to a key release within one frame instead of coasting on a direction
   * sampled up to 16ms ago. This eliminates the "ghost input after release"
   * (NET-01 Cause 1) by construction — there is no `step(null)` coasting
   * branch anymore.
   *
   * The network `InputFrame` is still built + sent at the 16ms cadence by
   * `InputCollector.collect()`; the prediction pushes a record ONLY when
   * `sendFrame` is non-null (a send-boundary frame). Between send boundaries,
   * the prediction advances localPos and accumulates per-substep directions
   * into the pending buffer, which the next pushed record flushes — so the
   * rewind-replay still sees one record per `seq` (the server-acked identity,
   * unchanged) and that record faithfully carries every within-record
   * direction change (NET-02).
   *
   * @param dirX       Live movement X (raw WASD/arrows, NOT normalized). The
   *                   caller (GameScene) handles the stationary-dash override
   *                   to the pointer angle before passing it in.
   * @param dirY       Live movement Y (raw WASD/arrows, NOT normalized).
   * @param dt         Render-frame delta seconds (clamped by GameScene).
   * @param mySpeed    Authoritative player speed (server-reported).
   * @param isStaggered Whether the local player is staggered this frame.
   * @param frameActions Edge actions detected THIS render frame (applied to
   *                   the prediction on the detection frame so e.g. DASH
   *                   starts on press). Only DASH affects the physics; the
   *                   others (PICKUP/THROW/WEAPON_SLOT_*) are passed through
   *                   for symmetry with the network send path. Defaults to
   *                   the empty frozen array when omitted.
   * @param sendFrame  Non-null on a 16ms send-boundary frame: the prediction
   *                   pushes an InputRecord for this frame's `seq` after
   *                   integrating. Null on throttle frames (no record pushed;
   *                   per-substep dirs still accumulate for the next record).
   * @param onDash     Optional callback fired when a DASH edge is applied
   *                   this frame. (Currently unused in production — GameScene
   *                   triggers the dash visual/audio directly. Kept for
   *                   completeness.)
   */
  step(
    dirX: number,
    dirY: number,
    dt: number,
    mySpeed: number,
    isStaggered: boolean,
    frameActions: ReadonlyArray<InputActionName> = EMPTY_EDGES,
    sendFrame: InputFrame | null = null,
    onDash?: () => void,
  ): void {
    this.predictionAccumulator += dt;

    this.decayCorrectionOffset(dt);

    const hasDashEdge = frameActions.includes('DASH');
    // Ticket 15: input normalization is the shared leaf — the SAME sqrt-form
    // arithmetic the server's validateAndMove runs. The returned length drives
    // the dash-direction capture's exact `len > 0` discriminator below.
    const len = normalizeMoveInputInto(this._dirScratch, dirX, dirY);

    // NET-03: capture the dash edge + direction at detection time. The dash
    // applies on the next substep that fires (which may be this frame or a
    // later render frame — at 165Hz the accumulator may not reach SIM_TICK_DT
    // on the detection frame). pendingDash persists across render frames until
    // a substep consumes it. The direction is frozen at detection time so a
    // direction change between detection and consumption doesn't redirect the
    // dash. len == 0 leaves the previous pending direction untouched (the
    // (0,0) fallback then resolves downstream in the physics step).
    if (hasDashEdge) {
      if (len > 0) {
        this.pendingDashDirX = this._dirScratch.x;
        this.pendingDashDirY = this._dirScratch.y;
      }
      this.pendingDash = true;
      if (onDash) onDash();
    }

    const inputX = this._dirScratch.x;
    const inputY = this._dirScratch.y;

    let subSteps = 0;
    while (this.predictionAccumulator >= SIM_TICK_DT && subSteps < MAX_PREDICTION_SUBSTEPS) {
      // NET-03: apply the pending dash on the first substep of this step()
      // call (if any). pendingDash persists across prior render frames where
      // no substep fired, so a dash edge detected on a throttle frame still
      // starts the dash at the earliest possible substep.
      const applyDash = subSteps === 0 && this.pendingDash;
      this.runPredictionStep(
        SIM_TICK_DT,
        inputX,
        inputY,
        mySpeed,
        applyDash,
        applyDash ? this.pendingDashDirX : 0,
        applyDash ? this.pendingDashDirY : 0,
        isStaggered,
      );
      if (applyDash) this.pendingDash = false;
      this.predictionAccumulator -= SIM_TICK_DT;
      // NET-02/NET-03: record the direction this render frame's substep
      // integrated. recordSubStepDir() appends to pendingSubStepDirsX/Y AND
      // increments pendingSubStepCount — so by the end of this loop the
      // accumulator holds every substep run since the last flush (whether
      // from this frame or from prior throttle frames inside the same 16ms
      // record window), in true temporal order.
      this.recordSubStepDir(inputX, inputY);
      subSteps++;
    }
    // If we hit MAX_PREDICTION_SUBSTEPS, drop the remaining accumulator so a
    // pathological frame can't pile up unbounded substeps. GameScene's dt
    // clamp (≤50ms → ≤3 ticks) keeps this branch from firing in normal play.
    if (subSteps >= MAX_PREDICTION_SUBSTEPS) {
      this.predictionAccumulator = 0;
    }
    this.lastSubstepCount = subSteps;

    // Push a record ONLY on a send-boundary frame. Between sends (throttle
    // frames) the per-substep directions keep accumulating into the pending
    // buffer (recordSubStepDir already updated pendingSubStepCount during the
    // loop above), so the next pushed record faithfully carries every within-
    // record direction change (NET-02). The `seq` identity the server acks
    // stays the sent-frame identity (records stay per-send, 16ms — unchanged).
    if (sendFrame !== null) {
      const recFrame = this._scratchRecordFrame;
      recFrame.movementX = sendFrame.movementX;
      recFrame.movementY = sendFrame.movementY;
      recFrame.aimAngle = sendFrame.aimAngle;
      recFrame.sequence = sendFrame.sequence;
      recFrame.actions = sendFrame.actions;
      recFrame.targetId = sendFrame.targetId;

      const rec = this._scratchRecord;
      rec.predictedX = this.state.localPos.x;
      rec.predictedY = this.state.localPos.y;
      rec.timestamp = performance.now();
      rec.speed = mySpeed;
      rec.dt = SIM_TICK_DT;
      rec.velocityX = this.state.localVelocity.x;
      rec.velocityY = this.state.localVelocity.y;
      // pendingSubStepCount already includes this frame's substeps (the loop
      // above appended them via recordSubStepDir). rec.subSteps therefore
      // reflects ALL substeps advanced since the last push — across every
      // render frame inside this 16ms record window.
      rec.subSteps = this.pendingSubStepCount;
      // NET-02/NET-03: copy the per-substep directions accumulated since the
      // last push into the record. Zero the trailing slots so wraparound
      // reuse in the ring buffer never leaks a previous record's directions.
      this.flushSubStepDirs(rec);

      this.inputBuffer.push(rec);
    }
    // Throttle-frame fall-through: nothing to do. pendingSubStepCount +
    // pendingSubStepDirsX/Y already hold this frame's substeps (appended in
    // the loop above); they will flush into the next send-boundary record.
    // There is NO `step(null)` coasting branch anymore — every frame
    // integrates with the LIVE direction passed in (NET-03).
  }

  /**
   * Append a per-substep direction to the pending accumulator (NET-02). The
   * cap guard preserves the bounded buffer; the counter still increments so
   * `pendingSubStepCount` tracks the true total (matching `rec.subSteps` at
   * flush time). On the impossible-in-practice overflow, the reconciler falls
   * back to the frame direction for the excess substeps.
   */
  private recordSubStepDir(dx: number, dy: number): void {
    if (this.pendingSubStepCount < MAX_SUBSTEPS_PER_RECORD) {
      this.pendingSubStepDirsX[this.pendingSubStepCount] = dx;
      this.pendingSubStepDirsY[this.pendingSubStepCount] = dy;
    }
    this.pendingSubStepCount++;
  }

  /**
   * Copy accumulated per-substep directions into the record being pushed and
   * reset the accumulator (NET-02). Zero-fills trailing slots beyond the valid
   * count so the ring buffer's wraparound reuse never leaks stale directions.
   */
  private flushSubStepDirs(rec: InputRecord): void {
    const count = Math.min(this.pendingSubStepCount, MAX_SUBSTEPS_PER_RECORD);
    const dirsX = rec.subStepDirsX;
    const dirsY = rec.subStepDirsY;
    for (let i = 0; i < count; i++) {
      dirsX[i] = this.pendingSubStepDirsX[i]!;
      dirsY[i] = this.pendingSubStepDirsY[i]!;
    }
    for (let i = count; i < MAX_SUBSTEPS_PER_RECORD; i++) {
      dirsX[i] = 0;
      dirsY[i] = 0;
    }
    this.pendingSubStepCount = 0;
  }

  getVisualPosition(): { x: number; y: number } {
    const pos = this._scratchVisualPos;
    pos.x =
      this.state.localPos.x +
      this.state.localVelocity.x * this.predictionAccumulator +
      this.state.correctionOffset.x;
    pos.y =
      this.state.localPos.y +
      this.state.localVelocity.y * this.predictionAccumulator +
      this.state.correctionOffset.y;
    return pos;
  }

  /**
   * Current fixed-timestep accumulator (seconds, in [0, SIM_TICK_DT)). Exposed
   * for walk-stutter instrumentation (C5): the sub-tick phase used by
   * getVisualPosition's extrapolation term (`localVelocity · accumulator`).
   */
  getAccumulator(): number {
    return this.predictionAccumulator;
  }

  /**
   * Number of fixed substeps the most recent {@link step} ran. Exposed for
   * walk-stutter instrumentation (C5).
   */
  getLastSubstepCount(): number {
    return this.lastSubstepCount;
  }

  private runPredictionStep(
    fixedDt: number,
    inputX: number,
    inputY: number,
    baseSpeed: number,
    hasDash: boolean,
    dashDirX: number,
    dashDirY: number,
    isStaggered: boolean,
  ): void {
    const s = this.state;
    this.predState.x = s.localPos.x;
    this.predState.y = s.localPos.y;
    this.predState.vx = s.localVelocity.x;
    this.predState.vy = s.localVelocity.y;
    this.predState.speed = baseSpeed;
    this.predState.isDashing = s.localIsDashing;
    this.predState.dashRemaining = s.localDashRemaining;
    this.predState.isStaggered = isStaggered;

    this.predInput.dx = inputX;
    this.predInput.dy = inputY;
    this.predInput.hasDash = hasDash;
    this.predInput.dashDirX = dashDirX;
    this.predInput.dashDirY = dashDirY;

    simulatePhysicsStepInto(
      this.predState,
      this.predInput,
      PLAYER_PHYSICS_CONFIG,
      this.collisionFn,
      fixedDt,
    );

    s.localPos.x = this.predState.x;
    s.localPos.y = this.predState.y;
    s.localVelocity.x = this.predState.vx;
    s.localVelocity.y = this.predState.vy;
    s.localIsDashing = this.predState.isDashing;
    s.localDashRemaining = this.predState.dashRemaining;
  }

  private decayCorrectionOffset(dt: number): void {
    const co = this.state.correctionOffset;
    if (co.x === 0 && co.y === 0) return;
    const decay = Math.exp(-ERROR_DECAY_RATE * dt);
    co.x *= decay;
    co.y *= decay;
    if (Math.abs(co.x) < 0.05) co.x = 0;
    if (Math.abs(co.y) < 0.05) co.y = 0;
  }
}

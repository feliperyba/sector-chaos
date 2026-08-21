import {
  PLAYER,
  SIM_TICK_DT,
  simulatePhysicsStepInto,
  MAX_SUBSTEPS_PER_RECORD,
  PLAYER_PHYSICS_CONFIG,
  normalizeMoveInputInto,
} from '@sector-battle/shared';
import type { PhysicsState, PhysicsInput, CollisionFn } from '@sector-battle/shared';
import type { InputBuffer } from './InputBuffer.js';

/**
 * Player physics config for the rewind-replay — the shared frozen
 * `PLAYER_PHYSICS_CONFIG` (ticket 02). Replaced a local 8-field literal that
 * was byte-identical to the one formerly in PredictionService.ts; both
 * consumers now share this single object, so the prediction step and the
 * rewind-replay can never integrate with drifted physics.
 */

export type CollisionResolveFn = CollisionFn;

// ──────────────────────────────────────────────────────────────────────────
// NET-01/NET-02 diagnosis instrumentation (opt-in, zero production cost).
//
// `reconInstrumentation` is null in production → the `if` guards below are
// dead branches the JIT elides. The transition-drift harness sets it via
// `setReconcileInstrumentation` to observe, per reconcile + per replayed
// record, whether the replay reconstructs the prediction's trajectory or
// diverges AT THE SEED.
//
// NET-01 identified the prime suspect: the prediction coasts on `step(null)`
// using `lastInputDirection` (the OLD direction) and merges those coasted
// substeps into the next record's `rec.subSteps`; the replay then replayed ALL
// `rec.subSteps` with that record's (NEW) frame direction → at a direction
// transition the coasted steps advanced under the wrong direction → seeding-
// level divergence (latency-independent, high-refresh-amplified).
//
// NET-02 FIXED this: each record now carries the per-substep direction the
// prediction actually integrated (`rec.subStepDirsX/Y`), and the replay below
// consumes them in order. The rewind-replay is now faithful by construction —
// the harness gate (COAST-then-STOP) shows ~0 divergence where it was ~107
// px/s / ~3.56 px before. The instrumentation stays to guard against
// regression and support future netcode work.
// ──────────────────────────────────────────────────────────────────────────

export interface ReconReplayedRecord {
  /** Input sequence of this record (`rec.frame.sequence`). */
  seq: number;
  /** What the PREDICTION recorded for this frame (post-step, at push time). */
  recPredictedX: number;
  recPredictedY: number;
  recVelX: number;
  recVelY: number;
  /** subSteps the prediction attributed to this record (frame + coasted). */
  recSubSteps: number;
  /** The REPLAY's reconstructed state AFTER replaying this record's subSteps. */
  reconXAfter: number;
  reconYAfter: number;
  reconVxAfter: number;
  reconVyAfter: number;
}

export interface ReconPerRecEntry {
  serverSeq: number;
  unackedCount: number;
  /** Seed state at the server-acked tick (server-authoritative, ADR-0033). */
  seedX: number;
  seedY: number;
  seedVx: number;
  seedVy: number;
  records: ReconReplayedRecord[];
  /** Final reconstructed state after replaying all unacked records. */
  finalX: number;
  finalY: number;
  finalVx: number;
  finalVy: number;
}

export let reconInstrumentation: ((entry: ReconPerRecEntry) => void) | null = null;

/**
 * Install/remove the per-reconcile instrumentation sink. The harness calls
 * `setReconcileInstrumentation(fn)` to capture per-record divergence; pass
 * `null` to disable. Production never calls this → the sink stays null.
 */
export function setReconcileInstrumentation(fn: ((entry: ReconPerRecEntry) => void) | null): void {
  reconInstrumentation = fn;
}

export class Reconciler {
  private inputBuffer: InputBuffer;
  private resolveCollision: CollisionResolveFn;
  private readonly reconState: PhysicsState = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    isDashing: false,
    dashRemaining: 0,
    isStaggered: false,
  };
  private readonly reconInput: PhysicsInput = {
    dx: 0,
    dy: 0,
    hasDash: false,
    dashDirX: 0,
    dashDirY: 0,
  };
  private readonly _scratchResult = { x: 0, y: 0, velocityX: 0, velocityY: 0 };
  /**
   * Dir receptacle for the shared normalize leaf (ticket 15). Written once per
   * replayed record, consumed synchronously into the dash-direction and
   * frame-direction locals — never escapes reconcile().
   */
  private readonly _frameDirScratch = { x: 0, y: 0 };

  constructor(inputBuffer: InputBuffer, resolveCollision: CollisionResolveFn) {
    this.inputBuffer = inputBuffer;
    this.resolveCollision = resolveCollision;
  }

  reconcile(
    serverX: number,
    serverY: number,
    serverSeq: number,
    _localX: number,
    _localY: number,
    serverVelocityX: number,
    serverVelocityY: number,
    /**
     * NET-23 — server-authoritative walk-speed scalar for the replay window.
     * The patch carries the player's `movement.speed.value` at the acked tick
     * (PlayerSchema.speed). The replay now integrates the whole unacked window
     * with THIS value (the live server speed at the seed tick) instead of each
     * record's stale `rec.speed` (the client's lagged-at-push-time value). See
     * the per-record loop comment below for why this unmasks the speed/stagger
     * desync. Default BASE_SPEED preserves the legacy seed for callers that
     * don't plumb the patch speed (tests, matched-physics harnesses).
     */
    serverSpeed: number = PLAYER.BASE_SPEED,
    /**
     * NET-23 — server-authoritative staggered flag for the replay window.
     * Derived from PlayerSchema.status & PlayerStatus.STAGGERED at patch time.
     * The replay applies STAGGER_MOVE_SPEED_PENALTY to the seed speed for the
     * whole window (mirroring MovementService's `effectiveMaxSpeed = speed.value
     * * staggerPenalty`). Previously hardcoded false, so a stagger never slowed
     * the replay → masked the desync. Default false preserves the legacy seed.
     */
    serverIsStaggered: boolean = false,
  ): { x: number; y: number; velocityX: number; velocityY: number } {
    const unacked = this.inputBuffer.getUnacknowledged(serverSeq);

    // ADR-0033 invariant: the VELOCITY seed stays the server-authoritative
    // velocity (reconState.vx/vy = serverVelocityX/Y). NET-23 widens ONLY the
    // speed/stagger SCALAR the replay integrates with — never the velocity seed.
    this.reconState.x = serverX;
    this.reconState.y = serverY;
    this.reconState.vx = serverVelocityX;
    this.reconState.vy = serverVelocityY;
    // NET-23: seed the replay's speed + stagger from the SERVER-AUTHORITATIVE
    // patch values (the live server speed/stagger at the acked tick), not from
    // PLAYER.BASE_SPEED. The per-record loop below no longer overwrites these
    // with the client's stale `rec.speed`.
    this.reconState.speed = serverSpeed;
    this.reconState.isStaggered = serverIsStaggered;
    // Derive dash state at the server-acked tick from the authoritative
    // server velocity. simulatePhysicsStepInto is dash-CONTINUOUS: a dash
    // starts on the DASH action edge, then carries across ticks via
    // isDashing + dashRemaining (decremented each step, DASH_DURATION_TICKS=30).
    // The prediction loop preserves this via GameState; the reconciler
    // previously hardcoded isDashing=false, so a correction arriving
    // mid-dash replayed the unacked records at WALK speed (the DASH action
    // only appears on the start-tick record, which was already acked) →
    // position diverged from the server → spurious correction → jitter.
    //
    // Server velocity is authoritative at tick S: if |v| exceeds the walk
    // speed cap, the player was dashing. We can't recover the exact
    // dashRemaining from velocity alone, so search the input buffer backward
    // from serverSeq for the most recent DASH action and compute the
    // remaining ticks. This mirrors the prediction's own dash tracking.
    this.seedDashState(serverSeq, serverVelocityX, serverVelocityY);

    const dt = SIM_TICK_DT;

    // NET-01 instrumentation: only allocate when a sink is attached.
    const sink = reconInstrumentation;
    const recEntries = sink !== null ? ([] as ReconReplayedRecord[]) : null;

    for (let i = 0; i < unacked.count; i++) {
      const rec = unacked.records[i]!;
      // NET-23: do NOT overwrite reconState.speed with rec.speed here. The
      // record's `rec.speed` is the client's lagged-at-push-time view of the
      // server speed (it sees a speed change only when the patch carrying it
      // arrives, ~RTT/2 late). Replaying each record with its stale rec.speed
      // faithfully RECONSTRUCTED the client's (wrong) trajectory, so the
      // genuine error |replay − localPos| stayed small even though the server
      // had integrated the NEW speed for that whole window — masking the
      // persistent positional offset (speed ×1.5: ~35.83px; stagger: ~50.17px
      // transient). The replay now integrates the whole unacked window with the
      // server-authoritative seed speed/stagger (set above from the patch),
      // which reconstructs the SERVER's trajectory → the genuine error reveals
      // the true desync → the threshold gate fires a clean correction → the
      // position converges (correctionOffset smooths it into a glide, no snap).
      //
      // This widens ONLY the speed/stagger scalar the replay integrates with.
      // ADR-0033's velocity-seed invariant holds (reconState.vx/vy above are
      // still the server-authoritative velocity; never seeded from prediction).
      // rec.speed is still written by PredictionService for record fidelity /
      // instrumentation but is no longer the replay's integration scalar.

      // Ticket 15: ONE normalize-leaf call per record replaces the two former
      // hand copies (dash-direction len + frame-direction inputLen — identical
      // expressions on the same unchanged movementX/Y, so a single computation
      // is bit-identical to both). The (1,0) dash fallback stays here
      // (call-site-owned semantics, mirroring the physics step's dash branch).
      const hasDash = rec.frame.actions.includes('DASH');
      let dashDirX = 0;
      let dashDirY = 0;
      const frameLen = normalizeMoveInputInto(
        this._frameDirScratch,
        rec.frame.movementX,
        rec.frame.movementY,
      );
      if (hasDash) {
        if (frameLen > 0) {
          dashDirX = this._frameDirScratch.x;
          dashDirY = this._frameDirScratch.y;
        } else {
          dashDirX = 1;
          dashDirY = 0;
        }
      }

      const frameDirX = this._frameDirScratch.x;
      const frameDirY = this._frameDirScratch.y;

      // The dash direction is derived from the frame movement (edge fires on
      // substep 0 of the record — see note below) and stays constant for the
      // whole record. NET-02 does not change dash edge handling.
      this.reconInput.dashDirX = dashDirX;
      this.reconInput.dashDirY = dashDirY;

      const steps = rec.subSteps ?? 1;
      // NET-02: replay each substep with the direction the prediction ACTUALLY
      // integrated for that substep — captured per-substep on the record. This
      // makes the rewind-replay faithful by construction: at a direction
      // transition a record's coasted substeps (which advanced under the OLD
      // direction via step(null) + lastInputDirection) are replayed under that
      // same old direction, not the record's new frame direction. Eliminates
      // the seeding-level recVelX-vs-reconVx divergence (NET-01 Cause 2). The
      // fallback to frameDirX/Y for s >= MAX (impossible under the dt clamp)
      // preserves the pre-NET-02 behavior for any overflow.
      const dirsX = rec.subStepDirsX;
      const dirsY = rec.subStepDirsY;
      const recordedCount = Math.min(steps, MAX_SUBSTEPS_PER_RECORD);
      for (let s = 0; s < steps; s++) {
        if (s < recordedCount) {
          this.reconInput.dx = dirsX[s]!;
          this.reconInput.dy = dirsY[s]!;
        } else {
          this.reconInput.dx = frameDirX;
          this.reconInput.dy = frameDirY;
        }
        this.reconInput.hasDash = s === 0 ? hasDash : false;
        simulatePhysicsStepInto(
          this.reconState,
          this.reconInput,
          PLAYER_PHYSICS_CONFIG,
          this.resolveCollision,
          dt,
        );
      }

      if (recEntries !== null) {
        recEntries.push({
          seq: rec.frame.sequence,
          recPredictedX: rec.predictedX,
          recPredictedY: rec.predictedY,
          recVelX: rec.velocityX,
          recVelY: rec.velocityY,
          recSubSteps: steps,
          reconXAfter: this.reconState.x,
          reconYAfter: this.reconState.y,
          reconVxAfter: this.reconState.vx,
          reconVyAfter: this.reconState.vy,
        });
      }
    }

    const result = this._scratchResult;
    result.x = this.reconState.x;
    result.y = this.reconState.y;
    result.velocityX = this.reconState.vx;
    result.velocityY = this.reconState.vy;

    if (sink !== null) {
      sink({
        serverSeq,
        unackedCount: unacked.count,
        seedX: serverX,
        seedY: serverY,
        seedVx: serverVelocityX,
        seedVy: serverVelocityY,
        records: recEntries!,
        finalX: result.x,
        finalY: result.y,
        finalVx: result.velocityX,
        finalVy: result.velocityY,
      });
    }

    return result;
  }

  /**
   * Seed isDashing/dashRemaining at the server-acked tick so the replay
   * matches the prediction's continuous-dash tracking. The server velocity
   * is authoritative: if |v| exceeds the walk speed cap, the player was
   * dashing at tick S. Then find the most recent DASH action ≤ S to compute
   * how many ticks remain (DASH_DURATION_TICKS minus ticks elapsed since
   * the dash started). If no DASH action is found in the window, the
   * velocity spike came from something else (e.g. knockback) — don't seed
   * dash state (let the normal edge-triggered path handle it).
   */
  private seedDashState(serverSeq: number, serverVelocityX: number, serverVelocityY: number): void {
    const speedMag = Math.hypot(serverVelocityX, serverVelocityY);
    // Walk speed cap (with margin for acceleration overshoot). Dash speed is
    // 2× BASE_SPEED, so anything above 1.3× is unambiguously dashing.
    const dashSpeedThreshold = PLAYER.BASE_SPEED * 1.3;
    const wasDashing = speedMag > dashSpeedThreshold;

    if (!wasDashing) {
      this.reconState.isDashing = false;
      this.reconState.dashRemaining = 0;
      return;
    }

    // Find the most recent DASH action at or before the acked tick. The dash
    // started at that tick; remaining = duration - ticks elapsed since.
    const dashStartSeq = this.inputBuffer.findLastDashBefore(serverSeq);
    if (dashStartSeq === undefined) {
      // Velocity says "dashing" but no DASH action in retained history — the
      // dash started before our input buffer's history. Assume the dash is
      // near its end (conservative: 1 tick remaining) so the replay doesn't
      // over-extend it.
      this.reconState.isDashing = true;
      this.reconState.dashRemaining = 1;
      return;
    }

    const elapsed = serverSeq - dashStartSeq;
    const remaining = PLAYER.DASH_DURATION_TICKS - elapsed;
    if (remaining > 0) {
      this.reconState.isDashing = true;
      this.reconState.dashRemaining = remaining;
    } else {
      // Dash ended exactly at or before the acked tick — not dashing anymore.
      this.reconState.isDashing = false;
      this.reconState.dashRemaining = 0;
    }
  }
}

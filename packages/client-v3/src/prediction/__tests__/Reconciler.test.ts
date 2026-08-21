import { describe, it, expect } from 'vitest';
import { Reconciler } from '../Reconciler.js';
import { InputBuffer } from '../InputBuffer.js';
import { PLAYER, SIM_TICK_DT, MAX_SUBSTEPS_PER_RECORD } from '@sector-battle/shared';
import type { InputRecord } from '../../types.js';
import type { CollisionResolveFn } from '../Reconciler.js';

/**
 * Characterization tests for `Reconciler` — the client reconciliation primitive
 * (ADR-0014/0015, ADR-0033). `reconcile()` takes the server-authoritative
 * position/velocity/sequence and replays the still-unacknowledged inputs from
 * the `InputBuffer` through `simulatePhysicsStepInto`, returning the corrected
 * client position + velocity.
 *
 * These PIN today's behavior — notably the ADR-0033 #2 velocity-start fix: an
 * empty unacked window returns the server velocity verbatim, it is never
 * zeroed.
 *
 * Physics kinematics (from shared PLAYER table):
 *   BASE_SPEED   = 430 px/s
 *   ACCELERATION = 4800 px/s^2
 *   DASH_SPEED_MULTIPLIER = 2.0  → dash speed = 860 px/s
 *   SIM_TICK_DT  = 1/60 s
 * First MOVE step displacement ≈ ACCELERATION * DT * DT = 4800/3600 ≈ 1.333 px,
 *   first-step velocity = ACCELERATION * DT = 80 px/s.
 *
 * Assertions are RELATIVE (advances / bounded / greater-than) rather than exact
 * pixel values, so the battery pins behavior without being brittle to the
 * acceleration integrator's exact arithmetic. The velocity-start case asserts
 * an exact value because no physics step runs.
 *
 * NOTE on sequencing: the underlying input ring numbers frames by insertion
 * order from 0, so tests push 0-based sequences. `serverSeq` is the last
 * sequence the server has acknowledged; records with `sequence > serverSeq`
 * are replayed.
 */

/** Pass-through collision: returns the proposed position unchanged (no walls). */
const passThroughCollision: CollisionResolveFn = (x, y) => ({ x, y });

/** Collision stub that clamps X to a wall at `wallX` (player cannot pass). */
function makeWallCollision(wallX: number): CollisionResolveFn {
  return (x, y) => ({ x: Math.min(x, wallX), y });
}

/**
 * Build per-substep direction arrays (NET-02) for a record whose substeps all
 * used the same normalized direction `(dx, dy)`. The first `count` entries are
 * set; trailing entries (up to MAX_SUBSTEPS_PER_RECORD) stay zero.
 */
function makeSubStepDirs(dx: number, dy: number, count = 1): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  const y = new Float64Array(MAX_SUBSTEPS_PER_RECORD);
  for (let i = 0; i < count && i < MAX_SUBSTEPS_PER_RECORD; i++) {
    x[i] = dx;
    y[i] = dy;
  }
  return { x, y };
}

function makeMoveRecord(sequence: number): InputRecord {
  const dirs = makeSubStepDirs(1, 0);
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
    timestamp: sequence * 100,
    speed: PLAYER.BASE_SPEED,
    dt: SIM_TICK_DT,
    velocityX: 0,
    velocityY: 0,
    subSteps: 1,
    subStepDirsX: dirs.x,
    subStepDirsY: dirs.y,
  };
}

function makeDashRecord(sequence: number): InputRecord {
  const dirs = makeSubStepDirs(1, 0);
  return {
    frame: {
      movementX: 1,
      movementY: 0,
      aimAngle: 0,
      sequence,
      actions: ['DASH'],
    },
    predictedX: 0,
    predictedY: 0,
    timestamp: sequence * 100,
    speed: PLAYER.BASE_SPEED,
    dt: SIM_TICK_DT,
    velocityX: 0,
    velocityY: 0,
    subSteps: 1,
    subStepDirsX: dirs.x,
    subStepDirsY: dirs.y,
  };
}

describe('Reconciler — characterization', () => {
  it('zero unacked inputs: returns server position + velocity verbatim', () => {
    const buf = new InputBuffer();
    const recon = new Reconciler(buf, passThroughCollision);

    // No inputs pushed → no replay steps → server state returned untouched.
    const result = recon.reconcile(100, 200, 5, 0, 0, 0, 0);

    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(result.velocityX).toBe(0);
    expect(result.velocityY).toBe(0);
  });

  it('one unacked MOVE input: position advances along the input axis by one step', () => {
    // Push a single frame at seq 0 and reconcile with serverSeq = -1 (nothing
    // acknowledged) so the one frame is replayed.
    const buf = new InputBuffer();
    buf.push(makeMoveRecord(0));
    const recon = new Reconciler(buf, passThroughCollision);

    const result = recon.reconcile(100, 200, -1, 0, 0, 0, 0);

    // +x input → x advances from the server position by ~one step (≈1.33 px).
    expect(result.x).toBeGreaterThan(100);
    // Upper bound: a single non-dash step can't move further than base speed.
    expect(result.x).toBeLessThan(100 + PLAYER.BASE_SPEED * SIM_TICK_DT + 1);
    // First-step velocity is exactly ACCELERATION * DT.
    expect(result.velocityX).toBeCloseTo(PLAYER.ACCELERATION * SIM_TICK_DT, 5);
    // y is untouched by a pure +x input.
    expect(result.y).toBeCloseTo(200, 5);
    expect(result.velocityY).toBe(0);
  });

  it('multiple unacked MOVE inputs: position advances further than a single step', () => {
    // One-step baseline: single replayed frame.
    const bufOne = new InputBuffer();
    bufOne.push(makeMoveRecord(0));
    const reconOne = new Reconciler(bufOne, passThroughCollision);
    const oneStep = reconOne.reconcile(100, 200, -1, 0, 0, 0, 0);

    // Three replayed frames: seqs 1, 2, 3 with serverSeq = 0.
    const bufThree = new InputBuffer();
    bufThree.push(makeMoveRecord(0));
    bufThree.push(makeMoveRecord(1));
    bufThree.push(makeMoveRecord(2));
    bufThree.push(makeMoveRecord(3));
    const reconThree = new Reconciler(bufThree, passThroughCollision);
    const threeSteps = reconThree.reconcile(100, 200, 0, 0, 0, 0, 0);

    // Three replayed steps cover strictly more distance than one (acceleration
    // compounds velocity across the replay loop).
    expect(threeSteps.x).toBeGreaterThan(oneStep.x);
    expect(threeSteps.velocityX).toBeGreaterThan(oneStep.velocityX);
    // Sanity upper bound: three steps of a base-speed-capped move can't jump
    // across the whole map.
    expect(threeSteps.x).toBeLessThan(100 + PLAYER.BASE_SPEED * SIM_TICK_DT * 3 + 1);
  });

  it('velocity-start fix (ADR-0033 #2): empty buffer preserves server velocity exactly', () => {
    const buf = new InputBuffer();
    const recon = new Reconciler(buf, passThroughCollision);

    // Server reports a non-zero velocity and an empty unacked window. The fix
    // seeds reconState.vx from the server and returns it as-is — no replay
    // step runs to overwrite it. This pins the regression: the velocity must
    // NOT be zeroed when the buffer is empty.
    const result = recon.reconcile(100, 200, 5, 0, 0, 500, 0);

    expect(result.velocityX).toBe(500);
    expect(result.velocityY).toBe(0);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it('dash input: velocity/position are boosted relative to a plain MOVE step', () => {
    // Plain MOVE: replay seqs 1, 2 (serverSeq = 0) — two non-dash steps.
    const bufMove = new InputBuffer();
    bufMove.push(makeMoveRecord(0));
    bufMove.push(makeMoveRecord(1));
    bufMove.push(makeMoveRecord(2));
    const reconMove = new Reconciler(bufMove, passThroughCollision);
    const moveResult = reconMove.reconcile(100, 200, 0, 0, 0, 0, 0);

    // Dash: same shape but the middle frame is a DASH action.
    const bufDash = new InputBuffer();
    bufDash.push(makeMoveRecord(0));
    bufDash.push(makeDashRecord(1));
    bufDash.push(makeMoveRecord(2));
    const reconDash = new Reconciler(bufDash, passThroughCollision);
    const dashResult = reconDash.reconcile(100, 200, 0, 0, 0, 0, 0);

    // Dash applies DASH_SPEED_MULTIPLIER, so the dash step covers materially
    // more distance than the normal move from the same start.
    expect(dashResult.x).toBeGreaterThan(moveResult.x);
    // The dash velocity is the dash speed (BASE_SPEED * multiplier = 860),
    // strictly greater than the plain-move velocity at the same step.
    expect(dashResult.velocityX).toBeGreaterThan(moveResult.velocityX);
    // The dash velocity hits the dash speed cap exactly (input axis = +x).
    expect(dashResult.velocityX).toBeCloseTo(PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER, 5);
  });

  it('collision resolution: a clamping collision stub constrains the reconciled position', () => {
    // Two replayed MOVE steps from x=100 land at ~104 (compounding
    // acceleration), so a wall at x=102 is crossed by the unclamped replay and
    // must clamp the result.
    const wallX = 102;

    const bufPass = new InputBuffer();
    bufPass.push(makeMoveRecord(0));
    bufPass.push(makeMoveRecord(1));
    bufPass.push(makeMoveRecord(2));
    const reconPass = new Reconciler(bufPass, passThroughCollision);
    const passed = reconPass.reconcile(100, 200, 0, 0, 0, 0, 0);

    const bufWall = new InputBuffer();
    bufWall.push(makeMoveRecord(0));
    bufWall.push(makeMoveRecord(1));
    bufWall.push(makeMoveRecord(2));
    const reconWall = new Reconciler(bufWall, makeWallCollision(wallX));
    const clamped = reconWall.reconcile(100, 200, 0, 0, 0, 0, 0);

    // Sanity: the unclamped replay advanced past the wall.
    expect(passed.x).toBeGreaterThan(wallX);
    // With the wall, the reconciled position is clamped at wallX — the
    // CollisionResolveFn is honored by the replay loop, not bypassed.
    expect(clamped.x).toBeLessThanOrEqual(wallX);
    expect(clamped.x).toBeLessThan(passed.x);
    // y is unaffected by an x-only wall clamp.
    expect(clamped.y).toBeCloseTo(200, 5);
  });

  it('mid-dash correction: replays unacked records at DASH speed (not walk speed)', () => {
    // Regression for the dash-state seeding bug. A dash is continuous: it
    // starts on the DASH action edge, then carries across ticks via
    // isDashing + dashRemaining (DASH_DURATION_TICKS = 30). When a server
    // correction arrives MID-dash (serverSeq past the dash-start tick but
    // the dash still in progress), the reconciler must seed isDashing=true
    // so the replay continues at dash speed. Previously it hardcoded
    // isDashing=false → replay used walk speed → position diverged → jitter.
    //
    // Setup: contiguous sequences 0-8 (as in production — one record per
    // tick). DASH at seq 0 (acked). Server correction arrives at seq 5
    // (mid-dash, dash still in progress). Unacked records 6, 7, 8 are plain
    // MOVE (no DASH action — the edge already passed).
    const buf = new InputBuffer();
    buf.push(makeDashRecord(0)); // dash start
    buf.push(makeMoveRecord(1));
    buf.push(makeMoveRecord(2));
    buf.push(makeMoveRecord(3));
    buf.push(makeMoveRecord(4));
    buf.push(makeMoveRecord(5));
    buf.push(makeMoveRecord(6)); // unacked (serverSeq=5 replays 6,7,8)
    buf.push(makeMoveRecord(7));
    buf.push(makeMoveRecord(8));
    const recon = new Reconciler(buf, passThroughCollision);

    // Server reports dash-speed velocity at seq 5 (dash in progress:
    // started at seq 0, duration 30, so 25 ticks remain).
    const dashSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
    const midDashResult = recon.reconcile(100, 200, 5, 0, 0, dashSpeed, 0);

    // Baseline: same setup but server reports WALK-speed velocity (not
    // dashing at seq 5). The replay should advance less.
    const reconWalk = new Reconciler(buf, passThroughCollision);
    const walkResult = reconWalk.reconcile(100, 200, 5, 0, 0, 0, 0);

    // If the dash state is seeded correctly, the mid-dash replay advances
    // materially further than the walk-speed replay (dash = 2× speed across
    // 3 steps). If the bug is present (isDashing hardcoded false), both
    // replays use walk speed and the gap vanishes.
    expect(midDashResult.x).toBeGreaterThan(walkResult.x + 5);
  });
});

describe('Reconciler — NET-23 speed/stagger scalar + ADR-0033 velocity-seed invariants', () => {
  // NET-23 widens ONLY the speed/stagger SCALAR the replay integrates with —
  // the velocity seed stays the server-authoritative velocity (ADR-0033 §2).
  // These tests pin both sides of that seam: the velocity is NEVER seeded from
  // the prediction's recorded velocity, and the speed/stagger scalar now comes
  // from the server-authoritative patch values (not the stale rec.speed / the
  // previously-hardcoded false).

  it('ADR-0033 invariant: replay velocity seeds from SERVER velocity, never from the record velocity', () => {
    // Record carries a large "prediction velocity" (rec.velocityX = 5000) that
    // MUST NOT seed the replay. The server velocity is 0. If the replay seeded
    // from the record velocity, the result would carry ~5000; seeded from the
    // server velocity (0), the first replay step yields ~ACCELERATION*DT = 80.
    const buf = new InputBuffer();
    const dirs = makeSubStepDirs(1, 0);
    buf.push({
      frame: { movementX: 1, movementY: 0, aimAngle: 0, sequence: 1, actions: [] },
      predictedX: 0,
      predictedY: 0,
      timestamp: 0,
      speed: PLAYER.BASE_SPEED,
      dt: SIM_TICK_DT,
      velocityX: 5000, // stale prediction velocity — must NOT seed the replay
      velocityY: 0,
      subSteps: 1,
      subStepDirsX: dirs.x,
      subStepDirsY: dirs.y,
    });
    const recon = new Reconciler(buf, passThroughCollision);

    // serverVelocityX = 0 (authoritative). Replay seeds from THIS, not 5000.
    const result = recon.reconcile(100, 200, 0, 0, 0, 0, 0);

    // First-step velocity from a 0 seed = ACCELERATION * DT = 80 px/s. If the
    // replay had seeded from the record's 5000, velocityX would be ~5000+.
    expect(result.velocityX).toBeCloseTo(PLAYER.ACCELERATION * SIM_TICK_DT, 4);
    expect(result.velocityX).toBeLessThan(200);
  });

  it('ADR-0033 invariant: empty window returns the SERVER velocity verbatim (never zeroed, never from prediction)', () => {
    const buf = new InputBuffer();
    const recon = new Reconciler(buf, passThroughCollision);

    // No records → no replay steps → server velocity returned untouched.
    // The authoritative server velocity (123, -456) must come back exactly.
    const result = recon.reconcile(100, 200, 5, 0, 0, 123, -456);
    expect(result.velocityX).toBe(123);
    expect(result.velocityY).toBe(-456);
  });

  it('NET-23: replay integrates with SERVER speed (serverSpeed param), not the stale rec.speed', () => {
    // Two identical record sets whose rec.speed is BASE_SPEED. The FIRST replay
    // passes serverSpeed = BASE_SPEED*2 (a speed power-up the server just
    // reported); the SECOND passes serverSpeed = BASE_SPEED (no boost). If the
    // replay uses serverSpeed, the boosted replay accelerates past the BASE_SPEED
    // cap and advances materially further. If the bug is present (replay uses
    // rec.speed = BASE_SPEED for both), the gap vanishes — exactly the masking
    // NET-23 eliminates.
    //
    // The replay is SEEDED at the server velocity = BASE_SPEED (the player is
    // already at full walk speed when the patch arrives), so the BASE_SPEED
    // target CAPS the baseline at 430 while the 2× target lets the boosted
    // replay continue accelerating past it. (From a 0 seed both would be
    // acceleration-bound for the first ~6 steps and the cap wouldn't bite.)
    const buildBuf = () => {
      const b = new InputBuffer();
      const dirs = makeSubStepDirs(1, 0);
      for (let seq = 1; seq <= 8; seq++) {
        b.push({
          frame: { movementX: 1, movementY: 0, aimAngle: 0, sequence: seq, actions: [] },
          predictedX: 0,
          predictedY: 0,
          timestamp: seq * 100,
          speed: PLAYER.BASE_SPEED, // the STALE client-recorded speed
          dt: SIM_TICK_DT,
          velocityX: 0,
          velocityY: 0,
          subSteps: 1,
          subStepDirsX: dirs.x,
          subStepDirsY: dirs.y,
        });
      }
      return b;
    };

    const boosted = new Reconciler(buildBuf(), passThroughCollision);
    const boostedResult = boosted.reconcile(
      100,
      200,
      0,
      0,
      0,
      PLAYER.BASE_SPEED, // seed: already at walk speed
      0,
      PLAYER.BASE_SPEED * 2, // server-authoritative: speed power-up active
      false,
    );
    const baseline = new Reconciler(buildBuf(), passThroughCollision);
    const baselineResult = baseline.reconcile(
      100,
      200,
      0,
      0,
      0,
      PLAYER.BASE_SPEED, // seed: already at walk speed
      0,
      PLAYER.BASE_SPEED, // server-authoritative: no boost
      false,
    );

    // Baseline caps at BASE_SPEED (430); boosted accelerates past it toward 860
    // → advances materially further over 8 steps.
    expect(boostedResult.x).toBeGreaterThan(baselineResult.x + 5);
    // And the boosted terminal velocity exceeds BASE_SPEED (proof the cap moved).
    expect(boostedResult.velocityX).toBeGreaterThan(PLAYER.BASE_SPEED);
  });

  it('NET-23: replay applies STAGGER penalty from SERVER isStaggered flag, not hardcoded false', () => {
    // Identical records seeded at velocity = BASE_SPEED + serverSpeed =
    // BASE_SPEED. With serverIsStaggered=true the replay must apply
    // STAGGER_MOVE_SPEED_PENALTY (< 1) → the effective target drops to
    // BASE_SPEED*0.5, so the replay DECELERATES from BASE_SPEED and advances
    // LESS than the non-staggered replay (which holds at BASE_SPEED).
    // Previously isStaggered was hardcoded false, so a stagger never slowed the
    // replay → masked the desync.
    const buildBuf = () => {
      const b = new InputBuffer();
      const dirs = makeSubStepDirs(1, 0);
      for (let seq = 1; seq <= 8; seq++) {
        b.push({
          frame: { movementX: 1, movementY: 0, aimAngle: 0, sequence: seq, actions: [] },
          predictedX: 0,
          predictedY: 0,
          timestamp: seq * 100,
          speed: PLAYER.BASE_SPEED,
          dt: SIM_TICK_DT,
          velocityX: 0,
          velocityY: 0,
          subSteps: 1,
          subStepDirsX: dirs.x,
          subStepDirsY: dirs.y,
        });
      }
      return b;
    };

    const staggered = new Reconciler(buildBuf(), passThroughCollision);
    const staggeredResult = staggered.reconcile(
      100,
      200,
      0,
      0,
      0,
      PLAYER.BASE_SPEED, // seed: already at walk speed
      0,
      PLAYER.BASE_SPEED,
      true, // server-authoritative: staggered
    );
    const baseline = new Reconciler(buildBuf(), passThroughCollision);
    const baselineResult = baseline.reconcile(
      100,
      200,
      0,
      0,
      0,
      PLAYER.BASE_SPEED, // seed: already at walk speed
      0,
      PLAYER.BASE_SPEED,
      false, // server-authoritative: not staggered
    );

    // Stagger penalty halves the effective target → replay decelerates from
    // BASE_SPEED toward BASE_SPEED*0.5 → advances less than the baseline
    // (which holds at BASE_SPEED).
    expect(staggeredResult.x).toBeLessThan(baselineResult.x - 1);
    expect(staggeredResult.velocityX).toBeLessThan(PLAYER.BASE_SPEED);
  });
});

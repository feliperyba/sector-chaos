import { describe, it, expect } from 'vitest';
import { simulatePhysicsStepInto } from '../simulatePhysicsStep.js';
import type { PhysicsState, PhysicsInput, PhysicsConfig, CollisionFn } from '../PhysicsTypes.js';
import { PLAYER, COMBAT, SIM_TICK_DT } from '../../constants/index.js';

/**
 * Characterization battery for `simulatePhysicsStepInto` — the shared primitive
 * shared by client prediction and reconciliation (ADR-0033/0035). These tests
 * PIN today's output so any future refactor that changes behavior trips a
 * visible, attributable failure. They do NOT define desired behavior — if a
 * pinned value is "wrong" by some external standard, that is a separate ticket.
 *
 * Pass-through collisionFn (no walls) is used throughout so the battery
 * isolates the accel + integration + dash + stagger core, which is the
 * should-agree surface with the server (see movementParity.test.ts).
 *
 * IMPORTANT implementation quirks pinned here (do not "fix" without a ticket):
 * - NET-21 dash tick-alignment: the dash-START step does NOT move at dash
 *   speed. The dash-start INTENT is captured up front but the velocity
 *   assignment is deferred until AFTER the integration step (mirroring the
 *   server's MOVE-before-DASH within-tick order — see simulatePhysicsStep.ts
 *   NET-21 note). So the dash-arrival step accelerates/moves at the PRE-dash
 *   (walk) velocity, and `dashRemaining` stays at `dashDurationTicks` after
 *   the start step (the decrement is skipped on the dash-start step so the
 *   dash spans exactly DASH_DURATION_TICKS dash-speed steps afterward). The
 *   dash velocity is armed at full `speed * dashSpeedMultiplier` with NO
 *   same-tick decay (it is assigned after `applyAccelerationInto`, so the
 *   decel branch never touches it on the start step).
 */

const DT = SIM_TICK_DT;

const CONFIG: PhysicsConfig = {
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
const noCollision: CollisionFn = (x, y) => ({ x, y });

function makeState(overrides: Partial<PhysicsState> = {}): PhysicsState {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    speed: PLAYER.BASE_SPEED,
    isDashing: false,
    dashRemaining: 0,
    isStaggered: false,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PhysicsInput> = {}): PhysicsInput {
  return { dx: 0, dy: 0, hasDash: false, dashDirX: 0, dashDirY: 0, ...overrides };
}

describe('simulatePhysicsStepInto — characterization battery', () => {
  describe('rest -> accel', () => {
    it('accelerates from rest toward BASE_SPEED in input direction (+x)', () => {
      const state = makeState();
      simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
      // First-frame velocity is ACCELERATION * dt (snap branch not taken;
      // dist(0 -> BASE_SPEED) > ACCEL*dt so we step by ACCEL*dt).
      expect(state.vx).toBeCloseTo(PLAYER.ACCELERATION * DT, 5);
      expect(state.vy).toBe(0);
      expect(state.x).toBeCloseTo(PLAYER.ACCELERATION * DT * DT, 7);
      expect(state.y).toBe(0);
    });

    it('accelerates from rest toward (-x) when input is (-1, 0)', () => {
      const state = makeState();
      simulatePhysicsStepInto(state, makeInput({ dx: -1, dy: 0 }), CONFIG, noCollision, DT);
      expect(state.vx).toBeCloseTo(-PLAYER.ACCELERATION * DT, 5);
      expect(state.vy).toBe(0);
    });
  });

  describe('terminal velocity (snap to BASE_SPEED)', () => {
    it('caps vx at +BASE_SPEED after enough frames (does not overshoot)', () => {
      const state = makeState();
      for (let i = 0; i < 300; i++) {
        simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
      }
      expect(state.vx).toBeCloseTo(PLAYER.BASE_SPEED, 5);
      expect(state.vy).toBe(0);
      expect(state.vx).toBeLessThanOrEqual(PLAYER.BASE_SPEED + 1e-6);
    });
  });

  describe('decel-to-zero (input released from velocity)', () => {
    it('reduces speed toward zero but does not cross zero in one frame', () => {
      const state = makeState({ vx: PLAYER.BASE_SPEED, vy: 0 });
      simulatePhysicsStepInto(state, makeInput({ dx: 0, dy: 0 }), CONFIG, noCollision, DT);
      // decel branch: reduction = DECEL*dt; scale = (speed - reduction)/speed
      const reduction = PLAYER.DECELERATION * DT;
      const scale = (PLAYER.BASE_SPEED - reduction) / PLAYER.BASE_SPEED;
      expect(state.vx).toBeCloseTo(PLAYER.BASE_SPEED * scale, 4);
      expect(state.vy).toBe(0);
      expect(state.vx).toBeGreaterThan(0);
      expect(state.vx).toBeLessThan(PLAYER.BASE_SPEED);
    });

    it('reaches exactly zero after enough frames with no input', () => {
      const state = makeState({ vx: PLAYER.BASE_SPEED, vy: 0 });
      for (let i = 0; i < 300; i++) {
        simulatePhysicsStepInto(state, makeInput({ dx: 0, dy: 0 }), CONFIG, noCollision, DT);
      }
      expect(state.vx).toBe(0);
      expect(state.vy).toBe(0);
    });
  });

  describe('decel-undershoot-snap (reduction >= speed snaps to zero)', () => {
    it('snaps velocity to zero when decel*dt >= current speed', () => {
      // Tiny velocity that DECEL*dt easily covers -> exact zero (the
      // `reduction >= speed` early-out branch in applyAccelerationInto).
      const state = makeState({ vx: 1, vy: 0 });
      simulatePhysicsStepInto(state, makeInput({ dx: 0, dy: 0 }), CONFIG, noCollision, DT);
      expect(state.vx).toBe(0);
      expect(state.vy).toBe(0);
    });
  });

  describe('diagonal normalization', () => {
    it('(1,1) input yields equal vx/vy approaching BASE_SPEED/sqrt(2) each', () => {
      const state = makeState();
      for (let i = 0; i < 300; i++) {
        simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 1 }), CONFIG, noCollision, DT);
      }
      const component = PLAYER.BASE_SPEED / Math.SQRT2;
      expect(state.vx).toBeCloseTo(component, 3);
      expect(state.vy).toBeCloseTo(component, 3);
      // Magnitude is exactly BASE_SPEED (diagonal is normalized, not 1.41x).
      expect(Math.hypot(state.vx, state.vy)).toBeCloseTo(PLAYER.BASE_SPEED, 3);
    });

    it('(1,1) and (100,100) produce identical output (magnitude-agnostic)', () => {
      const a = makeState();
      const b = makeState();
      for (let i = 0; i < 5; i++) {
        simulatePhysicsStepInto(a, makeInput({ dx: 1, dy: 1 }), CONFIG, noCollision, DT);
        simulatePhysicsStepInto(b, makeInput({ dx: 100, dy: 100 }), CONFIG, noCollision, DT);
      }
      expect(a.vx).toBeCloseTo(b.vx, 8);
      expect(a.vy).toBeCloseTo(b.vy, 8);
    });
  });

  describe('dash-start (normalized dir, movement input aligned)', () => {
    // NET-21: the dash velocity is armed AFTER the integration step, so the
    // decel branch never erodes it on the start step — the raw dash velocity
    // is preserved regardless of the movement input. We still pass an aligned
    // movement input so the dash-arrival step itself advances at walk speed
    // (mirroring the server's MOVE-before-DASH order).
    it('sets velocity to dir * speed * dashSpeedMultiplier on dash start (1,1)', () => {
      const state = makeState();
      simulatePhysicsStepInto(
        state,
        makeInput({ dx: 1, dy: 1, hasDash: true, dashDirX: 1, dashDirY: 1 }),
        CONFIG,
        noCollision,
        DT,
      );
      const dashSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
      const component = dashSpeed / Math.SQRT2;
      expect(state.isDashing).toBe(true);
      // NET-21: dashRemaining is set to dashDurationTicks and NOT decremented
      // on the start step (the decrement is skipped so the dash spans exactly
      // DASH_DURATION_TICKS dash-speed steps afterward).
      expect(state.dashRemaining).toBe(PLAYER.DASH_DURATION_TICKS);
      expect(state.vx).toBeCloseTo(component, 5);
      expect(state.vy).toBeCloseTo(component, 5);
    });

    it('(+1,0) dash direction with aligned input yields +dashSpeed vx, zero vy', () => {
      const state = makeState();
      simulatePhysicsStepInto(
        state,
        makeInput({ dx: 1, dy: 0, hasDash: true, dashDirX: 1, dashDirY: 0 }),
        CONFIG,
        noCollision,
        DT,
      );
      const dashSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
      expect(state.vx).toBeCloseTo(dashSpeed, 5);
      expect(state.vy).toBe(0);
    });

    it('dash velocity is armed at full dashSpeed on the start tick with no same-tick decay (NET-21)', () => {
      // NET-21: the dash velocity is assigned AFTER applyAccelerationInto, so
      // the decel branch never touches it on the dash-arrival step. Previously
      // (pre-NET-21) the dash velocity was set BEFORE the accel call and a zero
      // movement input eroded it from 860 to ~753.33 in the same tick — that
      // decay is gone; the dash velocity is now armed at full dashSpeed,
      // matching the server's DashCommand.execute (which sets velocity without
      // running it through acceleration).
      const state = makeState();
      simulatePhysicsStepInto(
        state,
        makeInput({ hasDash: true, dashDirX: 1, dashDirY: 0 }),
        CONFIG,
        noCollision,
        DT,
      );
      const dashSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
      expect(state.isDashing).toBe(true);
      expect(state.vx).toBeCloseTo(dashSpeed, 5);
      expect(state.vy).toBe(0);
    });
  });

  describe('dash-start (zero dir — defaults to (1,0), LOAD-BEARING)', () => {
    // Reconciler.ts relies on this exact default: when dashDir is (0,0) the
    // primitive must orient the dash along +x. Changing this would silently
    // break dash-from-rest prediction. Movement input is aligned (+x) so the
    // raw dash velocity is preserved through the same-tick accel call.
    it('zero dash direction defaults to +x (vx = +dashSpeed, vy = 0)', () => {
      const state = makeState();
      simulatePhysicsStepInto(
        state,
        makeInput({ dx: 1, dy: 0, hasDash: true, dashDirX: 0, dashDirY: 0 }),
        CONFIG,
        noCollision,
        DT,
      );
      const dashSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
      expect(state.isDashing).toBe(true);
      expect(state.vx).toBeCloseTo(dashSpeed, 5);
      expect(state.vy).toBe(0);
    });
  });

  describe('dash-mid (sustained dash with aligned input preserves dash velocity)', () => {
    it('during dash with aligned input, vx stays pinned at dashSpeed', () => {
      const state = makeState();
      const aligned = makeInput({ dx: 1, dy: 0, hasDash: true, dashDirX: 1, dashDirY: 0 });
      // Start dash.
      simulatePhysicsStepInto(state, aligned, CONFIG, noCollision, DT);
      const dashSpeed = PLAYER.BASE_SPEED * PLAYER.DASH_SPEED_MULTIPLIER;
      // Continue dashing with aligned input (hasDash does not re-trigger
      // because isDashing is true).
      const midTicks = 5;
      for (let i = 0; i < midTicks; i++) {
        simulatePhysicsStepInto(state, aligned, CONFIG, noCollision, DT);
      }
      expect(state.isDashing).toBe(true);
      // Accel target during dash is BASE_SPEED * dashSpeedMultiplier, so vx
      // stays pinned at dashSpeed (desired = dir * effectiveSpeed = dashSpeed).
      expect(state.vx).toBeCloseTo(dashSpeed, 3);
      expect(state.vy).toBe(0);
      // NET-21: the start step leaves dashRemaining at dashDurationTicks (no
      // decrement on the start step); each mid tick subtracts 1 more.
      expect(state.dashRemaining).toBe(PLAYER.DASH_DURATION_TICKS - midTicks);
    });

    it('dash velocity decays each tick when movement input is zero mid-dash', () => {
      // Pin the decay: with no movement input, each dash tick decelerates.
      const state = makeState();
      simulatePhysicsStepInto(
        state,
        makeInput({ hasDash: true, dashDirX: 1, dashDirY: 0 }),
        CONFIG,
        noCollision,
        DT,
      );
      const vxAfterStart = state.vx;
      // Continue dash with zero movement input.
      simulatePhysicsStepInto(
        state,
        makeInput({ hasDash: true, dashDirX: 1, dashDirY: 0 }),
        CONFIG,
        noCollision,
        DT,
      );
      expect(state.vx).toBeLessThan(vxAfterStart);
      expect(state.vx).toBeGreaterThan(0);
    });
  });

  describe('dash-end velocity-reset-to-zero (PIN — ADR-0033 historical break)', () => {
    // simulatePhysicsStep.ts lines ~66-72: when dashRemaining hits 0, the
    // primitive sets vx=vy=0. This was historically broken in reconciliation
    // and MUST remain pinned. If this case ever changes, dash feel breaks
    // silently across the whole game.
    it('resets velocity to exactly (0,0) on the tick dashRemaining reaches 0', () => {
      const state = makeState();
      const aligned = makeInput({ dx: 1, dy: 0, hasDash: true, dashDirX: 1, dashDirY: 0 });
      // Start a dash. NET-21: the start step does NOT decrement, so after it
      // dashRemaining = dashDurationTicks (the 30 dash-speed steps still to come).
      simulatePhysicsStepInto(state, aligned, CONFIG, noCollision, DT);
      expect(state.isDashing).toBe(true);
      expect(state.dashRemaining).toBe(PLAYER.DASH_DURATION_TICKS);
      expect(state.vx).toBeGreaterThan(0);

      // Tick DASH_DURATION_TICKS more times. NET-21: the start step consumed 0
      // of the 30 decrements; we need all 30 mid-step decrements so the final
      // one brings dashRemaining from 1 to 0 and fires the reset branch.
      for (let i = 0; i < PLAYER.DASH_DURATION_TICKS; i++) {
        simulatePhysicsStepInto(state, aligned, CONFIG, noCollision, DT);
      }
      expect(state.isDashing).toBe(false);
      expect(state.dashRemaining).toBe(0);
      // THE PIN: velocity must be exactly zero, not near-zero.
      expect(state.vx).toBe(0);
      expect(state.vy).toBe(0);
    });

    it('velocity is non-zero on the tick BEFORE the reset (one tick earlier)', () => {
      // Guards against the test above passing trivially if the reset fired
      // one tick too early. The tick before reset must still carry dash velocity.
      const state = makeState();
      const aligned = makeInput({ dx: 1, dy: 0, hasDash: true, dashDirX: 1, dashDirY: 0 });
      simulatePhysicsStepInto(state, aligned, CONFIG, noCollision, DT);
      // NET-21: stop one tick short of the reset. The start step leaves
      // dashRemaining = dashDurationTicks (no decrement); we need
      // (DASH_DURATION_TICKS - 1) mid-step decrements to leave dashRemaining = 1.
      for (let i = 0; i < PLAYER.DASH_DURATION_TICKS - 1; i++) {
        simulatePhysicsStepInto(state, aligned, CONFIG, noCollision, DT);
      }
      // One tick BEFORE the reset tick: still dashing, velocity still present.
      expect(state.isDashing).toBe(true);
      expect(state.dashRemaining).toBe(1);
      expect(state.vx).toBeGreaterThan(0);
    });
  });

  describe('stagger-only (penalty applied before accel call)', () => {
    it('staggered non-dash caps terminal velocity at BASE_SPEED * STAGGER_PENALTY', () => {
      const state = makeState({ isStaggered: true });
      for (let i = 0; i < 300; i++) {
        simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
      }
      const expected = PLAYER.BASE_SPEED * COMBAT.STAGGER_MOVE_SPEED_PENALTY;
      expect(state.vx).toBeCloseTo(expected, 3);
      expect(state.vy).toBe(0);
      expect(state.vx).toBeLessThan(PLAYER.BASE_SPEED);
    });

    it('stagger penalty multiplies effectiveSpeed before the accel call', () => {
      // After warm-up the desired target is BASE_SPEED * penalty. Verify the
      // penalty is applied so a regression that skips it is caught.
      const staggered = makeState({ isStaggered: true });
      const normal = makeState();
      for (let i = 0; i < 60; i++) {
        simulatePhysicsStepInto(staggered, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
        simulatePhysicsStepInto(normal, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
      }
      // Staggered terminal target is half; at 60 frames both are near terminal,
      // so staggered vx must be materially below normal vx.
      expect(staggered.vx).toBeLessThan(normal.vx);
      expect(staggered.vx).toBeCloseTo(PLAYER.BASE_SPEED * COMBAT.STAGGER_MOVE_SPEED_PENALTY, 1);
    });
  });

  describe('integration step (pos += v * dt)', () => {
    it('position advances by post-accel vx*dt (decel uses velocity magnitude)', () => {
      // No input -> decel branch. applyAccelerationInto scales by
      // (|v| - reduction)/|v| using the MAGNITUDE (hypot), not per-component.
      const vx0 = 300;
      const vy0 = -300;
      const state = makeState({ vx: vx0, vy: vy0 });
      const sx = state.x;
      const sy = state.y;
      simulatePhysicsStepInto(state, makeInput({ dx: 0, dy: 0 }), CONFIG, noCollision, DT);
      const reduction = PLAYER.DECELERATION * DT;
      const mag = Math.hypot(vx0, vy0);
      const scale = (mag - reduction) / mag;
      const expectedVxAfter = vx0 * scale;
      const expectedVyAfter = vy0 * scale;
      // Position uses the POST-accel velocity (v is updated in place before pos).
      expect(state.x).toBeCloseTo(sx + expectedVxAfter * DT, 5);
      expect(state.y).toBeCloseTo(sy + expectedVyAfter * DT, 5);
    });

    it('position advances by vx*dt when velocity is held by aligned input', () => {
      // Terminal velocity, held by aligned input: vx == BASE_SPEED, and a step
      // moves x by exactly BASE_SPEED * dt.
      const state = makeState();
      for (let i = 0; i < 300; i++) {
        simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
      }
      const xBefore = state.x;
      simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 0 }), CONFIG, noCollision, DT);
      expect(state.x - xBefore).toBeCloseTo(PLAYER.BASE_SPEED * DT, 6);
    });
  });

  describe('collisionFn is consulted with proposed position', () => {
    it('passes the post-integration (x,y) and playerHalfW/H to collisionFn', () => {
      const seen: Array<{ x: number; y: number; halfW: number; halfH: number }> = [];
      const recording: CollisionFn = (x, y, halfW, halfH) => {
        seen.push({ x, y, halfW, halfH });
        return { x, y };
      };
      const state = makeState({ vx: 200, vy: 0 });
      simulatePhysicsStepInto(state, makeInput({ dx: 0, dy: 0 }), CONFIG, recording, DT);
      expect(seen.length).toBe(1);
      expect(seen[0]!.halfW).toBe(PLAYER.HITBOX_WIDTH / 2);
      expect(seen[0]!.halfH).toBe(PLAYER.HITBOX_HEIGHT / 2);
      expect(seen[0]!.x).toBeCloseTo(state.x, 8);
      expect(seen[0]!.y).toBeCloseTo(state.y, 8);
    });

    it('adopts the corrected (x,y) returned by collisionFn', () => {
      const shoveRight: CollisionFn = (x, y) => ({ x: x + 1000, y: y + 2000 });
      const state = makeState();
      simulatePhysicsStepInto(state, makeInput({ dx: 1, dy: 0 }), CONFIG, shoveRight, DT);
      // Whatever the integration produced, collisionFn added (1000, 2000).
      expect(state.x).toBeGreaterThan(1000);
      expect(state.y).toBe(2000);
    });
  });
});

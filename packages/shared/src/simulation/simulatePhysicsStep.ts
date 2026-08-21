import { applyAccelerationInto } from './applyAcceleration.js';
import { normalizeMoveInputInto } from './normalizeMoveInputInto.js';
import { effectiveWalkSpeed } from './effectiveWalkSpeed.js';
import type { PhysicsState, PhysicsInput, PhysicsConfig, CollisionFn } from './PhysicsTypes.js';

const velocityScratch: { vx: number; vy: number } = { vx: 0, vy: 0 };
/**
 * Dir receptacle for the shared normalize leaf — module-pooled like
 * velocityScratch, consumed synchronously into locals before reuse (the
 * dash-direction normalize below runs before the input normalize, each reading
 * its result out immediately; nothing nests).
 */
const dirScratch: { x: number; y: number } = { x: 0, y: 0 };

export function simulatePhysicsStepInto(
  state: PhysicsState,
  input: PhysicsInput,
  config: PhysicsConfig,
  collisionFn: CollisionFn,
  dt: number,
): void {
  let { x, y, vx, vy, speed, isDashing, dashRemaining, isStaggered } = state;

  // NET-21 — dash tick-alignment with the server.
  //
  // The server processes MOVE before DASH within a single tick
  // (packages/server/src/room/handlers/input.ts enqueues MOVE at lines 50–78,
  // THEN the actions[] loop at 87–208 handles DASH). So step1_ProcessInputs
  // first runs validateAndMove at the PRE-DASH walk velocity, and only
  // afterwards does DashCommand.execute set the dash velocity. The
  // dash-arrival tick therefore moves at WALK speed; dash-speed movement
  // begins on the NEXT tick. Separately, step8_ExpireTimers zeroes the dash
  // velocity AFTER step1 movement, on the tick where
  // `tick - dashStartTick >= DASH_DURATION_TICKS`.
  //
  // Previously this primitive set the dash velocity BEFORE the integration
  // step, so the client moved at dash speed on the detection substep — one
  // tick earlier than the server — and ended the dash one tick earlier too.
  // That skew produced a transient ~15–21px genuine error across the dash
  // window (6–7 corrections; see NET-FINDINGS-physics-divergence §4 Cause A).
  //
  // The fix mirrors the server's within-tick order: the dash-start INTENT is
  // captured up front (direction frozen at detection time, matching
  // DashCommand), but the velocity assignment is DEFERRED until AFTER the
  // integration step. The dash-end decrement is skipped on the dash-start
  // step so the dash spans exactly DASH_DURATION_TICKS dash-speed steps (the
  // steps AFTER the dash-arrival step), matching the server's T+1..T+30
  // dash-speed window. Only the dash-start/dash-end lines widened by NET-21
  // changed; the accel/integration/collision/bounds path below is untouched.
  let startingDash = false;
  let dashDirX = 0;
  let dashDirY = 0;
  if (input.hasDash && !isDashing) {
    startingDash = true;
    // Ticket 15: the dash-direction normalize is the shared leaf (the SAME
    // sqrt-form arithmetic the server's DashCommand uses — the former local
    // Math.hypot form was NOT bit-identical to it). The (1,0) fallback stays
    // HERE: fallback semantics are per-call-site by design (DashCommand falls
    // back to facingAngle BEFORE normalize; the prediction falls back to the
    // previous pending direction; only this physics primitive defaults +x).
    const dirLen = normalizeMoveInputInto(dirScratch, input.dashDirX, input.dashDirY);
    if (dirLen > 0) {
      dashDirX = dirScratch.x;
      dashDirY = dirScratch.y;
    } else {
      dashDirX = 1;
      dashDirY = 0;
    }
  }

  // effectiveSpeed uses the PRE-dash isDashing (false on the dash-arrival
  // step) so that step accelerates/moves at walk speed — exactly what the
  // server's MOVE command does before DashCommand runs.
  //
  // NET-21 (Approach B): during the dash the accel target is the FIXED dash
  // speed `baseSpeed * dashSpeedMultiplier` (mirroring the server's
  // `PlayerMovement.startDashSpeed`, which sets `speed.value = baseSpeed *
  // DASH_SPEED_MULTIPLIER`). We must NOT use `state.speed * dashSpeedMultiplier`
  // here: once the server's dash-speed patch arrives, `state.speed` already
  // equals `BASE_SPEED * mult`, so multiplying again would target
  // `BASE_SPEED * mult^2` (1720 instead of 860) and the client would
  // over-accelerate past the server — the residual dash-window divergence.
  // The stagger penalty applies in BOTH branches (the server's
  // `validateAndMove` computes `effectiveMaxSpeed = speed.value * staggerPenalty`
  // even during the brief dash window before `DamagePipeline.cancelDash` lands)
  // — via the shared leaf (ticket 15), bit-identical to the former
  // `effectiveSpeed *= penalty`: staggered it is the SAME multiply expression
  // (penalty 0.75, identical operation on both sides), and `x * 1 === x`
  // exactly when not staggered, so the branch form agrees with the server's
  // multiply form on both paths.
  const effectiveSpeed = effectiveWalkSpeed(
    isDashing ? config.baseSpeed * config.dashSpeedMultiplier : speed,
    isStaggered,
    config,
  );

  // Ticket 15: the input normalization is the shared leaf — the same sqrt-form
  // arithmetic the server's validateAndMove uses. The former local
  // Math.hypot form was NOT bit-identical to it (implementation-approximate).
  normalizeMoveInputInto(dirScratch, input.dx, input.dy);
  const ndx = dirScratch.x;
  const ndy = dirScratch.y;

  applyAccelerationInto(
    velocityScratch,
    vx,
    vy,
    ndx,
    ndy,
    effectiveSpeed,
    config.acceleration,
    config.deceleration,
    dt,
  );
  vx = velocityScratch.vx;
  vy = velocityScratch.vy;

  const newX = x + vx * dt;
  const newY = y + vy * dt;

  const resolved = collisionFn(newX, newY, config.playerHalfW, config.playerHalfH);
  x = resolved.x;
  y = resolved.y;

  // AFTER movement: apply the dash-start (mirrors DashCommand.execute, which
  // runs after MoveCommand and only SETS the velocity — no movement). The dash
  // velocity therefore takes effect on the NEXT step. NET-21 (Approach B): the
  // dash velocity magnitude is `baseSpeed * dashSpeedMultiplier`, mirroring the
  // server's startDashSpeed (which uses baseSpeed, NOT the powered-up speed).
  if (startingDash) {
    isDashing = true;
    dashRemaining = config.dashDurationTicks;
    const dashSpeed = config.baseSpeed * config.dashSpeedMultiplier;
    vx = dashDirX * dashSpeed;
    vy = dashDirY * dashSpeed;
  }

  // AFTER movement: dash-end (mirrors step8_ExpireTimers, which runs after
  // step1 movement). The decrement is SKIPPED on the dash-start step — the
  // dash was just armed and has not yet powered a dash-speed step. This makes
  // the dash span exactly DASH_DURATION_TICKS dash-speed steps (the steps
  // after the dash-arrival step), matching the server's T+1..T+30 dash-speed
  // window (server zeroes velocity on the tick where
  // `tick - dashStartTick >= DASH_DURATION_TICKS`, i.e. T+DASH_DURATION_TICKS).
  if (isDashing && !startingDash) {
    dashRemaining--;
    if (dashRemaining <= 0) {
      isDashing = false;
      vx = 0;
      vy = 0;
    }
  }

  state.x = x;
  state.y = y;
  state.vx = vx;
  state.vy = vy;
  state.isDashing = isDashing;
  state.dashRemaining = dashRemaining;
}

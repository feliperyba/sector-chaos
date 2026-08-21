export interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  isDashing: boolean;
  dashRemaining: number;
  isStaggered: boolean;
}

export interface PhysicsInput {
  dx: number;
  dy: number;
  hasDash: boolean;
  dashDirX: number;
  dashDirY: number;
}

export interface PhysicsConfig {
  acceleration: number;
  deceleration: number;
  dashSpeedMultiplier: number;
  dashDurationTicks: number;
  staggerMoveSpeedPenalty: number;
  playerHalfW: number;
  playerHalfH: number;
  /**
   * The player's BASE walk speed (PLAYER.BASE_SPEED). NET-21: the dash
   * velocity and the dash accel target are computed from `baseSpeed *
   * dashSpeedMultiplier`, mirroring the server's `PlayerMovement.startDashSpeed`
   * which sets `speed.value = baseSpeed * DASH_SPEED_MULTIPLIER` (NOT the
   * powered-up value). Using `state.speed` here would double-count the
   * multiplier once the server's dash-speed patch arrives (state.speed becomes
   * `BASE_SPEED * mult`, so `state.speed * mult` = `BASE_SPEED * mult^2`).
   */
  baseSpeed: number;
}

export type CollisionFn = (
  x: number,
  y: number,
  halfW: number,
  halfH: number,
) => { x: number; y: number };

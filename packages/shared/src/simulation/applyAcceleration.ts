/**
 * Applies acceleration or deceleration to a velocity vector over a time step.
 *
 * When there is input (inputX/inputY non-zero), accelerates toward `maxSpeed`
 * in the input direction. When there is no input, decelerates toward zero.
 *
 * Frame-rate independent: all changes are proportional to `dt`.
 *
 * Zero-allocation variant: writes the resulting velocity into `out.vx`/`out.vy`
 * instead of returning a tuple. Use this on hot paths (per-move per-player).
 *
 * @param out       - Receptacle for the resulting velocity (mutated in place)
 * @param velocityX - Current horizontal velocity (pixels/sec)
 * @param velocityY - Current vertical velocity (pixels/sec)
 * @param inputX    - Normalised input direction X (-1, 0, or 1)
 * @param inputY    - Normalised input direction Y (-1, 0, or 1)
 * @param maxSpeed  - Maximum speed in pixels/sec (e.g. PLAYER.BASE_SPEED)
 * @param accel     - Acceleration in pixels/sec² (e.g. PLAYER.ACCELERATION)
 * @param decel     - Deceleration in pixels/sec² (e.g. PLAYER.DECELERATION)
 * @param dt        - Time step in seconds
 */
export function applyAccelerationInto(
  out: { vx: number; vy: number },
  velocityX: number,
  velocityY: number,
  inputX: number,
  inputY: number,
  maxSpeed: number,
  accel: number,
  decel: number,
  dt: number,
): void {
  const hasInput = inputX !== 0 || inputY !== 0;

  if (!hasInput) {
    // Decelerate toward zero
    const speed = Math.hypot(velocityX, velocityY);
    if (speed === 0) {
      out.vx = 0;
      out.vy = 0;
      return;
    }

    const reduction = decel * dt;
    if (reduction >= speed) {
      out.vx = 0;
      out.vy = 0;
      return;
    }

    const scale = (speed - reduction) / speed;
    out.vx = velocityX * scale;
    out.vy = velocityY * scale;
    return;
  }

  // Normalise input direction
  const inputLen = Math.hypot(inputX, inputY);
  const dirX = inputX / inputLen;
  const dirY = inputY / inputLen;

  // Desired velocity = direction * maxSpeed
  const desiredX = dirX * maxSpeed;
  const desiredY = dirY * maxSpeed;

  // Delta from current to desired
  const dx = desiredX - velocityX;
  const dy = desiredY - velocityY;
  const dist = Math.hypot(dx, dy);

  // If already very close to desired velocity, snap
  const maxDelta = accel * dt;
  if (dist <= maxDelta || dist === 0) {
    out.vx = desiredX;
    out.vy = desiredY;
    return;
  }

  // Step toward desired velocity, capped by acceleration * dt
  const ratio = maxDelta / dist;
  out.vx = velocityX + dx * ratio;
  out.vy = velocityY + dy * ratio;
}

/**
 * DetSpring.ts — Deterministic semi-implicit Euler spring-damper.
 *
 * Pure functions over plain SpringState. One call to stepSpring = one 60Hz
 * tick, integrated as EXACTLY 4 substeps of 1/240s — never derived from a
 * variable dt, so every caller (server tick, client prediction, replays)
 * produces the identical trajectory.
 *
 * Behavior-identical to the legacy client SpringVec2.update(1/60), which
 * computed ceil((1/60)/(1/240)) = 4 substeps.
 *
 * Damping is specified as zeta (damping ratio):
 *   zeta < 1 → underdamped (overshoot, springy), zeta = 1 → critical,
 *   zeta > 1 → overdamped (sluggish).
 */
import type { SpringState, SpringState1D } from './AnimTypes.js';

const SUBSTEPS = 4;
const SUB_DT = 1 / 240;

export function createSpringState(x: number, y: number): SpringState {
  return { x, y, vx: 0, vy: 0 };
}

export function createSpringState1D(value: number): SpringState1D {
  return { value, vel: 0 };
}

/** Advance one 60Hz tick toward (targetX, targetY). Mutates `s`. */
export function stepSpring(
  s: SpringState,
  targetX: number,
  targetY: number,
  stiffness: number,
  zeta: number,
): void {
  const omega = Math.sqrt(stiffness);
  const dampCoeff = 2 * zeta * omega;

  for (let i = 0; i < SUBSTEPS; i++) {
    const ax = -stiffness * (s.x - targetX) - dampCoeff * s.vx;
    const ay = -stiffness * (s.y - targetY) - dampCoeff * s.vy;
    // Semi-implicit Euler: velocity first, then position with NEW velocity
    s.vx += ax * SUB_DT;
    s.vy += ay * SUB_DT;
    s.x += s.vx * SUB_DT;
    s.y += s.vy * SUB_DT;
  }
}

/** Advance one 60Hz tick of a scalar spring. Mutates `s`. */
export function stepSpring1D(
  s: SpringState1D,
  target: number,
  stiffness: number,
  zeta: number,
): void {
  const omega = Math.sqrt(stiffness);
  const dampCoeff = 2 * zeta * omega;
  for (let i = 0; i < SUBSTEPS; i++) {
    const a = -stiffness * (s.value - target) - dampCoeff * s.vel;
    s.vel += a * SUB_DT;
    s.value += s.vel * SUB_DT;
  }
}

/**
 * Advance one 60Hz tick of an ANGLE spring — error wrapped to [-π, π] so the
 * spring always takes the shortest rotational path.
 */
export function stepAngleSpring(
  s: SpringState1D,
  target: number,
  stiffness: number,
  zeta: number,
): void {
  // Re-base the target each tick onto the branch nearest the current value
  let error = target - s.value;
  error = Math.atan2(Math.sin(error), Math.cos(error));
  stepSpring1D(s, s.value + error, stiffness, zeta);
}

/** Velocity kick — attack commitment, recoil, hit flinch. Mutates `s`. */
export function applyImpulse(s: SpringState, ix: number, iy: number): void {
  s.vx += ix;
  s.vy += iy;
}

/** Snap position to a point and zero velocity (late join / large desync). */
export function snapSpring(s: SpringState, x: number, y: number): void {
  s.x = x;
  s.y = y;
  s.vx = 0;
  s.vy = 0;
}

/**
 * Hard half-plane constraint: keep the spring at or behind `maxProj` along
 * the unit axis (ux, uy). Position is projected back onto the surface; the
 * outward velocity component is absorbed (reflected by `restitution`) and
 * the remaining velocity is damped by `friction` so motion grinds against
 * the surface. Returns true when the constraint engaged. Mutates `s`.
 */
export function constrainAlongAxis(
  s: SpringState,
  ux: number,
  uy: number,
  maxProj: number,
  restitution: number,
  friction = 0,
): boolean {
  const proj = s.x * ux + s.y * uy;
  if (proj <= maxProj) return false;
  const over = proj - maxProj;
  s.x -= ux * over;
  s.y -= uy * over;
  const vProj = s.vx * ux + s.vy * uy;
  if (vProj > 0) {
    const dv = vProj * (1 + restitution);
    s.vx -= ux * dv;
    s.vy -= uy * dv;
  }
  if (friction > 0) {
    const keep = 1 - friction;
    s.vx *= keep;
    s.vy *= keep;
  }
  return true;
}

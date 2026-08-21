/**
 * commonPoses.ts — Universal pose functions: dash, stagger, dying, block.
 *
 * Moved from client-v3 AnimationPoses.ts and made TICK-DRIVEN (no wall-clock
 * `now`) so both sides compute identical poses. Oscillator conversions use
 * tick ≈ now/16.67ms: sin(now/25) → sin(tick·(1000/60)/25) = sin(tick·0.6667).
 */
import type { HandTargets } from '../AnimTypes.js';
import { lerp } from '../AnimEasing.js';

const R = 48; // body radius

/** Idle hand pose used as the dying-fall start (fists idle). */
const DYING_START: HandTargets = { left: { x: 42, y: -58 }, right: { x: 42, y: 58 } };

/** Fallen hand pose (dying end state). */
const FALLEN: HandTargets = {
  left: { x: R * 0.15, y: -R * 0.15 },
  right: { x: R * 0.15, y: R * 0.15 },
};

/**
 * Shared scratch — safe because the four pose functions are mutually exclusive
 * (one phase per tick). Callers must read values before the next call.
 */
const _poseScratch: HandTargets = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

export function dashPose(t: number): HandTargets {
  const anticipation = t < 0.15 ? Math.cos((t / 0.15) * Math.PI * 0.5) : 0;
  const recovery = t > 0.8 ? Math.cos(((t - 0.8) / 0.2) * Math.PI * 0.5) : 0;

  const baseBackX = -R * 0.7;
  const baseSpread = R * 0.6;

  const x = baseBackX + anticipation * R * 0.3 - recovery * R * 0.5;

  _poseScratch.left.x = x;
  _poseScratch.left.y = -baseSpread;
  _poseScratch.right.x = x;
  _poseScratch.right.y = baseSpread;
  return _poseScratch;
}

export function staggerPose(t: number, tick: number): HandTargets {
  const decay = Math.exp(-4 * t);
  // legacy sin(now/25) at 16.67ms/tick
  const shake = Math.sin(tick * 0.6667) * R * 0.25 * decay;
  _poseScratch.left.x = R * 0.3 + shake;
  _poseScratch.left.y = -R * 0.6;
  _poseScratch.right.x = R * 0.3 - shake;
  _poseScratch.right.y = R * 0.6;
  return _poseScratch;
}

export function dyingPose(t: number): HandTargets {
  const et = t * t;
  _poseScratch.left.x = lerp(DYING_START.left.x, FALLEN.left.x, et);
  _poseScratch.left.y = lerp(DYING_START.left.y, FALLEN.left.y, et);
  _poseScratch.right.x = lerp(DYING_START.right.x, FALLEN.right.x, et);
  _poseScratch.right.y = lerp(DYING_START.right.y, FALLEN.right.y, et);
  return _poseScratch;
}

/**
 * Block hold with a breathing pulse. `hold` comes from the weapon's motion
 * spec (per-weapon guard stance).
 */
export function blockPose(hold: HandTargets, tick: number): HandTargets {
  // legacy sin(now/280) and sin(now/430) at 16.67ms/tick
  const pulse = Math.sin(tick * 0.0595) * 2.5;
  const sway = Math.sin(tick * 0.0388) * 1.5;
  _poseScratch.left.x = hold.left.x + pulse;
  _poseScratch.left.y = hold.left.y - sway;
  _poseScratch.right.x = hold.right.x + pulse;
  _poseScratch.right.y = hold.right.y - sway;
  return _poseScratch;
}

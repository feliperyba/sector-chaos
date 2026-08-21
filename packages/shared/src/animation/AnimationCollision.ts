/**
 * AnimationCollision.ts — Wall containment for hand springs.
 *
 * Extracted VERBATIM from stepAnimation.ts — no calculation, constant, formula,
 * conditional, or operation order has been changed.
 *
 * `WALL_SAMPLE_STEP` and `WALL_MARGIN` are EXPORTED because stepAnimation's
 * blade-containment loop also reads them (the blade is sampled with the same
 * step + margin as the hands).
 */
import { constrainAlongAxis } from './DetSpring.js';

/** Wall containment: sample step + clearance margin (px). */
export const WALL_SAMPLE_STEP = 8;
export const WALL_MARGIN = 4;

/**
 * Clamp a hand spring so its WORLD position stays out of blocking tiles:
 * walk the body→hand ray and stop the hand short of the first solid sample.
 * Outward velocity is absorbed via the half-plane constraint (arms grind
 * against the wall instead of poking through it).
 */
export function clampHandAgainstWalls(
  s: { x: number; y: number; vx: number; vy: number },
  bodyX: number,
  bodyY: number,
  cosA: number,
  sinA: number,
  isWorldBlocked: (x: number, y: number) => boolean,
): void {
  const dist = Math.sqrt(s.x * s.x + s.y * s.y);
  if (dist < WALL_SAMPLE_STEP) return;
  const ux = s.x / dist;
  const uy = s.y / dist;

  for (let d = WALL_SAMPLE_STEP; d <= dist; d += WALL_SAMPLE_STEP) {
    const sampleD = Math.min(d, dist);
    const lx = ux * sampleD;
    const ly = uy * sampleD;
    const wx = bodyX + lx * cosA - ly * sinA;
    const wy = bodyY + lx * sinA + ly * cosA;
    if (isWorldBlocked(wx, wy)) {
      const clampDist = Math.max(0, sampleD - WALL_SAMPLE_STEP - WALL_MARGIN) + WALL_MARGIN;
      constrainAlongAxis(s, ux, uy, clampDist, 0, 0.2);
      return;
    }
  }
}

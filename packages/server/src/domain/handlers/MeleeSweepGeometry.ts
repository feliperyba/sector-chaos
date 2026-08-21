import { segmentIntersectsAABB, type Vec2 } from '@sector-battle/shared';
import type { Player } from '../entities/index.ts';
import type { ICollisionService } from '../services/index.ts';

/**
 * Pure geometry helpers for the melee sweep pipeline. Mechanical extraction
 * from MeleeSweepHandler — bodies verbatim, only `this.match.getCollisionService()`
 * became a `collisionService` argument (same instance, same call).
 */

export const SWEEP_SUBSEGMENTS = 4;

/**
 * Sweep the blade from its previous-tick segment to the current one and
 * return the first contact point with the entity's hit/hurt AABB, or null.
 * Uses the exact slab test — consistent with the SAT-style collision the
 * rest of the game uses (corner contacts register).
 */
export function sweepContact(
  prevGrip: Vec2,
  prevTip: Vec2,
  grip: Vec2,
  tip: Vec2,
  hurtbox: { x: number; y: number; width: number; height: number },
  bladeRadius: number,
): Vec2 | null {
  const cx = hurtbox.x + hurtbox.width / 2;
  const cy = hurtbox.y + hurtbox.height / 2;
  const expanded =
    bladeRadius > 0
      ? {
          x: hurtbox.x - bladeRadius,
          y: hurtbox.y - bladeRadius,
          width: hurtbox.width + bladeRadius * 2,
          height: hurtbox.height + bladeRadius * 2,
        }
      : hurtbox;
  for (let i = 1; i <= SWEEP_SUBSEGMENTS; i++) {
    const t = i / SWEEP_SUBSEGMENTS;
    const gx = prevGrip.x + (grip.x - prevGrip.x) * t;
    const gy = prevGrip.y + (grip.y - prevGrip.y) * t;
    const tx = prevTip.x + (tip.x - prevTip.x) * t;
    const ty = prevTip.y + (tip.y - prevTip.y) * t;

    if (segmentIntersectsAABB(gx, gy, tx, ty, expanded)) {
      return closestPointOnSegment(gx, gy, tx, ty, cx, cy);
    }
  }
  return null;
}

/**
 * Sweep the blade against a destructible's enriched SAT collider polygon.
 * The blade is wall-clamped OUTSIDE the tile by stepAnimation, so a
 * point-in-polygon test can never fire — we must test segment-vs-polygon
 * overlap instead. Each of the 4 sweep subsegments is tested as a thin
 * AABB (expanded by bladeRadius) against the collider polygon via SAT.
 */
export function sweepContactDestructible(
  prevGrip: Vec2,
  prevTip: Vec2,
  grip: Vec2,
  tip: Vec2,
  gridX: number,
  gridY: number,
  bladeRadius: number,
  collisionService: ICollisionService,
): Vec2 | null {
  for (let i = 1; i <= SWEEP_SUBSEGMENTS; i++) {
    const t = i / SWEEP_SUBSEGMENTS;
    const gx = prevGrip.x + (grip.x - prevGrip.x) * t;
    const gy = prevGrip.y + (grip.y - prevGrip.y) * t;
    const tx = prevTip.x + (tip.x - prevTip.x) * t;
    const ty = prevTip.y + (tip.y - prevTip.y) * t;

    if (collisionService.segmentIntersectsTileCollider(gx, gy, tx, ty, bladeRadius, gridX, gridY)) {
      return { x: (gx + tx) / 2, y: (gy + ty) / 2 };
    }
  }
  return null;
}

export function closestPointOnSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  px: number,
  py: number,
): Vec2 {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: x1, y: y1 };
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

/** World-space blade travel direction (falls back to facing). */
export function swingDirection(player: Player, tip: Vec2, prevTip: Vec2): Vec2 {
  const dx = tip.x - prevTip.x;
  const dy = tip.y - prevTip.y;
  if (dx * dx + dy * dy > 0.01) return { x: dx, y: dy };
  return {
    x: Math.cos(player.movement.facingAngle),
    y: Math.sin(player.movement.facingAngle),
  };
}

/** Line segment defined by two endpoints. */
export interface LineSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Distance from a point to a line segment. */
export function pointToSegmentDistance(px: number, py: number, segment: LineSegment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.sqrt((px - segment.x1) ** 2 + (py - segment.y1) ** 2);
  }

  let t = ((px - segment.x1) * dx + (py - segment.y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const projX = segment.x1 + t * dx;
  const projY = segment.y1 + t * dy;

  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

/** Checks intersection between a segment and circle. */
export function segmentCircleIntersection(
  segment: LineSegment,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  return pointToSegmentDistance(cx, cy, segment) <= radius;
}

/**
 * Exact segment-vs-AABB intersection (slab method). Matches the SAT-style
 * hit/hurt box semantics used by the rest of the collision system — unlike a
 * circle approximation, corner contacts register.
 */
export function segmentIntersectsAABB(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  aabb: { x: number; y: number; width: number; height: number },
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tMin = 0;
  let tMax = 1;

  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (x1 < aabb.x || x1 > aabb.x + aabb.width) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (aabb.x - x1) * inv;
    let t2 = (aabb.x + aabb.width - x1) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (y1 < aabb.y || y1 > aabb.y + aabb.height) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (aabb.y - y1) * inv;
    let t2 = (aabb.y + aabb.height - y1) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return true;
}

/** Tests if point is in front of a line. */
export function isPointInFront(
  px: number,
  py: number,
  facingX: number,
  facingY: number,
  originX: number,
  originY: number,
): boolean {
  const toPointX = px - originX;
  const toPointY = py - originY;
  return toPointX * facingX + toPointY * facingY >= 0;
}

import type { MTV } from './Vec2.js';

/** Axis-aligned bounding box. */
export interface AABB {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** AABB collision detection and resolution. */
export class AABBCollision {
  static intersects(a: AABB, b: AABB): boolean {
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  }

  static getMTVInto(a: AABB, b: AABB, out: MTV): boolean {
    if (!AABBCollision.intersects(a, b)) return false;

    const overlapX = Math.min(a.x + a.width - b.x, b.x + b.width - a.x);
    const overlapY = Math.min(a.y + a.height - b.y, b.y + b.height - a.y);

    if (overlapX < overlapY) {
      const sign = a.x + a.width / 2 < b.x + b.width / 2 ? -1 : 1;
      out.x = sign;
      out.y = 0;
      out.depth = overlapX;
    } else {
      const sign = a.y + a.height / 2 < b.y + b.height / 2 ? -1 : 1;
      out.x = 0;
      out.y = sign;
      out.depth = overlapY;
    }
    return true;
  }

  static getMTV(a: AABB, b: AABB): MTV | null {
    const out: MTV = { x: 0, y: 0, depth: 0 };
    if (AABBCollision.getMTVInto(a, b, out)) return out;
    return null;
  }
}

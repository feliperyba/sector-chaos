import { AABBCollision, type AABB } from '../../src/math/AABBCollision.js';

describe('AABBCollision', () => {
  describe('intersects', () => {
    it('overlapping boxes return true', () => {
      const a: AABB = { x: 0, y: 0, width: 10, height: 10 };
      const b: AABB = { x: 5, y: 5, width: 10, height: 10 };
      expect(AABBCollision.intersects(a, b)).toBe(true);
    });

    it('non-overlapping boxes return false', () => {
      const a: AABB = { x: 0, y: 0, width: 10, height: 10 };
      const b: AABB = { x: 20, y: 20, width: 10, height: 10 };
      expect(AABBCollision.intersects(a, b)).toBe(false);
    });

    it('touching edges (gap=0) return false', () => {
      const a: AABB = { x: 0, y: 0, width: 10, height: 10 };
      const b: AABB = { x: 10, y: 0, width: 10, height: 10 };
      expect(AABBCollision.intersects(a, b)).toBe(false);
    });
  });

  describe('getMTV', () => {
    it('non-overlapping returns null', () => {
      const a: AABB = { x: 0, y: 0, width: 10, height: 10 };
      const b: AABB = { x: 20, y: 0, width: 10, height: 10 };
      expect(AABBCollision.getMTV(a, b)).toBeNull();
    });

    it('X-axis resolution when overlap is smaller on X', () => {
      const a: AABB = { x: 0, y: 0, width: 10, height: 10 };
      const b: AABB = { x: 8, y: 0, width: 10, height: 10 };
      const mtv = AABBCollision.getMTV(a, b)!;
      expect(mtv.x).not.toBe(0);
      expect(mtv.y).toBe(0);
      expect(mtv.depth).toBe(2);
    });

    it('Y-axis resolution when overlap is smaller on Y', () => {
      const a: AABB = { x: 0, y: 0, width: 10, height: 10 };
      const b: AABB = { x: 0, y: 8, width: 10, height: 10 };
      const mtv = AABBCollision.getMTV(a, b)!;
      expect(mtv.x).toBe(0);
      expect(mtv.y).not.toBe(0);
      expect(mtv.depth).toBe(2);
    });

    it('chooses axis with smaller overlap', () => {
      const a: AABB = { x: 0, y: 0, width: 20, height: 20 };
      const b: AABB = { x: 18, y: 5, width: 20, height: 20 };
      const mtv = AABBCollision.getMTV(a, b)!;
      expect(mtv.x).not.toBe(0);
      expect(mtv.y).toBe(0);
      expect(mtv.depth).toBe(2);
    });

    it('containment case returns an MTV', () => {
      const outer: AABB = { x: 0, y: 0, width: 20, height: 20 };
      const inner: AABB = { x: 5, y: 5, width: 5, height: 5 };
      const mtv = AABBCollision.getMTV(outer, inner)!;
      expect(mtv).not.toBeNull();
      expect(mtv.depth).toBeGreaterThan(0);
    });

    it('degenerate AABB (zero width/height) returns null', () => {
      const a: AABB = { x: 0, y: 0, width: 0, height: 0 };
      const b: AABB = { x: 0, y: 0, width: 10, height: 10 };
      expect(AABBCollision.getMTV(a, b)).toBeNull();
    });
  });
});

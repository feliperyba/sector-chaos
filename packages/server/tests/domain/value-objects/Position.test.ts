import { Position } from '../../../src/domain/value-objects/index.ts';

describe('Position', () => {
  describe('Creation', () => {
    it('creates position at origin', () => {
      const pos = new Position(0, 0);
      expect(pos.x).toBe(0);
      expect(pos.y).toBe(0);
    });

    it('creates position with positive coordinates', () => {
      const pos = new Position(100, 200);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(200);
    });

    it('creates position with negative coordinates', () => {
      const pos = new Position(-50, -75);
      expect(pos.x).toBe(-50);
      expect(pos.y).toBe(-75);
    });

    it('creates position with floating point coordinates', () => {
      const pos = new Position(3.14, 2.71);
      expect(pos.x).toBeCloseTo(3.14);
      expect(pos.y).toBeCloseTo(2.71);
    });
  });

  describe('distanceTo()', () => {
    it('returns 5 for 3-4-5 triangle', () => {
      const a = new Position(0, 0);
      const b = new Position(3, 4);
      expect(a.distanceTo(b)).toBeCloseTo(5);
    });

    it('returns 0 from origin to origin', () => {
      const a = new Position(0, 0);
      const b = new Position(0, 0);
      expect(a.distanceTo(b)).toBe(0);
    });

    it('returns 5 for offset 3-4-5 triangle', () => {
      const a = new Position(10, 10);
      const b = new Position(13, 14);
      expect(a.distanceTo(b)).toBeCloseTo(5);
    });

    it('returns 0 for same position', () => {
      const a = new Position(5, 5);
      expect(a.distanceTo(a)).toBe(0);
    });
  });

  describe('distanceToSquared()', () => {
    it('returns 25 for 3-4-5 triangle', () => {
      const a = new Position(0, 0);
      const b = new Position(3, 4);
      expect(a.distanceToSquared(b)).toBe(25);
    });

    it('returns 0 from origin to origin', () => {
      const a = new Position(0, 0);
      const b = new Position(0, 0);
      expect(a.distanceToSquared(b)).toBe(0);
    });
  });

  describe('move()', () => {
    it('returns new Position with added offsets', () => {
      const pos = new Position(10, 20).move(5, 10);
      expect(pos.x).toBe(15);
      expect(pos.y).toBe(30);
    });

    it('returns new Position with negative offsets', () => {
      const pos = new Position(0, 0).move(-5, -10);
      expect(pos.x).toBe(-5);
      expect(pos.y).toBe(-10);
    });

    it('returns same Position with zero offsets', () => {
      const pos = new Position(100, 200).move(0, 0);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(200);
    });

    it('does not mutate the original', () => {
      const original = new Position(10, 20);
      const moved = original.move(5, 10);
      expect(original.x).toBe(10);
      expect(original.y).toBe(20);
      expect(moved).not.toBe(original);
    });
  });

  describe('lerp()', () => {
    it('returns midpoint at t=0.5', () => {
      const result = new Position(0, 0).lerp(new Position(100, 100), 0.5);
      expect(result.x).toBeCloseTo(50);
      expect(result.y).toBeCloseTo(50);
    });

    it('returns start at t=0', () => {
      const result = new Position(0, 0).lerp(new Position(100, 100), 0);
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(0);
    });

    it('returns end at t=1', () => {
      const result = new Position(0, 0).lerp(new Position(100, 100), 1);
      expect(result.x).toBeCloseTo(100);
      expect(result.y).toBeCloseTo(100);
    });

    it('returns a new Position', () => {
      const a = new Position(0, 0);
      const b = new Position(100, 100);
      const result = a.lerp(b, 0.5);
      expect(result).not.toBe(a);
      expect(result).not.toBe(b);
    });
  });

  describe('equals()', () => {
    it('returns true for identical coordinates', () => {
      expect(new Position(10, 20).equals(new Position(10, 20))).toBe(true);
    });

    it('returns false when y differs', () => {
      expect(new Position(10, 20).equals(new Position(10, 21))).toBe(false);
    });

    it('returns false when x differs', () => {
      expect(new Position(10, 20).equals(new Position(11, 20))).toBe(false);
    });
  });

  describe('clone()', () => {
    it('returns a Position with the same coordinates', () => {
      const cloned = new Position(42, 99).clone();
      expect(cloned.x).toBe(42);
      expect(cloned.y).toBe(99);
    });

    it('returns a Position that equals the original', () => {
      const original = new Position(42, 99);
      expect(original.clone().equals(original)).toBe(true);
    });

    it('returns a different reference', () => {
      const original = new Position(42, 99);
      expect(original.clone()).not.toBe(original);
    });
  });

  describe('Immutability', () => {
    it('has readonly x and y', () => {
      const pos = new Position(10, 20);
      expect(pos.x).toBe(10);
      expect(pos.y).toBe(20);
    });

    it('move returns new instance without mutating this', () => {
      const original = new Position(10, 20);
      original.move(5, 5);
      expect(original.x).toBe(10);
      expect(original.y).toBe(20);
    });

    it('lerp returns new instance without mutating this', () => {
      const original = new Position(10, 20);
      original.lerp(new Position(100, 100), 0.5);
      expect(original.x).toBe(10);
      expect(original.y).toBe(20);
    });

    it('clone returns new instance without mutating this', () => {
      const original = new Position(10, 20);
      original.clone();
      expect(original.x).toBe(10);
      expect(original.y).toBe(20);
    });
  });
});

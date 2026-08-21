import { Speed } from '../../../src/domain/value-objects/index.ts';

describe('Speed', () => {
  describe('creation', () => {
    it('stores value and max for typical speed', () => {
      const speed = new Speed(200, 600);
      expect(speed.value).toBe(200);
      expect(speed.max).toBe(600);
    });

    it('stores value and max when value is zero', () => {
      const speed = new Speed(0, 600);
      expect(speed.value).toBe(0);
      expect(speed.max).toBe(600);
    });

    it('stores value and max for high speed', () => {
      const speed = new Speed(400, 600);
      expect(speed.value).toBe(400);
      expect(speed.max).toBe(600);
    });
  });

  describe('scale()', () => {
    it('doubles speed with factor 2.0 (dash speed)', () => {
      const speed = new Speed(200, 600).scale(2.0);
      expect(speed.value).toBe(400);
      expect(speed.max).toBe(600);
    });

    it('applies fractional factor 1.3 (speed boost)', () => {
      const speed = new Speed(200, 600).scale(1.3);
      expect(speed.value).toBe(260);
      expect(speed.max).toBe(600);
    });

    it('halves speed with factor 0.5 (blocking/stagger penalty)', () => {
      const speed = new Speed(200, 600).scale(0.5);
      expect(speed.value).toBe(100);
      expect(speed.max).toBe(600);
    });

    it('zeroes speed with factor 0', () => {
      const speed = new Speed(200, 600).scale(0);
      expect(speed.value).toBe(0);
      expect(speed.max).toBe(600);
    });

    it('clamps negative factor result to 0', () => {
      const speed = new Speed(200, 600).scale(-1);
      expect(speed.value).toBe(0);
      expect(speed.max).toBe(600);
    });

    it('returns a new Speed instance', () => {
      const original = new Speed(200, 600);
      const scaled = original.scale(2.0);
      expect(scaled).not.toBe(original);
      expect(scaled).toBeInstanceOf(Speed);
    });
  });

  describe('isZero', () => {
    it('returns true when value is 0', () => {
      expect(new Speed(0, 600).isZero).toBe(true);
    });

    it('returns false when value is 1', () => {
      expect(new Speed(1, 600).isZero).toBe(false);
    });

    it('returns false when value is 200', () => {
      expect(new Speed(200, 600).isZero).toBe(false);
    });
  });

  describe('normalized', () => {
    it('returns value/max ratio for 200/600', () => {
      expect(new Speed(200, 600).normalized).toBeCloseTo(200 / 600);
    });

    it('returns 0.5 for 300/600', () => {
      expect(new Speed(300, 600).normalized).toBe(0.5);
    });

    it('returns 1.0 for 600/600', () => {
      expect(new Speed(600, 600).normalized).toBe(1.0);
    });

    it('returns 0.0 for 0/600', () => {
      expect(new Speed(0, 600).normalized).toBe(0.0);
    });
  });
});

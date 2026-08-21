import { Health } from '../../../src/domain/value-objects/index.ts';

describe('Health', () => {
  describe('creation', () => {
    it('creates with full health', () => {
      const health = new Health(100, 100);

      expect(health.current).toBe(100);
      expect(health.max).toBe(100);
    });

    it('creates with partial health', () => {
      const health = new Health(50, 100);

      expect(health.current).toBe(50);
      expect(health.max).toBe(100);
    });

    it('creates with zero health', () => {
      const health = new Health(0, 100);

      expect(health.current).toBe(0);
      expect(health.max).toBe(100);
    });
  });

  describe('damage()', () => {
    it('reduces current health by damage amount', () => {
      const result = new Health(100, 100).damage(30);

      expect(result.current).toBe(70);
      expect(result.max).toBe(100);
    });

    it('kills exactly when damage equals current health', () => {
      const result = new Health(50, 100).damage(50);

      expect(result.current).toBe(0);
      expect(result.max).toBe(100);
    });

    it('clamps to zero on overkill', () => {
      const result = new Health(20, 100).damage(30);

      expect(result.current).toBe(0);
      expect(result.max).toBe(100);
    });

    it('does not change health on zero damage', () => {
      const result = new Health(100, 100).damage(0);

      expect(result.current).toBe(100);
      expect(result.max).toBe(100);
    });

    it('returns a new Health leaving the original unchanged', () => {
      const original = new Health(100, 100);
      const result = original.damage(30);

      expect(original.current).toBe(100);
      expect(result.current).toBe(70);
      expect(result).not.toBe(original);
    });
  });

  describe('heal()', () => {
    it('restores health up to max', () => {
      const result = new Health(70, 100).heal(30);

      expect(result.current).toBe(100);
      expect(result.max).toBe(100);
    });

    it('caps at max and never exceeds', () => {
      const result = new Health(90, 100).heal(30);

      expect(result.current).toBe(100);
      expect(result.max).toBe(100);
    });

    it('heals from zero', () => {
      const result = new Health(0, 100).heal(50);

      expect(result.current).toBe(50);
      expect(result.max).toBe(100);
    });

    it('does not change health on zero heal', () => {
      const result = new Health(100, 100).heal(0);

      expect(result.current).toBe(100);
      expect(result.max).toBe(100);
    });

    it('returns a new Health leaving the original unchanged', () => {
      const original = new Health(70, 100);
      const result = original.heal(30);

      expect(original.current).toBe(70);
      expect(result.current).toBe(100);
      expect(result).not.toBe(original);
    });
  });

  describe('isDead', () => {
    it('returns true when current is zero', () => {
      expect(new Health(0, 100).isDead).toBe(true);
    });

    it('returns false when current is one', () => {
      expect(new Health(1, 100).isDead).toBe(false);
    });

    it('returns false when at full health', () => {
      expect(new Health(100, 100).isDead).toBe(false);
    });
  });

  describe('percentage', () => {
    it('returns 1.0 at full health', () => {
      expect(new Health(100, 100).percentage).toBe(1.0);
    });

    it('returns 0.5 at half health', () => {
      expect(new Health(50, 100).percentage).toBe(0.5);
    });

    it('returns 0.0 at zero health', () => {
      expect(new Health(0, 100).percentage).toBe(0.0);
    });

    it('returns 0.75 at three-quarter health', () => {
      expect(new Health(75, 100).percentage).toBe(0.75);
    });
  });

  describe('isFull', () => {
    it('returns true when current equals max', () => {
      expect(new Health(100, 100).isFull).toBe(true);
    });

    it('returns false when one below max', () => {
      expect(new Health(99, 100).isFull).toBe(false);
    });

    it('returns false when at zero health', () => {
      expect(new Health(0, 100).isFull).toBe(false);
    });
  });

  describe('equals()', () => {
    it('returns true for identical full health', () => {
      expect(new Health(100, 100).equals(new Health(100, 100))).toBe(true);
    });

    it('returns true for identical partial health', () => {
      expect(new Health(50, 100).equals(new Health(50, 100))).toBe(true);
    });

    it('returns false when max differs', () => {
      expect(new Health(50, 100).equals(new Health(50, 200))).toBe(false);
    });

    it('returns false when current differs', () => {
      expect(new Health(50, 100).equals(new Health(60, 100))).toBe(false);
    });
  });
});

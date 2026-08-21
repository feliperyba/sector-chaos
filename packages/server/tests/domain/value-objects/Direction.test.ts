import { Direction } from '../../../src/domain/value-objects/index.ts';
import { Direction as DirectionEnum } from '@sector-battle/shared';

describe('Direction', () => {
  describe('Creation', () => {
    it('stores UP enum value', () => {
      const d = new Direction(DirectionEnum.UP);
      expect(d.value).toBe(DirectionEnum.UP);
    });

    it('stores NONE enum value', () => {
      const d = new Direction(DirectionEnum.NONE);
      expect(d.value).toBe(DirectionEnum.NONE);
    });
  });

  describe('toVector()', () => {
    it('returns { dx: 0, dy: -1 } for UP', () => {
      expect(Direction.UP.toVector()).toEqual({ dx: 0, dy: -1 });
    });

    it('returns { dx: 0, dy: 1 } for DOWN', () => {
      expect(Direction.DOWN.toVector()).toEqual({ dx: 0, dy: 1 });
    });

    it('returns { dx: -1, dy: 0 } for LEFT', () => {
      expect(Direction.LEFT.toVector()).toEqual({ dx: -1, dy: 0 });
    });

    it('returns { dx: 1, dy: 0 } for RIGHT', () => {
      expect(Direction.RIGHT.toVector()).toEqual({ dx: 1, dy: 0 });
    });

    it('returns { dx: 0, dy: 0 } for NONE', () => {
      expect(Direction.NONE.toVector()).toEqual({ dx: 0, dy: 0 });
    });
  });

  describe('fromVector()', () => {
    it('returns RIGHT for (1, 0)', () => {
      expect(Direction.fromVector(1, 0)).toBe(Direction.RIGHT);
    });

    it('returns LEFT for (-1, 0)', () => {
      expect(Direction.fromVector(-1, 0)).toBe(Direction.LEFT);
    });

    it('returns UP for (0, -1)', () => {
      expect(Direction.fromVector(0, -1)).toBe(Direction.UP);
    });

    it('returns DOWN for (0, 1)', () => {
      expect(Direction.fromVector(0, 1)).toBe(Direction.DOWN);
    });

    it('returns NONE for (0, 0)', () => {
      expect(Direction.fromVector(0, 0)).toBe(Direction.NONE);
    });

    it('returns RIGHT for (5, 0) — absX > absY, vx > 0', () => {
      expect(Direction.fromVector(5, 0)).toBe(Direction.RIGHT);
    });

    it('returns UP for (0, -5) — absY > absX, vy < 0', () => {
      expect(Direction.fromVector(0, -5)).toBe(Direction.UP);
    });

    it('returns RIGHT for (1, 1) — absX >= absY, vx > 0', () => {
      expect(Direction.fromVector(1, 1)).toBe(Direction.RIGHT);
    });

    it('returns DOWN for (0.5, 1) — absY > absX, vy > 0', () => {
      expect(Direction.fromVector(0.5, 1)).toBe(Direction.DOWN);
    });
  });

  describe('isOpposite()', () => {
    it('UP is opposite of DOWN', () => {
      expect(Direction.UP.isOpposite(Direction.DOWN)).toBe(true);
    });

    it('DOWN is opposite of UP', () => {
      expect(Direction.DOWN.isOpposite(Direction.UP)).toBe(true);
    });

    it('LEFT is opposite of RIGHT', () => {
      expect(Direction.LEFT.isOpposite(Direction.RIGHT)).toBe(true);
    });

    it('RIGHT is opposite of LEFT', () => {
      expect(Direction.RIGHT.isOpposite(Direction.LEFT)).toBe(true);
    });

    it('UP is not opposite of itself', () => {
      expect(Direction.UP.isOpposite(Direction.UP)).toBe(false);
    });

    it('NONE is never opposite of NONE', () => {
      expect(Direction.NONE.isOpposite(Direction.NONE)).toBe(false);
    });

    it('NONE is never opposite of UP', () => {
      expect(Direction.NONE.isOpposite(Direction.UP)).toBe(false);
    });

    it('UP is not opposite of LEFT (perpendicular)', () => {
      expect(Direction.UP.isOpposite(Direction.LEFT)).toBe(false);
    });
  });

  describe('Static instances', () => {
    it('NONE is a Direction with value NONE', () => {
      expect(Direction.NONE).toBeInstanceOf(Direction);
      expect(Direction.NONE.value).toBe(DirectionEnum.NONE);
    });

    it('UP is a Direction with value UP', () => {
      expect(Direction.UP).toBeInstanceOf(Direction);
      expect(Direction.UP.value).toBe(DirectionEnum.UP);
    });

    it('DOWN is a Direction with value DOWN', () => {
      expect(Direction.DOWN).toBeInstanceOf(Direction);
      expect(Direction.DOWN.value).toBe(DirectionEnum.DOWN);
    });

    it('LEFT is a Direction with value LEFT', () => {
      expect(Direction.LEFT).toBeInstanceOf(Direction);
      expect(Direction.LEFT.value).toBe(DirectionEnum.LEFT);
    });

    it('RIGHT is a Direction with value RIGHT', () => {
      expect(Direction.RIGHT).toBeInstanceOf(Direction);
      expect(Direction.RIGHT.value).toBe(DirectionEnum.RIGHT);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { Exit } from '../../../src/domain/entities/Exit.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { GridCoord } from '../../../src/domain/value-objects/GridCoord.ts';

describe('Exit', () => {
  describe('creation', () => {
    it('creates with correct properties', () => {
      const exit = new Exit('e1', new Position(500, 500), new GridCoord(2, 3), 1);

      expect(exit.id).toBe('e1');
      expect(exit.position.x).toBe(500);
      expect(exit.position.y).toBe(500);
      expect(exit.gridCoord.x).toBe(2);
      expect(exit.gridCoord.y).toBe(3);
      expect(exit.sectorIndex).toBe(1);
    });

    it('starts inactive', () => {
      const exit = new Exit('e1', new Position(500, 500), new GridCoord(2, 3), 1);
      expect(exit.active).toBe(false);
    });

    it('stores different sector indices', () => {
      const exit = new Exit('e2', new Position(0, 0), new GridCoord(0, 0), 5);
      expect(exit.sectorIndex).toBe(5);
    });
  });

  describe('activation', () => {
    it('activate sets active to true', () => {
      const exit = new Exit('e1', new Position(500, 500), new GridCoord(2, 3), 1);
      expect(exit.active).toBe(false);

      exit.activate();
      expect(exit.active).toBe(true);
    });

    it('activate is idempotent', () => {
      const exit = new Exit('e1', new Position(500, 500), new GridCoord(2, 3), 1);
      exit.activate();
      exit.activate();
      expect(exit.active).toBe(true);
    });
  });

  describe('no gameplay function', () => {
    it('only tracks position and active state', () => {
      const exit = new Exit('e1', new Position(100, 200), new GridCoord(1, 1), 0);

      expect(exit.id).toBe('e1');
      expect(exit.position.x).toBe(100);
      expect(exit.position.y).toBe(200);
      expect(exit.active).toBe(false);

      exit.activate();
      expect(exit.active).toBe(true);
    });

    it('has no methods beyond activate', () => {
      const exit = new Exit('e1', new Position(0, 0), new GridCoord(0, 0), 0);
      const proto = Object.getPrototypeOf(exit);
      const ownMethods = Object.getOwnPropertyNames(proto).filter(
        (m) => m !== 'constructor' && typeof (proto as Record<string, unknown>)[m] === 'function',
      );

      expect(ownMethods).toEqual(['activate']);
    });
  });
});

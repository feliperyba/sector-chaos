import { describe, it, expect } from 'vitest';
import {
  SiegeWallManager,
  type SiegeWallWarning,
} from '../../../src/domain/aggregates/SiegeWallManager.ts';

describe('SiegeWallManager', () => {
  describe('hasSiegeWall', () => {
    it('returns false when no walls added', () => {
      const manager = new SiegeWallManager(32, 32);
      expect(manager.hasSiegeWall(0, 0)).toBe(false);
    });
  });

  describe('addWall', () => {
    it('adds wall and hasSiegeWall returns true', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWall(3, 5);
      expect(manager.hasSiegeWall(3, 5)).toBe(true);
      expect(manager.hasSiegeWall(3, 4)).toBe(false);
    });

    it('is idempotent when adding same position twice', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWall(3, 5);
      manager.addWall(3, 5);
      expect(manager.hasSiegeWall(3, 5)).toBe(true);
    });

    it('supports multiple walls at different positions', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWall(0, 0);
      manager.addWall(1, 1);
      manager.addWall(5, 3);
      expect(manager.hasSiegeWall(0, 0)).toBe(true);
      expect(manager.hasSiegeWall(1, 1)).toBe(true);
      expect(manager.hasSiegeWall(5, 3)).toBe(true);
    });
  });

  describe('addWarning', () => {
    it('adds a single warning', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(3, 5, 1000);
      const warnings = manager.getWarnings();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toEqual({ gridX: 3, gridY: 5, solidifyAt: 1000 });
    });

    it('adds multiple warnings', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(1, 2, 100);
      manager.addWarning(3, 4, 200);
      manager.addWarning(5, 6, 300);
      expect(manager.getWarnings().length).toBe(3);
    });
  });

  describe('getWarnings', () => {
    it('returns all warnings in insertion order', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(1, 2, 100);
      manager.addWarning(3, 4, 200);
      manager.addWarning(5, 6, 300);
      const warnings = manager.getWarnings();
      expect(warnings[0]).toEqual({ gridX: 1, gridY: 2, solidifyAt: 100 });
      expect(warnings[1]).toEqual({ gridX: 3, gridY: 4, solidifyAt: 200 });
      expect(warnings[2]).toEqual({ gridX: 5, gridY: 6, solidifyAt: 300 });
    });
  });

  describe('clearExpiredWarnings', () => {
    it('removes expired warnings', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(3, 5, 500);
      manager.clearExpiredWarnings(600);
      expect(manager.getWarnings().length).toBe(0);
    });

    it('keeps active warnings', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(3, 5, 500);
      manager.clearExpiredWarnings(400);
      expect(manager.getWarnings().length).toBe(1);
    });

    it('removes warning at boundary where currentTime equals solidifyAt', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(3, 5, 500);
      manager.clearExpiredWarnings(500);
      expect(manager.getWarnings().length).toBe(0);
    });

    it('handles mixed expired and active warnings', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWarning(1, 1, 300);
      manager.addWarning(2, 2, 700);
      manager.clearExpiredWarnings(500);
      const warnings = manager.getWarnings();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toEqual({ gridX: 2, gridY: 2, solidifyAt: 700 });
    });

    it('is a no-op when no warnings exist', () => {
      const manager = new SiegeWallManager(32, 32);
      expect(() => manager.clearExpiredWarnings(100)).not.toThrow();
      expect(manager.getWarnings().length).toBe(0);
    });
  });

  describe('key format', () => {
    it('produces consistent key format for various positions', () => {
      const manager = new SiegeWallManager(32, 32);
      manager.addWall(3, 5);
      manager.addWall(0, 0);
      manager.addWall(10, 20);
      expect(manager.hasSiegeWall(3, 5)).toBe(true);
      expect(manager.hasSiegeWall(0, 0)).toBe(true);
      expect(manager.hasSiegeWall(10, 20)).toBe(true);
      expect(manager.hasSiegeWall(5, 3)).toBe(false);
      expect(manager.hasSiegeWall(0, 1)).toBe(false);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { POWERUP } from '@sector-battle/shared';
import { PowerUp } from '../../../src/domain/entities/index.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';

describe('PowerUp', () => {
  describe('create', () => {
    it('creates a speed_boost power-up with correct defaults', () => {
      const pu = PowerUp.create('pu1', 'speed_boost', new Position(100, 200), 0);
      expect(pu.id).toBe('pu1');
      expect(pu.type).toBe('speed_boost');
      expect(pu.position.x).toBe(100);
      expect(pu.position.y).toBe(200);
      expect(pu.spawnTime).toBe(0);
      expect(pu.isActive).toBe(true);
    });

    it('creates a health_pack power-up with correct defaults', () => {
      const pu = PowerUp.create('pu2', 'health_pack', new Position(50, 50), 10);
      expect(pu.type).toBe('health_pack');
      expect(pu.spawnTime).toBe(10);
    });

    it('creates a barrier power-up with correct defaults', () => {
      const pu = PowerUp.create('pu3', 'barrier', new Position(75, 75), 5);
      expect(pu.type).toBe('barrier');
      expect(pu.spawnTime).toBe(5);
    });
  });

  describe('applyTo', () => {
    describe('speed_boost type', () => {
      it('returns speed_boost effect with the tuned multiplier and duration', () => {
        const pu = PowerUp.create('pu', 'speed_boost', new Position(0, 0), 0);
        const effect = pu.applyTo(false);
        expect(effect).toEqual({
          type: 'speed_boost',
          multiplier: POWERUP.SPEED_BOOST_MULTIPLIER,
          duration: POWERUP.SPEED_BOOST_DURATION,
          isRefresh: false,
        });
      });

      it('sets isRefresh when hasExistingEffect is true', () => {
        const pu = PowerUp.create('pu', 'speed_boost', new Position(0, 0), 0);
        expect(pu.applyTo(true).isRefresh).toBe(true);
        expect(pu.applyTo(false).isRefresh).toBe(false);
      });
    });

    describe('barrier type', () => {
      it('returns barrier effect with 10s duration', () => {
        const pu = PowerUp.create('pu', 'barrier', new Position(0, 0), 0);
        const effect = pu.applyTo(false);
        expect(effect).toEqual({ type: 'barrier', duration: 10, isRefresh: false });
      });

      it('sets isRefresh when hasExistingEffect is true', () => {
        const pu = PowerUp.create('pu', 'barrier', new Position(0, 0), 0);
        expect(pu.applyTo(true).isRefresh).toBe(true);
      });
    });

    describe('health_pack type', () => {
      it('returns health_pack effect with heal amount 30', () => {
        const pu = PowerUp.create('pu', 'health_pack', new Position(0, 0), 0);
        const effect = pu.applyTo(false);
        expect(effect).toEqual({ type: 'health_pack', duration: 0, amount: 30 });
      });

      it('ignores hasExistingEffect parameter', () => {
        const pu = PowerUp.create('pu', 'health_pack', new Position(0, 0), 0);
        expect(pu.applyTo(true)).toEqual(pu.applyTo(false));
      });
    });
  });

  describe('deactivate', () => {
    it('sets isActive to false', () => {
      const pu = PowerUp.create('pu', 'speed_boost', new Position(0, 0), 0);
      expect(pu.isActive).toBe(true);
      pu.deactivate();
      expect(pu.isActive).toBe(false);
    });
  });
});

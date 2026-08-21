import { describe, it, expect, beforeEach } from 'vitest';
import { ZoneService } from '../../../src/domain/services/ZoneService.ts';
import { ZONE, TileType } from '@sector-battle/shared';

const MAP_BOUNDS = { width: 10240, height: 10240 };
const FULL_MAP_RADIUS = MAP_BOUNDS.width / 2;
// Phase timings derive from the tuned ZONE constants (872859f5): phases 1-4
// are 60s, the warning window is 15s. Deriving keeps this suite honest
// against future balance passes instead of pinning stale literals.
const PHASE_MS = (n: number): number => ZONE.PHASES[n - 1]!.duration * 1000;
const PHASES_MS = (from: number, through: number): number => {
  let total = 0;
  for (let n = from; n <= through; n++) total += PHASE_MS(n);
  return total;
};
const TRANSITION_MS = ZONE.ZONE_TRANSITION_DURATION * 1000;
const WARN_MS = ZONE.ZONE_WARNING_TIME * 1000;

function advanceTime(svc: ZoneService, totalMs: number): void {
  const step = 250;
  let remaining = totalMs;
  while (remaining > 0) {
    const delta = Math.min(remaining, step);
    svc.update(delta);
    remaining -= delta;
  }
}

describe('ZoneService', () => {
  let service: ZoneService;

  beforeEach(() => {
    service = new ZoneService();
  });

  describe('initialize', () => {
    it('sets fullMapRadius correctly to half map width', () => {
      service.initialize(MAP_BOUNDS, 42);
      const zone = service.getCurrentZone();
      expect(zone.currentRadius).toBe(FULL_MAP_RADIUS);
    });

    it('sets phase to 1', () => {
      service.initialize(MAP_BOUNDS, 42);
      const zone = service.getCurrentZone();
      expect(zone.phase).toBe(1);
    });

    it('sets currentRadius to fullMapRadius covering full map', () => {
      service.initialize(MAP_BOUNDS, 42);
      const zone = service.getCurrentZone();
      expect(zone.currentRadius).toBe(FULL_MAP_RADIUS);
    });

    it('places zone center at exact world center on Phase 1', () => {
      service.initialize(MAP_BOUNDS, 42);
      const zone = service.getCurrentZone();
      expect(zone.centerX).toBe(MAP_BOUNDS.width / 2);
      expect(zone.centerY).toBe(MAP_BOUNDS.height / 2);
    });

    it('sets targetCenter equal to center on Phase 1', () => {
      service.initialize(MAP_BOUNDS, 42);
      const zone = service.getCurrentZone();
      expect(zone.targetCenterX).toBe(MAP_BOUNDS.width / 2);
      expect(zone.targetCenterY).toBe(MAP_BOUNDS.height / 2);
    });

    it('isTransitioningCenter is false on Phase 1', () => {
      service.initialize(MAP_BOUNDS, 42);
      const zone = service.getCurrentZone();
      expect(zone.isTransitioningCenter).toBe(false);
    });

    it('does not shift center on Phase 1 regardless of seed', () => {
      service.initialize(MAP_BOUNDS, 1);
      const zone1 = service.getCurrentZone();
      const service2 = new ZoneService();
      service2.initialize(MAP_BOUNDS, 999);
      const zone2 = service2.getCurrentZone();
      expect(zone1.centerX).toBe(zone2.centerX);
      expect(zone1.centerY).toBe(zone2.centerY);
    });

    it('produces different phase 2 target centers for different seeds', () => {
      service.initialize(MAP_BOUNDS, 1);
      advanceTime(service, PHASE_MS(1));
      const zone1 = service.getCurrentZone();

      const service2 = new ZoneService();
      service2.initialize(MAP_BOUNDS, 999);
      advanceTime(service2, PHASE_MS(1));
      const zone2 = service2.getCurrentZone();

      const dx = zone1.targetCenterX - zone2.targetCenterX;
      const dy = zone1.targetCenterY - zone2.targetCenterY;
      expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(0);
    });

    it('works with non-square maps', () => {
      const nonSquareBounds = { width: 8000, height: 6000 };
      service.initialize(nonSquareBounds, 42);
      const zone = service.getCurrentZone();
      expect(zone.centerX).toBe(4000);
      expect(zone.centerY).toBe(3000);
      expect(zone.currentRadius).toBe(4000);
    });

    it('isOvertime returns false after initialize', () => {
      service.initialize(MAP_BOUNDS, 42);
      expect(service.isOvertime()).toBe(false);
    });

    it('phase 1 radius and phase stay stable after small update', () => {
      service.initialize(MAP_BOUNDS, 42);
      service.update(5000);
      expect(service.getCurrentZone().phase).toBe(1);
      expect(service.getCurrentZone().currentRadius).toBe(FULL_MAP_RADIUS);
    });
  });

  describe('phase transitions', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('transitions from phase 1 to 2 after the phase 1 duration', () => {
      advanceTime(service, PHASE_MS(1));
      expect(service.getCurrentZone().phase).toBe(2);
    });

    it('transitions from phase 2 to 3 after the phase 2 duration', () => {
      advanceTime(service, PHASES_MS(1, 2));
      expect(service.getCurrentZone().phase).toBe(3);
    });

    it('transitions from phase 3 to 4 after the phase 3 duration', () => {
      advanceTime(service, PHASES_MS(1, 3));
      expect(service.getCurrentZone().phase).toBe(4);
    });

    it('transitions from phase 4 to 5 after the phase 4 duration', () => {
      advanceTime(service, PHASES_MS(1, 4));
      expect(service.getCurrentZone().phase).toBe(5);
    });

    it('transitions from phase 5 to 6 after the phase 5 duration', () => {
      advanceTime(service, PHASES_MS(1, 5));
      expect(service.getCurrentZone().phase).toBe(6);
    });

    it('reaches phase 5 after phases 1-4 complete', () => {
      advanceTime(service, PHASES_MS(1, 4));
      expect(service.getCurrentZone().phase).toBe(5);
    });

    it('advances to phase 7 (overtime) after phase 6 completes', () => {
      advanceTime(service, PHASES_MS(1, 6));
      expect(service.getCurrentZone().phase).toBe(7);
      expect(service.isOvertime()).toBe(true);
    });

    it('stays at phase 7 after additional time', () => {
      advanceTime(service, PHASES_MS(1, 6));
      advanceTime(service, 60000);
      expect(service.getCurrentZone().phase).toBe(7);
      expect(service.isOvertime()).toBe(true);
    });
  });

  describe('advancePhase events', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('emits ZonePhaseChanged event after advancing', () => {
      service.advancePhase();
      const events = service.drainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ZonePhaseChanged');
      expect(events[0].previousPhase).toBe(1);
      expect(events[0].newPhase).toBe(2);
    });

    it('emits events with correct phases across multiple advances', () => {
      service.advancePhase();
      service.advancePhase();
      const events = service.drainEvents();
      expect(events).toHaveLength(2);
      expect(events[0].previousPhase).toBe(1);
      expect(events[0].newPhase).toBe(2);
      expect(events[1].previousPhase).toBe(2);
      expect(events[1].newPhase).toBe(3);
    });
  });

  describe('zone shrink', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('maintains start radius during stable period of phase 2', () => {
      advanceTime(service, PHASE_MS(1));
      advanceTime(service, (PHASE_MS(2) - TRANSITION_MS) / 2);
      const zone = service.getCurrentZone();
      expect(zone.currentRadius).toBeCloseTo(FULL_MAP_RADIUS, 1);
    });

    it('interpolates radius during transition period of phase 2', () => {
      advanceTime(service, PHASE_MS(1));
      advanceTime(service, PHASE_MS(2) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS / 2);
      const zone = service.getCurrentZone();
      const startRadius = FULL_MAP_RADIUS;
      const targetRadius = FULL_MAP_RADIUS * 0.6;
      const expectedRadius = startRadius + (targetRadius - startRadius) * 0.5;
      expect(zone.currentRadius).toBeCloseTo(expectedRadius, 1);
    });

    it('reaches target radius at end of phase 2 transition', () => {
      advanceTime(service, PHASE_MS(1));
      advanceTime(service, PHASE_MS(2) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS);
      const zone = service.getCurrentZone();
      expect(zone.currentRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.6, 1);
    });

    it('carries target radius into next phase start', () => {
      advanceTime(service, PHASES_MS(1, 2));
      const zone = service.getCurrentZone();
      expect(zone.phase).toBe(3);
      expect(zone.currentRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.6, 1);
    });

    it('interpolates radius at midpoint during phase 4 transition', () => {
      advanceTime(service, PHASES_MS(1, 3));
      advanceTime(service, PHASE_MS(4) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS / 2);
      const zone = service.getCurrentZone();
      expect(zone.phase).toBe(4);
      const startRadius = FULL_MAP_RADIUS * 0.25;
      const targetRadius = FULL_MAP_RADIUS * 0.15;
      const expectedMidpoint = (startRadius + targetRadius) / 2;
      expect(zone.currentRadius).toBeCloseTo(expectedMidpoint, 1);
    });

    it('holds Phase 4 target radius during Phase 5 stable period', () => {
      advanceTime(service, PHASES_MS(1, 4));
      advanceTime(service, (PHASE_MS(5) - TRANSITION_MS) / 2);
      const zone = service.getCurrentZone();
      expect(zone.phase).toBe(5);
      expect(zone.currentRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.15, 1);
    });

    it('interpolates radius at midpoint during Phase 5 transition', () => {
      advanceTime(service, PHASES_MS(1, 4));
      advanceTime(service, PHASE_MS(5) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS / 2);
      const zone = service.getCurrentZone();
      expect(zone.phase).toBe(5);
      const startRadius = FULL_MAP_RADIUS * 0.15;
      const targetRadius = FULL_MAP_RADIUS * 0.1;
      const expectedMidpoint = (startRadius + targetRadius) / 2;
      expect(zone.currentRadius).toBeCloseTo(expectedMidpoint, 1);
    });

    it('reaches target radius at end of Phase 6 transition', () => {
      advanceTime(service, PHASES_MS(1, 5));
      advanceTime(service, PHASE_MS(6) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS);
      const zone = service.getCurrentZone();
      expect(zone.phase).toBe(7);
      expect(zone.currentRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.08, 1);
    });
  });

  describe('target radii', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('phase 1 target is fullMapRadius', () => {
      expect(service.getCurrentZone().targetRadius).toBe(FULL_MAP_RADIUS);
    });

    it('phase 2 target is fullMapRadius * 0.6', () => {
      advanceTime(service, PHASE_MS(1));
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.6, 1);
    });

    it('phase 3 target is fullMapRadius * 0.25', () => {
      advanceTime(service, PHASES_MS(1, 2));
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.25, 1);
    });

    it('phase 4 target is fullMapRadius * 0.15', () => {
      advanceTime(service, PHASES_MS(1, 3));
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.15, 1);
    });

    it('phase 5 target is fullMapRadius * 0.10', () => {
      advanceTime(service, PHASES_MS(1, 4));
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.1, 1);
    });

    it('phase 6 target is fullMapRadius * 0.08', () => {
      advanceTime(service, PHASES_MS(1, 5));
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.08, 1);
    });

    it('phase 6 name is Final Closure', () => {
      expect(ZONE.PHASES[5].name).toBe('Final Closure');
    });

    it('phase 7 (OT) target radius is fullMapRadius * 0.08', () => {
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      expect(service.getCurrentZone().phase).toBe(7);
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.08, 1);
      expect(service.isOvertime()).toBe(true);
    });
  });

  describe('isInZone', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('returns true for point at zone center', () => {
      const zone = service.getCurrentZone();
      expect(service.isInZone(zone.centerX, zone.centerY)).toBe(true);
    });

    it('returns false for point far outside map', () => {
      expect(service.isInZone(20000, 20000)).toBe(false);
    });

    it('returns true for point just inside radius', () => {
      const zone = service.getCurrentZone();
      const offset = zone.currentRadius - 1;
      expect(service.isInZone(zone.centerX + offset, zone.centerY)).toBe(true);
    });

    it('returns false for point just outside radius', () => {
      const zone = service.getCurrentZone();
      const offset = zone.currentRadius + 1;
      expect(service.isInZone(zone.centerX + offset, zone.centerY)).toBe(false);
    });

    it('returns true for point exactly at radius boundary', () => {
      const zone = service.getCurrentZone();
      expect(service.isInZone(zone.centerX + zone.currentRadius, zone.centerY)).toBe(true);
    });

    it('returns false when currentRadius is zero', () => {
      service.initialize({ width: 0, height: 0 }, 42);
      expect(service.isInZone(0, 0)).toBe(false);
    });
  });

  describe('getTickDamage', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('returns 0 for phase 1', () => {
      expect(service.getTickDamage()).toBe(0);
    });

    it('returns ZONE_DAMAGE_PER_TICK for phases 2-5', () => {
      advanceTime(service, PHASE_MS(1));
      expect(service.getTickDamage()).toBe(ZONE.ZONE_DAMAGE_PER_TICK);
      advanceTime(service, PHASE_MS(2));
      expect(service.getTickDamage()).toBe(ZONE.ZONE_DAMAGE_PER_TICK);
      advanceTime(service, PHASE_MS(3));
      expect(service.getTickDamage()).toBe(ZONE.ZONE_DAMAGE_PER_TICK);
      advanceTime(service, PHASE_MS(4));
      expect(service.getTickDamage()).toBe(ZONE.ZONE_DAMAGE_PER_TICK);
    });

    it('returns ZONE_DAMAGE_SUDDEN_DEATH for phase 6 (sudden death)', () => {
      advanceTime(service, PHASES_MS(1, 5));
      expect(service.getTickDamage()).toBe(ZONE.ZONE_DAMAGE_SUDDEN_DEATH);
    });
  });

  describe('shouldTick', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('returns false before 500ms accumulated', () => {
      expect(service.shouldTick(100)).toBe(false);
      expect(service.shouldTick(200)).toBe(false);
    });

    it('returns true when 500ms accumulated', () => {
      expect(service.shouldTick(500)).toBe(true);
    });

    it('returns true after accumulated calls reach 500ms', () => {
      expect(service.shouldTick(250)).toBe(false);
      expect(service.shouldTick(250)).toBe(true);
    });

    it('carries remainder after tick', () => {
      expect(service.shouldTick(600)).toBe(true);
      expect(service.shouldTick(400)).toBe(true);
    });

    it('returns false for zero delta', () => {
      expect(service.shouldTick(0)).toBe(false);
    });

    it('returns false for negative delta', () => {
      expect(service.shouldTick(-100)).toBe(false);
    });

    it('accumulates and fires per spec: 300+200=500 fires, then 500 fires', () => {
      expect(service.shouldTick(300)).toBe(false);
      expect(service.shouldTick(200)).toBe(true);
      expect(service.shouldTick(500)).toBe(true);
    });
  });

  describe('getCurrentZone', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('returns all expected fields', () => {
      const zone = service.getCurrentZone();
      expect(zone).toHaveProperty('centerX');
      expect(zone).toHaveProperty('centerY');
      expect(zone).toHaveProperty('targetCenterX');
      expect(zone).toHaveProperty('targetCenterY');
      expect(zone).toHaveProperty('isTransitioningCenter');
      expect(zone).toHaveProperty('currentRadius');
      expect(zone).toHaveProperty('targetRadius');
      expect(zone).toHaveProperty('phase');
      expect(zone).toHaveProperty('phaseStartTime');
      expect(zone).toHaveProperty('phaseEndTime');
    });

    it('computes correct phaseStartTime and phaseEndTime', () => {
      const zone = service.getCurrentZone();
      expect(zone.phaseEndTime - zone.phaseStartTime).toBe(PHASE_MS(1));
    });
  });

  describe('isWarning', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('returns false during phase 1', () => {
      expect(service.isWarning()).toBe(false);
    });

    it('returns false before warning period in phase 2', () => {
      advanceTime(service, PHASE_MS(1));
      const stable = PHASE_MS(2) - TRANSITION_MS;
      advanceTime(service, stable - WARN_MS - 5000);
      expect(service.isWarning()).toBe(false);
    });

    it('returns true during warning period in phase 2', () => {
      advanceTime(service, PHASE_MS(1));
      const stable = PHASE_MS(2) - TRANSITION_MS;
      advanceTime(service, stable - WARN_MS / 2);
      expect(service.isWarning()).toBe(true);
    });
  });

  describe('warning events', () => {
    it('emits exactly one ZoneWarning per phase', () => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASE_MS(1));
      service.drainEvents();
      advanceTime(service, PHASE_MS(2) + 1000);
      const events = service.drainEvents().filter((e) => e.type === 'ZoneWarning');
      expect(events).toHaveLength(1);
      expect(events[0].nextPhaseIndex).toBe(3);

      advanceTime(service, 1000); // < the phase-3 warning trigger (stable − WARN_MS)
      const moreEvents = service.drainEvents().filter((e) => e.type === 'ZoneWarning');
      expect(moreEvents).toHaveLength(0);
    });
  });

  describe('getPhaseDuration', () => {
    it('returns the tuned durations for phases 1-4', () => {
      for (const n of [1, 2, 3, 4]) expect(service.getPhaseDuration(n)).toBe(PHASE_MS(n));
    });

    it('returns the tuned durations for phases 5 and 6', () => {
      expect(service.getPhaseDuration(5)).toBe(PHASE_MS(5));
      expect(service.getPhaseDuration(6)).toBe(PHASE_MS(6));
    });
  });

  describe('center shifting', () => {
    it('computes new center within 20% edge buffer on phase 2', () => {
      service.initialize(MAP_BOUNDS, 42);
      const initialCenter = { ...service.getCurrentZone() };

      advanceTime(service, PHASE_MS(1));
      advanceTime(service, PHASE_MS(2) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS);

      const zone = service.getCurrentZone();
      const maxOffset = FULL_MAP_RADIUS * 0.8;
      const dx = zone.centerX - initialCenter.centerX;
      const dy = zone.centerY - initialCenter.centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      expect(distance).toBeLessThanOrEqual(maxOffset + 1);
    });

    it('clamps new center within world bounds', () => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASE_MS(1));
      advanceTime(service, PHASE_MS(2) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS);

      const zone = service.getCurrentZone();
      const targetRadius = FULL_MAP_RADIUS * 0.6;
      expect(zone.centerX).toBeGreaterThanOrEqual(targetRadius - 1);
      expect(zone.centerX).toBeLessThanOrEqual(MAP_BOUNDS.width - targetRadius + 1);
      expect(zone.centerY).toBeGreaterThanOrEqual(targetRadius - 1);
      expect(zone.centerY).toBeLessThanOrEqual(MAP_BOUNDS.height - targetRadius + 1);
    });

    it('interpolates center linearly during transition', () => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASE_MS(1));

      const zoneAfterAdvance = service.getCurrentZone();
      const startCX = MAP_BOUNDS.width / 2;
      const startCY = MAP_BOUNDS.height / 2;
      const targetCX = zoneAfterAdvance.targetCenterX;
      const targetCY = zoneAfterAdvance.targetCenterY;

      advanceTime(service, PHASE_MS(2) - TRANSITION_MS);
      advanceTime(service, TRANSITION_MS / 2);
      const zone = service.getCurrentZone();

      const expectedCX = startCX + (targetCX - startCX) * 0.5;
      const expectedCY = startCY + (targetCY - startCY) * 0.5;
      expect(zone.centerX).toBeCloseTo(expectedCX, 1);
      expect(zone.centerY).toBeCloseTo(expectedCY, 1);
    });

    it('sets isTransitioningCenter true during transition', () => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASE_MS(1));

      const zoneBefore = service.getCurrentZone();
      if (
        zoneBefore.targetCenterX === MAP_BOUNDS.width / 2 &&
        zoneBefore.targetCenterY === MAP_BOUNDS.height / 2
      ) {
        return;
      }

      advanceTime(service, PHASE_MS(2) - TRANSITION_MS);
      advanceTime(service, 1000);
      const zone = service.getCurrentZone();
      expect(zone.isTransitioningCenter).toBe(true);
    });

    it('sets isTransitioningCenter false after transition completes', () => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASES_MS(1, 2));

      const zone = service.getCurrentZone();
      expect(zone.isTransitioningCenter).toBe(false);
    });

    it('snaps center to targetCenter after transition', () => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASE_MS(1));
      const targetCX = service.getCurrentZone().targetCenterX;
      const targetCY = service.getCurrentZone().targetCenterY;

      advanceTime(service, PHASE_MS(2));
      const zone = service.getCurrentZone();
      expect(zone.centerX).toBeCloseTo(targetCX, 2);
      expect(zone.centerY).toBeCloseTo(targetCY, 2);
    });

    it('does not shift center when currentRadius * 0.8 <= 0', () => {
      const zeroBounds = { width: 0, height: 0 };
      service.initialize(zeroBounds, 42);
      const initialCenterX = service.getCurrentZone().centerX;

      advanceTime(service, PHASE_MS(1));
      advanceTime(service, 15000);

      const zone = service.getCurrentZone();
      expect(zone.centerX).toBe(initialCenterX);
    });

    it('produces deterministic centers with same seed', () => {
      service.initialize(MAP_BOUNDS, 12345);
      advanceTime(service, PHASE_MS(1));
      advanceTime(service, 15000);
      const zone1 = service.getCurrentZone();

      const service2 = new ZoneService();
      service2.initialize(MAP_BOUNDS, 12345);
      advanceTime(service2, PHASE_MS(1));
      advanceTime(service2, 15000);
      const zone2 = service2.getCurrentZone();

      expect(zone1.centerX).toBeCloseTo(zone2.centerX, 5);
      expect(zone1.centerY).toBeCloseTo(zone2.centerY, 5);
    });
  });

  describe('overtime (phase 7)', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
      advanceTime(service, PHASES_MS(1, 6));
    });

    it('radius stays static at 8% during overtime', () => {
      const zoneBefore = service.getCurrentZone();
      advanceTime(service, 120000);
      const zoneAfter = service.getCurrentZone();
      expect(zoneBefore.currentRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.08, 1);
      expect(zoneAfter.currentRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.08, 1);
    });

    it('center stays frozen at phase 6 target during overtime', () => {
      const zoneBefore = service.getCurrentZone();
      advanceTime(service, 120000);
      const zoneAfter = service.getCurrentZone();
      expect(zoneAfter.centerX).toBeCloseTo(zoneBefore.targetCenterX, 1);
      expect(zoneAfter.centerY).toBeCloseTo(zoneBefore.targetCenterY, 1);
    });

    it('does not advance past phase 7', () => {
      advanceTime(service, 600000);
      expect(service.getCurrentZone().phase).toBe(7);
    });

    it('isOvertime returns true', () => {
      expect(service.isOvertime()).toBe(true);
    });

    it('getSiegeInterval returns 1500ms during overtime', () => {
      expect(service.getSiegeInterval()).toBe(1500);
    });

    it('damage remains ZONE_DAMAGE_SUDDEN_DEATH during overtime', () => {
      expect(service.getTickDamage()).toBe(ZONE.ZONE_DAMAGE_SUDDEN_DEATH);
    });

    it('targetRadius is 409.6 (8% of fullMapRadius)', () => {
      expect(service.getCurrentZone().targetRadius).toBeCloseTo(FULL_MAP_RADIUS * 0.08, 1);
    });
  });

  describe('getSiegeInterval', () => {
    it('returns 3000ms before overtime', () => {
      service.initialize(MAP_BOUNDS, 42);
      expect(service.getSiegeInterval()).toBe(3000);
    });
  });

  describe('update deltaMs cap', () => {
    it('caps deltaMs at 250 per update call', () => {
      service.configure({
        phases: [{ index: 1, radiusRatio: 1.0, duration: 0.3, name: 'Short' }],
      });
      service.initialize(MAP_BOUNDS, 42);
      service.update(1000);
      expect(service.getCurrentZone().phase).toBe(1);
    });
  });

  describe('update without initialization', () => {
    it('does not crash or change state', () => {
      const uninit = new ZoneService();
      uninit.update(100);
      expect(uninit.getCurrentZone().phase).toBe(1);
    });
  });

  describe('getNextPhasePreview', () => {
    beforeEach(() => {
      service.initialize(MAP_BOUNDS, 42);
    });

    it('returns null during phase 1', () => {
      expect(service.getNextPhasePreview()).toBeNull();
    });

    it('returns center and radius during phase 2', () => {
      service.advancePhase();
      const preview = service.getNextPhasePreview();
      expect(preview).not.toBeNull();
      expect(preview!.radius).toBeCloseTo(FULL_MAP_RADIUS * 0.6, 1);
      expect(typeof preview!.center.x).toBe('number');
      expect(typeof preview!.center.y).toBe('number');
    });

    it('returns center and radius during phase 3', () => {
      service.advancePhase();
      service.advancePhase();
      const preview = service.getNextPhasePreview();
      expect(preview).not.toBeNull();
      expect(preview!.radius).toBeCloseTo(FULL_MAP_RADIUS * 0.25, 1);
    });

    it('returns center and radius during phase 4', () => {
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      const preview = service.getNextPhasePreview();
      expect(preview).not.toBeNull();
      expect(preview!.radius).toBeCloseTo(FULL_MAP_RADIUS * 0.15, 1);
    });

    it('returns center and radius during phase 5', () => {
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      service.advancePhase();
      const preview = service.getNextPhasePreview();
      expect(preview).not.toBeNull();
      expect(preview!.radius).toBeCloseTo(FULL_MAP_RADIUS * 0.1, 1);
    });

    it('returns null during phase 6', () => {
      for (let i = 0; i < 5; i++) service.advancePhase();
      expect(service.getCurrentZone().phase).toBe(6);
      expect(service.getNextPhasePreview()).toBeNull();
    });

    it('returns null during phase 7 (overtime)', () => {
      for (let i = 0; i < 6; i++) service.advancePhase();
      expect(service.getCurrentZone().phase).toBe(7);
      expect(service.getNextPhasePreview()).toBeNull();
    });
  });

  describe('setGrid center behavior', () => {
    it('center stays at current when grid has no empty tiles', () => {
      service.initialize(MAP_BOUNDS, 42);
      const grid: TileType[][] = Array.from({ length: 80 }, () =>
        Array.from({ length: 80 }, () => TileType.INDESTRUCTIBLE_WALL),
      );
      service.setGrid(grid);
      service.advancePhase();
      const zone = service.getCurrentZone();
      expect(zone.targetCenterX).toBe(MAP_BOUNDS.width / 2);
      expect(zone.targetCenterY).toBe(MAP_BOUNDS.height / 2);
    });
  });
});

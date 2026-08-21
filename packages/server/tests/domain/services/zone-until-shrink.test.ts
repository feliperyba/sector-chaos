/**
 * timeUntilShrink surfacing tests — bot-ai-v2 ticket 07 (DEC-008).
 *
 * ZoneService.getMsUntilShrink is the READ-ONLY rotation clock the macro-goal
 * generator consumes. Derived purely from the accumulated phaseElapsedMs
 * (update(deltaMs) inputs — the benchmark virtual clock drives them), NEVER
 * from Date.now(): these tests drive the service with plain deltas and
 * assert the countdown arithmetic per phase, including the phase-1 → first-
 * shrink composition and the sudden-death clamp at 0.
 */

import { describe, it, expect } from 'vitest';
import { ZoneService } from '../../../src/domain/services/ZoneService.ts';
import { ZONE } from '@sector-battle/shared';

function boot(): ZoneService {
  const svc = new ZoneService();
  svc.initialize({ width: 10240, height: 10240 }, 12345);
  return svc;
}

/** Advance the phase clock deterministically (no wall-clock reads). */
function advance(svc: ZoneService, totalMs: number, stepMs = 100): void {
  for (let t = 0; t < totalMs; t += stepMs) svc.update(stepMs);
}

describe('ZoneService.getMsUntilShrink (read-only rotation clock)', () => {
  it('phase 1: drop remaining + phase 2 stable window (time to FIRST shrink)', () => {
    const svc = boot();
    // Fresh phase 1: 120s drop + (120s phase 2 − 30s transition) stable.
    const dropMs = ZONE.PHASES[0]!.duration * 1000;
    const stable2Ms = ZONE.PHASES[1]!.duration * 1000 - ZONE.ZONE_TRANSITION_DURATION * 1000;
    expect(svc.getMsUntilShrink()).toBeCloseTo(dropMs + stable2Ms, -2);
    // Halfway through the drop: exactly half the drop left + the stable 2.
    advance(svc, dropMs / 2);
    expect(svc.getMsUntilShrink()).toBeCloseTo(dropMs / 2 + stable2Ms, -2);
  });

  it('phases 2+: counts down the stable window and clamps at 0', () => {
    const svc = boot();
    const dropMs = ZONE.PHASES[0]!.duration * 1000;
    advance(svc, dropMs + 1000); // now 1s into phase 2
    const stable2Ms = ZONE.PHASES[1]!.duration * 1000 - ZONE.ZONE_TRANSITION_DURATION * 1000;
    expect(svc.getMsUntilShrink()).toBeCloseTo(stable2Ms - 1000, -2);
    // Deep into the transition window (elapsed past the stable boundary):
    // clamped at 0 — the shrink is underway.
    advance(svc, stable2Ms);
    expect(svc.getMsUntilShrink()).toBe(0);
  });

  it('sudden death (phase 7): always 0 (the continuous shrink is always on)', () => {
    const svc = boot();
    const total = ZONE.PHASES.slice(0, 6).reduce((acc, p) => acc + p.duration * 1000, 0);
    advance(svc, total + 5000, 250); // step cap 250ms — stay faithful
    expect(svc.getCurrentZone().phase).toBe(7);
    expect(svc.getMsUntilShrink()).toBe(0);
  });

  it('surfaces on getCurrentZone (the projected read the bots consume)', () => {
    const svc = boot();
    const data = svc.getCurrentZone();
    expect(data.msUntilShrink).toBe(svc.getMsUntilShrink());
    expect(data.msUntilShrink).toBeGreaterThan(0);
  });

  it('is monotone non-increasing under forward clock deltas', () => {
    const svc = boot();
    let prev = svc.getMsUntilShrink();
    for (let i = 0; i < 240; i++) {
      svc.update(500);
      const now = svc.getMsUntilShrink();
      expect(now).toBeLessThanOrEqual(prev + 1); // +1 float tolerance
      prev = now;
    }
  });
});

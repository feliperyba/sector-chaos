/**
 * Zone timing + zone-as-cost tests — bot-ai-v2 ticket 07 (DEC-008).
 *
 * Pure-seam assertions over the rotation-timing margin model (early movers
 * vs late cutters, per-archetype data table), the HP-budgeted zone shortcut
 * (budget respected, never lethal, personality-gated), the endgame hold
 * points (edge-early/center-late), the ms→tick conversion, and the
 * circle-geometry helpers behind the shortcut estimates.
 */

import { describe, it, expect } from 'vitest';
import { NETWORK } from '@sector-battle/shared';
import {
  LETHAL_FLOOR_HP,
  endgameHoldPoint,
  evaluateZoneShortcut,
  msToTicks,
  shouldRotateForShrink,
  travelTicksEstimate,
} from '../../../src/ai/goal/ZoneTiming.ts';
import {
  ARCHETYPE_GOAL_PROFILES,
  TRAVEL_SPEED_PX_PER_TICK,
} from '../../../src/ai/goal/GoalTables.ts';
import { PersonalityArchetype } from '../../../src/ai/intent/PersonalityProfile.ts';
import {
  segmentOutsideCircleLength,
  circleReentryPoint,
  routeToGoal,
} from '../../../src/ai/goal/GoalBinding.ts';
import type { GoalZoneView } from '../../../src/ai/goal/GoalTypes.ts';

const SURVIVOR = ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.SURVIVOR];
const AGGRESSOR = ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.AGGRESSOR];
const DUELIST = ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.DUELIST];

// ---------------------------------------------------------------------------
// Rotation timing (the margin model — early movers vs late cutters)
// ---------------------------------------------------------------------------

describe('shouldRotateForShrink (rotation-timing margins)', () => {
  it('rotates when timeUntilShrink < travel × margin (the DEC-008 rule)', () => {
    const travel = 100;
    // SURVIVOR margin 1.8 → trip threshold 180 ticks.
    expect(shouldRotateForShrink(181, travel, SURVIVOR.rotationMargin)).toBe(false);
    expect(shouldRotateForShrink(179, travel, SURVIVOR.rotationMargin)).toBe(true);
  });

  it('unknown timing (−1) never trips the gate', () => {
    expect(shouldRotateForShrink(-1, 100, SURVIVOR.rotationMargin)).toBe(false);
  });

  it('0 (shrinking now / sudden death) always rotates', () => {
    expect(shouldRotateForShrink(0, 1000, SURVIVOR.rotationMargin)).toBe(true);
  });

  it('SURVIVOR is an EARLY mover, AGGRESSOR a LATE cutter (distribution order)', () => {
    // Over a travel-time sweep, the tick at which each archetype trips the
    // gate (holding travel fixed, sweeping timeUntil) must order:
    // SURVIVOR trips ≫ earlier than DUELIST ≫ earlier than AGGRESSOR.
    const travel = 120;
    const tripTick = (margin: number): number => Math.ceil(travel * margin);
    expect(tripTick(SURVIVOR.rotationMargin)).toBeGreaterThan(tripTick(DUELIST.rotationMargin));
    expect(tripTick(DUELIST.rotationMargin)).toBeGreaterThan(tripTick(AGGRESSOR.rotationMargin));
    // The margin DATA TABLE ordering (Viktor's dissent: survival visibly
    // valued — SURVIVOR large, AGGRESSOR tiny).
    expect(SURVIVOR.rotationMargin).toBeGreaterThan(DUELIST.rotationMargin);
    expect(DUELIST.rotationMargin).toBeGreaterThan(AGGRESSOR.rotationMargin);
    expect(AGGRESSOR.rotationMargin).toBeLessThan(1); // eats storm, like people
    expect(SURVIVOR.rotationMargin).toBeGreaterThan(1); // leaves with slack
  });

  it('msToTicks uses the named network tick interval', () => {
    expect(msToTicks(NETWORK.TICK_INTERVAL)).toBe(1);
    expect(msToTicks(1000)).toBe(Math.ceil(1000 / NETWORK.TICK_INTERVAL));
    expect(msToTicks(0)).toBe(0);
  });

  it('travel estimates derive from the path-discounted walk speed', () => {
    expect(travelTicksEstimate(TRAVEL_SPEED_PX_PER_TICK)).toBe(1);
    expect(travelTicksEstimate(TRAVEL_SPEED_PX_PER_TICK * 10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Zone-as-cost (HP-budgeted shortcuts)
// ---------------------------------------------------------------------------

describe('evaluateZoneShortcut (zone-as-cost)', () => {
  const base = {
    outsideTicks: 10,
    directTicks: 40,
    safeTicks: 80, // 2.0× direct → trade exists by detour ratio
    dangerAlongSafe: 0,
    zoneDamagePerTick: 5,
    health: 100,
    budgetFraction: 0.12, // DUELIST-scale budget
  };

  it('rejects a shortcut that overruns the HP budget', () => {
    const v = evaluateZoneShortcut(base);
    expect(v.hpCost).toBe(50); // 10 ticks × 5 dmg
    expect(v.budget).toBe(12); // 100 × 0.12 (floor not binding)
    expect(v.accept).toBe(false); // 50 > 12 — over budget
  });

  it('accepts when the shortcut cost fits the budget', () => {
    const v = evaluateZoneShortcut({ ...base, outsideTicks: 2 }); // 10 HP
    expect(v.hpCost).toBe(10);
    expect(v.accept).toBe(true);
  });

  it('respects the budget: cost just over budget is rejected', () => {
    // budget = 12 → 2 ticks (10) ok, 3 ticks (15) rejected.
    expect(evaluateZoneShortcut({ ...base, outsideTicks: 2 }).accept).toBe(true);
    expect(evaluateZoneShortcut({ ...base, outsideTicks: 3 }).accept).toBe(false);
  });

  it('NEVER lethal: the budget is floored at health − LETHAL_FLOOR_HP', () => {
    // Low-health bot (40 HP): budget = min(40×0.12, 40−30) = min(4.8, 10) = 4.8.
    const v = evaluateZoneShortcut({ ...base, health: 40, outsideTicks: 2 });
    expect(v.budget).toBeCloseTo(4.8, 5);
    expect(v.accept).toBe(false); // 10 HP cost > 4.8 budget
    // A bot already below the floor can NEVER shortcut (budget 0).
    const dying = evaluateZoneShortcut({ ...base, health: 20, outsideTicks: 1 });
    expect(dying.budget).toBe(0);
    expect(dying.accept).toBe(false);
    expect(LETHAL_FLOOR_HP).toBe(30);
  });

  it('personality-gated: AGGRESSOR may spend a bigger sliver than SURVIVOR', () => {
    const aggr = evaluateZoneShortcut({
      ...base,
      outsideTicks: 12,
      budgetFraction: AGGRESSOR.zoneShortcutBudgetFraction, // 0.15 → 15 HP
    });
    const surv = evaluateZoneShortcut({
      ...base,
      outsideTicks: 12,
      budgetFraction: SURVIVOR.zoneShortcutBudgetFraction, // 0.06 → 6 HP
    });
    expect(aggr.budget).toBeCloseTo(15, 5);
    expect(surv.budget).toBeCloseTo(6, 5);
    expect(AGGRESSOR.zoneShortcutBudgetFraction).toBeGreaterThan(
      SURVIVOR.zoneShortcutBudgetFraction,
    );
  });

  it('no trade, no shortcut: a near-equal safe route is rejected', () => {
    // Safe route 45 vs direct 40 (1.125×) and no danger → nothing to buy.
    const v = evaluateZoneShortcut({
      ...base,
      outsideTicks: 1,
      safeTicks: 45,
      budgetFraction: 0.15,
    });
    expect(v.accept).toBe(false);
  });

  it('a high-danger corridor justifies the trade even on a short detour', () => {
    const v = evaluateZoneShortcut({
      ...base,
      outsideTicks: 2,
      safeTicks: 42, // barely longer than direct 40 — no detour trade...
      dangerAlongSafe: 1.2, // ...but the safe corridor crosses a hot fight
      budgetFraction: 0.15,
    });
    expect(v.accept).toBe(true);
  });

  it('zero zone damage (phase 1 drop) never shortcuts', () => {
    const v = evaluateZoneShortcut({ ...base, zoneDamagePerTick: 0 });
    expect(v.accept).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Circle geometry (the shortcut estimators)
// ---------------------------------------------------------------------------

describe('segmentOutsideCircleLength', () => {
  it('0 when both endpoints are inside the circle (convexity)', () => {
    expect(segmentOutsideCircleLength(0, 0, 100, 0, 50, 0, 100)).toBe(0);
  });

  it('full length when both endpoints are outside with no crossing', () => {
    expect(segmentOutsideCircleLength(200, 0, 400, 0, 0, 0, 100)).toBeCloseTo(200, 5);
  });

  it('partial clip: only the portion beyond the ring counts', () => {
    // A(0,0) inside → B(200,0) outside, circle center (0,0) r=100: the
    // outside portion is the segment from x=100 to x=200 = 100px.
    expect(segmentOutsideCircleLength(0, 0, 200, 0, 0, 0, 100)).toBeCloseTo(100, 5);
    // Outside→inside through the ring: same length by symmetry.
    expect(segmentOutsideCircleLength(200, 0, 0, 0, 0, 0, 100)).toBeCloseTo(100, 5);
  });

  it('degenerate inputs do not NaN', () => {
    expect(segmentOutsideCircleLength(0, 0, 0, 0, 0, 0, 100)).toBe(0);
    expect(segmentOutsideCircleLength(50, 0, 150, 0, 100, 0, 0)).toBeCloseTo(100, 5);
  });
});

describe('circleReentryPoint', () => {
  it('returns the re-entry point pulled inside the ring', () => {
    const p = circleReentryPoint(200, 0, 0, 0, 0, 0, 100);
    // Re-entry heading B-ward is (100, 0); pulled in by margin 10.
    expect(p.x).toBeCloseTo(90, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });

  it('degenerate geometry falls back to the safe anchor', () => {
    expect(circleReentryPoint(0, 0, 0, 0, 50, 50, 100)).toEqual({ x: 50, y: 50 });
  });
});

describe('routeToGoal (the executor-side verdict composition)', () => {
  const zone: GoalZoneView = {
    safeX: 0,
    safeY: 0,
    safeRadius: 1000,
    timeUntilShrinkTicks: -1,
    isShrinking: false,
    lethal: true,
    damagePerTick: 5,
    nextX: 0,
    nextY: 0,
    nextRadius: 1000,
  };

  it('direct when the straight line never leaves the safe circle', () => {
    const r = routeToGoal(0, 0, 500, 0, zone, 100, 0.15, []);
    expect(r.shortcut).toBe(false);
    expect(r.x).toBe(500);
    expect(r.y).toBe(0);
  });

  it('a budget-fitting clip across a dangerous corridor is taken (shortcut = true)', () => {
    // Bot inside at (900, 0), goal at (1300, 0): the outside portion is the
    // 300px beyond the ring ≈ 1 tick of zone damage (5 HP) — inside a 15 HP
    // budget. The safe alternative (re-entry then goal) re-crosses the same
    // corridor, and a fresh fight sits on it → the danger gate justifies
    // the trade (the DEC-008 clause: shortcut when the SAFE alternative
    // crosses a high-danger corridor).
    const fights = [{ x: 900, y: 0, strength: 1 }];
    const r = routeToGoal(900, 0, 1300, 0, zone, 100, 0.15, fights);
    expect(r.shortcut).toBe(true);
    expect(r.x).toBe(1300);
  });

  it('a rejected shortcut routes to the safe re-entry waypoint instead', () => {
    // Same geometry + corridor, but a SURVIVOR-scale 0.02 budget (2 HP) —
    // the 5 HP clip does not fit, so the bot routes to the in-ring
    // waypoint (the re-entry point pulled inside).
    const fights = [{ x: 900, y: 0, strength: 1 }];
    const r = routeToGoal(900, 0, 1300, 0, zone, 100, 0.02, fights);
    expect(r.shortcut).toBe(false);
    expect(r.x).toBeLessThan(1000); // inside the ring
  });

  it('a non-lethal zone (phase 1) routes directly regardless', () => {
    const harmless: GoalZoneView = { ...zone, lethal: false, damagePerTick: 0 };
    const r = routeToGoal(900, 0, 1300, 0, harmless, 100, 0.001, []);
    expect(r.shortcut).toBe(false);
    expect(r.x).toBe(1300);
  });
});

// ---------------------------------------------------------------------------
// Endgame hold (edge-early / center-late — the orbit's replacement)
// ---------------------------------------------------------------------------

describe('endgameHoldPoint (edge/center positioning)', () => {
  const q = {
    anchorX: 5000,
    anchorY: 5000,
    radius: 1200,
    edgeBias: 0.8,
    lateProgress: 0,
    aliveCount: 10,
    contactAlive: 3,
  };

  it('early endgame: the edge bias holds the RING (edge-early)', () => {
    const p = endgameHoldPoint(q, 0);
    expect(p.ringFraction).toBeCloseTo(0.8, 5);
    const d = Math.hypot(p.x - 5000, p.y - 5000);
    expect(d).toBeCloseTo(1200 * 0.8, 5);
  });

  it('late endgame: every bias drifts toward center (center-late)', () => {
    const p = endgameHoldPoint({ ...q, lateProgress: 1 }, 0);
    // ring = 0.8 × (1 − 0.7) = 0.24 — clamped band [0.05, 0.85].
    expect(p.ringFraction).toBeCloseTo(0.24, 5);
    const d = Math.hypot(p.x - 5000, p.y - 5000);
    expect(d).toBeCloseTo(1200 * 0.24, 5);
  });

  it('contact endgame (≤ contactAlive) collapses to near-center for ALL', () => {
    for (const bias of [0.15, 0.5, 0.8]) {
      const p = endgameHoldPoint({ ...q, edgeBias: bias, aliveCount: 2 }, 0);
      expect(p.ringFraction).toBeLessThanOrEqual(0.1);
    }
  });

  it('the hold angle is the CALLER-supplied stable angle (never swept here)', () => {
    const a = endgameHoldPoint(q, 1.25);
    expect(a.angle).toBe(1.25);
    const b = endgameHoldPoint(q, 2.5);
    expect(b.angle).toBe(2.5);
  });

  it('archetype data table: SURVIVOR edge-heavy, AGGRESSOR center-heavy', () => {
    expect(SURVIVOR.endgameEdgeBias).toBeGreaterThan(AGGRESSOR.endgameEdgeBias);
    expect(SURVIVOR.endgameEdgeBias).toBeGreaterThan(0.5);
    expect(AGGRESSOR.endgameEdgeBias).toBeLessThan(0.5);
  });
});

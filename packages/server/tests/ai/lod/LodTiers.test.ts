import { describe, it, expect } from 'vitest';
import {
  LodReliefLevel,
  LodTier,
  LOD_T0_MAX_REF_DIST,
  LOD_T1_MAX_REF_DIST,
  LOD_ENGAGE_ENEMY_RANGE,
  LOD_COMBAT_ENTRY_DAMAGE_TICKS,
  T1_THINK_STRIDE,
  T2_THINK_STRIDE,
  T2_SCAN_STRIDE,
  computeLodTier,
  isThinkTick,
  lodDeliberationSuspended,
  scanStrideForTier,
  scanPhaseForStride,
  type LodAssignmentInputs,
} from '../../../src/ai/lod/LodTiers.ts';

/**
 * LOD tier assignment at the pure seam (bot-ai-v2 ticket 11, DEC-012.1):
 * tier boundaries, combat-triggers, immediate upgrade on combat entry,
 * think-cadence strides, and the relief ladder — all WITHOUT a room (every
 * input is an explicit literal; purity is asserted by repeated evaluation).
 */

/** The neutral far-field baseline: no enemy, no damage, very far reference. */
const FAR_NEUTRAL: LodAssignmentInputs = {
  inFightState: false,
  nearestEnemyDist: null,
  lastDamageTick: -9999,
  tick: 10_000,
  nearestReferenceDist: 9_999,
};

describe('computeLodTier — proximity boundaries', () => {
  it('T0 at/below the 1.5-screen bound, T1 above it', () => {
    const t0 = computeLodTier({ ...FAR_NEUTRAL, nearestReferenceDist: LOD_T0_MAX_REF_DIST });
    expect(t0).toEqual({ tier: LodTier.T0, combatTier: false });
    expect(computeLodTier({ ...FAR_NEUTRAL, nearestReferenceDist: 0 })).toEqual({
      tier: LodTier.T0,
      combatTier: false,
    });
    const t1 = computeLodTier({ ...FAR_NEUTRAL, nearestReferenceDist: LOD_T0_MAX_REF_DIST + 1 });
    expect(t1).toEqual({ tier: LodTier.T1, combatTier: false });
  });

  it('T1 at/below the 3-screen bound, T2 above it (and at infinity)', () => {
    expect(computeLodTier({ ...FAR_NEUTRAL, nearestReferenceDist: LOD_T1_MAX_REF_DIST })).toEqual({
      tier: LodTier.T1,
      combatTier: false,
    });
    expect(
      computeLodTier({ ...FAR_NEUTRAL, nearestReferenceDist: LOD_T1_MAX_REF_DIST + 1 }),
    ).toEqual({ tier: LodTier.T2, combatTier: false });
    expect(computeLodTier({ ...FAR_NEUTRAL, nearestReferenceDist: Infinity })).toEqual({
      tier: LodTier.T2,
      combatTier: false,
    });
  });

  it('engagement beats proximity order: combat is checked first', () => {
    // A bot alone at the far corner of the map, but in a committed fight
    // state, is T0-combat (evaluation order: engagement before distance).
    const engaged = computeLodTier({ ...FAR_NEUTRAL, inFightState: true });
    expect(engaged).toEqual({ tier: LodTier.T0, combatTier: true });
  });
});

describe('computeLodTier — combat triggers (all three)', () => {
  it('committed fight state (ENGAGE/RETREAT executor states) is combat-tier T0', () => {
    expect(computeLodTier({ ...FAR_NEUTRAL, inFightState: true }).combatTier).toBe(true);
  });

  it('perceived enemy within the engage range is combat-tier T0', () => {
    const atRange = computeLodTier({
      ...FAR_NEUTRAL,
      nearestEnemyDist: LOD_ENGAGE_ENEMY_RANGE,
    });
    expect(atRange).toEqual({ tier: LodTier.T0, combatTier: true });
    const justBeyond = computeLodTier({
      ...FAR_NEUTRAL,
      nearestEnemyDist: LOD_ENGAGE_ENEMY_RANGE + 1,
      nearestReferenceDist: LOD_T1_MAX_REF_DIST + 1,
    });
    expect(justBeyond).toEqual({ tier: LodTier.T2, combatTier: false });
  });

  it('recent damage is combat-tier T0; the window is bounded', () => {
    // Damaged THIS tick — the off-screen-attack immediate-upgrade path.
    const fresh = computeLodTier({ ...FAR_NEUTRAL, tick: 5_000, lastDamageTick: 5_000 });
    expect(fresh).toEqual({ tier: LodTier.T0, combatTier: true });
    // Last tick inside the window.
    const edge = computeLodTier({
      ...FAR_NEUTRAL,
      tick: 5_000,
      lastDamageTick: 5_000 - LOD_COMBAT_ENTRY_DAMAGE_TICKS,
    });
    expect(edge.combatTier).toBe(true);
    // One tick past the window the bot falls back to distance tiering.
    const stale = computeLodTier({
      ...FAR_NEUTRAL,
      tick: 5_000,
      lastDamageTick: 5_000 - LOD_COMBAT_ENTRY_DAMAGE_TICKS - 1,
    });
    expect(stale).toEqual({ tier: LodTier.T2, combatTier: false });
  });

  it('the never-damaged sentinel (-9999) is not combat', () => {
    expect(computeLodTier({ ...FAR_NEUTRAL, tick: 0, lastDamageTick: -9999 }).combatTier).toBe(
      false,
    );
  });
});

describe('computeLodTier — immediate upgrade on combat entry', () => {
  it('the SAME tick combat appears, a previously-T2 bot is T0 (no hysteresis)', () => {
    // Tick N: far, calm → T2. Tick N (same position): an attacker lands a
    // hit → combat-tier T0 on the very next evaluation — which, since
    // BotSystem recomputes the tier before the think gate every tick, is the
    // same BotSystem.tick the damage is visible in.
    const before = computeLodTier(FAR_NEUTRAL);
    expect(before.tier).toBe(LodTier.T2);
    const after = computeLodTier({ ...FAR_NEUTRAL, lastDamageTick: FAR_NEUTRAL.tick });
    expect(after).toEqual({ tier: LodTier.T0, combatTier: true });
    // And the think gate opens the same tick (T0 thinks every tick).
    expect(
      isThinkTick(after.tier, after.combatTier, FAR_NEUTRAL.tick, 0, 0, LodReliefLevel.NONE),
    ).toBe(true);
  });
});

describe('computeLodTier — purity / determinism', () => {
  it('identical inputs always produce identical assignments', () => {
    const inputs: LodAssignmentInputs[] = [
      FAR_NEUTRAL,
      { ...FAR_NEUTRAL, nearestReferenceDist: 100 },
      { ...FAR_NEUTRAL, inFightState: true, nearestReferenceDist: 100 },
      { ...FAR_NEUTRAL, nearestEnemyDist: 200, nearestReferenceDist: 9_000 },
    ];
    for (const i of inputs) {
      expect(computeLodTier(i)).toEqual(computeLodTier({ ...i }));
      expect(computeLodTier(i)).toEqual(computeLodTier({ ...i }));
    }
  });
});

describe('isThinkTick — cadence strides', () => {
  it('T0 thinks EVERY tick (full fidelity)', () => {
    for (let tick = 0; tick < 30; tick++) {
      expect(isThinkTick(LodTier.T0, false, tick, 0, 0, LodReliefLevel.NONE)).toBe(true);
      expect(isThinkTick(LodTier.T0, true, tick, 2, 7, LodReliefLevel.NONE)).toBe(true);
    }
  });

  it('T1 thinks exactly every stride-3rd tick, staggered by the hashed phase', () => {
    for (const phase of [0, 1, 2]) {
      let thinks = 0;
      for (let tick = 0; tick < 30; tick++) {
        const think = isThinkTick(LodTier.T1, false, tick, phase, 0, LodReliefLevel.NONE);
        expect(think).toBe(tick % T1_THINK_STRIDE === phase % T1_THINK_STRIDE);
        if (think) thinks++;
      }
      expect(thinks).toBe(30 / T1_THINK_STRIDE);
    }
  });

  it('T2 thinks exactly every stride-9th tick, staggered by the phase-9', () => {
    for (const phase of [0, 4, 8]) {
      let thinks = 0;
      for (let tick = 0; tick < 90; tick++) {
        const think = isThinkTick(LodTier.T2, false, tick, 0, phase, LodReliefLevel.NONE);
        expect(think).toBe(tick % T2_THINK_STRIDE === phase % T2_THINK_STRIDE);
        if (think) thinks++;
      }
      expect(thinks).toBe(90 / T2_THINK_STRIDE);
    }
  });
});

describe('lodDeliberationSuspended / relief ladder (T2 downgraded first)', () => {
  it('level NONE suspends nothing', () => {
    for (const tier of [LodTier.T0, LodTier.T1, LodTier.T2]) {
      expect(lodDeliberationSuspended(tier, false, LodReliefLevel.NONE)).toBe(false);
    }
  });

  it('SUSPEND_T2 suspends only T2', () => {
    expect(lodDeliberationSuspended(LodTier.T0, false, LodReliefLevel.SUSPEND_T2)).toBe(false);
    expect(lodDeliberationSuspended(LodTier.T1, false, LodReliefLevel.SUSPEND_T2)).toBe(false);
    expect(lodDeliberationSuspended(LodTier.T2, false, LodReliefLevel.SUSPEND_T2)).toBe(true);
  });

  it('SUSPEND_T1 suspends T1 and T2', () => {
    expect(lodDeliberationSuspended(LodTier.T0, false, LodReliefLevel.SUSPEND_T1)).toBe(false);
    expect(lodDeliberationSuspended(LodTier.T1, false, LodReliefLevel.SUSPEND_T1)).toBe(true);
    expect(lodDeliberationSuspended(LodTier.T2, false, LodReliefLevel.SUSPEND_T1)).toBe(true);
  });

  it('SUSPEND_T0 suspends every NON-combat tier — combat T0 is never suspended (no cliff)', () => {
    expect(lodDeliberationSuspended(LodTier.T0, false, LodReliefLevel.SUSPEND_T0)).toBe(true);
    expect(lodDeliberationSuspended(LodTier.T1, false, LodReliefLevel.SUSPEND_T0)).toBe(true);
    expect(lodDeliberationSuspended(LodTier.T2, false, LodReliefLevel.SUSPEND_T0)).toBe(true);
    // The fighting bots keep full-fidelity thinking at maximum relief.
    expect(lodDeliberationSuspended(LodTier.T0, true, LodReliefLevel.SUSPEND_T0)).toBe(false);
  });

  it('relief overrides cadence in isThinkTick at every level', () => {
    // A T2 bot on its stride-9 think tick still skips under relief...
    const t2ThinkTick = 9; // phase 0
    expect(isThinkTick(LodTier.T2, false, t2ThinkTick, 0, 0, LodReliefLevel.NONE)).toBe(true);
    expect(isThinkTick(LodTier.T2, false, t2ThinkTick, 0, 0, LodReliefLevel.SUSPEND_T2)).toBe(
      false,
    );
    // ...and so does a proximity T0 at maximum relief, but not a combat T0.
    expect(isThinkTick(LodTier.T0, false, 42, 0, 0, LodReliefLevel.SUSPEND_T0)).toBe(false);
    expect(isThinkTick(LodTier.T0, true, 42, 0, 0, LodReliefLevel.SUSPEND_T0)).toBe(true);
  });
});

describe('scan strides (coarse perception)', () => {
  it('T0/T1 keep the 3-tick scan; T2 stretches to the coarse stride', () => {
    expect(scanStrideForTier(LodTier.T0)).toBe(3);
    expect(scanStrideForTier(LodTier.T1)).toBe(3);
    expect(scanStrideForTier(LodTier.T2)).toBe(T2_SCAN_STRIDE);
    expect(T2_SCAN_STRIDE).toBeGreaterThan(3);
  });

  it('scanPhaseForStride pairs the hashed phase with the stride', () => {
    expect(scanPhaseForStride(3, 1, 5)).toBe(1);
    expect(scanPhaseForStride(T2_SCAN_STRIDE, 1, 5)).toBe(5);
  });
});

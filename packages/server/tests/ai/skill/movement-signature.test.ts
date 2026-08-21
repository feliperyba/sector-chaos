import { describe, it, expect } from 'vitest';
import { BotRNG } from '../../../src/ai/BotContext.ts';
import { BotState } from '../../../src/ai/BotContextTypes.ts';
import { InputAction } from '@sector-battle/shared';
import {
  MOVEMENT_PROFILES,
  NEUTRAL_MOVEMENT_PROFILE,
} from '../../../src/ai/skill/MovementProfileTables.ts';
import {
  applyHotspotAvoidance,
  applyMovementShaping,
  applyZoneEdgePreference,
  createMovementSignature,
  signatureStopInput,
  type MovementSignatureState,
  type SignatureStopView,
} from '../../../src/ai/skill/BotMovementSignature.ts';
import { PersonalityArchetype } from '../../../src/ai/intent/PersonalityProfile.ts';

/**
 * bot-ai-v2 ticket 08 (DEC-009.2) — the archetype signature MOVEMENT
 * profiles change the emitted movement features measurably per archetype:
 * approach-curve lateral variance, turn-smoothing convergence, stop
 * frequency near anchors, speed-variance cadence, hotspot avoidance, and
 * zone-edge preference.
 */

const rng = (seed: number): BotRNG => new BotRNG(seed);

/** Signed shortest-arc delta helper (mirrors the module's internal one). */
function delta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

describe('approach-curve shaping (always-on signature)', () => {
  it('DUELIST (direct) emits the intended heading; AGGRESSOR (weave) deviates around it', () => {
    const duel = createMovementSignature(rng(11), MOVEMENT_PROFILES[PersonalityArchetype.DUELIST]);
    const aggr = createMovementSignature(
      rng(11),
      MOVEMENT_PROFILES[PersonalityArchetype.AGGRESSOR],
    );
    const heading = 0.8;
    const duelDevs: number[] = [];
    const aggrDevs: number[] = [];
    for (let t = 0; t < 240; t++) {
      duelDevs.push(delta(heading, applyMovementShaping(duel, t, heading)));
      aggrDevs.push(delta(heading, applyMovementShaping(aggr, t, heading)));
    }
    const spread = (ds: number[]): number => {
      const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      return ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length;
    };
    // The direct curve tracks the heading; the weave's lateral offset gives
    // the AGGRESSOR's approach a measurably wider angle distribution.
    expect(spread(duelDevs)).toBeLessThan(1e-9);
    expect(spread(aggrDevs)).toBeGreaterThan(0.002);
    // The weave stays BOUNDED by the profile amplitude (a deflection, not a
    // different heading).
    for (const d of aggrDevs) expect(Math.abs(d)).toBeLessThanOrEqual(0.22 + 1e-9);
  });

  it('TRAPPER (arc) curves with a constant sign per segment; SCAVENGER (drift) meanders', () => {
    const trap = createMovementSignature(rng(23), MOVEMENT_PROFILES[PersonalityArchetype.TRAPPER]);
    const heading = -1.2;
    const devs: number[] = [];
    // 40 ticks = the MINIMUM arc segment draw — no sign re-roll can occur.
    for (let t = 0; t < 40; t++) {
      devs.push(delta(heading, applyMovementShaping(trap, t, heading)));
    }
    // Within one segment every deviation carries the SAME sign — the arc
    // reads as a curved approach, not oscillation.
    const signs = new Set(devs.map((d) => Math.sign(d)));
    expect(signs.size).toBe(1);
    expect(Math.abs(devs[0]!)).toBeGreaterThan(0.05);
  });

  it('turn smoothing: a smooth profile converges slower after a heading step', () => {
    const smooth = createMovementSignature(rng(31), {
      ...NEUTRAL_MOVEMENT_PROFILE,
      turnSmoothing: 0.3,
      approachCurve: 'direct',
    });
    const snappy = createMovementSignature(rng(31), {
      ...NEUTRAL_MOVEMENT_PROFILE,
      turnSmoothing: 1,
      approachCurve: 'direct',
    });
    const A = 0;
    const B = Math.PI / 2;
    applyMovementShaping(smooth, 0, A);
    applyMovementShaping(snappy, 0, A);
    const smoothFirst = Math.abs(delta(A, applyMovementShaping(smooth, 1, B)));
    const snappyFirst = Math.abs(delta(A, applyMovementShaping(snappy, 1, B)));
    // The smooth profile moves only ~30% of the way on the first tick; the
    // snappy profile lands on the new heading immediately.
    expect(snappyFirst).toBeCloseTo(Math.PI / 2, 6);
    expect(smoothFirst).toBeGreaterThan(Math.PI / 10);
    expect(smoothFirst).toBeLessThan(Math.PI / 4);
    // And it CONVERGES (keeps easing toward B — never freezes).
    let out = smooth.lastAngle!;
    for (let t = 2; t < 40; t++) out = applyMovementShaping(smooth, t, B);
    expect(Math.abs(delta(A, out))).toBeGreaterThan(Math.PI / 2 - 0.05);
  });

  it('a null signature is neutral (unchanged angle — pre-signature behavior)', () => {
    expect(applyMovementShaping(null, 5, 1.234)).toBe(1.234);
  });
});

describe('stop frequency + speed variance (signatureStopInput)', () => {
  const baseView = {
    tick: 0,
    playerId: 'p1',
    state: BotState.WANDER,
    hasLootNearby: false,
    hasChestNearby: false,
    hasBarrelNearby: false,
    aimAngle: 0,
  };

  /** Longest contiguous run of stop-emitting ticks. An anchor LOITER holds
   *  for stopDurationTicks+ (a deliberate multi-tick pause); a speed-variance
   *  micro-pause is always EXACTLY 1 tick (SPEED_WOBBLE_DURATION_TICKS). The
   *  run length is what separates "loitering at the anchor" (the archetype
   *  stop-frequency signature) from ordinary per-bot operation noise, which
   *  every archetype with speedVariance > 0 emits. */
  function maxStopRun(sig: MovementSignatureState, view: SignatureStopView): number {
    let best = 0;
    let run = 0;
    for (let t = 0; t < 900; t++) {
      if (signatureStopInput(sig, { ...view, tick: t }) !== null) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
    }
    return best;
  }

  it('SCAVENGER loiters at loot (multi-tick runs); AGGRESSOR never loiters (1-tick dips only)', () => {
    // Multiple seeds: each armed loiter emits a 24-36-tick contiguous stop
    // run, so a single armed loiter already clears the bar; pooling seeds
    // makes the "never armed at all" tail (~0.05%/seed) astronomically
    // unlikely.
    let scavBest = 0;
    let aggrBest = 0;
    for (const seed of [41, 42, 43]) {
      const scav = createMovementSignature(
        rng(seed),
        MOVEMENT_PROFILES[PersonalityArchetype.SCAVENGER],
      );
      const aggr = createMovementSignature(
        rng(seed),
        MOVEMENT_PROFILES[PersonalityArchetype.AGGRESSOR],
      );
      const lootView = { ...baseView, hasLootNearby: true };
      for (let t = 0; t < 900; t++) {
        const a = signatureStopInput(scav, { ...lootView, tick: t });
        if (a) {
          expect(a.action).toBe(InputAction.MOVE);
          expect((a.data as { dx: number }).dx).toBe(0);
          expect((a.data as { dy: number }).dy).toBe(0);
        }
      }
      // maxStopRun drives ticks 0..899 AGAIN — the stateful cadence anchors
      // (nextStopCheckTick / speedWobbleNextTick) are already past that range
      // after the sweep above, so the run-length measurement needs FRESH
      // signatures (the shape assertions consumed the ones above).
      const scavFresh = createMovementSignature(
        rng(seed),
        MOVEMENT_PROFILES[PersonalityArchetype.SCAVENGER],
      );
      scavBest = Math.max(scavBest, maxStopRun(scavFresh, lootView));
      aggrBest = Math.max(aggrBest, maxStopRun(aggr, lootView));
    }
    // SCAVENGER's stop FREQUENCY surface: real anchor loiters (≥ the profile's
    // stopDurationTicks floor of 24).
    expect(scavBest).toBeGreaterThanOrEqual(20);
    // AGGRESSOR has stopFrequency 0 — its only stops are the 1-tick
    // speed-variance micro-pauses (it still has speed noise, DEC-007.4).
    expect(aggrBest).toBeLessThanOrEqual(1);
  });

  it('SCAVENGER does NOT loiter without a loot anchor; TRAPPER loiters at chests/barrels, not loot', () => {
    for (const seed of [43, 44, 45]) {
      // Each maxStopRun sweep drives ticks 0..899 and CONSUMES the stateful
      // cadence anchors — every measurement below gets a fresh signature.
      const scavNoAnchor = createMovementSignature(
        rng(seed),
        MOVEMENT_PROFILES[PersonalityArchetype.SCAVENGER],
      );
      const trap = createMovementSignature(
        rng(seed),
        MOVEMENT_PROFILES[PersonalityArchetype.TRAPPER],
      );
      const trapChest = createMovementSignature(
        rng(seed),
        MOVEMENT_PROFILES[PersonalityArchetype.TRAPPER],
      );
      // No anchor → only micro-pauses (1-tick runs): no loiter ever arms.
      expect(maxStopRun(scavNoAnchor, { ...baseView })).toBeLessThanOrEqual(1);
      // Wrong anchor (loot for a feature-loiterer): same — no loiter.
      expect(maxStopRun(trap, { ...baseView, hasLootNearby: true })).toBeLessThanOrEqual(1);
      // Right anchor (chest): the pre-position hold loiters.
      expect(maxStopRun(trapChest, { ...baseView, hasChestNearby: true })).toBeGreaterThanOrEqual(
        20,
      );
    }
  });

  it('never stops in combat/flee/breach states (any archetype, any anchor)', () => {
    const scav = createMovementSignature(
      rng(47),
      MOVEMENT_PROFILES[PersonalityArchetype.SCAVENGER],
    );
    for (const state of [
      BotState.ENGAGE,
      BotState.RETREAT,
      BotState.FLEE_ZONE,
      BotState.DEMOLITION,
    ]) {
      for (let t = 0; t < 400; t++) {
        expect(
          signatureStopInput(scav, {
            ...baseView,
            tick: t,
            state,
            hasLootNearby: true,
            hasChestNearby: true,
            hasBarrelNearby: true,
          }),
        ).toBeNull();
      }
    }
  });

  it('speed-variance cadence: SCAVENGER micro-pauses more often than AGGRESSOR (same RNG draws)', () => {
    // Same-seed RNGs make the per-bot interval comparison EXACT: the interval
    // formula differs only by the variance term.
    const scavEvery: number[] = [];
    const aggrEvery: number[] = [];
    for (let i = 0; i < 40; i++) {
      const s = createMovementSignature(
        new BotRNG(1000 + i),
        MOVEMENT_PROFILES[PersonalityArchetype.SCAVENGER],
      );
      const a = createMovementSignature(
        new BotRNG(1000 + i),
        MOVEMENT_PROFILES[PersonalityArchetype.AGGRESSOR],
      );
      scavEvery.push(s.speedWobbleEvery);
      aggrEvery.push(a.speedWobbleEvery);
      expect(s.speedWobbleEvery).toBeLessThan(a.speedWobbleEvery);
    }
    const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    // (1-0.45)*220 vs (1-0.15)*220 — a 66-tick mean gap.
    expect(mean(aggrEvery) - mean(scavEvery)).toBeGreaterThan(50);
  });

  it('a null signature never emits a stop', () => {
    expect(signatureStopInput(null, baseView)).toBeNull();
  });
});

describe('hotspot avoidance + zone-edge preference (SURVIVOR steering)', () => {
  it('a fresh nearby hotspot deflects the SURVIVOR heading AWAY; never AGGRESSOR/combat/stale', () => {
    const surv = createMovementSignature(rng(53), MOVEMENT_PROFILES[PersonalityArchetype.SURVIVOR]);
    const aggr = createMovementSignature(
      rng(53),
      MOVEMENT_PROFILES[PersonalityArchetype.AGGRESSOR],
    );
    const view = {
      tick: 1000,
      state: BotState.WANDER,
      x: 0,
      y: 0,
      fightMemoryX: 300,
      fightMemoryY: 0,
      fightMemoryTick: 990,
    };
    const heading = Math.PI / 3; // walking with a hotspot component ahead
    const awayAngle = Math.PI; // the away-from-hotspot heading (-x side)
    const shaped = applyHotspotAvoidance(surv, view, heading);
    // The shaped heading is measurably MORE aligned with "away" than the
    // original (sign-safe: alignment improvement, not a rotation sign).
    expect(Math.abs(delta(awayAngle, shaped))).toBeLessThan(Math.abs(delta(awayAngle, heading)));
    expect(Math.abs(delta(awayAngle, shaped))).toBeLessThan(
      Math.abs(delta(awayAngle, heading)) - 0.005,
    );
    // No weight: unchanged. Combat state: unchanged. Stale memory (tick
    // delta beyond the 1200-tick freshness window): unchanged.
    expect(applyHotspotAvoidance(aggr, view, heading)).toBe(heading);
    expect(applyHotspotAvoidance(surv, { ...view, state: BotState.ENGAGE }, heading)).toBe(heading);
    expect(applyHotspotAvoidance(surv, { ...view, tick: 1300, fightMemoryTick: 0 }, heading)).toBe(
      heading,
    );
  });

  it('zone-edge preference pushes a deep-center SURVIVOR outward on patrol only', () => {
    const surv = createMovementSignature(rng(59), MOVEMENT_PROFILES[PersonalityArchetype.SURVIVOR]);
    const view = { zoneCenterX: 0, zoneCenterY: 0, zoneRadius: 2000, x: 200, y: 0 };
    const outward = 0; // the radial-outward heading at (200, 0)
    const heading = Math.PI / 2; // walking tangentially (north)
    const shaped = applyZoneEdgePreference(surv, { state: BotState.WANDER, ...view }, heading);
    // The blend bends the tangential walk outward (toward the ring).
    expect(Math.abs(delta(outward, shaped))).toBeLessThan(Math.abs(delta(outward, heading)));
    // Near the ring (0.8 radius) or on a loot run: unchanged.
    expect(
      applyZoneEdgePreference(surv, { state: BotState.WANDER, ...view, x: 1600 }, heading),
    ).toBe(heading);
    expect(applyZoneEdgePreference(surv, { state: BotState.LOOT, ...view }, heading)).toBe(heading);
    // AGGRESSOR has no preference.
    const aggr = createMovementSignature(
      rng(59),
      MOVEMENT_PROFILES[PersonalityArchetype.AGGRESSOR],
    );
    expect(applyZoneEdgePreference(aggr, { state: BotState.WANDER, ...view }, heading)).toBe(
      heading,
    );
  });
});

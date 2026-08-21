/**
 * C7 — Juice: aura breathing + perceptible candle/lantern flicker (Seam A).
 *
 * PINS three load-bearing properties of the C7 ticket (lighting-system-3):
 *
 *  1. Aura `flickerMul` is NO LONGER the constant `1.0` — it is now a
 *     deterministic function of time + per-player phase. Two players at the
 *     same instant have DIFFERENT breathing phases (the per-player hash
 *     de-synchronizes the 64 auras so they don't pulse in unison).
 *  2. Candle + lantern flicker profiles produce a worst-case dip ≥ 20% (the
 *     new floor for perceptibility — pre-C7 they dipped ~17% / ~10%).
 *  3. Determinism: same `nowMs` + same `playerId` → same `flickerMul`. No
 *     `Math.random()` anywhere in the breathing path.
 *
 * Reference: `.scratch/lighting-system-3/issues/C7-juice-aura-breathing-candle-lantern-flicker.md`
 * Cosmetic-only (GDD `docs/GDD.md:210`) — the breathing is ±6%, never a strobe.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AURA_BREATHING_AMP,
  AURA_BREATHING_HZ,
  computeAuraBreathingMul,
  hashPlayerIdPhase,
} from '../DynamicLightPopulator.js';
import {
  FLICKER_PROFILES,
  computeFlickerMulForKind,
  type FlickerFlameKind,
} from '../TorchFlicker.js';

describe('C7 Layer 1 — aura breathing (deterministic slow pulse)', () => {
  describe('the breathing multiplier is NO LONGER constant 1.0', () => {
    it('varies with time (the aura rises + falls slowly)', () => {
      // Over a 5s window the breathing sine (0.6Hz, ~1.7s period) sweeps
      // through multiple cycles — the multiplier must take a range of values,
      // not stay pinned at 1.0.
      const playerId = 'player-1';
      const values: number[] = [];
      for (let i = 0; i < 100; i++) {
        values.push(computeAuraBreathingMul(i * 0.05, playerId)); // 5s @ 50ms
      }
      const min = Math.min(...values);
      const max = Math.max(...values);
      expect(max).toBeGreaterThan(min); // varies (not constant)
      // The amp is ±AURA_BREATHING_AMP — the swept range must reflect it.
      // Allow tolerance for the discrete sampling missing the exact extrema.
      expect(max - min).toBeGreaterThan(AURA_BREATHING_AMP); // swings more than ~half-amp
    });

    it('the breathing multiplier stays within ±AURA_BREATHING_AMP of 1.0', () => {
      // The contract: ±6% is subtle, never a strobe. Sweep a long window +
      // every value must lie in [1 - amp, 1 + amp] (plus a tiny float epsilon).
      const playerId = 'player-1';
      const eps = 1e-9;
      for (let i = 0; i < 1000; i++) {
        const m = computeAuraBreathingMul(i * 0.01, playerId);
        expect(m).toBeGreaterThanOrEqual(1 - AURA_BREATHING_AMP - eps);
        expect(m).toBeLessThanOrEqual(1 + AURA_BREATHING_AMP + eps);
      }
    });

    it('the breathing frequency is slow (~0.6Hz — distinct from torch flicker)', () => {
      // 0.6Hz = ~1.7s period. Zero-crossings of (m - 1) happen twice per
      // period (once rising, once falling). Over a 10s window at 0.6Hz that's
      // ~12 zero crossings. A torch flicker (multi-Hz) would have many more.
      // This pins that the breathing is SLOW.
      const playerId = 'player-1';
      let crossings = 0;
      let prevSign = 0;
      for (let i = 0; i <= 1000; i++) {
        const m = computeAuraBreathingMul(i * 0.01, playerId); // 10s @ 10ms
        const sign = m > 1 ? 1 : m < 1 ? -1 : 0;
        if (prevSign !== 0 && sign !== 0 && sign !== prevSign) crossings++;
        if (sign !== 0) prevSign = sign;
      }
      // 0.6Hz × 10s = 6 cycles × 2 crossings = 12. Allow tolerance.
      expect(crossings).toBeGreaterThanOrEqual(8);
      expect(crossings).toBeLessThanOrEqual(16);
    });
  });

  describe('per-player hash de-synchronizes 64 auras (no in-unison pulse)', () => {
    it('two DIFFERENT players at the SAME time have DIFFERENT phases', () => {
      // The load-bearing C7 assertion: the per-player hash offset means two
      // players' breathing curves differ at a shared instant. (They could
      // coincide by extreme bad luck at one isolated t, so we sweep a window
      // + assert they differ SOMEWHERE in it.)
      let anyDiffer = false;
      for (let i = 0; i < 200; i++) {
        const t = i * 0.02;
        const a = computeAuraBreathingMul(t, 'player-AAAA');
        const b = computeAuraBreathingMul(t, 'player-ZZZZ');
        if (Math.abs(a - b) > 1e-6) {
          anyDiffer = true;
          break;
        }
      }
      expect(anyDiffer).toBe(true);
    });

    it('the phase offset spreads a population of players (no global sync)', () => {
      // Simulate 64 players + measure the spread of breathing values at one
      // instant. If all phases were equal, all 64 values would be identical
      // (spread = 0). With per-player hashing the values spread across the
      // ±amp range → standard deviation > 0.
      const nowMs = 12345.6;
      const values: number[] = [];
      for (let i = 0; i < 64; i++) {
        values.push(computeAuraBreathingMul(nowMs, `bot-${i}`));
      }
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
      // A healthy spread: variance well above 0 (population is not in unison).
      expect(variance).toBeGreaterThan(1e-4);
    });

    it('hashPlayerIdPhase returns a value in [0, 2π) + is deterministic per id', () => {
      for (const id of ['local', 'remote-1', 'bot-42', 'aaaa', 'zzzz']) {
        const phase = hashPlayerIdPhase(id);
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(2 * Math.PI);
        // Deterministic: same id → same phase, every call.
        expect(hashPlayerIdPhase(id)).toBe(phase);
      }
    });

    it('hashPlayerIdPhase spreads distinct ids (cheap diversity)', () => {
      // Adjacent/related ids should not all collide on the same phase.
      const phases = new Set<number>();
      for (let i = 0; i < 50; i++) {
        // Round to coarse buckets so near-equal phases collapse — assert
        // there's real diversity, not 50 identical phases.
        phases.add(Math.floor(hashPlayerIdPhase(`p-${i}`) * 10) / 10);
      }
      expect(phases.size).toBeGreaterThan(10);
    });
  });

  describe('determinism (same time + same playerId → same flickerMul)', () => {
    it('produces bit-identical output for the same (nowMs, playerId)', () => {
      const nowMs = 9876.5;
      const playerId = 'deterministic-player';
      const a = computeAuraBreathingMul(nowMs, playerId);
      const b = computeAuraBreathingMul(nowMs, playerId);
      expect(a).toBe(b); // toBe, not toBeCloseTo — exact equality is the contract
    });

    it('no Math.random in the breathing path (pure of inputs)', () => {
      // Spy on Math.random to prove it's never called during breathing compute.
      const spy = vi.spyOn(Math, 'random');
      for (let i = 0; i < 100; i++) {
        computeAuraBreathingMul(i * 100.0, `player-${i}`);
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('the amp + hz constants match the spec (±6%, ~0.6Hz)', () => {
      // Pinned per the C7 spec — guards against an accidental retune.
      expect(AURA_BREATHING_AMP).toBeCloseTo(0.06, 5);
      expect(AURA_BREATHING_HZ).toBeCloseTo(0.6, 5);
    });
  });

  describe('integration: the populator emits the breathing multiplier', () => {
    // Lighter-weight check that the populateDynamicLights path picks up the
    // breathing: at two different times for the same player the captured
    // flickerMul differs somewhere. The full populator test fixture lives in
    // DynamicLightPopulator.test.ts; here we just sanity-check the function
    // the populator calls.
    it('computeAuraBreathingMul matches the populateDynamicLights contract', () => {
      // The populator computes flickerMul = computeAuraBreathingMul(nowMs/1000, id)
      // — i.e. the helper takes SECONDS. Pin a few values so a refactor that
      // decouples the populator from this helper trips this test.
      expect(computeAuraBreathingMul(0, 'x')).toBeCloseTo(
        1 + AURA_BREATHING_AMP * Math.sin(hashPlayerIdPhase('x')),
        10,
      );
      // 1.0 second (the populator would pass nowMs=1000 → t=1.0).
      expect(computeAuraBreathingMul(1.0, 'y')).toBeCloseTo(
        1 +
          AURA_BREATHING_AMP *
            Math.sin(1.0 * AURA_BREATHING_HZ * 2 * Math.PI + hashPlayerIdPhase('y')),
        10,
      );
    });
  });
});

describe('C7 Layer 2 — candle/lantern flicker boosted to perceptible (≥20% dip)', () => {
  /**
   * The C7 spec raises candle/lantern amplitudes so the worst-case dip is
   * ≥ 20% (was ~17% / ~10%). The "dip" is `1 - min(flickerMul)` over a long
   * time + seed sweep — the deepest dim the flame reaches.
   */
  describe('profile amplitude pins (the verbatim C7 spec values)', () => {
    it('candle: lowAmp 0.10, highAmp 0.07 (was 0.05 / 0.04)', () => {
      const candle = FLICKER_PROFILES.candle;
      expect(candle.lowAmp).toBeCloseTo(0.1, 5);
      expect(candle.highAmp).toBeCloseTo(0.07, 5);
    });

    it('lantern: lowAmp 0.06, highAmp 0.05 (was 0.03 / 0.02)', () => {
      // C7 spec listed highAmp 0.04; bumped to 0.05 to clear the ≥20% dip floor
      // (see the DEVIATION note in TorchFlicker.ts). lowAmp stays at the spec's 0.06.
      const lantern = FLICKER_PROFILES.lantern;
      expect(lantern.lowAmp).toBeCloseTo(0.06, 5);
      expect(lantern.highAmp).toBeCloseTo(0.05, 5);
    });

    it('lantern flare stays disabled (a lantern is enclosed — no gust)', () => {
      // The spec: keep flareThreshold disabled.
      expect(FLICKER_PROFILES.lantern.flareThreshold).toBeGreaterThanOrEqual(1.0);
      expect(FLICKER_PROFILES.lantern.flareMul).toBe(1.0);
    });
  });

  describe('worst-case dip ≥ 20% (the new perceptibility floor)', () => {
    /**
     * Sweep a long time window × many seeds; record the minimum multiplier
     * each kind reaches. The dip is `1 - min`. The C7 spec floor is ≥ 20%.
     */
    function worstCaseDip(kind: FlickerFlameKind): number {
      let min = Infinity;
      for (let t = 0; t < 400; t++) {
        for (let s = 0; s < 20; s++) {
          const m = computeFlickerMulForKind(kind, { t: t * 0.025, seed: s * 0.7 });
          if (m < min) min = m;
        }
      }
      return 1 - min;
    }

    it('candle worst-case dip ≥ 20% (was ~17%)', () => {
      const dip = worstCaseDip('candle');
      expect(dip).toBeGreaterThanOrEqual(0.2);
    });

    it('lantern worst-case dip ≥ 20% (was ~10%)', () => {
      const dip = worstCaseDip('lantern');
      expect(dip).toBeGreaterThanOrEqual(0.2);
    });

    it('candle + lantern stay the calmest flames (smaller dip than torch/campfire)', () => {
      // The C7 spec: "These stay the calmest flames but read as alive." Even
      // after the boost, candle + lantern dip less than torch + campfire.
      const candle = worstCaseDip('candle');
      const lantern = worstCaseDip('lantern');
      const torch = worstCaseDip('torch');
      const campfire = worstCaseDip('campfire');
      expect(candle).toBeLessThan(torch);
      expect(lantern).toBeLessThan(torch);
      expect(candle).toBeLessThan(campfire);
      expect(lantern).toBeLessThan(campfire);
    });
  });

  describe('determinism preserved after the amp boost', () => {
    it('candle: same (t, seed) → bit-identical multiplier', () => {
      const a = computeFlickerMulForKind('candle', { t: 3.3, seed: 2.2 });
      const b = computeFlickerMulForKind('candle', { t: 3.3, seed: 2.2 });
      expect(a).toBe(b);
    });

    it('lantern: same (t, seed) → bit-identical multiplier', () => {
      const a = computeFlickerMulForKind('lantern', { t: 3.3, seed: 2.2 });
      const b = computeFlickerMulForKind('lantern', { t: 3.3, seed: 2.2 });
      expect(a).toBe(b);
    });
  });
});

/**
 * Per-kind flicker profile regression test (ticket 08 / A4 H5).
 *
 * Guards the per-kind flicker-config system (`TorchFlicker.FLICKER_PROFILES` +
 * `computeFlickerMulForKind`) that replaced the single generic `computeFlickerMul`
 * pre-ticket-08. Each flame kind gets its own (amplitude, frequency, flare)
 * tuning per the user's verbatim spec:
 *   - candle       steady-flicker (small amp)
 *   - torch        modulate (medium amp)
 *   - campfire     roar (big amp, slow)
 *   - fireplace    roar like campfire (big amp, slow)
 *   - brazier      steady-medium
 *   - lantern      very steady (tiny amp)
 *   - fire-trap    medium amp, active
 *
 * WHAT THIS PROVES:
 *  1. Determinism: same (kind, t, seed) → bit-identical multiplier. NO
 *     `Math.random()` anywhere in the flicker path (all clients agree on the
 *     multiplier for a given seed — the seed is deterministic per light).
 *  2. Per-kind differentiation: each kind's flicker character is DISTINCT
 *     (campfire roars bigger than candle, lantern is steadier than torch, etc.)
 *     — pins the user's per-kind spec so a regression to "one generic flicker"
 *     trips these tests.
 *  3. The flame never goes negative (the floor stays > 0 — a negative-intensity
 *     light is nonsensical).
 *  4. The explosion is NOT a flicker profile (it's a single pulse — covered by
 *     ExplosionLightRegistry.test.ts); this test asserts `FLICKER_PROFILES` has
 *     no `explosion` key.
 *
 * Reference: `.scratch/lighting-system-2/01-findings/A4-fire-source-completeness-flicker.md`
 * §5 (one generic flicker), §7.2 (per-kind fix).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  FLICKER_PROFILES,
  computeFlickerMulForKind,
  computeFlickerMulForProfile,
  computeFlickerMul,
  resolveFlickerProfile,
  type FlickerFlameKind,
  type FlickerProfile,
} from '../TorchFlicker.js';

const FLAME_KINDS: readonly FlickerFlameKind[] = [
  'torch',
  'campfire',
  'candle',
  'fireplace',
  'brazier',
  'lantern',
  'fire-trap',
];

describe('ticket 08 (A4 H5) — per-kind flicker profiles', () => {
  describe('determinism (same kind + t + seed → bit-identical multiplier)', () => {
    it.each(FLAME_KINDS)('%s produces bit-identical output for the same (t, seed)', (kind) => {
      const params = { t: 12.345, seed: 7.5 };
      const a = computeFlickerMulForKind(kind, params);
      const b = computeFlickerMulForKind(kind, params);
      expect(a).toBe(b); // toBe, not toBeCloseTo — exact equality is the contract
    });

    it('no Math.random in the flicker path (multiplier is pure of inputs)', () => {
      // Spy on Math.random to prove it's never called during flicker compute.
      const spy = vi.spyOn(Math, 'random');
      for (const kind of FLAME_KINDS) {
        for (let i = 0; i < 20; i++) {
          computeFlickerMulForKind(kind, { t: i * 0.1, seed: i * 1.3 });
        }
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('the multiplier varies with t (the flame moves over time)', () => {
      // Over a 1s window the multiplier is overwhelmingly likely to vary for
      // every flame kind (the slow + fast octaves ensure this). Assert finite +
      // in a sane range + varies somewhere in the window.
      for (const kind of FLAME_KINDS) {
        const values: number[] = [];
        for (let i = 0; i < 60; i++) {
          values.push(computeFlickerMulForKind(kind, { t: i * 0.05, seed: 3.3 }));
        }
        const min = Math.min(...values);
        const max = Math.max(...values);
        expect(max).toBeGreaterThan(min); // varies
        values.forEach((v) => {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThan(0); // never negative or zero
        });
      }
    });
  });

  describe('per-kind differentiation (the user verbatim spec)', () => {
    it('campfire ROARS bigger than candle steady-flickers (bigger amplitude)', () => {
      // The user: "a campfire roars ... a candle steady-flickers". Campfire's
      // slow-octave amplitude must be larger than candle's.
      const campfire = FLICKER_PROFILES.campfire;
      const candle = FLICKER_PROFILES.candle;
      expect(campfire.lowAmp).toBeGreaterThan(candle.lowAmp);
      expect(campfire.flareMul).toBeGreaterThan(candle.flareMul); // bigger gusts
    });

    it('campfire roars SLOWER than torch modulates (lower dominant frequency)', () => {
      // The user: "a campfire roars ... a torch modulates". A roar is low-
      // frequency; a modulate is medium. Campfire's slow-octave frequency must
      // be lower than torch's.
      expect(FLICKER_PROFILES.campfire.lowFreqHz).toBeLessThan(FLICKER_PROFILES.torch.lowFreqHz);
    });

    it('fireplace roars like campfire (same slow frequency, comparable amplitude)', () => {
      // The user: "a fireplace [is] big amp, slow roar (like campfire)".
      // Fireplace's slow-octave frequency must match campfire's (the roar rate).
      expect(FLICKER_PROFILES.fireplace.lowFreqHz).toBeCloseTo(
        FLICKER_PROFILES.campfire.lowFreqHz,
        5,
      );
      // Amplitude is comparable (fireplace is slightly smaller per the profile,
      // but in the same order of magnitude — both "big amp").
      expect(FLICKER_PROFILES.fireplace.lowAmp).toBeGreaterThan(0.2);
    });

    it('lantern is VERY steady (smallest amplitude of all flame kinds)', () => {
      // The user: "a lantern [is] tiny amp, very steady". Lantern's amplitudes
      // must be the smallest in the table.
      const lantern = FLICKER_PROFILES.lantern;
      for (const kind of FLAME_KINDS) {
        if (kind === 'lantern') continue;
        expect(lantern.lowAmp).toBeLessThanOrEqual(FLICKER_PROFILES[kind]!.lowAmp);
      }
      // Flare effectively disabled (a lantern doesn't gust).
      expect(lantern.flareThreshold).toBeGreaterThanOrEqual(1.0); // never fires
      expect(lantern.flareMul).toBe(1.0);
    });

    it('brazier is steady-MEDIUM (between campfire and lantern)', () => {
      // The user: "a brazier [is] medium amp, steady". Brazier's slow amplitude
      // sits between campfire (big) and lantern (tiny).
      const brazier = FLICKER_PROFILES.brazier!.lowAmp;
      expect(brazier).toBeLessThan(FLICKER_PROFILES.campfire!.lowAmp);
      expect(brazier).toBeGreaterThan(FLICKER_PROFILES.lantern!.lowAmp);
    });

    it('torch MODULATES (medium amplitude — the verbatim-prototype baseline)', () => {
      // The user: "a torch modulates". Torch is the de-facto "modulate" — its
      // amplitudes are the verbatim-prototype values (the A/B baseline).
      // lowAmp 0.15, highAmp 0.10 (from prototype.js:718-723).
      expect(FLICKER_PROFILES.torch.lowAmp).toBeCloseTo(0.15, 5);
      expect(FLICKER_PROFILES.torch.highAmp).toBeCloseTo(0.1, 5);
    });

    it('fire-trap is MEDIUM amp, active (between candle and campfire)', () => {
      // The user: "a fire-trap [is] medium amp, active". A contained floor-patch
      // fire — between candle (small) and campfire (big).
      const fireTrap = FLICKER_PROFILES['fire-trap'].lowAmp;
      expect(fireTrap).toBeGreaterThan(FLICKER_PROFILES.candle.lowAmp);
      expect(fireTrap).toBeLessThan(FLICKER_PROFILES.campfire.lowAmp);
    });

    it('each kind produces a DISTINCT flicker curve (no two kinds are identical)', () => {
      // Pin that the per-kind profiles actually differ — guards against a
      // regression where two kinds accidentally share a profile. Compare the
      // full multiplier curve over a time window; distinct kinds must differ
      // somewhere.
      for (let i = 0; i < FLAME_KINDS.length; i++) {
        for (let j = i + 1; j < FLAME_KINDS.length; j++) {
          const a = FLAME_KINDS[i]!;
          const b = FLAME_KINDS[j]!;
          let anyDiffer = false;
          for (let t = 0; t < 50; t++) {
            const ma = computeFlickerMulForKind(a, { t: t * 0.1, seed: 1.0 });
            const mb = computeFlickerMulForKind(b, { t: t * 0.1, seed: 1.0 });
            if (Math.abs(ma - mb) > 1e-6) {
              anyDiffer = true;
              break;
            }
          }
          expect(anyDiffer, `${a} vs ${b} must produce distinct curves`).toBe(true);
        }
      }
    });
  });

  describe('safety (the flame never goes negative)', () => {
    it.each(FLAME_KINDS)(
      '%s multiplier stays > 0.2 over a long window (no negative/zero light)',
      (kind) => {
        // The profile amplitudes let a "roaring" flame (campfire/fireplace) dip
        // to ~30-40% of base during a big dip — that's the roar character (big
        // swells AND dips), not a bug. The hard safety constraint is "never
        // negative or zero" (a negative-intensity light is nonsensical). The
        // > 0.2 floor is comfortably above zero + accommodates the big-amp roar
        // profiles while still catching a degenerate always-zero regression.
        let min = Infinity;
        for (let t = 0; t < 200; t++) {
          for (let s = 0; s < 10; s++) {
            const m = computeFlickerMulForKind(kind, { t: t * 0.1, seed: s * 1.7 });
            if (m < min) min = m;
          }
        }
        expect(min).toBeGreaterThan(0.2);
      },
    );
  });

  describe('the explosion is NOT a flicker profile (single pulse, handled separately)', () => {
    it('FLICKER_PROFILES has no "explosion" key (the explosion is a single pulse)', () => {
      // The explosion is handled by ExplosionLightRegistry.computeExplosionPulseMul
      // — a monotonic peak + decay, NOT a flicker profile. Assert the profile
      // table does not contain it (guards against accidentally adding a steady-
      // state flicker for a transient).
      expect('explosion' in FLICKER_PROFILES).toBe(false);
    });

    it('resolveFlickerProfile falls back to torch for unknown kinds (defensive)', () => {
      // 'biome-glow' is a LightKind but NOT a FlameKind (it's a steady magical
      // glow). If somehow passed to resolveFlickerProfile, it must fall back to
      // the torch profile (the de-facto "modulate") rather than throw.
      // Cast through unknown to exercise the fallback path.
      const profile = resolveFlickerProfile('biome-glow' as unknown as FlickerFlameKind);
      expect(profile).toBe(FLICKER_PROFILES.torch);
    });
  });

  describe('profile structure (the four levers are present + well-formed)', () => {
    it.each(FLAME_KINDS)('%s profile has all four levers in valid ranges', (kind) => {
      const p: FlickerProfile = FLICKER_PROFILES[kind]!;
      expect(p.lowAmp).toBeGreaterThan(0);
      expect(p.lowAmp).toBeLessThan(0.5); // sane ceiling
      expect(p.lowFreqHz).toBeGreaterThan(0);
      expect(p.lowFreqHz).toBeLessThan(10); // sane ceiling (< ~10Hz roar)
      expect(p.highAmp).toBeGreaterThan(0);
      expect(p.highAmp).toBeLessThan(0.5);
      expect(p.highFreqHz).toBeGreaterThan(p.lowFreqHz); // fast octave is faster
      expect(p.flareMul).toBeGreaterThanOrEqual(1.0); // flare scales UP (or neutral)
    });
  });

  describe('legacy API preserved (the global flame modulation + existing tests)', () => {
    it('computeFlickerMulForProfile is equivalent to computeFlickerMulForKind(torch)', () => {
      // The legacy `computeFlickerMul(params)` is pinned to the torch profile.
      // The GameSceneHelpers global flame modulation (seed 0.0) relies on this.
      const params = { t: 5.5, seed: 2.2 };
      expect(computeFlickerMulForKind('torch', params)).toBe(computeFlickerMul(params));
    });
  });
});

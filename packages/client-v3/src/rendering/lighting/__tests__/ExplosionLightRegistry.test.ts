import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExplosionLightRegistry,
  EXPLOSION_LIGHT_LIFETIME_MS,
  EXPLOSION_PULSE_PEAK_MS,
  computeExplosionPulseMul,
} from '../ExplosionLightRegistry.js';
import { resolveLightKind } from '../LightPalette.js';
import { cookieKeyToIndex } from '../LightPacker.js';

describe('ExplosionLightRegistry — explosion-light lifecycle (ticket 11 + ticket 08 single-pulse)', () => {
  let registry: ExplosionLightRegistry;

  beforeEach(() => {
    registry = new ExplosionLightRegistry();
  });

  describe('register + collect (the brief hot flash)', () => {
    it('registers a fire-palette light at the explosion position', () => {
      registry.register(1500, 2000, 256, 0, 7.3);
      const lights = registry.collect(0, 1.0);
      expect(lights.length).toBe(1);
      const l = lights[0]!;
      expect(l.x).toBe(1500);
      expect(l.y).toBe(2000);
    });

    it('uses the hottest fire palette + light_01 cookie (spec hero values)', () => {
      registry.register(0, 0, 256, 0, 1.0);
      const [l] = registry.collect(0, 1.0);
      const fire = resolveLightKind('fire');
      expect(l!.color[0]).toBeCloseTo(fire.color[0], 5);
      expect(l!.color[1]).toBeCloseTo(fire.color[1], 5);
      expect(l!.color[2]).toBeCloseTo(fire.color[2], 5);
      expect(l!.corePower).toBe(fire.corePower); // 3.8 (ticket 07)
      expect(l!.specPower).toBe(fire.specPower); // 22.0
      // light_01 cookie → index 1 (spec hero override: explosions use light_01).
      expect(l!.cookieOn).toBe(cookieKeyToIndex('light_01'));
      expect(l!.cookieOn).toBe(1);
    });

    it('scales radius + intensity to the blast radius', () => {
      // A bigger blast → a bigger + hotter light. Radius scales at 1.1× (the
      // fireball exceeds the damage radius for dramatic spill), intensity at
      // 0.016×. Both monotonic in the blast radius.
      registry.register(0, 0, 128, 0, 1.0);
      registry.register(100, 0, 256, 0, 2.0);
      registry.register(200, 0, 512, 0, 3.0);
      const lights = registry.collect(0, 1.0);
      // Order is insertion order; indices 0/1/2 = blast 128/256/512.
      const r128 = lights[0]!;
      const r256 = lights[1]!;
      const r512 = lights[2]!;
      expect(r512.radius).toBeGreaterThan(r256.radius);
      expect(r256.radius).toBeGreaterThan(r128.radius);
      expect(r512.intensity).toBeGreaterThan(r256.intensity);
      expect(r256.intensity).toBeGreaterThan(r128.intensity);
    });

    it('a max barrel blast (256) produces a hot light (intensity ≈ 4.10 at peak)', () => {
      // BARREL.EXPLOSION_RADIUS = 256. intensity = max(1.8, 256 * 0.016) = 4.096.
      // Prior baselines: 0.014 → 3.584 (pre-ticket-07), 0.012 → 3.072 (ticket-07).
      registry.register(0, 0, 256, 0, 1.0);
      const [l] = registry.collect(0, 1.0);
      // At age 0 (within the peak window), pulse = 1.0, so intensity = base.
      expect(l!.intensity).toBeCloseTo(4.096, 2);
      // Hotter than a campfire (2.6) — explosions are the hottest scene element.
      expect(l!.intensity).toBeGreaterThan(2.6);
    });
  });

  describe('single-pulse envelope (ticket 08 / A4 H3 — NO flicker octaves)', () => {
    it('full intensity during the peak window, then exponential decay', () => {
      // Ticket 08: the explosion light is now a SINGLE PULSE, not continuous
      // flame flicker. The envelope is: full intensity for the first PEAK ms
      // (the AAA "flash" — research §4: 1–3 frames), then exp(-t/DECAY) decay.
      // NO linear fade, NO octave noise.
      registry.register(0, 0, 256, 0, 0.0); // seed 0 → no jitter
      // Read intensity IMMEDIATELY after each collect (the registry reuses a
      // stable DynamicLight ref mutated in place per call).
      const peakIntensity = registry.collect(0, 1.0)[0]!.intensity;
      const midDecayIntensity = registry.collect(EXPLOSION_PULSE_PEAK_MS + 50, 1.0)[0]!.intensity;
      const lateIntensity = registry.collect(EXPLOSION_PULSE_PEAK_MS + 200, 1.0)[0]!.intensity;
      // Peak = full base intensity (4.096 = 256 * 0.016).
      expect(peakIntensity).toBeCloseTo(4.096, 2);
      // Mid-decay (50ms after peak): exp(-50/100) ≈ 0.607 of base.
      expect(midDecayIntensity).toBeCloseTo(4.096 * Math.exp(-50 / 100), 1);
      // Late (200ms after peak): exp(-200/100) ≈ 0.135 of base — nearly gone.
      expect(lateIntensity).toBeLessThan(peakIntensity * 0.2);
      expect(lateIntensity).toBeGreaterThan(0);
    });

    it('intensity is MONOTONICALLY non-increasing after the peak (no flicker oscillation)', () => {
      // The defining property of a single pulse: once decaying, intensity never
      // goes back up. Continuous flicker octaves would violate this (strobing).
      // Sample every 16ms (1 frame at 60fps) and assert non-increasing post-peak.
      registry.register(0, 0, 256, 0, 0.0);
      let prev = Infinity;
      for (let age = EXPLOSION_PULSE_PEAK_MS; age < EXPLOSION_LIGHT_LIFETIME_MS; age += 16) {
        const intensity = registry.collect(age, 1.0)[0]!.intensity;
        expect(intensity).toBeLessThanOrEqual(prev + 1e-9); // non-increasing (epsilon for FP)
        prev = intensity;
      }
    });

    it('flickerMul is always 1.0 (the explosion has NO flicker octaves)', () => {
      // Ticket 08: the pulse is folded into INTENSITY, not flickerMul. The
      // flickerMul channel stays at 1.0 so the packer's `intensity * flickerMul`
      // sees the pulse cleanly. The continuous-flame-flicker factor is GONE.
      registry.register(0, 0, 256, 0, 4.2);
      for (let age = 0; age < EXPLOSION_LIGHT_LIFETIME_MS; age += 50) {
        const l = registry.collect(age, 0.75)[0]!; // caller flickerMul IGNORED
        expect(l.flickerMul).toBe(1.0);
      }
    });

    it('the caller-supplied flickerMul is IGNORED (no mixing with flame flicker)', () => {
      // Ticket 08: the populator still passes the global flame flickerMul for
      // signature compatibility, but the explosion registry IGNORES it (mixing
      // the pulse with continuous flame flicker would re-introduce the
      // strobe-on-transient bug the single-pulse fix removes). Asserts the
      // caller flickerMul has zero effect on the collected intensity.
      registry.register(0, 0, 256, 0, 1.0);
      const withFlicker = registry.collect(0, 0.5)[0]!.intensity;
      const withoutFlicker = registry.collect(0, 1.0)[0]!.intensity;
      expect(withFlicker).toBe(withoutFlicker);
    });

    it('computeExplosionPulseMul is pure + deterministic (same age + seed → same mul)', () => {
      // The determinism contract: same inputs → bit-identical output. All clients
      // viewing the same explosion (same position → same seed) compute the same
      // pulse envelope.
      expect(computeExplosionPulseMul(123.4, 7.7)).toBe(computeExplosionPulseMul(123.4, 7.7));
      // Peak window: mul = 1.0
      expect(computeExplosionPulseMul(0, 1.0)).toBe(1.0);
      // Decay: mul in (0, 1)
      const decay = computeExplosionPulseMul(EXPLOSION_PULSE_PEAK_MS + 100, 1.0);
      expect(decay).toBeGreaterThan(0);
      expect(decay).toBeLessThan(1);
    });

    it('distinct seeds phase-offset the peak start (chain explosions not in lockstep)', () => {
      // The seed adds a tiny deterministic jitter (±16ms ≈ ±1 frame at 60fps) to
      // the peak window start so chain explosions (distinct seeds) don't all
      // peak on the exact same frame. The jitter is small + bounded; this test
      // asserts the seed actually shifts the curve (distinct seeds → distinct
      // muls at a fixed age near the peak boundary).
      const age = EXPLOSION_PULSE_PEAK_MS; // right at the un-jittered peak end
      const mulA = computeExplosionPulseMul(age, 1.0);
      const mulB = computeExplosionPulseMul(age, 99.3);
      // At least one of them should differ (the jitter shifts the peak end).
      // They MAY coincide for specific (age, seed) pairs, so assert they're
      // both in [0,1] + finite + the function varies with seed somewhere.
      expect(mulA).toBeGreaterThanOrEqual(0);
      expect(mulA).toBeLessThanOrEqual(1);
      expect(mulB).toBeGreaterThanOrEqual(0);
      expect(mulB).toBeLessThanOrEqual(1);
      // Stronger: somewhere in the [peakEnd - 16, peakEnd + 16] window (where the
      // ±16ms jitter shifts one seed into decay while the other is still in
      // peak), distinct seeds produce distinct muls. The jitter shifts peakEnd
      // by ±16ms, so sampling across that boundary finds the divergence.
      let anyDiffer = false;
      for (let a = EXPLOSION_PULSE_PEAK_MS - 16; a <= EXPLOSION_PULSE_PEAK_MS + 16; a += 2) {
        if (Math.abs(computeExplosionPulseMul(a, 1.0) - computeExplosionPulseMul(a, 99.3)) > 1e-6) {
          anyDiffer = true;
          break;
        }
      }
      expect(anyDiffer).toBe(true);
    });
  });

  describe('fade-out lifecycle (brief, then unregister)', () => {
    it('update() expires lights past their lifetime (auto-unregister)', () => {
      registry.register(0, 0, 256, 0, 1.0);
      expect(registry.size).toBe(1);
      // Before lifetime → still live.
      registry.update(EXPLOSION_LIGHT_LIFETIME_MS / 2);
      expect(registry.size).toBe(1);
      // After lifetime → expired + recycled to the pool.
      registry.update(EXPLOSION_LIGHT_LIFETIME_MS + 1);
      expect(registry.size).toBe(0);
      // collect() now returns nothing.
      expect(registry.collect(EXPLOSION_LIGHT_LIFETIME_MS + 1, 1.0).length).toBe(0);
    });

    it('collect reflects only lights still alive after update()', () => {
      registry.register(0, 0, 256, 0, 1.0); // expires at 300ms (ticket 08)
      registry.register(100, 0, 256, 200, 2.0); // expires at 500ms
      registry.update(350); // first expired, second live
      const lights = registry.collect(350, 1.0);
      expect(lights.length).toBe(1);
      expect(lights[0]!.x).toBe(100); // the second (later) explosion
    });
  });

  describe('zero-allocation steady state (the hot-path contract)', () => {
    it('collect reuses the same output array + stable DynamicLight refs', () => {
      registry.register(0, 0, 256, 0, 1.0);
      const first = registry.collect(0, 1.0);
      const firstRef = first[0];
      const second = registry.collect(10, 1.0);
      // Same array identity + same element identity (mutated in place).
      expect(second).toBe(first);
      expect(second[0]).toBe(firstRef);
    });

    it('register reuses pooled entries after expiry (no unbounded growth)', () => {
      // Register + expire many explosions; the entries array never exceeds the
      // peak concurrent count (here, 1 at a time). The pool recycles.
      for (let i = 0; i < 50; i++) {
        registry.register(i * 10, 0, 256, i * 1000, 1.0);
        registry.update(i * 1000 + EXPLOSION_LIGHT_LIFETIME_MS + 1); // expire it
      }
      expect(registry.size).toBe(0);
    });
  });

  describe('clear (scene teardown / reset)', () => {
    it('clears all live entries', () => {
      registry.register(0, 0, 256, 0, 1.0);
      registry.register(100, 0, 256, 0, 2.0);
      expect(registry.size).toBe(2);
      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.collect(0, 1.0).length).toBe(0);
    });
  });

  describe('determinism (same spawn + now → same light)', () => {
    it('identical register calls produce identical collected lights', () => {
      const r1 = new ExplosionLightRegistry();
      const r2 = new ExplosionLightRegistry();
      r1.register(1234, 5678, 256, 1000, 4.2);
      r2.register(1234, 5678, 256, 1000, 4.2);
      const l1 = r1.collect(1000, 0.9)[0]!;
      const l2 = r2.collect(1000, 0.9)[0]!;
      // Same position/radius/intensity/color/cookie (the pulse is deterministic
      // per age + seed). NOTE: caller flickerMul (0.9) is IGNORED post-ticket-08
      // (explosions use the single-pulse curve only), so both registries see
      // the same intensity regardless of the passed flickerMul.
      expect(l1.x).toBe(l2.x);
      expect(l1.y).toBe(l2.y);
      expect(l1.radius).toBe(l2.radius);
      expect(l1.intensity).toBe(l2.intensity);
      expect(l1.cookieOn).toBe(l2.cookieOn);
    });
  });
});

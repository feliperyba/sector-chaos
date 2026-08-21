/**
 * Ticket 09 / A3 — ImpactLightRegistry (combat-impact flash lifecycle) unit tests.
 *
 * `ImpactLightRegistry.ts` is a stateful-but-deterministic module (no Phaser, no
 * GPU; reads wall-clock only via the `nowMs` arg the caller passes — same shape
 * as ExplosionLightRegistry). These tests assert the registry facts
 * deterministically:
 *
 *   1. `register` records an entry; `collect` returns it once (per the
 *      single-pulse curve). N events → N lights.
 *   2. Per-event-kind tinting: each of the 4 kinds (projectile/block/melee/
 *      break) resolves to a DISTINCT color/cookie — the AAA per-element principle
 *      applied to impact color-coding.
 *   3. The single-pulse envelope (peak + exponential decay, NO flicker octaves)
 *      matches the AAA "flash = the briefest first layer" read (research §4).
 *   4. The fade-out lifecycle (auto-expire past lifetime, pool recycling).
 *
 * Reference: `.scratch/lighting-system-2/01-findings/A3-projectiles-arrows-
 * elemental-only.md` (the RANGED-only ruling) + the AAA research §4 (impact
 * layering). Cosmetic-only (GDD `docs/GDD.md:210`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ImpactLightRegistry,
  IMPACT_LIGHT_LIFETIME_MS,
  IMPACT_PULSE_PEAK_MS,
  computeImpactPulseMul,
  type ImpactLightKind,
} from '../ImpactLightRegistry.js';

describe('ImpactLightRegistry — combat-impact flash lifecycle (ticket 09 / A3)', () => {
  let registry: ImpactLightRegistry;

  beforeEach(() => {
    registry = new ImpactLightRegistry();
  });

  describe('register + collect (the brief impact flash)', () => {
    it('registers a light at the impact position', () => {
      registry.register(1500, 2000, 'projectile', 0, 7.3);
      const lights = registry.collect(0, 1.0);
      expect(lights.length).toBe(1);
      const l = lights[0]!;
      expect(l.x).toBe(1500);
      expect(l.y).toBe(2000);
    });

    it('N events → N lights (one entry per register call)', () => {
      // The headline ticket fact: "assert it produces N lights for N events".
      registry.register(0, 0, 'projectile', 0, 1.0);
      registry.register(100, 0, 'block', 0, 2.0);
      registry.register(200, 0, 'melee', 0, 3.0);
      registry.register(300, 0, 'break', 0, 4.0);
      const lights = registry.collect(0, 1.0);
      expect(lights.length).toBe(4);
      // Order is insertion order.
      expect(lights[0]!.x).toBe(0);
      expect(lights[1]!.x).toBe(100);
      expect(lights[2]!.x).toBe(200);
      expect(lights[3]!.x).toBe(300);
    });

    it('each impact kind resolves to a DISTINCT color (AAA per-element principle)', () => {
      // The four kinds must NOT collide on color — the per-element tinting is
      // the load-bearing differentiation (a block spark ≠ a melee hit ≠ an
      // arrow impact ≠ a weapon break).
      const kinds: ImpactLightKind[] = ['projectile', 'block', 'melee', 'break'];
      const colors = kinds.map((k) => {
        registry.clear();
        registry.register(0, 0, k, 0, 1.0);
        return registry.collect(0, 1.0)[0]!.color;
      });
      for (let i = 0; i < colors.length; i++) {
        for (let j = i + 1; j < colors.length; j++) {
          const a = colors[i]!;
          const b = colors[j]!;
          const same = a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
          expect(same, `kind ${kinds[i]} ≠ kind ${kinds[j]}`).toBe(false);
        }
      }
    });

    it('arrow impact (projectile) = warm white, warm radial cookie', () => {
      registry.register(0, 0, 'projectile', 0, 1.0);
      const [l] = registry.collect(0, 1.0);
      // Warm white: R/G high, B slightly below (matches the RANGED traveling
      // light's hot near-white core — the impact is the streak's terminus).
      expect(l!.color[0]).toBeGreaterThanOrEqual(0.95);
      expect(l!.color[1]).toBeGreaterThanOrEqual(0.9);
      expect(l!.color[2]).toBeLessThan(l!.color[0]); // faint warm bias.
      expect(l!.cookieOn).toBe(1); // light_01 warm radial.
    });

    it('shield-block spark (block) = spark white-blue, COOL radial cookie', () => {
      registry.register(0, 0, 'block', 0, 1.0);
      const [l] = registry.collect(0, 1.0);
      // Spark white-blue: B >= R (cool-biased — a metallic clash, distinct from
      // the warm flesh-hit spark).
      expect(l!.color[2]).toBeGreaterThanOrEqual(l!.color[0]);
      expect(l!.cookieOn).toBe(2); // light_02 cool radial — distinct from warm.
    });

    it('melee hit spark (melee) = warm spark, warm radial cookie', () => {
      registry.register(0, 0, 'melee', 0, 1.0);
      const [l] = registry.collect(0, 1.0);
      // Warm spark: R > G > B (warm enough to read as impact, not as fire — less
      // saturated red than the explosion palette).
      expect(l!.color[0]).toBeGreaterThan(l!.color[1]);
      expect(l!.color[1]).toBeGreaterThan(l!.color[2]);
      expect(l!.cookieOn).toBe(1); // light_01 warm radial.
    });

    it('weapon-break shatter (break) = warm-orange, warm radial cookie', () => {
      registry.register(0, 0, 'break', 0, 1.0);
      const [l] = registry.collect(0, 1.0);
      // Warm-orange: R >> G >> B (warmer than the melee spark — a fractured
      // weapon's dying glint, not a flesh hit).
      expect(l!.color[0]).toBeGreaterThan(l!.color[1]);
      expect(l!.color[2]).toBeLessThan(0.4); // low blue = warm.
      expect(l!.cookieOn).toBe(1); // light_01 warm radial.
    });

    it('radii are tactical (small — ~80–120px, not scene-dominating)', () => {
      // The ticket: "small radius (~80–120px)". Each kind's radius sits in that
      // band so the flash reads as a spark, not a flood.
      const kinds: ImpactLightKind[] = ['projectile', 'block', 'melee', 'break'];
      for (const k of kinds) {
        registry.clear();
        registry.register(0, 0, k, 0, 1.0);
        const r = registry.collect(0, 1.0)[0]!.radius;
        expect(r, `kind ${k} radius`).toBeGreaterThanOrEqual(80);
        expect(r, `kind ${k} radius`).toBeLessThanOrEqual(120);
      }
    });

    it('intensities are modest (accents, below the explosion flash + campfire)', () => {
      // The ticket: "modest intensity. Tactical, not scene-dominating." Each
      // kind's peak intensity sits below the explosion flash (~3.07) + campfire
      // hero (2.6), above the chest glint (1.2).
      const kinds: ImpactLightKind[] = ['projectile', 'block', 'melee', 'break'];
      for (const k of kinds) {
        registry.clear();
        registry.register(0, 0, k, 0, 1.0);
        const intensity = registry.collect(0, 1.0)[0]!.intensity;
        expect(intensity, `kind ${k} intensity`).toBeGreaterThan(1.2); // above chest glint.
        expect(intensity, `kind ${k} intensity`).toBeLessThan(2.6); // below campfire hero.
      }
    });
  });

  describe('single-pulse envelope (ticket 09 — NO flicker octaves)', () => {
    it('full intensity during the peak window, then exponential decay', () => {
      // The AAA "flash" = the briefest first layer (1–3 frames). After the peak
      // window the light decays exponentially. NO linear fade, NO octave noise.
      registry.register(0, 0, 'melee', 0, 0.0); // seed 0 → no jitter.
      // Read intensity IMMEDIATELY after each collect (the registry reuses a
      // stable DynamicLight ref mutated in place per call).
      const peakIntensity = registry.collect(0, 1.0)[0]!.intensity;
      const midDecayIntensity = registry.collect(IMPACT_PULSE_PEAK_MS + 40, 1.0)[0]!.intensity;
      const lateIntensity = registry.collect(IMPACT_PULSE_PEAK_MS + 150, 1.0)[0]!.intensity;
      // Peak = full base intensity.
      const baseIntensity = 1.6; // melee kind intensity (see IMPACT_KIND_TUNING).
      expect(peakIntensity).toBeCloseTo(baseIntensity, 5);
      // Mid-decay (40ms after peak): exp(-40/80) ≈ 0.607 of base.
      expect(midDecayIntensity).toBeCloseTo(baseIntensity * Math.exp(-40 / 80), 2);
      // Late (150ms after peak): exp(-150/80) ≈ 0.153 of base — nearly gone.
      expect(lateIntensity).toBeLessThan(peakIntensity * 0.2);
      expect(lateIntensity).toBeGreaterThan(0);
    });

    it('intensity is MONOTONICALLY non-increasing after the peak (no flicker oscillation)', () => {
      // The defining property of a single pulse: once decaying, intensity never
      // goes back up. Continuous flicker octaves would violate this (strobing).
      // Sample every 16ms (1 frame at 60fps) and assert non-increasing post-peak.
      registry.register(0, 0, 'projectile', 0, 0.0);
      let prev = Infinity;
      for (let age = IMPACT_PULSE_PEAK_MS; age < IMPACT_LIGHT_LIFETIME_MS; age += 16) {
        const intensity = registry.collect(age, 1.0)[0]!.intensity;
        expect(intensity).toBeLessThanOrEqual(prev + 1e-9); // non-increasing (epsilon for FP)
        prev = intensity;
      }
    });

    it('flickerMul is always 1.0 (the impact has NO flicker octaves)', () => {
      // The pulse is folded into INTENSITY, not flickerMul. The flickerMul channel
      // stays at 1.0 so the packer's `intensity * flickerMul` sees the pulse
      // cleanly. NO continuous flame flicker (per AAA research §4 — the flash is
      // the briefest first layer, NOT a steady flickering light).
      registry.register(0, 0, 'block', 0, 4.2);
      for (let age = 0; age < IMPACT_LIGHT_LIFETIME_MS; age += 50) {
        const l = registry.collect(age, 0.75)[0]!; // caller flickerMul IGNORED
        expect(l.flickerMul).toBe(1.0);
      }
    });

    it('the caller-supplied flickerMul is IGNORED (no mixing with flame flicker)', () => {
      // The populator still passes the global flame flickerMul for signature
      // compatibility (mirroring the explosion registry), but the impact registry
      // IGNORES it (mixing the pulse with continuous flame flicker would
      // re-introduce a strobe-on-transient bug). Asserts zero effect.
      registry.register(0, 0, 'melee', 0, 1.0);
      const withFlicker = registry.collect(0, 0.5)[0]!.intensity;
      const withoutFlicker = registry.collect(0, 1.0)[0]!.intensity;
      expect(withFlicker).toBe(withoutFlicker);
    });

    it('computeImpactPulseMul is pure + deterministic (same age + seed → same mul)', () => {
      // The determinism contract: same inputs → bit-identical output. All clients
      // viewing the same impact (same position → same seed) compute the same pulse
      // envelope.
      expect(computeImpactPulseMul(123.4, 7.7)).toBe(computeImpactPulseMul(123.4, 7.7));
      // Peak window: mul = 1.0
      expect(computeImpactPulseMul(0, 1.0)).toBe(1.0);
      // Decay: mul in (0, 1)
      const decay = computeImpactPulseMul(IMPACT_PULSE_PEAK_MS + 80, 1.0);
      expect(decay).toBeGreaterThan(0);
      expect(decay).toBeLessThan(1);
    });

    it('distinct seeds phase-offset the peak start (concurrent impacts not in lockstep)', () => {
      // The seed adds a tiny deterministic jitter (±16ms ≈ ±1 frame at 60fps) to
      // the peak window start so concurrent impacts (a multi-hit sweep, a cluster
      // of arrow strikes) don't all peak on the exact same frame. Asserts the
      // seed actually shifts the curve somewhere across the jitter boundary.
      let anyDiffer = false;
      for (let a = IMPACT_PULSE_PEAK_MS - 16; a <= IMPACT_PULSE_PEAK_MS + 16; a += 2) {
        if (Math.abs(computeImpactPulseMul(a, 1.0) - computeImpactPulseMul(a, 99.3)) > 1e-6) {
          anyDiffer = true;
          break;
        }
      }
      expect(anyDiffer).toBe(true);
    });

    it('impact decay is FASTER than explosion decay (impacts are smaller events)', () => {
      // The ticket: impacts are tactical accents, not primary lights. The decay
      // time constant (80ms) is shorter than the explosion decay (100ms), so the
      // scene doesn't accumulate lingering flashes during a busy melee. Asserted
      // via the pulse math: at a fixed post-peak age, impact mul < explosion mul
      // (impact decays faster).
      // Explosion decay constant = 100ms (ExplosionLightRegistry); impact = 80ms.
      // Both peak windows are 50ms.
      const ageAfterPeak = 100;
      const impactMul = computeImpactPulseMul(IMPACT_PULSE_PEAK_MS + ageAfterPeak, 1.0);
      // Explosion: exp(-100/100) = exp(-1) ≈ 0.368. Impact: exp(-100/80) ≈ 0.287.
      expect(impactMul).toBeLessThan(Math.exp(-ageAfterPeak / 100));
    });
  });

  describe('fade-out lifecycle (brief, then unregister)', () => {
    it('update() expires lights past their lifetime (auto-unregister)', () => {
      registry.register(0, 0, 'melee', 0, 1.0);
      expect(registry.size).toBe(1);
      // Before lifetime → still live.
      registry.update(IMPACT_LIGHT_LIFETIME_MS / 2);
      expect(registry.size).toBe(1);
      // After lifetime → expired + recycled to the pool.
      registry.update(IMPACT_LIGHT_LIFETIME_MS + 1);
      expect(registry.size).toBe(0);
      // collect() now returns nothing.
      expect(registry.collect(IMPACT_LIGHT_LIFETIME_MS + 1, 1.0).length).toBe(0);
    });

    it('collect reflects only lights still alive after update()', () => {
      registry.register(0, 0, 'melee', 0, 1.0); // expires at 180ms
      registry.register(100, 0, 'block', 200, 2.0); // expires at 380ms
      registry.update(250); // first expired, second live
      const lights = registry.collect(250, 1.0);
      expect(lights.length).toBe(1);
      expect(lights[0]!.x).toBe(100); // the second (later) impact
    });

    it('impact lifetime is SHORTER than explosion lifetime (180ms vs 300ms)', () => {
      // The ticket: impacts are briefer than explosions. Asserted as a constant
      // so a future tuning change doesn't silently make impacts out-last blasts.
      expect(IMPACT_LIGHT_LIFETIME_MS).toBe(180);
      expect(IMPACT_LIGHT_LIFETIME_MS).toBeLessThan(300); // < explosion lifetime.
    });

    it('clear() empties the registry (scene teardown / test reset)', () => {
      registry.register(0, 0, 'melee', 0, 1.0);
      registry.register(100, 0, 'block', 0, 2.0);
      expect(registry.size).toBe(2);
      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.collect(0, 1.0).length).toBe(0);
    });

    it('reused collected slots reflect the CURRENT kind (not a stale prior kind)', () => {
      // The collected array is indexed by position, not by entry identity. A slot
      // that held a 'block' flash last frame may hold a 'melee' flash this frame.
      // Assert the per-frame color/cookie re-application keeps them distinct.
      // NOTE: capture color VALUES (copy the tuple), not the reference — the slot
      // is mutated in place, so holding the reference would read the NEW color
      // after the slot is reused.
      registry.register(0, 0, 'block', 0, 1.0);
      const blockLight = registry.collect(0, 1.0)[0]!;
      const blockColor: [number, number, number] = [
        blockLight.color[0],
        blockLight.color[1],
        blockLight.color[2],
      ];
      const blockCookie = blockLight.cookieOn;
      // Expire the block flash, then register a melee flash at the same slot.
      registry.update(IMPACT_LIGHT_LIFETIME_MS + 1);
      registry.register(0, 0, 'melee', IMPACT_LIGHT_LIFETIME_MS + 2, 1.0);
      const meleeLight = registry.collect(IMPACT_LIGHT_LIFETIME_MS + 2, 1.0)[0]!;
      const meleeColor: [number, number, number] = [
        meleeLight.color[0],
        meleeLight.color[1],
        meleeLight.color[2],
      ];
      const meleeCookie = meleeLight.cookieOn;
      // The two colors must differ (block = cool, melee = warm) + the cookies
      // differ (block = light_02, melee = light_01) — proves the slot's stale
      // block color/cookie was overwritten with the melee values.
      const sameColor =
        blockColor[0] === meleeColor[0] &&
        blockColor[1] === meleeColor[1] &&
        blockColor[2] === meleeColor[2];
      expect(sameColor).toBe(false);
      expect(blockCookie).not.toBe(meleeCookie);
    });
  });

  describe('zero-allocation steady state (mirrors ExplosionLightRegistry)', () => {
    it('collect returns STABLE refs (mutated in place across frames)', () => {
      // The populator holds the collected refs for the frame; the registry must
      // NOT allocate new objects each call. Asserted by identity: two collect
      // calls for the same live entry return the SAME DynamicLight object.
      registry.register(0, 0, 'melee', 0, 1.0);
      const ref1 = registry.collect(0, 1.0)[0]!;
      const ref2 = registry.collect(0, 1.0)[0]!;
      expect(ref1).toBe(ref2); // same object reference (mutated in place).
    });

    it('expired entries are recycled to the pool (no growth across cycles)', () => {
      // Register + expire several entries; the pool absorbs them. The next
      // register reuses a pooled entry (no new allocation). Asserted indirectly:
      // after many cycles the registry still functions correctly (no leak, no
      // duplicate entries).
      for (let cycle = 0; cycle < 10; cycle++) {
        registry.register(cycle * 10, 0, 'melee', cycle * 100, 1.0);
        registry.update(cycle * 100 + IMPACT_LIGHT_LIFETIME_MS + 1); // expire.
      }
      expect(registry.size).toBe(0); // all expired.
      // One fresh register works cleanly.
      registry.register(999, 0, 'block', 9999, 1.0);
      expect(registry.size).toBe(1);
      expect(registry.collect(9999, 1.0)[0]!.x).toBe(999);
    });
  });
});

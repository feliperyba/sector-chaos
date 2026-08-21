import { describe, it, expect } from 'vitest';
import {
  BEACON_INTENSITY_MAX,
  BEACON_INTENSITY_MIN,
  BEACON_RADIUS,
  BEACON_TIER_LIGHT,
} from '@sector-battle/shared';
import { LIGHT_PALETTE, HERO_LIGHT_OVERRIDES, resolveLightKind } from '../LightPalette.js';
import { LIGHT_PROP_TEXTURES, resolveLightPropTexture } from '../LightPropResolver.js';
import { lightPropYOffset } from '../LightPropRenderer.js';

/**
 * Map-redesign ticket 04 (DEC-002/005) + map-polish ticket 01 (moody retune)
 * — the `beacon` light kind: the hero-landmark destination light. These
 * Seam-A guards lock the client-side resolution of the shared wire kind so
 * the theme-colored, slow-pulsing, radius-≥512 beacons (authored in shared
 * generation, appended to `lightPlacements` by the map enrichment) render
 * through the existing pipeline exactly as designed:
 *  - palette: focused core + restrained rim (the moody ticket-17 falloff
 *    eased by ticket 30 so the glow is a backdrop for the over-composite
 *    motes — corePower 3.4 / haloFrac 0.44, was 4.2/0.50 at ticket 17, was
 *    3.2/0.70 at ticket 01, was 2.6/0.85 at ticket 04), no flicker (the `pulse`
 *    flag breathes it — a beacon does not gutter);
 *  - hero override: radius ≥ 512 fallback (in-game placements carry the
 *    per-tier overrides) with intensity in the authored [2.45, 2.6] band —
 *    equal-top of every static kind with the widest radius, below the
 *    explosion VFX band, so the player/VFX value band stays supreme;
 *  - wash-reduction gate: pure-falloff math proving the retuned disk stops
 *    washing the tiles beneath (mid-disk, super-albedo radius, peak caps);
 *  - prop: the NEUTRAL crystal frame (tints cleanly to the theme hue via the
 *    per-placement `color` override).
 */
describe('Beacon light kind (map-redesign ticket 04 + map-polish tickets 01/17)', () => {
  it('resolves a focused moody palette entry (tight core, restrained rim)', () => {
    const beacon = resolveLightKind('beacon');
    // Map-polish ticket 17 (round 2 — "kill the wash"): ticket-01's 3.2/0.70
    // was still halo-dominant (mid-disk atten 1.19 kept the bloom bright-pass
    // engaged out to ≈200px — one big white-blue bloom). Re-cut core-dominant:
    // the beacon is a destination marker read from DISTANCE (a lighthouse,
    // not a hearth).
    // Map-polish ticket 30 (round 3 — the motes wash): the motes moved ABOVE
    // the composite, so the glow must read as a BACKDROP, not a white-out.
    // Ticket 17's 4.2 core saturated the core into a white-ish blob (peak
    // atten 3.9); eased to 3.4/0.44 (peak 3.74, −21%) while every ticket-17
    // anti-wash gate below still holds. Old A/B baselines: 2.6/0.85/20
    // (ticket 04, the wash driver) → 3.2/0.70/16 (ticket 01) → 4.2/0.50/16
    // (ticket 17) → 3.4/0.44/16 (ticket 30).
    expect(beacon.corePower).toBe(3.4); // was 4.2 (ticket 17), was 3.2, was 2.6 — glow as backdrop
    expect(beacon.haloFrac).toBe(0.44); // was 0.50 (ticket 17), was 0.70, was 0.85
    expect(beacon.specPower).toBe(16.0); // was 20.0 (ticket 01 — unchanged since)
    expect(beacon.blend).toBe('add');
  });

  it('hero override: radius ≥ 512, intensity inside the authored band, no flicker', () => {
    const hero = HERO_LIGHT_OVERRIDES.beacon;
    expect(hero).toBeDefined();
    expect(hero!.radius).toBeGreaterThanOrEqual(BEACON_RADIUS);
    expect(hero!.intensity).toBeGreaterThanOrEqual(BEACON_INTENSITY_MIN);
    expect(hero!.intensity).toBeLessThanOrEqual(BEACON_INTENSITY_MAX);
    expect(hero!.flicker).toBe(false);
  });

  it('beacon is at least as bright as every other STATIC light kind', () => {
    // "Brightest static light in its sector": the fallback intensity must be
    // ≥ every other static kind's override/fallback intensity (campfire +
    // fireplace peak at 2.6). Dynamic VFX (explosions ~4) stay above.
    const beaconIntensity = HERO_LIGHT_OVERRIDES.beacon!.intensity;
    for (const key of Object.keys(LIGHT_PALETTE) as Array<keyof typeof LIGHT_PALETTE>) {
      if (key === 'beacon' || key === 'aura' || key === 'fire' || key === 'poison') continue;
      const other = HERO_LIGHT_OVERRIDES[key]?.intensity ?? 1.9; // DEFAULT_HERO_LIGHT
      expect(beaconIntensity).toBeGreaterThanOrEqual(other);
    }
  });

  it('wiring audit: the client override mirror agrees with the shared constants', () => {
    // The three beacon radius/intensity sites must hold identical values:
    // shared `landmarks.ts` (source of truth), the client fallback here, and
    // the server `KIND_DEFAULT_LIGHT` mirror (asserted against the same
    // shared constants in LightingDiscipline.test.ts). A drift would desync
    // the fallback-rendered light from the discipline gate.
    expect(HERO_LIGHT_OVERRIDES.beacon!.radius).toBe(BEACON_RADIUS);
    expect(HERO_LIGHT_OVERRIDES.beacon!.intensity).toBe(BEACON_INTENSITY_MAX);
  });

  it('wash-reduction gate: the retuned falloff stops washing tiles beneath (pure math)', () => {
    // Mirrors the hdrLit tier-2+ falloff (shaders/lighting/hdrLit.frag):
    //   t = 1 - dist/radius;  atten = (t^corePower + smoothstep(t)*haloFrac) * intensity
    const smoothstep = (t: number): number => t * t * (3 - 2 * t);
    const beaconAttent = (
      t: number,
      params: { corePower: number; haloFrac: number; intensity: number },
    ): number =>
      (Math.pow(t, params.corePower) + smoothstep(t) * params.haloFrac) * params.intensity;

    const entry = resolveLightKind('beacon');
    // NEW (map-polish ticket 30): ticket-17 falloff eased for the backdrop
    // role + the shared HOT tier.
    const next = {
      corePower: entry.corePower,
      haloFrac: entry.haloFrac,
      intensity: BEACON_TIER_LIGHT.HOT.intensity,
    };
    // OLD (map-redesign ticket 04) A/B baseline: the wash driver.
    const old = { corePower: 2.6, haloFrac: 0.85, intensity: 2.8 };
    // PREVIOUS (map-polish ticket 01) A/B baseline: still halo-dominant —
    // mid-disk 1.19 kept the bloom bright-pass engaged (ticket 17's driver).
    const prev = { corePower: 3.2, haloFrac: 0.7, intensity: 2.6 };

    // (a) mid-disk wash: t=0.5 atten ≤ 0.75 × the OLD HOT baseline (≈1.65 —
    // the value that lifted max-band floor tiles into the WALL value band).
    const oldMidDisk = beaconAttent(0.5, old);
    expect(oldMidDisk).toBeCloseTo(1.65, 2);
    expect(beaconAttent(0.5, next)).toBeLessThanOrEqual(0.75 * oldMidDisk);
    // Ticket 17 addition: the mid must also drop vs the ticket-01 falloff —
    // the bloom-engagement driver (atten ≳1.7 lights the bright-pass).
    expect(beaconAttent(0.5, next)).toBeLessThanOrEqual(0.7 * beaconAttent(0.5, prev));

    // (b) the "super-albedo" radius (light alone ≥ full albedo brightness,
    // atten ≥ 1) ≤ 2.4 tiles (≤ 307px). atten is monotonically increasing in
    // t, so bisect for the lowest t where atten ≥ 1 and convert via the hero
    // radius (the Citadel's 576 shares the same t at the same 2.6 intensity).
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (beaconAttent(mid, next) >= 1) hi = mid;
      else lo = mid;
    }
    const superAlbedoPx = (1 - hi) * BEACON_RADIUS;
    expect(superAlbedoPx).toBeLessThanOrEqual(307);

    // (c) peak core atten (disk center, t=1, pulse max) ≤ 4.5 — still the
    // brightest static kind, but under the sanity cap.
    expect(beaconAttent(1, next)).toBeLessThanOrEqual(4.5);

    // (d) ticket 17 — the bloom-engagement radius: the bright-pass
    // (threshold 0.55) engages wherever the light pushes a gold-tinted floor
    // tile (albedo·color·diff ≈ 0.32 of atten) past luma 0.55, i.e.
    // atten ≳ 1.7. Bisect that t; the radius must sit INSIDE the inner disk
    // (≤ 0.75 tiles = 96px + the crystal's own reach) so the bloom reads as a
    // tight halo around the crystal, not a regional wash.
    lo = 0;
    hi = 1;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (beaconAttent(mid, next) >= 1.7) hi = mid;
      else lo = mid;
    }
    expect((1 - hi) * BEACON_RADIUS).toBeLessThanOrEqual(160);
  });

  it('prop fixture: the NEUTRAL crystal frame (tints cleanly per tier)', () => {
    expect(resolveLightPropTexture('beacon')).toEqual({
      atlas: 'lightProps',
      frame: 'biome-crystal_01',
    });
    expect(LIGHT_PROP_TEXTURES.beacon).toBeDefined();
    // The crystal's bright core sits at the cell center — no vertical raise.
    expect(lightPropYOffset('beacon')).toBe(0);
  });
});

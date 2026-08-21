import { describe, it, expect, vi } from 'vitest';

// The render-order contract block imports the world-capture predicate from
// LightingAlbedoRtBuilder — which imports ALBEDO_RT_KEY (a value) from
// LightingPipeline.js, whose construction graph is WebGL-only (Phaser boots a
// canvas at module scope — impossible under jsdom). Mocking that one module
// keeps this suite Phaser-free (the registry-test pattern,
// LightingWorldCaptureRegistry.test.ts).
vi.mock('../../lighting/LightingPipeline.js', () => ({ ALBEDO_RT_KEY: '__albedoRT' }));

import {
  BEACON_RADIUS,
  BEACON_THEME_LIGHT,
  BEACON_TIER_LIGHT,
  CITADEL_BEACON_RADIUS,
  SectorType,
  type LandmarkAssignment,
  type LightPlacementTiled,
} from '@sector-battle/shared';
import { DesignTokens } from '../../../ui/DesignTokens.js';
import {
  excludeFromWorldLightCapture,
  passesWorldCaptureFilter,
} from '../../lighting/LightingAlbedoRtBuilder.js';
import {
  BOB_AMPLITUDE_MAX,
  BOB_AMPLITUDE_MIN,
  BOB_FREQ_MAX,
  BOB_FREQ_MIN,
  HERO_ANCHOR_COUNT,
  MAX_ANCHORS,
  MAX_TOTAL_MOTES,
  MOTES_PER_BEACON,
  MOTE_ALPHA_MAX,
  MOTE_ALPHA_MIN,
  MOTE_PARAM_STRIDE,
  MOTE_SIZE_MAX,
  MOTE_SIZE_MIN,
  MOTE_TINT_BRIGHTEN,
  ORBIT_RADIUS_MAX,
  ORBIT_RADIUS_MIN,
  ORBIT_SPEED_MAX,
  ORBIT_SPEED_MIN,
  TAU,
  collectBeaconAnchors,
  fillMoteParams,
  findFortressBeaconPlacement,
  moteAlpha,
  moteBobAmplitude,
  moteBobFreq,
  moteBobPhase,
  moteHash01,
  moteOrbitRadius,
  motePhase,
  moteSize,
  moteSpeed,
  moteTint,
  moteTintWith,
  type BeaconAnchorSpec,
} from '../BeaconMotesConfig.js';
import {
  ACCENT_TINT_BRIGHTEN,
  CULL_MARGIN,
  DUST_ALPHA_MAX,
  DUST_ALPHA_MIN,
  DUST_BOB_AMPLITUDE_MAX,
  DUST_BOB_AMPLITUDE_MIN,
  DUST_BOB_FREQ_MAX,
  DUST_BOB_FREQ_MIN,
  DUST_ORBIT_RADIUS_MAX,
  DUST_ORBIT_RADIUS_MIN,
  DUST_ORBIT_SPEED_MAX,
  DUST_ORBIT_SPEED_MIN,
  DUST_PER_BEACON,
  DUST_SIZE_MAX,
  DUST_SIZE_MIN,
  DUST_TINT_BRIGHTEN,
  DUST_TOTAL_MOTES,
  EMBER_ALPHA_PEAK,
  EMBER_HEAD_SIZE,
  EMBER_LIFE_FRACTION,
  EMBER_PERIOD_MAX,
  EMBER_PERIOD_MIN,
  EMBER_RADIUS_END,
  EMBER_RISE,
  EMBER_TRAIL_SEGMENTS,
  RING_ALPHA_PEAK,
  RING_FADE_IN,
  RING_PERIOD_MAX,
  RING_PERIOD_MIN,
  RING_RADIUS_MAX,
  RING_WIDTH,
  dustAlpha,
  dustBobAmplitude,
  dustBobFreq,
  dustBobPhase,
  dustOrbitRadius,
  dustPhase,
  dustSize,
  dustSpeed,
  emberAlpha,
  emberLifeProgress,
  emberLifeSeconds,
  emberPeriod,
  emberPointAt,
  evalPulseRing,
  fillDustParams,
  isAnchorInView,
  type EmberPoint,
  type RingEval,
} from '../BeaconMotesTiers.js';

/**
 * Map-polish tickets 02 + 17 — the beacon particle system's pure regression
 * guard (the `LightingAtmosphere` Seam-A pattern: assert the Phaser-free
 * config/tier modules' tuning bands, determinism, spread, budget/subtlety
 * gates, tint contract, closed-form accents and the culling predicate
 * WITHOUT booting Phaser).
 *
 * Determinism contract (ADR-0035): the particles consume NO RNG stream —
 * every per-particle parameter is a pure hash of `(tileX, tileY, index,
 * salt)`, and the accents (pulse ring + ember streak) are CLOSED-FORM
 * functions of `(tileX, tileY, elapsed)` — so the same map draws the
 * identical composition on every client.
 */

// ─── Synthetic synced map data (the exact wire shapes) ───────────────────────

const THEME_ORDER = [
  SectorType.GRID_ARENA,
  SectorType.OPEN_ARENA,
  SectorType.MAZE,
  SectorType.RESOURCE_RICH,
] as const;

/** Full 4×4 hero grid — theme-keyed beacon colors, tiles 20 apart (sector grid). */
function fullLandmarks(): LandmarkAssignment {
  const heroes = [];
  for (let row = 0; row < 4; row++) {
    const rowHeroes = [];
    for (let col = 0; col < 4; col++) {
      rowHeroes.push({
        compositionId: `comp-${row}-${col}`,
        rarity: 'common' as const,
        tileX: col * 20 + 10,
        tileY: row * 20 + 10,
        beacon: {
          color: BEACON_THEME_LIGHT[THEME_ORDER[(row * 4 + col) % 4]!].color,
          intensity: BEACON_TIER_LIGHT.WARM.intensity,
          radius: BEACON_RADIUS,
        },
      });
    }
    heroes.push(rowHeroes);
  }
  return {
    heroes,
    minors: [
      {
        // (propId was removed from MinorLandmark by map-polish ticket 29.)
        tileX: 19,
        tileY: 19,
        light: { color: [0.72, 0.78, 0.92] as const, intensity: 1.0, radius: 176 },
      },
    ],
  };
}

function beaconPlacement(
  gridX: number,
  gridY: number,
  pulse: boolean,
  radius: number,
  color: readonly [number, number, number],
): LightPlacementTiled {
  return {
    gridX,
    gridY,
    kind: 'beacon',
    color,
    radius,
    intensity: BEACON_TIER_LIGHT.WARM.intensity,
    pulse,
    rotation: 0,
    flipH: false,
    flipV: false,
  };
}

/** The synced placements the adapter appends: 16 hero + 2 minors + 1 Citadel fortress. */
function fullPlacements(): LightPlacementTiled[] {
  const landmarks = fullLandmarks();
  const placements: LightPlacementTiled[] = [];
  for (const row of landmarks.heroes) {
    for (const hero of row) {
      placements.push(
        beaconPlacement(hero.tileX, hero.tileY, true, BEACON_RADIUS, hero.beacon.color),
      );
    }
  }
  // Minor markers: steady (pulse false) — a junction node is not a destination.
  placements.push(beaconPlacement(19, 19, false, 176, [0.72, 0.78, 0.92]));
  placements.push(beaconPlacement(59, 59, false, 176, [0.72, 0.78, 0.92]));
  // The one fortress beacon (Citadel vault — RARE violet, radius beyond every hero).
  placements.push(
    beaconPlacement(37, 37, true, CITADEL_BEACON_RADIUS, BEACON_TIER_LIGHT.RARE.color),
  );
  return placements;
}

/** The canonical 17 anchors (16 hero + 1 fortress) with their FINAL colors. */
function canonicalAnchors(): BeaconAnchorSpec[] {
  const landmarks = fullLandmarks();
  return collectBeaconAnchors(landmarks, findFortressBeaconPlacement(landmarks, fullPlacements()));
}

// ─── Tuning band — INNER SPARKS (ticket 02 bands, retuned ticket 17) ─────────

describe('BeaconMotesConfig — spark tuning band (tickets 02 + 17)', () => {
  it('pins the spark-tier tuning constants', () => {
    expect(MOTES_PER_BEACON).toBe(10);
    expect(HERO_ANCHOR_COUNT).toBe(16);
    expect(MAX_ANCHORS).toBe(17); // 16 hero + 1 fortress
    expect(MAX_TOTAL_MOTES).toBe(170); // ≤ ~170 sparks map-wide
    expect(ORBIT_RADIUS_MIN).toBe(64); // 0.5 tile
    expect(ORBIT_RADIUS_MAX).toBe(128); // 1 tile
    expect(ORBIT_SPEED_MIN).toBe(0.05); // rad/s — full orbit ≈2.1 min
    expect(ORBIT_SPEED_MAX).toBe(0.12); // rad/s — full orbit ≈52 s
    expect(BOB_AMPLITUDE_MIN).toBe(4);
    expect(BOB_AMPLITUDE_MAX).toBe(8);
    expect(BOB_FREQ_MIN).toBe(0.2);
    expect(BOB_FREQ_MAX).toBe(0.45);
    // Ticket 17 retune: the sparks must READ against the glow (was 1–2.5 px,
    // 0.12–0.30 alpha — the "too subtle, washed out" verdict). Ticket 30
    // (above-composite): the band re-pins for the premultiplied slot-0
    // composite — effective presence = α², so 0.55–0.95 reads as 0.30–0.90.
    expect(MOTE_SIZE_MIN).toBe(2.5);
    expect(MOTE_SIZE_MAX).toBe(4.5);
    expect(MOTE_ALPHA_MIN).toBe(0.55);
    expect(MOTE_ALPHA_MAX).toBe(0.95);
    expect(MOTE_TINT_BRIGHTEN).toBe(0.6); // was 0.30 (ticket 02) → 0.45 (ticket 17) — ticket 30: whiter for the over-composite lerp
  });

  it('orbit period stays inside the ≈1–2 minute band at both speed extremes', () => {
    expect(TAU / ORBIT_SPEED_MAX).toBeGreaterThanOrEqual(50); // ≈0.9 min
    expect(TAU / ORBIT_SPEED_MIN).toBeLessThanOrEqual(130); // ≈2.1 min
  });
});

// ─── Tuning band — OUTER DUST + ACCENTS (ticket 17) ──────────────────────────

describe('BeaconMotesTiers — dust + accent tuning bands (ticket 17)', () => {
  it('pins the outer-dust tier constants (slower, larger, fainter)', () => {
    expect(DUST_PER_BEACON).toBe(12);
    expect(DUST_TOTAL_MOTES).toBe(204); // 17 × 12
    expect(DUST_ORBIT_RADIUS_MIN).toBe(160); // 1.25 tiles — out in the mid falloff
    expect(DUST_ORBIT_RADIUS_MAX).toBe(288); // 2.25 tiles
    expect(DUST_ORBIT_SPEED_MIN).toBe(0.015); // rad/s — full drift ≈7 min
    expect(DUST_ORBIT_SPEED_MAX).toBe(0.04); // rad/s — full drift ≈2.6 min
    expect(DUST_BOB_AMPLITUDE_MIN).toBe(6);
    expect(DUST_BOB_AMPLITUDE_MAX).toBe(14);
    expect(DUST_BOB_FREQ_MIN).toBe(0.08);
    expect(DUST_BOB_FREQ_MAX).toBe(0.2);
    expect(DUST_SIZE_MIN).toBe(3.5); // reaches larger than every spark (max 4.5)
    expect(DUST_SIZE_MAX).toBe(8);
    // Ticket 30: slot-0 draw band — √-compensated so the QUADRATIC premultiplied
    // composite (effective presence = α²) lands on the intended 0.10–0.20.
    expect(DUST_ALPHA_MIN).toBe(0.32);
    expect(DUST_ALPHA_MAX).toBe(0.45);
    expect(DUST_TINT_BRIGHTEN).toBe(0.15); // more saturated than the sparks (0.6)
  });

  it('pins the pulse-ring accent constants (rare, bounded, inside the glow)', () => {
    expect(RING_PERIOD_MIN).toBe(8);
    expect(RING_PERIOD_MAX).toBe(13);
    expect(RING_RADIUS_MAX).toBe(320); // 2.5 tiles — inside the 512px light disk
    // Ticket 30: √-compensated for the quadratic slot-0 composite (0.45² ≈
    // 0.20 effective — the owner's "only the ring is noticeable" stays true).
    expect(RING_ALPHA_PEAK).toBe(0.45);
    expect(RING_WIDTH).toBe(2.5);
    expect(RING_FADE_IN).toBeGreaterThan(0);
    expect(RING_FADE_IN).toBeLessThan(1);
  });

  it('pins the ember-streak accent constants (rare, rises, bounded)', () => {
    expect(EMBER_PERIOD_MIN).toBe(11);
    expect(EMBER_PERIOD_MAX).toBe(16);
    expect(EMBER_LIFE_FRACTION).toBeGreaterThan(0.05); // alive ≈1.5–2.2 s — rare
    expect(EMBER_LIFE_FRACTION).toBeLessThan(0.25);
    expect(EMBER_RADIUS_END).toBe(240);
    expect(EMBER_RADIUS_END).toBeLessThan(RING_RADIUS_MAX); // the ember stays inside the ring's reach
    expect(EMBER_RISE).toBe(40); // embers rise
    // Ticket 30: √-compensated slot-0 peak (0.7² ≈ 0.49 effective) + the head
    // dot raised with the spark band (2.5–4.5 px).
    expect(EMBER_ALPHA_PEAK).toBe(0.7);
    expect(EMBER_HEAD_SIZE).toBe(2.2);
    expect(EMBER_TRAIL_SEGMENTS).toBe(6);
    // Ticket 30: raised with the spark band (0.6) so accents stay the
    // WHITEST derivation — the monotone tint contract holds.
    expect(ACCENT_TINT_BRIGHTEN).toBe(0.65);
  });

  it('tier ordering: sparks bright+small, dust fainter+larger, accents rare', () => {
    // Dust is fainter AND reaches larger sizes than the sparks — the two tiers
    // never compete for the same read (bright glints vs colored haze).
    // Ticket 30: the size BANDS now overlap (sparks 2.5–4.5, dust 3.5–8 — the
    // over-composite sparks carry a confident dot), so the ordering gate is at
    // the MAX level: the dust tier still reaches beyond every spark.
    expect(DUST_ALPHA_MAX).toBeLessThan(MOTE_ALPHA_MIN);
    expect(DUST_SIZE_MAX).toBeGreaterThan(MOTE_SIZE_MAX);
    // Accents are the rarest layer by construction: one ring + one ember per
    // multi-second period vs 22 continuously-orbiting motes.
    expect(RING_PERIOD_MIN).toBeGreaterThan(5);
    expect(EMBER_PERIOD_MIN).toBeGreaterThan(5);
  });
});

// ─── Determinism (ADR-0035) ──────────────────────────────────────────────────

describe('BeaconMotes — determinism (ADR-0035 stream contract)', () => {
  it('same (tileX,tileY,index) ⇒ identical spark parameters on every call', () => {
    for (const [x, y] of [
      [10, 10],
      [37, 37],
      [52, 13],
    ] as const) {
      for (let i = 0; i < MOTES_PER_BEACON; i++) {
        expect(motePhase(x, y, i)).toBe(motePhase(x, y, i));
        expect(moteOrbitRadius(x, y, i)).toBe(moteOrbitRadius(x, y, i));
        expect(moteSpeed(x, y, i)).toBe(moteSpeed(x, y, i));
        expect(moteAlpha(x, y, i)).toBe(moteAlpha(x, y, i));
        expect(moteSize(x, y, i)).toBe(moteSize(x, y, i));
        expect(moteBobAmplitude(x, y, i)).toBe(moteBobAmplitude(x, y, i));
        expect(moteBobPhase(x, y, i)).toBe(moteBobPhase(x, y, i));
        expect(moteBobFreq(x, y, i)).toBe(moteBobFreq(x, y, i));
      }
    }
  });

  it('same (tileX,tileY,index) ⇒ identical dust parameters on every call', () => {
    for (const [x, y] of [
      [10, 10],
      [37, 37],
    ] as const) {
      for (let i = 0; i < DUST_PER_BEACON; i++) {
        expect(dustPhase(x, y, i)).toBe(dustPhase(x, y, i));
        expect(dustOrbitRadius(x, y, i)).toBe(dustOrbitRadius(x, y, i));
        expect(dustSpeed(x, y, i)).toBe(dustSpeed(x, y, i));
        expect(dustAlpha(x, y, i)).toBe(dustAlpha(x, y, i));
        expect(dustSize(x, y, i)).toBe(dustSize(x, y, i));
        expect(dustBobAmplitude(x, y, i)).toBe(dustBobAmplitude(x, y, i));
        expect(dustBobPhase(x, y, i)).toBe(dustBobPhase(x, y, i));
        expect(dustBobFreq(x, y, i)).toBe(dustBobFreq(x, y, i));
      }
    }
  });

  it('fillMoteParams/fillDustParams are byte-identical across invocations (same map ⇒ same halo)', () => {
    const a = new Float64Array(MOTES_PER_BEACON * MOTE_PARAM_STRIDE);
    const b = new Float64Array(MOTES_PER_BEACON * MOTE_PARAM_STRIDE);
    fillMoteParams(13, 42, a);
    fillMoteParams(13, 42, b);
    expect(Array.from(a)).toEqual(Array.from(b));
    // Different anchor ⇒ different layout (the hash actually keys on the tile).
    fillMoteParams(14, 42, b);
    expect(Array.from(a)).not.toEqual(Array.from(b));

    const da = new Float64Array(DUST_PER_BEACON * MOTE_PARAM_STRIDE);
    const db = new Float64Array(DUST_PER_BEACON * MOTE_PARAM_STRIDE);
    fillDustParams(13, 42, da);
    fillDustParams(13, 42, db);
    expect(Array.from(da)).toEqual(Array.from(db));
    fillDustParams(14, 42, db);
    expect(Array.from(da)).not.toEqual(Array.from(db));
  });

  it('moteHash01 returns values in [0,1) and is pure', () => {
    for (let i = 0; i < 200; i++) {
      const v = moteHash01(i, i * 7, i % MOTES_PER_BEACON, 0x9e3779b9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(moteHash01(i, i * 7, i % MOTES_PER_BEACON, 0x9e3779b9));
    }
  });

  it('the closed-form accents are pure: same (tile,time) ⇒ same evaluation', () => {
    const r1: RingEval = { radius: -1, alpha: -1 };
    const r2: RingEval = { radius: -1, alpha: -1 };
    const e1: EmberPoint = { dx: -1, dy: -1 };
    const e2: EmberPoint = { dx: -1, dy: -1 };
    for (const t of [0, 1.5, 7.25, 60, 600.5]) {
      evalPulseRing(37, 37, t, r1);
      evalPulseRing(37, 37, t, r2);
      expect(r1.radius).toBe(r2.radius);
      expect(r1.alpha).toBe(r2.alpha);
      emberPointAt(37, 37, 0.5, e1);
      emberPointAt(37, 37, 0.5, e2);
      expect(e1.dx).toBe(e2.dx);
      expect(e1.dy).toBe(e2.dy);
      expect(emberLifeProgress(37, 37, t)).toBe(emberLifeProgress(37, 37, t));
    }
  });

  it('the accents stay inside their envelopes at every evaluation instant', () => {
    const ring: RingEval = { radius: 0, alpha: 0 };
    const ember: EmberPoint = { dx: 0, dy: 0 };
    // A dense sweep over 3 anchors × 10 minutes: the ring never exceeds its
    // reach/peak, the ember never leaves its radius+rise envelope.
    for (const [x, y] of [
      [10, 10],
      [37, 37],
      [50, 30],
    ] as const) {
      for (let t = 0; t < 600; t += 0.05) {
        evalPulseRing(x, y, t, ring);
        expect(ring.radius).toBeGreaterThanOrEqual(0);
        expect(ring.radius).toBeLessThanOrEqual(RING_RADIUS_MAX);
        expect(ring.alpha).toBeGreaterThanOrEqual(0);
        expect(ring.alpha).toBeLessThanOrEqual(RING_ALPHA_PEAK);
        const q = emberLifeProgress(x, y, t);
        if (q >= 0) {
          expect(q).toBeLessThan(1);
          emberPointAt(x, y, q, ember);
          const dist = Math.hypot(ember.dx, ember.dy);
          expect(dist).toBeLessThanOrEqual(EMBER_RADIUS_END + EMBER_RISE + EMBER_HEAD_SIZE);
          expect(emberAlpha(q)).toBeLessThanOrEqual(EMBER_ALPHA_PEAK);
        }
      }
    }
  });

  it('the accents are RARE: the ember is alive ≈EMBER_LIFE_FRACTION of the time, the ring breathes from zero', () => {
    // Ember duty cycle over a 600 s dense sweep per anchor — the statistical
    // pin that the streak is a rare accent, not a permanent fixture.
    for (const [x, y] of [
      [10, 10],
      [37, 37],
    ] as const) {
      expect(emberPeriod(x, y)).toBeGreaterThanOrEqual(EMBER_PERIOD_MIN);
      expect(emberPeriod(x, y)).toBeLessThanOrEqual(EMBER_PERIOD_MAX);
      expect(emberLifeSeconds(x, y)).toBeCloseTo(emberPeriod(x, y) * EMBER_LIFE_FRACTION, 10);
      let alive = 0;
      let samples = 0;
      for (let t = 0; t < 600; t += 0.05) {
        if (emberLifeProgress(x, y, t) >= 0) alive++;
        samples++;
      }
      expect(alive / samples).toBeGreaterThan(EMBER_LIFE_FRACTION - 0.02);
      expect(alive / samples).toBeLessThan(EMBER_LIFE_FRACTION + 0.02);
    }
    // Ring birth/death: the alpha envelope fades to (near) zero at BOTH ends
    // of every cycle (fade-in at birth p→0, full fade at max reach p→1), so a
    // dense sweep over ≥1 period always finds near-invisible instants, and
    // mid-cycle it rises to most of the peak (at p = RING_FADE_IN it holds
    // (1−0.12)·peak ≈ 0.88·peak). This is the "breathes, no hard pop" pin.
    const ring: RingEval = { radius: 0, alpha: 0 };
    let minAlpha = Infinity;
    let maxAlpha = 0;
    for (let t = 0; t < RING_PERIOD_MAX + 1; t += 0.02) {
      evalPulseRing(10, 10, t, ring);
      minAlpha = Math.min(minAlpha, ring.alpha);
      maxAlpha = Math.max(maxAlpha, ring.alpha);
    }
    expect(minAlpha).toBeLessThan(RING_ALPHA_PEAK * 0.02); // invisible slice exists
    expect(maxAlpha).toBeGreaterThan(RING_ALPHA_PEAK * 0.8); // and it clearly reads
    expect(RING_FADE_IN).toBeGreaterThan(0);
  });

  it('source audit: the particle CODE contains NO Math.random / RNG draws', () => {
    // Audit the code, not the prose: strip block/line comments first (the
    // modules' docstrings deliberately SAY "NO Math.random" — the contract).
    const fs = require('node:fs') as typeof import('fs');
    const path = require('node:path') as typeof import('path');
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const cfgSrc = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'BeaconMotesConfig.ts'), 'utf8'),
    );
    const tiersSrc = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'BeaconMotesTiers.ts'), 'utf8'),
    );
    const vfxSrc = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'BeaconMotesVFX.ts'), 'utf8'),
    );
    expect(cfgSrc).not.toMatch(/Math\.random|\brandom\(\)|SeededRNG|avalanche\(/);
    expect(tiersSrc).not.toMatch(/Math\.random|\brandom\(\)|SeededRNG|avalanche\(/);
    expect(vfxSrc).not.toMatch(/Math\.random|\brandom\(\)|SeededRNG|avalanche\(/);
  });
});

// ─── Parameter spread ────────────────────────────────────────────────────────

describe('BeaconMotes — parameter spread (adjacent beacons never sync)', () => {
  it('the 10 sparks of one beacon have distinct phases/radii/speeds', () => {
    const phases = new Set<number>();
    const radii = new Set<number>();
    const speeds = new Set<number>();
    for (let i = 0; i < MOTES_PER_BEACON; i++) {
      phases.add(motePhase(10, 10, i));
      radii.add(moteOrbitRadius(10, 10, i));
      speeds.add(moteSpeed(10, 10, i));
    }
    expect(phases.size).toBe(MOTES_PER_BEACON);
    expect(radii.size).toBe(MOTES_PER_BEACON);
    expect(speeds.size).toBe(MOTES_PER_BEACON);
  });

  it('the 12 dust motes of one beacon have distinct phases/radii (and never sync with the sparks)', () => {
    const phases = new Set<number>();
    const radii = new Set<number>();
    for (let i = 0; i < DUST_PER_BEACON; i++) {
      phases.add(dustPhase(10, 10, i));
      radii.add(dustOrbitRadius(10, 10, i));
    }
    expect(phases.size).toBe(DUST_PER_BEACON);
    expect(radii.size).toBe(DUST_PER_BEACON);
    // Dust phase i never equals spark phase i (different salts).
    for (let i = 0; i < MOTES_PER_BEACON; i++) {
      expect(dustPhase(10, 10, i)).not.toBe(motePhase(10, 10, i));
    }
  });

  it('mote-0 phases across the 17 anchors: ≥16 distinct values, spread ≥ π', () => {
    const anchors = canonicalAnchors();
    const phases = anchors.map((a) => motePhase(a.tileX, a.tileY, 0));
    expect(new Set(phases).size).toBeGreaterThanOrEqual(16);
    expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThanOrEqual(Math.PI);
  });

  it('tile-adjacent anchors never share a phase (no synced halos)', () => {
    // Every anchor vs its 4 neighbors at Manhattan 1: never exactly synced, and
    // the overwhelming majority differ by a visible margin (> 0.1 rad ≈ 6°).
    // Uniform phases give P(delta < 0.1 rad) ≈ 3.2% per pair, so a per-pair
    // gate would over-pin; the ≤10%-of-pairs aggregate is the honest bound.
    const tiles: Array<[number, number]> = [];
    for (const a of canonicalAnchors()) tiles.push([a.tileX, a.tileY]);
    tiles.push([30, 30]);
    let pairs = 0;
    let tiny = 0;
    for (const [x, y] of tiles) {
      const base = motePhase(x, y, 0);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        const delta = Math.abs(motePhase(nx, ny, 0) - base);
        expect(delta).toBeGreaterThan(0.001); // never exactly synced
        pairs++;
        if (delta < 0.1) tiny++;
      }
    }
    expect(tiny / pairs).toBeLessThan(0.1); // ≥90% of neighbor pairs differ visibly
  });
});

// ─── Budget + band gates ─────────────────────────────────────────────────────

describe('BeaconMotes — budget + band gates (pure)', () => {
  it('a full map is exactly 17 anchors × (10 sparks + 12 dust) ≤ the budgets', () => {
    const anchors = canonicalAnchors();
    expect(anchors).toHaveLength(17);
    expect(anchors.length * MOTES_PER_BEACON).toBeLessThanOrEqual(MAX_TOTAL_MOTES);
    expect(anchors.length * DUST_PER_BEACON).toBeLessThanOrEqual(DUST_TOTAL_MOTES);
  });

  it('every spark of the full map sits inside the alpha/size/speed/bob bands', () => {
    const anchors = canonicalAnchors();
    for (const a of anchors) {
      for (let i = 0; i < MOTES_PER_BEACON; i++) {
        expect(moteAlpha(a.tileX, a.tileY, i)).toBeLessThanOrEqual(MOTE_ALPHA_MAX); // ≤ 0.95
        expect(moteAlpha(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(MOTE_ALPHA_MIN);
        expect(moteSize(a.tileX, a.tileY, i)).toBeLessThanOrEqual(MOTE_SIZE_MAX); // ≤ 4.5 px
        expect(moteSize(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(MOTE_SIZE_MIN);
        expect(moteSpeed(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(ORBIT_SPEED_MIN);
        expect(moteSpeed(a.tileX, a.tileY, i)).toBeLessThanOrEqual(ORBIT_SPEED_MAX); // slow orbit, never a swarm
        expect(moteOrbitRadius(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(ORBIT_RADIUS_MIN);
        expect(moteOrbitRadius(a.tileX, a.tileY, i)).toBeLessThanOrEqual(ORBIT_RADIUS_MAX);
        expect(moteBobAmplitude(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(BOB_AMPLITUDE_MIN);
        expect(moteBobAmplitude(a.tileX, a.tileY, i)).toBeLessThanOrEqual(BOB_AMPLITUDE_MAX);
      }
    }
  });

  it('every dust mote of the full map sits inside its bands (faint + large + slow)', () => {
    const anchors = canonicalAnchors();
    for (const a of anchors) {
      for (let i = 0; i < DUST_PER_BEACON; i++) {
        expect(dustAlpha(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(DUST_ALPHA_MIN);
        expect(dustAlpha(a.tileX, a.tileY, i)).toBeLessThanOrEqual(DUST_ALPHA_MAX); // ≤ 0.45 slot-0 (≈0.20 effective — faint)
        expect(dustSize(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(DUST_SIZE_MIN);
        expect(dustSize(a.tileX, a.tileY, i)).toBeLessThanOrEqual(DUST_SIZE_MAX);
        expect(dustSpeed(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(DUST_ORBIT_SPEED_MIN);
        expect(dustSpeed(a.tileX, a.tileY, i)).toBeLessThanOrEqual(DUST_ORBIT_SPEED_MAX); // ≤ 0.04 — drift
        expect(dustOrbitRadius(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(DUST_ORBIT_RADIUS_MIN);
        expect(dustOrbitRadius(a.tileX, a.tileY, i)).toBeLessThanOrEqual(DUST_ORBIT_RADIUS_MAX);
        expect(dustBobAmplitude(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(
          DUST_BOB_AMPLITUDE_MIN,
        );
        expect(dustBobAmplitude(a.tileX, a.tileY, i)).toBeLessThanOrEqual(DUST_BOB_AMPLITUDE_MAX);
        expect(dustBobFreq(a.tileX, a.tileY, i)).toBeGreaterThanOrEqual(DUST_BOB_FREQ_MIN);
        expect(dustBobFreq(a.tileX, a.tileY, i)).toBeLessThanOrEqual(DUST_BOB_FREQ_MAX);
      }
    }
  });
});

// ─── Anchor derivation from the synced data ──────────────────────────────────

describe('BeaconMotesConfig — anchors derive from the synced MapData', () => {
  it('hero anchors carry the hero beacon color verbatim (theme-keyed, never tier)', () => {
    const anchors = canonicalAnchors();
    const heroes = fullLandmarks().heroes.flat();
    const heroAnchors = anchors.filter((a) =>
      heroes.some((h) => h.tileX === a.tileX && h.tileY === a.tileY),
    );
    expect(heroAnchors).toHaveLength(16);
    for (const a of heroAnchors) {
      const hero = heroes.find((h) => h.tileX === a.tileX && h.tileY === a.tileY)!;
      expect(a.color).toBe(hero.beacon.color);
    }
  });

  it('the fortress anchor is the pulsing non-hero beacon placement (RARE violet)', () => {
    const landmarks = fullLandmarks();
    const fortress = findFortressBeaconPlacement(landmarks, fullPlacements());
    expect(fortress).not.toBeNull();
    expect(fortress!.gridX).toBe(37);
    expect(fortress!.gridY).toBe(37);
    expect(fortress!.color).toBe(BEACON_TIER_LIGHT.RARE.color);
    // And it lands in the anchor list with that exact color.
    const anchors = collectBeaconAnchors(landmarks, fortress);
    const citadel = anchors.find((a) => a.tileX === 37 && a.tileY === 37);
    expect(citadel).toBeDefined();
    expect(citadel!.color).toBe(BEACON_TIER_LIGHT.RARE.color);
  });

  it('minor landmark markers are excluded (steady pulse false — junction markers)', () => {
    const landmarks = fullLandmarks();
    const fortress = findFortressBeaconPlacement(landmarks, fullPlacements());
    expect(fortress).not.toBeNull();
    const anchors = collectBeaconAnchors(landmarks, fortress);
    expect(anchors).toHaveLength(17); // 16 heroes + 1 fortress — no minors
    expect(anchors.some((a) => a.tileX === 19 && a.tileY === 19)).toBe(false);
    expect(anchors.some((a) => a.tileX === 59 && a.tileY === 59)).toBe(false);
  });

  it('no fortress placement (demo maps) ⇒ hero anchors only, no crash', () => {
    const landmarks = fullLandmarks();
    expect(findFortressBeaconPlacement(landmarks, [])).toBeNull();
    expect(findFortressBeaconPlacement(landmarks, undefined)).toBeNull();
    expect(collectBeaconAnchors(landmarks, null)).toHaveLength(16);
    expect(collectBeaconAnchors(null, null)).toHaveLength(0);
  });

  it('a hero-tile pulsing beacon is skipped (only the fortress remains)', () => {
    // A placement list containing ONLY hero beacons: none of them is the fortress.
    const landmarks = fullLandmarks();
    const heroOnly = landmarks.heroes
      .flat()
      .map((h) => beaconPlacement(h.tileX, h.tileY, true, BEACON_RADIUS, h.beacon.color));
    expect(findFortressBeaconPlacement(landmarks, heroOnly)).toBeNull();
  });
});

// ─── Tint contract (single derivation, per-tier brighten) ────────────────────

describe('BeaconMotes — tint derivation (beacon FINAL color, parameterized)', () => {
  const colors = [
    ...Object.values(BEACON_THEME_LIGHT).map((t) => t.color),
    BEACON_TIER_LIGHT.RARE.color, // the Citadel vault beacon
  ];

  it('moteTintWith lifts each channel exactly by the brighten fraction, for any fraction', () => {
    for (const c of colors) {
      for (const brighten of [0, 0.15, 0.3, 0.45, 0.55, 1]) {
        const tint = moteTintWith(c, brighten);
        const channels = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
        for (let k = 0; k < 3; k++) {
          expect(channels[k]).toBe(Math.round((c[k]! + (1 - c[k]!) * brighten) * 255));
        }
      }
    }
  });

  it('moteTint is the spark-tier derivation; every tier derives from the SAME color', () => {
    for (const c of colors) {
      expect(moteTint(c)).toBe(moteTintWith(c, MOTE_TINT_BRIGHTEN));
      // Monotone in brighten: dust (0.15) ≤ sparks (0.6) ≤ accents (0.65).
      const dust = moteTintWith(c, DUST_TINT_BRIGHTEN);
      const spark = moteTintWith(c, MOTE_TINT_BRIGHTEN);
      const accent = moteTintWith(c, ACCENT_TINT_BRIGHTEN);
      for (const tint of [dust, spark, accent]) {
        const ch = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
        for (let k = 0; k < 3; k++) {
          expect(ch[k]).toBeGreaterThanOrEqual(Math.round(c[k]! * 255)); // never dimmed
        }
      }
      expect(dust).toBeLessThanOrEqual(spark);
      expect(spark).toBeLessThanOrEqual(accent);
    }
  });
});

// ─── Camera-rect culling (union of every tier's reach) ───────────────────────

describe('BeaconMotesTiers — camera-rect culling (union, pure)', () => {
  const VIEW = { x: 1000, y: 1000, w: 1920, h: 1080 };

  it('CULL_MARGIN is exactly the farthest any tier can reach from its anchor', () => {
    const sparkReach = ORBIT_RADIUS_MAX + BOB_AMPLITUDE_MAX + MOTE_SIZE_MAX;
    const dustReach = DUST_ORBIT_RADIUS_MAX + DUST_BOB_AMPLITUDE_MAX + DUST_SIZE_MAX;
    const ringReach = RING_RADIUS_MAX + RING_WIDTH;
    const emberReach = EMBER_RADIUS_END + EMBER_RISE + EMBER_HEAD_SIZE;
    expect(CULL_MARGIN).toBe(Math.max(sparkReach, dustReach, ringReach, emberReach));
  });

  it('an anchor inside the view rect is visible', () => {
    expect(isAnchorInView(1960, 1540, VIEW.x, VIEW.y, VIEW.w, VIEW.h)).toBe(true);
  });

  it('an anchor exactly at the margin boundary is still visible (a particle can reach inward)', () => {
    expect(isAnchorInView(VIEW.x - CULL_MARGIN, 1540, VIEW.x, VIEW.y, VIEW.w, VIEW.h)).toBe(true);
    expect(
      isAnchorInView(VIEW.x + VIEW.w + CULL_MARGIN, 1540, VIEW.x, VIEW.y, VIEW.w, VIEW.h),
    ).toBe(true);
  });

  it('anchors outside the view rect + margin produce ZERO draw entries (all 4 sides)', () => {
    expect(isAnchorInView(VIEW.x - CULL_MARGIN - 1, 1540, VIEW.x, VIEW.y, VIEW.w, VIEW.h)).toBe(
      false,
    ); // left
    expect(
      isAnchorInView(VIEW.x + VIEW.w + CULL_MARGIN + 1, 1540, VIEW.x, VIEW.y, VIEW.w, VIEW.h),
    ).toBe(false); // right
    expect(isAnchorInView(1960, VIEW.y - CULL_MARGIN - 1, VIEW.x, VIEW.y, VIEW.w, VIEW.h)).toBe(
      false,
    ); // top
    expect(
      isAnchorInView(1960, VIEW.y + VIEW.h + CULL_MARGIN + 1, VIEW.x, VIEW.y, VIEW.w, VIEW.h),
    ).toBe(false); // bottom
  });
});

// ─── Wiring + value-band audit (source grep — "wiring is implementation") ────

describe('BeaconMotesVFX — wiring + value-band audit (source grep)', () => {
  const fs = require('node:fs') as typeof import('fs');
  const path = require('node:path') as typeof import('path');
  const vfxSrc = fs.readFileSync(path.join(__dirname, '..', 'BeaconMotesVFX.ts'), 'utf8');
  const setupSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'GameSceneSetup.ts'),
    'utf8',
  );

  it('GameSceneSetup constructs, feeds and destroys the motes (construct/update/destroy wiring)', () => {
    expect(setupSrc).toMatch(/new BeaconMotesVFX\(scene\)/); // constructed in setupGameSystems
    expect(setupSrc).toMatch(/beaconMotes\?\.setAnchors\(data\.landmarks, lights, tileSize\)/); // fed in onMapData
    expect(setupSrc).toMatch(/beaconMotes\?\.destroy\(\)/); // destroyed on scene shutdown
  });

  it('the renderer drives itself from the scene UPDATE loop + shuts down on SHUTDOWN', () => {
    expect(vfxSrc).toMatch(/Phaser\.Scenes\.Events\.UPDATE/);
    expect(vfxSrc).toMatch(/Phaser\.Scenes\.Events\.SHUTDOWN/);
    // Ticket 30: the OVERLAY depth band — above the lighting composite, below
    // the HUD (was `DesignTokens.depth.vfx`, the captured-into-albedo band).
    expect(vfxSrc).toMatch(/DesignTokens\.depth\.vfxOverlay/);
  });

  it('renders ADDITIVELY — particles may only brighten (never occlude) one another', () => {
    expect(vfxSrc).toMatch(/setBlendMode\(Phaser\.BlendModes\.ADD\)/);
  });

  it('submits NO dynamic light (zero light-budget slots consumed)', () => {
    expect(vfxSrc).not.toMatch(/addDynamicLight|DynamicLight|beginDynamicLights|setPlacements/);
  });

  it('zero per-frame allocations: two Float64Arrays (spark + dust, once per map), one Graphics', () => {
    expect(vfxSrc.match(/new Float64Array\(/g)?.length).toBe(2); // once per map, never per frame
    expect(vfxSrc.match(/scene\.add\.graphics\(\)/g)?.length).toBe(1); // single Graphics object
    expect(vfxSrc).toMatch(/this\.gfx\.clear\(\)/); // clear + redraw per frame (ParticleVFX pattern)
  });

  it('draws every tier through the same single Graphics (bounded draw calls, no per-tier objects)', () => {
    // The accent evaluators receive caller-owned scratch records — the update
    // path never constructs per-frame objects (grep for the scratch writes).
    expect(vfxSrc).toMatch(/this\.ringOut/);
    expect(vfxSrc).toMatch(/this\.emberNow/);
    expect(vfxSrc).toMatch(/this\.emberPrev/);
    expect(vfxSrc.match(/new Phaser\./g)).toBe(null); // no Phaser object construction mid-life
  });
});

// ─── Render-order contract (ticket 30 — above the composite, excluded from the albedo) ──

describe('BeaconMotesVFX — render-order contract (ticket 30)', () => {
  const fs = require('node:fs') as typeof import('fs');
  const path = require('node:path') as typeof import('path');
  const vfxSrc = fs.readFileSync(path.join(__dirname, '..', 'BeaconMotesVFX.ts'), 'utf8');

  it('the overlay depth slot sits ABOVE the world-VFX band and BELOW the HUD cutoff', () => {
    // The Final filter composites the camera scene texture (slot 0 — the
    // non-ignored band) OVER the lit RT; `hudBg` (500) is the world/HUD
    // capture cutoff. The motes must sit strictly between: above the
    // lighting composite output (i.e. outside the captured world band) and
    // under the HUD in slot-0's own depth order.
    expect(DesignTokens.depth.vfxOverlay).toBeGreaterThan(DesignTokens.depth.vfx);
    expect(DesignTokens.depth.vfxOverlay).toBeLessThan(DesignTokens.depth.hudBg);
  });

  it('the motes Graphics is registered out of the albedo world-capture (exclusion)', () => {
    // Source wiring: the constructor registers the Graphics with
    // `excludeFromWorldLightCapture` in the SAME synchronous block as its
    // creation (before the capture registry's deferred first evaluation).
    expect(vfxSrc).toMatch(/excludeFromWorldLightCapture\(this\.gfx\)/);
  });

  it('a registered object fails the world-capture predicate at WORLD depth (never captured, never ignored)', () => {
    // Pure predicate assertions — no Phaser boot. The motes Graphics sits at
    // 480 (BELOW the 500 cutoff), so the depth check alone would CAPTURE it;
    // the explicit registration is what excludes it — and exclusion means the
    // object is also never `cam.ignore`d (renders into the slot-0 scene
    // texture the Final filter composites over the lit world).
    type FakeObj = { depth: number; type: string };
    const albedoRT = { depth: 0, type: 'RenderTexture' } as unknown as never;
    const fakeObj = (depth: number, type = 'Graphics'): FakeObj => ({ depth, type });
    const rtShaders: never[] = [];
    const cutoff = DesignTokens.depth.hudBg;

    const motes = fakeObj(DesignTokens.depth.vfxOverlay);
    excludeFromWorldLightCapture(
      motes as unknown as Parameters<typeof excludeFromWorldLightCapture>[0],
    );
    expect(
      passesWorldCaptureFilter(
        motes as unknown as Parameters<typeof passesWorldCaptureFilter>[0],
        albedoRT,
        rtShaders,
        cutoff,
      ),
    ).toBe(false);

    // Unregistered controls: same depth passes; a HUD object is excluded by
    // depth alone (unchanged pre-existing behavior).
    const sameDepthUnregistered = fakeObj(DesignTokens.depth.vfxOverlay);
    expect(
      passesWorldCaptureFilter(
        sameDepthUnregistered as unknown as Parameters<typeof passesWorldCaptureFilter>[0],
        albedoRT,
        rtShaders,
        cutoff,
      ),
    ).toBe(true);
    const hud = fakeObj(DesignTokens.depth.hudBg);
    expect(
      passesWorldCaptureFilter(
        hud as unknown as Parameters<typeof passesWorldCaptureFilter>[0],
        albedoRT,
        rtShaders,
        cutoff,
      ),
    ).toBe(false);
  });

  it('the atmosphere ember layer is UNTOUCHED by the overlay move (still captured at depth.vfx)', () => {
    // Static audit: the OTHER depth.vfx consumers keep the in-albedo behavior
    // — only the motes moved. LightingAtmosphereConfig pins its own depth to
    // DesignTokens.depth.vfx (asserted in LightingAtmosphere.test.ts).
    const atmosSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lighting', 'LightingAtmosphereConfig.ts'),
      'utf8',
    );
    expect(atmosSrc).toMatch(/ATMOSPHERE_DEPTH = DesignTokens\.depth\.vfx/);
    expect(atmosSrc).not.toMatch(/vfxOverlay/);
    // DamageParticleVFX likewise stays in the world band.
    const dmgSrc = fs.readFileSync(path.join(__dirname, '..', 'DamageParticleVFX.ts'), 'utf8');
    expect(dmgSrc).toMatch(/DesignTokens\.depth\.vfx\b/);
    expect(dmgSrc).not.toMatch(/vfxOverlay/);
  });
});

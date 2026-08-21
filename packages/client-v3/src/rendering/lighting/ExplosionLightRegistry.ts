/**
 * ExplosionLightRegistry — per-explosion fire-light lifecycle (ticket 11).
 *
 * Stateful registry (NOT pure). When the ExplosionEventHandler fires on a
 * BarrelExploded/explosion event, it calls `register()` here; the registry
 * tracks the light's brief fade-out lifecycle and exposes the live lights each
 * frame for the dynamic-light populator. Lights auto-expire (unregister) once
 * their lifetime elapses — the ticket-10 "re-upload mechanism" exercised by
 * the barrel-destruction flow is just "the destroyed barrel stops emitting
 * + its explosion flash fades then is dropped from the registry."
 *
 * Ticket 08 (A4 H3 + A7): the explosion light is now a SINGLE PULSE, not a
 * continuous flicker. The prior implementation called `computeFlickerMul`
 * (continuous multi-octave flame noise) every frame of the 450ms life → erratic
 * strobing on a transient. Per AAA research §4 (flash = the briefest first
 * layer, 1–3 frames) + the user's verbatim spec ("an explosion is a single
 * bright pulse with no steady state"), the light now follows a sharp monotonic
 * decay envelope (see {@link EXPLOSION_PULSE_PEAK_MS} + the exponential decay
 * in {@link collect}). The `computeFlickerMul` factor is GONE; the per-explosion
 * `seed` still phase-offsets concurrent flashes (chain explosions) via a tiny
 * deterministic jitter on the decay start, but there is NO continuous octave
 * noise. The lifetime is shortened 450ms → 300ms to match the pulse decay.
 *
 * Light tuning (spec §"Light data + tuning values", hero overrides):
 *   - fire palette color (1.0, 0.30, 0.12), corePower 3.8, haloFrac 0.65,
 *     specPower 22.0, cookie light_01 → cookie index 1 (ticket 07).
 *   - NO flicker octaves (single pulse — see above).
 *   - radius + intensity scaled to the explosion's blast radius; the hero
 *     intensity is tuned so a max-radius barrel blast (BARREL.EXPLOSION_RADIUS
 *     = 256) reads as a brief hot flash without blowing out the whole screen.
 *   - lifetime: 300ms (was 450ms) — the hot-core flash phase of the explosion
 *     VFX (muzzle + flare + fireball) is the first ~300ms; the light tracks
 *     that, not the smoke/scorch tail.
 *
 * Zero-allocation steady state: the registry reuses a single `DynamicLight[]`
 * scratch + a pooled entry array. `register`/`update`/`collect` never allocate
 * in steady state (entries are pooled; the collected `DynamicLight` objects are
 * reused across frames — the populator reads them immediately).
 */
import type { DynamicLight } from './LightPacker.js';
import { cookieKeyToIndex } from './LightPacker.js';
import { resolveLightKind } from './LightPalette.js';

/** The validated fire palette (hot red). Resolved once. */
const FIRE_PALETTE = resolveLightKind('fire');
const FIRE_COOKIE_INDEX = cookieKeyToIndex(FIRE_PALETTE.cookieKey); // light_01 → 1

/**
 * Explosion-light lifetime (ms). Ticket 08 (A4 H3): shortened 450ms → 300ms to
 * match the single-pulse decay envelope (the hot-core flash phase of the
 * explosion VFX — muzzle + flare + fireball — is the first ~300ms; the light
 * tracks that, not the smoke/scorch tail). The prior 450ms lifetime paired
 * with continuous flicker octaves read as a sputtering fire; the new 300ms
 * paired with a monotonic pulse reads as a sharp punch then a fast die-off.
 * A/B baseline: was 450ms (pre-ticket-08).
 */
export const EXPLOSION_LIGHT_LIFETIME_MS = 300;

/**
 * The peak window (ms) at the start of the pulse where the light is at full
 * intensity (the AAA "flash" — research §4: 1–3 frames). At 60fps, 50ms ≈ 3
 * frames. After this window the light decays exponentially to 0 by the
 * lifetime end. The peak window sells the "single bright pulse" read; the
 * decay sells the "no steady state" read.
 */
export const EXPLOSION_PULSE_PEAK_MS = 50;

/**
 * The exponential decay time constant for the post-peak tail. The decay
 * follows `exp(-elapsed_after_peak / DECAY_MS)`. At ~100ms the light is at
 * ~37% of peak; at ~200ms ~14%; at ~300ms ~5%. This gives a sharp punch that
 * trails off quickly (the fireball phase dims + dies), matching the explosion
 * VFX's muzzle→flare→fireball→smoke layering (research §4).
 */
const EXPLOSION_PULSE_DECAY_MS = 100;

/**
 * Intensity scaler: maps an explosion's blast radius to a light intensity.
 * Barrel explosions (radius 256) → intensity ~4.10 (was 3.07 pre-polish).
 * Explosions are the hottest thing in the scene (campfire hero is 2.6), and
 * the wider disk (1.1× blast) + softer `fire` palette (corePower 3.8,
 * haloFrac 0.65) means the same perceived-hotness needs less raw intensity —
 * otherwise the wider softer disk blows out. `0.016 * radius` gives 256 →
 * 4.096. Prior baselines: 0.014 (256 → 3.584, pre-ticket-07), 0.012 (256 →
 * 3.072, ticket-07).
 */
const EXPLOSION_INTENSITY_PER_RADIUS = 0.016;

/**
 * Minimum radius for an explosion light (avoid degenerate tiny flashes).
 * Ticket 07 (A2 findings §5): 96 → 128 (1.0 tile) so even the smallest flash
 * reads as a full-tile soft glow, not a sub-tile dot. A/B baseline: was 96.
 */
const MIN_EXPLOSION_LIGHT_RADIUS = 128;

interface ExplosionLightEntry {
  /** World px X (the explosion center — stationary through the flash). */
  x: number;
  /** World px Y. */
  y: number;
  /** Resolved light radius (scaled to the blast). */
  radius: number;
  /** Base intensity at age 0 (scales the fade). */
  baseIntensity: number;
  /** Spawn timestamp (performance.now() ms). */
  spawnTime: number;
  /**
   * Deterministic per-explosion seed. Ticket 08: no longer drives continuous
   * flicker octaves (the explosion is a single pulse). It now phase-offsets
   * the pulse START slightly (a tiny deterministic jitter so concurrent chain
   * explosions don't all peak on the exact same frame — they're already
   * position-distinct, but the jitter adds temporal diversity). Pure +
   * deterministic per (position, tick).
   */
  seed: number;
}

/**
 * Compute the single-pulse intensity multiplier for an explosion light at age
 * `ageMs`. Ticket 08 (A4 H3): replaces the prior continuous `computeFlickerMul`
 * on a transient. The envelope is:
 *   - age < PEAK: full intensity (1.0) — the AAA "flash" (research §4: 1–3 frames)
 *   - age ≥ PEAK: exponential decay `exp(-(age - PEAK) / DECAY_MS)` — sharp
 *     punch then fast die-off, NO steady state, NO flicker octaves.
 *
 * The per-explosion `seed` adds a tiny deterministic jitter to the peak window
 * start (±1 frame at 60fps) so chain explosions (distinct seeds) don't peak on
 * the exact same frame. Pure + deterministic per (ageMs, seed).
 *
 * Per the user's verbatim spec: "an explosion is a single bright pulse with no
 * steady state." Per AAA research §4: the flash is the briefest first layer
 * (1–3 frames); the fireball lingers but the LIGHT should punch and die.
 */
export function computeExplosionPulseMul(ageMs: number, seed: number): number {
  // Deterministic per-seed jitter on the peak window start (±~16ms ≈ ±1 frame
  // at 60fps). Mixed via the same hash family the rest of the flicker system
  // uses (kept local to avoid a circular import — the jitter is a single
  // bounded sine, not the full multi-octave noise). The seed is itself derived
  // from the explosion's position + tick (see ExplosionEventHandler), so
  // distinct explosions get distinct jitters deterministically.
  const jitter = Math.sin(seed * 7.13) * 16; // ±16ms
  const peakStart = Math.max(0, jitter); // never start before age 0
  const peakEnd = peakStart + EXPLOSION_PULSE_PEAK_MS;
  if (ageMs < peakEnd) return 1.0; // the flash — full intensity
  const elapsedAfterPeak = ageMs - peakEnd;
  return Math.exp(-elapsedAfterPeak / EXPLOSION_PULSE_DECAY_MS);
}

/**
 * The registry. One instance per GameScene (owned by the dynamic-light
 * populator). Methods are safe to call from the update loop + the explosion
 * event handler (both run on the main thread, serially).
 */
export class ExplosionLightRegistry {
  private readonly entries: ExplosionLightEntry[] = [];
  /** Pool of recycled entries (avoid alloc on re-register after expire). */
  private readonly pool: ExplosionLightEntry[] = [];
  /**
   * Reused collected-light output. The DynamicLight objects are STABLE refs
   * (one per slot, mutated in place each frame) so callers can hold them for
   * the frame without copying. Sized to a sane cap (rarely >5 concurrent
   * explosions in a 64-player match; 32 is generous headroom).
   */
  private readonly collected: DynamicLight[] = [];

  /**
   * Register an explosion light. Called by the ExplosionEventHandler on
   * BarrelExploded/explosion events. The light fades from `intensity` to 0
   * over `EXPLOSION_LIGHT_LIFETIME_MS`, then auto-expires.
   *
   * @param x             explosion center X (world px).
   * @param y             explosion center Y (world px).
   * @param blastRadius   the explosion's blast radius (world px). The light
   *                      radius + intensity scale from this.
   * @param nowMs         wall-clock ms (performance.now()).
   * @param seed          deterministic per-explosion flicker seed (so
   *                      concurrent flashes don't strobe in unison).
   */
  register(x: number, y: number, blastRadius: number, nowMs: number, seed: number): void {
    // Radius: the light disk EXCEEDS the blast radius (1.1×) so the fireball
    // spills dramatically past the damage edge — the standard AAA convention
    // for explosion VFX (the visible blast is larger than the gameplay blast).
    // Prior: 0.7× (ticket-07, "match the damage radius") read as a flat disk
    // the same size as the blast — not dramatic. A barrel blast (256) → 282px
    // (~2.2 tiles). Clamped to the 1-tile floor.
    const radius = Math.max(MIN_EXPLOSION_LIGHT_RADIUS, blastRadius * 1.1);
    const baseIntensity = Math.max(1.8, blastRadius * EXPLOSION_INTENSITY_PER_RADIUS);
    const entry = this.pool.pop() ?? {
      x: 0,
      y: 0,
      radius: 0,
      baseIntensity: 0,
      spawnTime: 0,
      seed: 0,
    };
    entry.x = x;
    entry.y = y;
    entry.radius = radius;
    entry.baseIntensity = baseIntensity;
    entry.spawnTime = nowMs;
    entry.seed = seed;
    this.entries.push(entry);
  }

  /**
   * Advance the registry: expire lights past their lifetime (returning their
   * entries to the pool). Called once per frame BEFORE `collect`.
   */
  update(nowMs: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (nowMs - e.spawnTime >= EXPLOSION_LIGHT_LIFETIME_MS) {
        // Expired — recycle to the pool (splice-then-push; safe because we
        // iterate descending).
        this.entries.splice(i, 1);
        this.pool.push(e);
      }
    }
  }

  /**
   * Collect the live explosion lights for this frame, writing into the reused
   * `collected` array. Each entry's intensity follows the single-pulse envelope
   * (see {@link computeExplosionPulseMul}): full intensity during the peak
   * window, then exponential decay. NO continuous flicker octaves — the
   * explosion is a single bright pulse with no steady state (ticket 08 / A4 H3,
   * per AAA research §4 + the user's verbatim spec).
   *
   * The returned array is the registry's reused `collected` (NOT a copy). The
   * caller reads it immediately, before the next `collect` call. Each element
   * is a stable `DynamicLight` ref mutated in place (so the populator can
   * pass it straight to `addDynamicLight` without re-wrapping).
   *
   * @param nowMs       wall-clock ms (performance.now()).
   * @param flickerMul  RESERVED — kept for signature compatibility with the
   *                    populator's call site (which passes the global flame
   *                    flicker). Ticket 08: this is IGNORED for explosions (the
   *                    single-pulse envelope replaces the continuous flame
   *                    flicker; mixing them would re-introduce the strobe-on-
   *                    transient bug). The param stays so the populator doesn't
   *                    need a per-light-type branch.
   * @returns the reused array of live explosion DynamicLights (pulse-shaped).
   */
  collect(nowMs: number, flickerMul: number): DynamicLight[] {
    // Trim the collected array to the live count (reuse the backing storage).
    this.collected.length = this.entries.length;
    void flickerMul; // ticket 08: ignored — explosions use the single-pulse curve only.
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const age = nowMs - e.spawnTime;
      // Single-pulse envelope: peak then exponential decay. NO linear fade, NO
      // flicker octaves. The pulse multiplier is in [0, 1] — full at the peak,
      // decaying to ~0 by the lifetime end. The base intensity is fixed at
      // registration; the pulse scales it.
      const pulse = computeExplosionPulseMul(age, e.seed);
      let light = this.collected[i];
      if (!light) {
        // First time this slot is used — allocate a stable ref. Subsequent
        // frames mutate it in place (zero alloc in steady state).
        light = {
          x: 0,
          y: 0,
          radius: 0,
          intensity: 0,
          color: [FIRE_PALETTE.color[0], FIRE_PALETTE.color[1], FIRE_PALETTE.color[2]],
          corePower: FIRE_PALETTE.corePower,
          haloFrac: FIRE_PALETTE.haloFrac,
          specPower: FIRE_PALETTE.specPower,
          cookieOn: FIRE_COOKIE_INDEX,
          flickerMul: 1.0,
        };
        this.collected[i] = light;
      }
      light.x = e.x;
      light.y = e.y;
      light.radius = e.radius;
      // The pulse multiplier IS the intensity envelope. Fold it directly into
      // the intensity (not flickerMul) so the packer's `intensity * flickerMul`
      // sees `baseIntensity * pulse * 1.0`. Using flickerMul for the pulse would
      // conflate it with the (now-disabled) flame flicker; intensity is the
      // clean channel. flickerMul stays at 1.0 — the explosion has NO flicker.
      light.intensity = e.baseIntensity * pulse;
      light.flickerMul = 1.0;
      // Color + params + cookie are fixed (set once at allocation); the palette
      // is a module constant so they never drift.
    }
    return this.collected;
  }

  /** Current live-entry count (test/diagnostic helper). */
  get size(): number {
    return this.entries.length;
  }

  /** Clear the registry (scene teardown / test reset). */
  clear(): void {
    this.pool.push(...this.entries);
    this.entries.length = 0;
    this.collected.length = 0;
  }
}

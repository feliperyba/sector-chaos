/**
 * ImpactLightRegistry — per-combat-impact flash lifecycle (ticket 09 / A3).
 *
 * Stateful registry (NOT pure). Mirrors {@link ExplosionLightRegistry}: when a
 * combat event the client already receives fires (`PlayerDamaged` for a melee
 * hit, `ShieldBlocked` for a shield block, `WeaponBroken` for a weapon break,
 * `ProjectileDestroyed` for an arrow impact), the corresponding event handler
 * calls `register()` here; the registry tracks the light's brief flash + decay
 * lifecycle and exposes the live lights each frame for the dynamic-light
 * populator. Lights auto-expire (return to the pool) once their lifetime
 * elapses.
 *
 * ── Scope (the four impact event types) ──
 *
 * Per the ticket (and the user's ruling — "the block of the shield should spark
 * a light together with the block particles to match the mood"), four combat
 * events produce a brief light flash at the contact point:
 *
 *   - **Projectile impact** (`ProjectileDestroyed` on a RANGED bolt): a brief
 *     warm-white spark at the impact point. Gated to RANGED-only client-side
 *     (the AttackEventHandler resolves the projectile's AttackType from the
 *     entity map; physical-throw impacts emit no flash — they already emit no
 *     traveling light per the RANGED-only narrowing, so their impact would be a
 *     stray spark disconnected from any streak).
 *   - **Shield-block spark** (`ShieldBlocked`): a brief spark-white-blue flash
 *     at the block point (matches the existing block particles — the user's
 *     example). Prefers the swept-melee `contactX/contactY` when present, falls
 *     back to the defender `x/y`.
 *   - **Melee hit spark** (`PlayerDamaged` with a melee/thrown/ranged damage
 *     type): a brief warm spark at the contact point. The damage-type taxonomy
 *     gates this: `melee_hit` / `thrown_hit` / `ranged_hit` / `projectile_hit`
 *     flash; `barrel_explosion` does NOT (the explosion light —
 *     ExplosionLightRegistry — already covers blasts, double-lighting would
 *     blow out); `zone_damage` / `sudden_death` / `siege_crush` do NOT (no
 *     contact point, not a weapon hit).
 *   - **Weapon-break shatter flash** (`WeaponBroken`): a brief warm-orange
 *     shatter flash at the broken weapon's position. Ties to ticket 03's break
 *     event wiring (the same event that hides the weapon sprite).
 *
 * ── AAA reference (research §4) ──
 *
 * The flash is the BRIEFEST first layer (1–3 frames), NOT a steady flickering
 * light. Per the user's verbatim spec ("tactical, not scene-dominating") + AAA
 * research §4 (Love, D3 GDC 2013 — "be able to space out when looking at an
 * effect"), each impact flash is a single sharp pulse (peak + exponential
 * decay), small radius (~80–120px), modest intensity. The flash is a
 * readability/character accent, not a primary light — it never competes with
 * the player aura or motivated prop layer.
 *
 * ── Cosmetic-only (GDD `docs/GDD.md:210`) ──
 *
 * Impact flashes are mood accents, never a vision gate. They never block vision
 * (the ambient floor keeps the world fully visible); they never change gameplay
 * (the combat damage/resolution is server-authoritative + unchanged — the
 * client only adds a light flash on events it already handles). No new server
 * events, no new network traffic, no new server state.
 *
 * ── Per-event-kind tinting ──
 *
 * Each impact kind has a distinct tint (the AAA per-element principle applied to
 * impact color-coding):
 *   - `projectile` (arrow impact)  — warm white (matches the RANGED traveling
 *                                    light's hot near-white core; the impact is
 *                                    the streak's terminus).
 *   - `block` (shield-block spark) — spark white-blue (a metallic clash; reads
 *                                    as parried energy, distinct from a flesh
 *                                    hit).
 *   - `melee` (melee/thrown hit)   — warm spark (a flesh/steel contact; warm
 *                                    enough to read as impact, not as fire).
 *   - `break` (weapon shatter)     — warm-orange (a fractured weapon's dying
 *                                    glint; warmer than the melee spark to read
 *                                    as a shatter, not a hit).
 *
 * ── Zero-allocation steady state ──
 *
 * Same as ExplosionLightRegistry: the registry reuses a single `DynamicLight[]`
 * scratch + a pooled entry array. `register`/`update`/`collect` never allocate
 * in steady state (entries are pooled; the collected `DynamicLight` objects are
 * reused across frames — the populator reads them immediately, mirroring the
 * explosion-light collection pattern).
 *
 * ── REVIEW item C — payload-shape trace ──
 *
 * The four event types have DIFFERENT payload shapes (traced before writing the
 * registry; each handler reads the fields it needs defensively):
 *   - `PlayerDamaged` (`damage-messages.ts:30-43`): `x`, `y`, `damageType`.
 *   - `ShieldBlocked` (`damage-messages.ts:61-79`): `x`, `y` + OPTIONAL
 *     `contactX`, `contactY` (the swept-melee clash point) + `attackerWeaponType?`.
 *   - `WeaponBroken` (`damage-messages.ts:45-59`): `x`, `y`, `weaponType`.
 *   - `ProjectileDestroyed` (`attack-messages.ts:39-54`): `x`, `y`,
 *     `projectileId`. NO `weaponType`/`attackType` on the wire (the mapper omits
 *     both) — the handler resolves the AttackType from the projectile entity in
 *     `stateSync` BEFORE it despawns, gating to RANGED-only.
 *
 * The registry itself is shape-agnostic: it takes a resolved `(x, y, kind,
 * nowMs, seed)` and does not know which event produced the call. The per-event
 * payload decoding lives in the handlers (one shape per handler, traced + tested
 * at the handler seam).
 */
import type { DynamicLight } from './LightPacker.js';

/**
 * The four combat-impact event kinds the registry flashes. Each maps to a
 * distinct tint + tuning (see {@link IMPACT_KIND_TUNING}). The registry is
 * shape-agnostic beyond the kind tag; the handler decodes the event payload and
 * picks the kind.
 */
export type ImpactLightKind = 'projectile' | 'block' | 'melee' | 'break';

/**
 * Per-kind tuning (color + radius + intensity + falloff + cookie). Derived per
 * the ticket ("small radius ~80–120px, brief, modest intensity") + the AAA
 * per-element principle. Colors are inline (no LightKind entries — these are
 * one-off mood accents, not map-gen/light-palette kinds, mirroring the chest-
 * glint inline color in DynamicLightPopulator).
 *
 * Cookie: 1 (light_01, warm radial) for the warm/white/orange kinds; 2
 * (light_02, soft cool radial) for the spark-white-blue block kind. Mirrors the
 * cookie semantics in LightPalette (warm vs cool radials).
 *
 * Radius: ~80–120px (0.6–0.9 tile) — small enough to read as a spark, not a
 * flood. Intensity: ~1.5–2.2 — modest; below the explosion flash (~3.0) and the
 * campfire hero (2.6), above the chest glint (1.2). Tuned so a flash reads as a
 * sharp accent without blowing out the local region.
 *
 * corePower/haloFrac: softer core + more halo (matches the ticket-07 diffuseness
 * convention — sparks are soft, not tight dots). specPower: gentle (a spark is
 * not a metallic spec).
 */
interface ImpactKindTuning {
  readonly color: readonly [number, number, number];
  readonly radius: number;
  readonly intensity: number;
  readonly corePower: number;
  readonly haloFrac: number;
  readonly specPower: number;
  readonly cookieOn: number;
}

const IMPACT_KIND_TUNING: Readonly<Record<ImpactLightKind, ImpactKindTuning>> = {
  // Arrow impact — warm white (the streak's terminus). Matches the RANGED
  // traveling light's hot near-white core so the impact reads as the streak
  // landing. Small radius (a bolt is a sliver); modest intensity (accent).
  projectile: {
    color: [1.0, 0.95, 0.82],
    radius: 90,
    intensity: 1.7,
    corePower: 3.8,
    haloFrac: 0.7,
    specPower: 26.0,
    cookieOn: 1, // light_01 warm radial.
  },
  // Shield-block spark — spark white-blue (a metallic clash). Cool-biased so it
  // reads as parried energy, distinct from the warm flesh-hit spark. Small
  // radius; modest intensity.
  block: {
    color: [0.78, 0.88, 1.0],
    radius: 100,
    intensity: 1.9,
    corePower: 3.6,
    haloFrac: 0.75,
    specPower: 30.0,
    cookieOn: 2, // light_02 cool radial.
  },
  // Melee/thrown hit spark — warm spark (a flesh/steel contact). Warm enough to
  // read as impact, not as fire (less saturated red than the explosion palette).
  // Small radius; modest intensity.
  melee: {
    color: [1.0, 0.78, 0.5],
    radius: 95,
    intensity: 1.6,
    corePower: 3.7,
    haloFrac: 0.7,
    specPower: 24.0,
    cookieOn: 1, // light_01 warm radial.
  },
  // Weapon-break shatter flash — warm-orange (a fractured weapon's dying glint).
  // Warmer than the melee spark to read as a shatter (the weapon is gone), not
  // as a hit. Slightly bigger radius (a shatter is a small burst); modest
  // intensity.
  break: {
    color: [1.0, 0.62, 0.32],
    radius: 110,
    intensity: 2.0,
    corePower: 3.5,
    haloFrac: 0.72,
    specPower: 22.0,
    cookieOn: 1, // light_01 warm radial.
  },
};

/**
 * Impact-light lifetime (ms). Per the ticket ("brief, ~150ms decay") + AAA
 * research §4 (the flash is the briefest first layer; the decay is short). 180ms
 * gives a perceptible-but-tactical flash: at 60fps that's ~11 frames total, with
 * the peak window (~3 frames) carrying the flash + the exponential decay
 * (~150ms time constant) carrying the tail. Mirrors ExplosionLightRegistry's
 * 300ms lifetime but SHORTER (an impact is a smaller event than a barrel blast;
 * the flash should punch and die faster).
 */
export const IMPACT_LIGHT_LIFETIME_MS = 180;

/**
 * The peak window (ms) at the start of the pulse where the light is at full
 * intensity (the AAA "flash" — research §4: 1–3 frames). At 60fps, 50ms ≈ 3
 * frames. After this window the light decays exponentially. Same value as
 * ExplosionLightRegistry (the flash read is identical; only the decay tail
 * differs — impacts decay faster).
 */
export const IMPACT_PULSE_PEAK_MS = 50;

/**
 * The exponential decay time constant for the post-peak tail. The decay follows
 * `exp(-elapsed_after_peak / DECAY_MS)`. At ~80ms the light is at ~37% of peak;
 * at ~160ms ~14%; at ~180ms ~11%. SHORTER than the explosion decay (100ms) — an
 * impact is a smaller event; the tail dies faster so the scene doesn't accumulate
 * lingering flashes during a busy melee.
 */
const IMPACT_PULSE_DECAY_MS = 80;

interface ImpactLightEntry {
  /** World px X (the contact point — stationary through the flash). */
  x: number;
  /** World px Y. */
  y: number;
  /** The impact kind (drives the tint via {@link IMPACT_KIND_TUNING}). */
  kind: ImpactLightKind;
  /** Base intensity at age 0 (scales the fade — from the kind tuning). */
  baseIntensity: number;
  /** Spawn timestamp (performance.now() ms). */
  spawnTime: number;
  /**
   * Deterministic per-impact seed. Phase-offsets the pulse START slightly (a
   * tiny deterministic jitter so concurrent impacts — e.g. a multi-hit sweep —
   * don't all peak on the exact same frame). Pure + deterministic per
   * (position, tick).
   */
  seed: number;
}

/**
 * Compute the single-pulse intensity multiplier for an impact light at age
 * `ageMs`. Mirrors {@link ExplosionLightRegistry.computeExplosionPulseMul}: peak
 * then exponential decay, NO continuous flicker octaves (per AAA research §4 —
 * the flash is the briefest first layer, NOT a steady flickering light).
 *
 *   - age < PEAK: full intensity (1.0) — the AAA "flash" (1–3 frames)
 *   - age ≥ PEAK: exponential decay `exp(-(age - PEAK) / DECAY_MS)` — sharp
 *     punch then fast die-off, NO steady state, NO flicker octaves.
 *
 * The per-impact `seed` adds a tiny deterministic jitter to the peak window
 * start (±1 frame at 60fps) so concurrent impacts (distinct seeds) don't peak on
 * the exact same frame. Pure + deterministic per (ageMs, seed).
 */
export function computeImpactPulseMul(ageMs: number, seed: number): number {
  // Deterministic per-seed jitter on the peak window start (±~16ms ≈ ±1 frame
  // at 60fps). Same shape as the explosion pulse jitter (kept local — a single
  // bounded sine, not the full multi-octave noise). The seed is itself derived
  // from the impact's position + tick (see the event handlers), so distinct
  // impacts get distinct jitters deterministically.
  const jitter = Math.sin(seed * 7.13) * 16; // ±16ms
  const peakStart = Math.max(0, jitter); // never start before age 0
  const peakEnd = peakStart + IMPACT_PULSE_PEAK_MS;
  if (ageMs < peakEnd) return 1.0; // the flash — full intensity
  const elapsedAfterPeak = ageMs - peakEnd;
  return Math.exp(-elapsedAfterPeak / IMPACT_PULSE_DECAY_MS);
}

/**
 * The registry. One instance per GameScene (owned by GameState, mirroring
 * ExplosionLightRegistry's ownership). Methods are safe to call from the update
 * loop + the combat event handlers (both run on the main thread, serially).
 */
export class ImpactLightRegistry {
  private readonly entries: ImpactLightEntry[] = [];
  /** Pool of recycled entries (avoid alloc on re-register after expire). */
  private readonly pool: ImpactLightEntry[] = [];
  /**
   * Reused collected-light output. The DynamicLight objects are STABLE refs
   * (one per slot, mutated in place each frame) so callers can hold them for
   * the frame without copying. Sized to a sane cap (rarely >10 concurrent
   * impacts in a 64-player match; 32 is generous headroom, same as the explosion
   * registry).
   */
  private readonly collected: DynamicLight[] = [];

  /**
   * Register an impact flash. Called by the combat event handlers
   * (DamageEventHandler for PlayerDamaged/ShieldBlocked/WeaponBroken;
   * AttackEventHandler for ProjectileDestroyed). The light flashes at full
   * intensity for {@link IMPACT_PULSE_PEAK_MS}, then decays exponentially to ~0
   * over {@link IMPACT_LIGHT_LIFETIME_MS}, then auto-expires.
   *
   * @param x       contact-point X (world px).
   * @param y       contact-point Y (world px).
   * @param kind    the impact kind (drives the tint via IMPACT_KIND_TUNING).
   * @param nowMs   wall-clock ms (performance.now()).
   * @param seed    deterministic per-impact seed (so concurrent flashes don't
   *                strobe in unison).
   */
  register(
    x: number,
    y: number,
    kind: ImpactLightKind,
    nowMs: number,
    seed: number,
  ): void {
    const tuning = IMPACT_KIND_TUNING[kind];
    const entry = this.pool.pop() ?? {
      x: 0,
      y: 0,
      kind: 'melee' as ImpactLightKind,
      baseIntensity: 0,
      spawnTime: 0,
      seed: 0,
    };
    entry.x = x;
    entry.y = y;
    entry.kind = kind;
    entry.baseIntensity = tuning.intensity;
    entry.spawnTime = nowMs;
    entry.seed = seed;
    this.entries.push(entry);
  }

  /**
   * Advance the registry: expire lights past their lifetime (returning their
   * entries to the pool). Called once per frame BEFORE `collect`. Mirrors
   * ExplosionLightRegistry.update.
   */
  update(nowMs: number): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (nowMs - e.spawnTime >= IMPACT_LIGHT_LIFETIME_MS) {
        // Expired — recycle to the pool (splice-then-push; safe because we
        // iterate descending).
        this.entries.splice(i, 1);
        this.pool.push(e);
      }
    }
  }

  /**
   * Collect the live impact lights for this frame, writing into the reused
   * `collected` array. Each entry's intensity follows the single-pulse envelope
   * (see {@link computeImpactPulseMul}): full intensity during the peak window,
   * then exponential decay. NO continuous flicker octaves — the impact is a
   * single sharp pulse (per AAA research §4 + the user's "tactical" ruling).
   *
   * The returned array is the registry's reused `collected` (NOT a copy). The
   * caller reads it immediately, before the next `collect` call. Each element is
   * a stable `DynamicLight` ref mutated in place (so the populator can pass it
   * straight to `addDynamicLight` without re-wrapping).
   *
   * @param nowMs       wall-clock ms (performance.now()).
   * @param flickerMul  RESERVED — kept for signature compatibility with the
   *                    populator's call site (which passes the global flame
   *                    flicker, mirroring the explosion-light collect). Ignored
   *                    for impacts (the single-pulse envelope replaces any
   *                    continuous flicker; mixing them would re-introduce a
   *                    strobe-on-transient). The param stays so the populator
   *                    doesn't need a per-light-type branch.
   * @returns the reused array of live impact DynamicLights (pulse-shaped).
   */
  collect(nowMs: number, flickerMul: number): DynamicLight[] {
    // Trim the collected array to the live count (reuse the backing storage).
    this.collected.length = this.entries.length;
    void flickerMul; // ignored — impacts use the single-pulse curve only.
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      const tuning = IMPACT_KIND_TUNING[e.kind];
      const age = nowMs - e.spawnTime;
      // Single-pulse envelope: peak then exponential decay. NO linear fade, NO
      // flicker octaves. The pulse multiplier is in [0, 1] — full at the peak,
      // decaying to ~0 by the lifetime end.
      const pulse = computeImpactPulseMul(age, e.seed);
      let light = this.collected[i];
      if (!light) {
        // First time this slot is used — allocate a stable ref. Subsequent
        // frames mutate it in place (zero alloc in steady state).
        light = {
          x: 0,
          y: 0,
          radius: 0,
          intensity: 0,
          color: [tuning.color[0], tuning.color[1], tuning.color[2]],
          corePower: tuning.corePower,
          haloFrac: tuning.haloFrac,
          specPower: tuning.specPower,
          cookieOn: tuning.cookieOn,
          flickerMul: 1.0,
        };
        this.collected[i] = light;
      }
      light.x = e.x;
      light.y = e.y;
      light.radius = tuning.radius;
      // The pulse multiplier IS the intensity envelope. Fold it directly into
      // the intensity (not flickerMul) so the packer's `intensity * flickerMul`
      // sees `baseIntensity * pulse * 1.0`. flickerMul stays at 1.0 — the impact
      // has NO flicker.
      light.intensity = e.baseIntensity * pulse;
      light.flickerMul = 1.0;
      // Per-frame: re-apply the kind's color/falloff/cookie in case the slot was
      // reused for a different kind last frame (the collected array is indexed
      // by position, not by entry identity — a slot that held a 'block' flash
      // last frame may hold a 'melee' flash this frame).
      const c = light.color as [number, number, number];
      c[0] = tuning.color[0];
      c[1] = tuning.color[1];
      c[2] = tuning.color[2];
      light.corePower = tuning.corePower;
      light.haloFrac = tuning.haloFrac;
      light.specPower = tuning.specPower;
      light.cookieOn = tuning.cookieOn;
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

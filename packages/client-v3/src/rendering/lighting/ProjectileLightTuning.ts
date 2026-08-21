/**
 * ProjectileLightTuning — per-AttackType projectile light character (ticket 20).
 *
 * Pure data + pure logic (no Phaser, no GPU, no wall-clock). This is the Seam-A
 * unit-test surface for ticket 20: the per-AttackType tuning table is a
 * deterministic lookup, the trail ring buffer is a deterministic per-projectile
 * position/dim transform, and the AttackType resolver is a defensive pure
 * function. `DynamicLightPopulator` consumes these to light each projectile by
 * its real element + streak a short fade trail behind it.
 *
 * ── Why per-AttackType (the ticket's headline) ──
 *
 * Pre-ticket-20 the populator collapsed every projectile into two buckets —
 * arrow (`bounces < 0`) vs thrown — all with the same warm-yellow color, the
 * same corePower/haloFrac/specPower, the same cookie as auras + barrels. So a
 * thrown axe glow was identical to a barrel-fire glow, just smaller; a crossbow
 * bolt looked like a mini campfire. The AAA reference (research §4): per-element
 * color is observed across ARPGs (fire=orange, cold=blue, poison=green,
 * lightning=white/yellow), and a projectile should read as a discrete fast
 * streak, not a static fused disk (Love, D3 GDC 2013 — "be able to space out
 * when looking at an effect").
 *
 * ── Ticket 09 (A3) — RANGED-only ruling (the load-bearing change) ──
 *
 * The user ruled (A3 findings, `.scratch/lighting-system-2/01-findings/
 * A3-projectiles-arrows-elemental-only.md`): ONLY arrows (RANGED — SHORT_BOW +
 * CROSSBOW) AND explicitly-elemental projectiles (poison/fire/ice) cast a
 * traveling light. Physical throws (ARC/LINE/THROWN — axes, spears, daggers,
 * swords, hammers, polearms, staves, throwing axes) cast NO traveling light.
 * A thrown axe glowed identically to a barrel-fire; that silhouette collision
 * is gone. The table was narrowed from 4 kinetic entries (RANGED/LINE/THROWN/
 * ARC, ticket 20) to a single RANGED entry (ticket 09). A/B baseline (ticket 20
 * → ticket 09): LINE/THROWN/ARC entries removed; their colors are recorded in
 * the comments below for the A/B record.
 *
 * The populator's existing `tuning !== null` check at
 * `DynamicLightPopulator.ts:313-314` AUTO-GATES the trail too: with the table
 * RANGED-only, ARC/LINE/THROWN projectiles skip the head light AND the trail
 * (the trail is emitted inside the same `tuning !== null` block). No separate
 * trail change is needed — verified by the populator read.
 *
 * Elemental: confirmed NOT to exist on the gameplay side (A3 §4 — no
 * `element`/`affinity`/`poison`/`fire`/`ice` field on `WeaponDefinition`,
 * `Projectile`, `ProjectileSchema`, or the wire `ProjectileSchemaData`;
 * `DamageType` is a damage-source taxonomy, not elemental). "Poison/fire/ice"
 * exist ONLY as client lighting-palette concepts. The {@link POISON_OVERRIDE}
 * hook is left as the documented future elemental path; wire it when an affinity
 * field actually exists on weapons/projectiles.
 *
 * ── Color rationale (tied to the AAA per-element principle) ──
 *
 *   RANGED (crossbow bolt /  — hot near-white core with a faint warm bias. A bolt
 *          short-bow arrow)    is a fast kinetic tracer; the whitest, hottest read
 *                              matches "lightning/fast" convention + lets the eye
 *                              lock onto the streak. Tiny radius, tight core. This
 *                              is the ONLY kinetic AttackType that casts light.
 *   ARC/LINE/THROWN          — NULL (ticket 09). Physical throws (axes, spears,
 *                              daggers, swords, hammers, polearms, staves,
 *                              throwing axes) are inert. (Pre-ticket-09 they each
 *                              had a warm entry: LINE pale-gold [1.0,0.9,0.62] r88;
 *                              THROWN warm-ember [1.0,0.62,0.28] r120; ARC aliased
 *                              to THROWN. Recorded for the A/B baseline.)
 *   poison (future hook)    — green tint entry is present in the palette
 *                            (`LightPalette.poison`, light_03 cookie). The
 *                            weapon registry has NO poison discriminator today
 *                            (no `element`/`affinity` field on WeaponDefinition,
 *                            verified), so there is no automatic green path yet.
 *                            The table is structured so a `POISON_PROJECTILE`
 *                            override slots in cleanly when poison weapons
 *                            exist — see {@link POISON_OVERRIDE}.
 *   SHIELD                  — emits NO traveling light. SHIELD bashes are a melee
 *                            pulse (server `ShieldAttackHandler` spawns no
 *                            Projectile entity), and if a SHIELD-affinity
 *                            projectile ever appears it should not read as a
 *                            traveling disk.
 *
 * ── Intensity — accents, not the main light ──
 *
 * Pre-ticket-20: arrow 0.9. The motivated prop lights (ticket 17's
 * torches/campfires) are the dominant warm layer; the bolt is a mood accent.
 * Tuned DOWN (RANGED ~0.55) so a projectile never out-glows the prop layer it
 * flies past.
 *
 * ── Trail ──
 *
 * A short streak of 2 fade-trailing lights at past interpolated positions, each
 * dimmer than the head (×0.5, ×0.25). Implemented as a tiny per-projectile ring
 * buffer of past head positions (capped, leak-cleaned on death). Cheap: 2 extra
 * `addDynamicLight` calls per projectile, tagged `LIGHT_PRIORITY.PROJECTILE` so
 * they trim before props/scatter when the scene is busy (budget-safe).
 *
 * Cosmetic-only (GDD `docs/GDD.md:210` forbids fog of war): projectile lights
 * are trailing glow accents, never a vision radius. No gameplay gate, no network
 * traffic (AttackType is resolved client-side from `weaponType` the renderer
 * already reads).
 *
 * No flicker on projectiles (steady glow + trail) — matches the existing spec.
 */
import { AttackType, weaponRegistry } from '@sector-battle/shared';
import type { WeaponType } from '@sector-battle/shared';

/**
 * The per-AttackType projectile light tuning. Each entry is the FULL resolved
 * visual: color (linear RGB [0,1]), radius (world px), intensity, corePower,
 * haloFrac, specPower, cookie index. Color/falloff/cookie per type — the
 * load-bearing differentiation. See module docstring for the per-element
 * rationale.
 */
export interface ProjectileLightEntry {
  readonly attackType: AttackType;
  readonly color: readonly [number, number, number];
  readonly radius: number;
  readonly intensity: number;
  readonly corePower: number;
  readonly haloFrac: number;
  readonly specPower: number;
  readonly cookieOn: number;
}

/**
 * Cookie indices (mirrors `cookieKeyToIndex` without importing the packer — this
 * module is kept packer-free so the Seam-A test stays GPU/Phaser-free). 1 =
 * light_01 (warm radial), 2 = light_02 (soft cool radial), 3 = light_03 (poison
 * radial). See `LightPacker.cookieKeyToIndex`.
 */
const COOKIE_WARM = 1; // light_01 — hot ember core (fire/torch family).
const COOKIE_POISON = 3; // light_03 — green poison radial.

/**
 * The per-AttackType tuning table. DETERMINISTIC pure-data lookup — the Seam-A
 * test asserts each AttackType resolves to a stable entry (or null per the
 * ruling).
 *
 * Ticket 09 (A3 — RANGED-only ruling): the table is narrowed to a SINGLE kinetic
 * entry (RANGED). LINE / THROWN / ARC are REMOVED — physical throws cast no
 * traveling light per the user ruling. `SHIELD` was already absent (melee
 * pulse). `getProjectileLight` now returns null for every non-RANGED AttackType
 * (and the populator's existing `tuning === null` check at
 * `DynamicLightPopulator.ts:313-314` auto-gates the trail too — see the module
 * docstring).
 *
 * Intensities are tuned DOWN from pre-ticket-20 (arrow 0.9) so projectiles read
 * as accents under the motivated prop light layer (ticket 17).
 *
 * Ticket 07 (A2 findings — GLOBAL radii + diffuseness retune): modest radius
 * bump + softer corePower / higher haloFrac so the bolt reads as a soft streak,
 * not a tight dot. A/B baseline (verbatim-prototype → ticket-07 → ticket-09):
 *   RANGED  radius 58  → 72    corePower 5.0 → 4.3   haloFrac 0.35 → 0.50
 *   LINE/THROWN/ARC    → removed (ticket 09; physical throws are inert).
 */
const PROJECTILE_LIGHT_TABLE: Readonly<Partial<Record<AttackType, ProjectileLightEntry>>> = {
  // RANGED (crossbow bolt / short-bow arrow): tiny + hot + fast streak. Whitest
  // core (lightning-fast tracer convention), smallest radius, tightest core,
  // lowest intensity (a bolt is a sliver, not a globe). Cool-ish tint biases the
  // streak away from the warm campfire layer so it reads as kinetic, not
  // pyrotechnic. The ONLY kinetic AttackType that casts a traveling light
  // (ticket 09 / A3).
  [AttackType.RANGED]: {
    attackType: AttackType.RANGED,
    color: [1.0, 0.96, 0.85], // hot near-white with a faint warm bias.
    radius: 72, // was 58 — modest bump (a bolt is still a sliver; ticket 07).
    intensity: 0.55, // accent (down from 0.9).
    corePower: 4.3, // was 5.0 — softer hot core (ticket 07).
    haloFrac: 0.5, // was 0.35 — more halo energy (ticket 07).
    specPower: 34.0, // crisp spec (kinetic steel/energy).
    cookieOn: COOKIE_WARM,
  },
  // LINE / THROWN / ARC are intentionally ABSENT (ticket 09 / A3). Physical
  // throws (spear, axe, dagger, etc.) cast NO traveling light per the user
  // ruling. A3 §3 confirms: SPEAR/POLEARM/STAFF are LINE; THROWING_AXE is
  // THROWN; DAGGER→DOUBLE_AXE are ARC — all physical, all no-light now.
  // `getProjectileLight` returns null for these (verified by the populator's
  // `tuning === null` skip — the trail auto-gates inside the same block).
  // Pre-ticket-09 A/B baseline (for the record, do not restore):
  //   LINE   color [1.0,0.9,0.62]  radius 88  intensity 0.7  corePower 4.0  haloFrac 0.55
  //   THROWN color [1.0,0.62,0.28] radius 120 intensity 0.9  corePower 3.6  haloFrac 0.65
  //   ARC    aliased to THROWN.
};

/**
 * The AttackType whose projectiles emit NO traveling light. SHIELD bashes are a
 * melee pulse (server `ShieldAttackHandler` spawns no `Projectile` entity —
 * verified), so a SHIELD-affinity projectile should never appear. If one
 * somehow does, {@link getProjectileLight} returns null so the populator skips
 * it (no traveling disk for a melee pulse).
 */
export const SHIELD_ATTACK_TYPE: AttackType = AttackType.SHIELD;

/**
 * The fallback AttackType when `weaponType` is unknown / unresolvable. Mirrors
 * the shared `resolveAttackType` helper (`AnimTiming.ts:25`) which falls back to
 * ARC.
 *
 * Ticket 09 (A3): the fallback is THROWN (a physical throw), which under the
 * RANGED-only ruling resolves to NULL — an unknown/unresolvable weapon emits NO
 * traveling light. This is the conservative, ruling-aligned choice: better
 * inert than wrong (a mystery weapon shouldn't glow as a stray arrow streak).
 * The fallback still never throws; it just produces a null light.
 */
export const FALLBACK_ATTACK_TYPE: AttackType = AttackType.THROWN;

/**
 * The default entry used when the registry lookup fails (unknown weaponType).
 *
 * Ticket 09 (A3): under the RANGED-only ruling this is now NULL — an unknown
 * weaponType resolves to the THROWN fallback (a physical throw), which emits no
 * traveling light. Kept as an exported constant (null) so the Seam-A test can
 * assert the fallback is consistently null (no surprise glow on a mystery
 * weapon). Pre-ticket-09 this was the THROWN entry (a warm-ember glow); the
 * ruling removed it.
 */
export const FALLBACK_PROJECTILE_LIGHT: ProjectileLightEntry | null = null;

/**
 * A green-tinted poison override entry, ready to wire when a poison discriminator
 * exists on weapons. The weapon registry has NO `element`/`affinity`/`poison`
 * field today (verified — `WeaponDefinition` in `packages/shared/src/weapons/
 * Weapon.ts` carries only kinetic + durability stats), so there is no automatic
 * green path yet. When poison weapons land, the populator can call
 * {@link getProjectileLight} with a poison flag OR add a `POISON_WEAPON_TYPES`
 * set here + branch in {@link resolveAttackTypeForProjectile}. Exported so the
 * Seam-A test documents the ready hook (the entry is distinct from every
 * kinetic entry — green, light_03 cookie).
 *
 * Rationale: research §4 — "poison=green" is the observed ARPG per-element color
 * convention; light_03 is the existing poison cookie (`LightPalette.poison`).
 */
export const POISON_OVERRIDE: ProjectileLightEntry = {
  attackType: AttackType.THROWN, // poison delivery is typically thrown (bomb/flask).
  color: [0.5, 1.0, 0.4], // green (matches LightPalette.poison).
  radius: 96,
  intensity: 0.8,
  corePower: 4.0,
  haloFrac: 0.6,
  specPower: 26.0,
  cookieOn: COOKIE_POISON, // light_03 — the poison radial.
};

/**
 * Resolve the light tuning for a given AttackType. DETERMINISTIC.
 *
 * Ticket 09 (A3 — RANGED-only ruling): only RANGED resolves to a non-null
 * tuning. Every other AttackType (LINE / THROWN / ARC / SHIELD, plus the
 * THROWN fallback for unknown weaponTypes) returns null — the populator's
 * `tuning === null` check skips the light entirely (and auto-gates the trail,
 * which is emitted inside the same block). Verified by the populator read at
 * `DynamicLightPopulator.ts:313-314`.
 *
 * @param attackType  the resolved AttackType (from {@link resolveAttackTypeForProjectile}).
 * @returns the RANGED tuning entry, or null for every other AttackType (skip
 *          the light entirely — no traveling disk for a physical throw / melee
 *          pulse / unknown weapon).
 */
export function getProjectileLight(attackType: AttackType): ProjectileLightEntry | null {
  // Ticket 09: the table is RANGED-only; every other key is absent. The
  // `?? FALLBACK_PROJECTILE_LIGHT` (null) is belt-and-braces — an unknown
  // AttackType (shouldn't happen — the enum is closed) also resolves to null
  // (no surprise glow on a mystery weapon).
  return PROJECTILE_LIGHT_TABLE[attackType] ?? FALLBACK_PROJECTILE_LIGHT;
}

/**
 * Resolve a projectile's AttackType from its `weaponType`, defensively.
 *
 * Mirrors the renderer's existing pattern (`EntityRendererProjectiles.ts:49-53`
 * + the shared `resolveAttackType` helper, `AnimTiming.ts:25`): look the weapon
 * up in the registry, read `baseStats.attackType`. The lookup is wrapped in
 * try/catch like the renderer — an unknown weaponType falls back to
 * {@link FALLBACK_ATTACK_TYPE} (THROWN), never throws. The server
 * `ProjectileSchema` does NOT carry `attackType` over the wire (only
 * `weaponType`), so this client-side resolution is the clean path (no schema
 * change, no new network traffic).
 *
 * DETERMINISTIC: same weaponType → same AttackType, always.
 */
export function resolveAttackTypeForProjectile(weaponType: number): AttackType {
  try {
    const def = weaponRegistry.getDefinition(weaponType as WeaponType);
    return def.baseStats.attackType;
  } catch {
    return FALLBACK_ATTACK_TYPE;
  }
}

// ── Trail ring buffer ──────────────────────────────────────────────────────

/**
 * The dim factors for the trailing lights behind a projectile head. Index 0 is
 * the OLDEST recorded past position (dimmest); the last is the most-recent past
 * position (brightest of the trail, still dimmer than the head). Two trailing
 * lights gives a clear streak without tripling the projectile light count: a
 * head + 2 trail = 3 lights per projectile. With the budget trimming
 * `LIGHT_PRIORITY.PROJECTILE` (priority 2, below STATIC/scatter) before props,
 * this stays budget-safe in a busy scene (documented in the populator).
 *
 * Values: ×0.5 (most-recent past), ×0.25 (older past). Fades quickly — the
 * streak reads as motion, not a persistent tail.
 */
export const TRAIL_DIM_FACTORS: readonly number[] = [0.5, 0.25];

/**
 * The max number of trailing positions remembered per projectile. Equals
 * {@link TRAIL_DIM_FACTORS}.length so each remembered position emits exactly one
 * trailing light. Capped to keep per-projectile memory bounded.
 */
export const TRAIL_MAX_POSITIONS = TRAIL_DIM_FACTORS.length;

/**
 * One projectile's trail state: a small ring buffer of past head positions
 * (oldest at index 0). The buffer is filled frame-by-frame by
 * {@link ProjectileTrailBuffer.record} and read by the populator to emit the
 * trailing lights.
 */
interface TrailState {
  /** Past head positions, oldest first. Length ≤ {@link TRAIL_MAX_POSITIONS}. */
  positions: { x: number; y: number }[];
}

/**
 * A per-projectile ring buffer of past head positions, keyed by projectile id.
 * Used by the populator to streak 2 fade-trailing lights behind each
 * projectile's head. Capped at {@link MAX_TRAIL_PROJECTILES} entries to bound
 * memory; dead projectiles are cleaned each frame ({@link collectTrailPositions}
 * drops ids not in the live set). Zero-allocation steady state: the buffer
 * reuses its internal arrays across frames (positions are mutated in place).
 */
export class ProjectileTrailBuffer {
  private readonly entries = new Map<string, TrailState>();
  /**
   * Cap on tracked projectiles. The on-screen projectile count is bounded by the
   * match (≤64 players, each with at most a handful of live projectiles), so a
   * generous cap that we never expect to hit. If exceeded, the oldest entry is
   * evicted (simple cap — the budget pass trims the visual anyway).
   */
  static readonly MAX_TRAIL_PROJECTILES = 256;

  /**
   * Record a projectile's head position this frame. The buffer keeps the last
   * {@link TRAIL_MAX_POSITIONS} positions per id; older positions roll off. Call
   * once per projectile per frame, BEFORE emitting the head light.
   */
  record(id: string, x: number, y: number): void {
    let st = this.entries.get(id);
    if (st === undefined) {
      if (this.entries.size >= ProjectileTrailBuffer.MAX_TRAIL_PROJECTILES) {
        // Cap reached: evict the first inserted entry (Map preserves insertion
        // order). Avoids unbounded growth if ids churn faster than cleanup.
        const firstId = this.entries.keys().next().value;
        if (firstId !== undefined) this.entries.delete(firstId);
      }
      st = { positions: [] };
      this.entries.set(id, st);
    }
    const positions = st.positions;
    // Slide the window: drop the oldest once full, then append the new position.
    // Mutates the same backing array (zero-alloc steady state).
    if (positions.length >= TRAIL_MAX_POSITIONS) {
      positions.shift();
    }
    positions.push({ x, y });
  }

  /**
   * Emit trailing-light descriptors for the given projectile id: the past head
   * positions (oldest first), each paired with its dim factor. The newest past
   * position is paired with the BRIGHTEST dim factor so the trail fades tail-off
   * behind the head.
   *
   * Returns a FRESH array each call (small — ≤ {@link TRAIL_MAX_POSITIONS}
   * entries) so callers can hold multiple results without aliasing. The per-call
   * allocation is negligible (the populator already allocates per light via
   * `cloneLight`; a 2-entry trail array per projectile is the same order), and
   * a fresh return avoids the aliasing footgun a reused buffer would create
   * (the populator emits trail lights inside its projectile loop, but a reused
   * buffer would corrupt if any caller held two `collect` results at once).
   *
   * Entries are oldest→newest so the populator emits the trail tail→head; each
   * entry's dim factor matches the research convention (most-recent past =
   * brightest trail light).
   */
  collect(id: string): ReadonlyArray<{ x: number; y: number; dim: number }> {
    const st = this.entries.get(id);
    if (st === undefined || st.positions.length === 0) return TRAIL_EMPTY_OUT;
    const positions = st.positions;
    const n = positions.length;
    // Trail factors are ordered [mostRecentPast=0.5, olderPast=0.25]. The
    // positions array is oldest→newest, so the LAST position pairs with the
    // BRIGHTEST factor (TRAIL_DIM_FACTORS[0]). We emit oldest→newest so the
    // caller's trail reads tail→head; the dim factor for position i (from the
    // end) is TRAIL_DIM_FACTORS[n-1-i].
    const out: { x: number; y: number; dim: number }[] = [];
    for (let i = 0; i < n; i++) {
      const pos = positions[i]!;
      const dimIdx = n - 1 - i;
      const dim = dimIdx < TRAIL_DIM_FACTORS.length ? TRAIL_DIM_FACTORS[dimIdx]! : 0;
      out.push({ x: pos.x, y: pos.y, dim });
    }
    return out;
  }

  /**
   * Drop trail state for projectile ids no longer in the live set. Call once
   * per frame AFTER iterating the live projectiles — prevents the buffer from
   * leaking dead ids (a projectile that despawns would otherwise keep its last
   * few positions forever). DETERMINISTIC given the live set.
   */
  pruneDead(liveIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) {
        this.entries.delete(id);
      }
    }
  }

  /** Test/diagnostics: current number of tracked projectiles. */
  get size(): number {
    return this.entries.size;
  }
}

/** Stable empty return for un-tracked ids (no allocation). */
const TRAIL_EMPTY_OUT: ReadonlyArray<{ x: number; y: number; dim: number }> = Object.freeze([]);

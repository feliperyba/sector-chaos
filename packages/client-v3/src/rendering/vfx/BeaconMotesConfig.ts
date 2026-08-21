/**
 * BeaconMotesConfig — pure-logic constants + orbit math for the beacon
 * particle system's INNER tier (the "spark motes": bright, tight-orbit
 * dust near the crystal). Map-polish ticket 02 introduced the motes
 * ("cool but subtle particles slowly orbit every hero + fortress beacon
 * crystal"); map-polish ticket 17 (round 2) made particles a first-class
 * artistic layer — see `BeaconMotesTiers.ts` for the OUTER dust tier + the
 * rare pulse-ring/ember accents, and `BeaconMotesVFX.ts` for the renderer.
 * Map-polish ticket 30 (round 3) moved the whole composition ABOVE the
 * lighting composite (the wash fix — layer, not alpha) and re-pinned these
 * bands for the slot-0 composite.
 *
 * This module is Phaser-free (the `LightingAtmosphereConfig` pattern) so the
 * vitest regression guard can assert the tuning band, the determinism and the
 * budget/culling contracts WITHOUT booting Phaser (which needs a canvas —
 * unavailable under jsdom). The Phaser-dependent `BeaconMotesVFX` class
 * consumes only what is exported here.
 *
 * ── Determinism / ADR-0035 stream contract ──
 *
 * Decorative VFX consumes NO ADR-0035 avalanche stream: the per-mote phase /
 * radius / speed / alpha / bob / size derive from a PURE integer hash of
 * `(tileX, tileY, moteIndex, salt)` (the `atmosphereSeed`
 * LightingAtmosphereConfig.ts:141-144 / `flickerSeedForPlacement`
 * LightPacker.ts:193-200 discipline). NO `Math.random`, NO RNG-stream draws —
 * same map ⇒ identical mote layout on every client. Because the hash inputs
 * are already-synced ids — `MapData.landmarks.heroes[].{tileX,tileY}` plus
 * the fortress beacon's light placement (see
 * `findFortressBeaconPlacement`; the client `MapDataMessage` carries the
 * fortress only via its `kind:'beacon'` light placement) — there is NO new
 * network state, NO MapData/serialized-shape change and no light-budget
 * impact: the motes submit no dynamic light (brightness sits under the
 * player-VFX floor trivially, capped by the alpha band).
 *
 * ── Mote tint contract (follows the beacon's FINAL color) ──
 *
 * The tint is derived from the per-anchor beacon color the LIGHT renders with
 * — `hero.beacon.color` / `fortress.beacon.color` on the synced MapData (after
 * map-polish ticket 03: the sector-theme color from `BEACON_THEME_LIGHT`, RARE
 * violet for the Citadel vault) — NEVER from a loot tier and NEVER from a
 * local copy of the color table (ticket 15 retunes `BEACON_THEME_LIGHT`; the
 * derivation in `moteTintWith` is functional over WHATEVER color arrives, so
 * it survives that retune unchanged). The brighten fraction is per-tier
 * (sparks whiter so they read against the glow, outer dust more saturated).
 */
import type { LandmarkAssignment, LightPlacementTiled } from '@sector-battle/shared';

/** Full circle, in radians. */
export const TAU = Math.PI * 2;

// ─── Tuning (ticket 02 bands, retuned ticket 17; the regression guard pins it) ─

/** Spark motes per beacon crystal. 17 anchors × 10 = 170 dots map-wide. */
export const MOTES_PER_BEACON = 10;

/** Hero anchors per map (one per sector, 4×4 — DEC-002). */
export const HERO_ANCHOR_COUNT = 16;

/**
 * Hard anchor cap (16 hero + 1 fortress; minor landmark markers EXCLUDED —
 * they are junction markers, not destinations). Defensive: the real map never
 * exceeds it, but a cap here makes the ≤170-spark budget a structural
 * guarantee, not a data coincidence.
 */
export const MAX_ANCHORS = 17;

/** Total SPARK-mote budget map-wide (MAX_ANCHORS × MOTES_PER_BEACON). */
export const MAX_TOTAL_MOTES = MAX_ANCHORS * MOTES_PER_BEACON; // 170

/** Orbit radius band (world px) — 0.5–1 tile around the crystal (@128 tile). */
export const ORBIT_RADIUS_MIN = 64;
export const ORBIT_RADIUS_MAX = 128;

/**
 * Angular speed band (rad/s). 0.05 → a full orbit in ≈2.1 min, 0.12 → ≈52 s
 * — the "a full orbit takes ≈1–2 minutes" slow halo, never a swarm.
 */
export const ORBIT_SPEED_MIN = 0.05;
export const ORBIT_SPEED_MAX = 0.12;

/** Vertical bob amplitude band (px) — "slight vertical bob (±4–8 px)". */
export const BOB_AMPLITUDE_MIN = 4;
export const BOB_AMPLITUDE_MAX = 8;

/**
 * Vertical bob frequency band (Hz → period ≈2.2–5 s). A serene float, much
 * slower than the fire-DOT aura bob (ParticleVFX `now/200` ≈ 0.8 Hz) — beacons
 * breathe, they do not gutter.
 */
export const BOB_FREQ_MIN = 0.2;
export const BOB_FREQ_MAX = 0.45;

/**
 * Mote size band (px). SIZE is the `fillCircle` RADIUS — the atmosphere
 * prototype's `g.fillCircle(x, y, size)` convention (LightingAtmosphereConfig
 * `PARTICLE_TEXTURE_PX` note: prototype size = radius). Ticket 17 raised the
 * band (was 1–2.5): 2px-wide dots vanished under the glow even post-wash-fix.
 * Ticket 30 raises it again (2.5–4.5): now that the motes composite OVER the
 * lit glow (slot-0 path, see BeaconMotesVFX) the sparks are the primary
 * "glinting" read and must carry a confident dot at a glance.
 */
export const MOTE_SIZE_MIN = 2.5;
export const MOTE_SIZE_MAX = 4.5;

/**
 * Alpha band — the SLOT-0 (above-composite) draw alpha, NOT the on-screen
 * presence. The scene texture stores premultiplied pixels and the Final
 * filter composites `mix(mapped, scene.rgb, scene.a)`, so effective presence
 * = α² (BeaconMotesVFX header): 0.55–0.95 reads as a 0.30–0.90 lerp toward
 * the spark tint — the ticket-30 "modest numbers, do not blind" band.
 * History: ticket 02 pinned 0.12–0.30 ("subtle"); ticket 17 raised to
 * 0.35–0.80 for the in-albedo ADD read; ticket 30 moves the layer above the
 * composite and re-pins the band for the quadratic slot-0 composite. The
 * outer-dust tier stays faint (BeaconMotesTiers).
 */
export const MOTE_ALPHA_MIN = 0.55;
export const MOTE_ALPHA_MAX = 0.95;

/**
 * Fraction the SPARK tint is brightened toward white from the anchor's beacon
 * color ("tint = the beacon's FINAL color brightened ≈30% toward white" —
 * ticket 02; ticket 17 → 0.45; ticket 30 → 0.6: over the composite the spark
 * LERPs toward its tint rather than adding over it, so a whiter derivation
 * keeps the glint read). Per-tier values live with their tiers (see
 * `DUST_TINT_BRIGHTEN` / `ACCENT_TINT_BRIGHTEN` in BeaconMotesTiers.ts).
 */
export const MOTE_TINT_BRIGHTEN = 0.6;

// ─── The pure per-mote hash ───────────────────────────────────────────────────

/**
 * Salts decoupling each per-mote parameter's hash so phase/radius/speed/
 * alpha/bob/size never correlate (murmur3 finalizer constants — good mixing).
 */
const SALT_PHASE = 0x6d746570; // "metp"
const SALT_RADIUS = 0x9e3779b9;
const SALT_SPEED = 0x85ebca6b;
const SALT_ALPHA = 0xc2b2ae35;
const SALT_SIZE = 0x27d4eb2f;
const SALT_BOB = 0x165667b1;

/**
 * Deterministic hash of `(tileX, tileY, index, salt)` → [0,1). The
 * `placementHash01` integer-hash pattern (LightPacker.ts:208-213): distinct
 * prime multipliers per input, one avalanche round. All operations are int32
 * after coercion → bit-stable across clients/runs. Pure: same inputs, same
 * output, no RNG, no state.
 */
export function moteHash01(tileX: number, tileY: number, index: number, salt: number): number {
  let h = (tileX * 374761393) ^ (tileY * 668265263) ^ (index * 1274126177) ^ (salt * 2147483647);
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h % 1_000_000) / 1_000_000;
}

/** Per-mote orbit start angle [0, 2π). */
export function motePhase(tileX: number, tileY: number, index: number): number {
  return moteHash01(tileX, tileY, index, SALT_PHASE) * TAU;
}

/** Per-mote orbit radius [64, 128] px. */
export function moteOrbitRadius(tileX: number, tileY: number, index: number): number {
  return (
    ORBIT_RADIUS_MIN +
    moteHash01(tileX, tileY, index, SALT_RADIUS) * (ORBIT_RADIUS_MAX - ORBIT_RADIUS_MIN)
  );
}

/** Per-mote angular speed [0.05, 0.12] rad/s. */
export function moteSpeed(tileX: number, tileY: number, index: number): number {
  return (
    ORBIT_SPEED_MIN +
    moteHash01(tileX, tileY, index, SALT_SPEED) * (ORBIT_SPEED_MAX - ORBIT_SPEED_MIN)
  );
}

/** Per-mote alpha [0.55, 0.95] (ticket 30 above-composite band; was 0.35–0.80). */
export function moteAlpha(tileX: number, tileY: number, index: number): number {
  return (
    MOTE_ALPHA_MIN + moteHash01(tileX, tileY, index, SALT_ALPHA) * (MOTE_ALPHA_MAX - MOTE_ALPHA_MIN)
  );
}

/** Per-mote fillCircle radius [2.5, 4.5] px (ticket 30 raise; was 1.5–3). */
export function moteSize(tileX: number, tileY: number, index: number): number {
  return (
    MOTE_SIZE_MIN + moteHash01(tileX, tileY, index, SALT_SIZE) * (MOTE_SIZE_MAX - MOTE_SIZE_MIN)
  );
}

/** Per-mote bob amplitude [4, 8] px. */
export function moteBobAmplitude(tileX: number, tileY: number, index: number): number {
  return (
    BOB_AMPLITUDE_MIN +
    moteHash01(tileX, tileY, index, SALT_BOB) * (BOB_AMPLITUDE_MAX - BOB_AMPLITUDE_MIN)
  );
}

/** Per-mote bob start phase [0, 2π) — bobs never sync across motes/anchors. */
export function moteBobPhase(tileX: number, tileY: number, index: number): number {
  return moteHash01(tileY, tileX, index, SALT_PHASE) * TAU;
}

/** Per-mote bob frequency [0.2, 0.45] Hz. */
export function moteBobFreq(tileX: number, tileY: number, index: number): number {
  return BOB_FREQ_MIN + moteHash01(tileY, tileX, index, SALT_BOB) * (BOB_FREQ_MAX - BOB_FREQ_MIN);
}

// ─── Packed per-anchor param layout (the pre-allocated array contract) ───────

/** Float64 slots per mote in the per-anchor packed params array. */
export const MOTE_PARAM_STRIDE = 8;
/** Slot offsets inside one mote's stride (fillMoteParams owns the layout). */
export const MOTE_PHASE_OFFSET = 0;
export const MOTE_RADIUS_OFFSET = 1;
export const MOTE_SPEED_OFFSET = 2;
export const MOTE_ALPHA_OFFSET = 3;
export const MOTE_SIZE_OFFSET = 4;
export const MOTE_BOB_AMPLITUDE_OFFSET = 5;
export const MOTE_BOB_FREQ_OFFSET = 6;
export const MOTE_BOB_PHASE_OFFSET = 7;

/**
 * Fill one anchor's packed mote-param array (`MOTES_PER_BEACON ×
 * MOTE_PARAM_STRIDE` Float64 slots). Called ONCE per anchor at anchor-feed
 * time (never per frame) — the renderer reads the packed array in its
 * steady-state update with zero allocation. Pure function of
 * `(tileX, tileY)`.
 */
export function fillMoteParams(tileX: number, tileY: number, out: Float64Array): void {
  for (let i = 0; i < MOTES_PER_BEACON; i++) {
    const o = i * MOTE_PARAM_STRIDE;
    out[o + MOTE_PHASE_OFFSET] = motePhase(tileX, tileY, i);
    out[o + MOTE_RADIUS_OFFSET] = moteOrbitRadius(tileX, tileY, i);
    out[o + MOTE_SPEED_OFFSET] = moteSpeed(tileX, tileY, i);
    out[o + MOTE_ALPHA_OFFSET] = moteAlpha(tileX, tileY, i);
    out[o + MOTE_SIZE_OFFSET] = moteSize(tileX, tileY, i);
    out[o + MOTE_BOB_AMPLITUDE_OFFSET] = moteBobAmplitude(tileX, tileY, i);
    out[o + MOTE_BOB_FREQ_OFFSET] = moteBobFreq(tileX, tileY, i);
    out[o + MOTE_BOB_PHASE_OFFSET] = moteBobPhase(tileX, tileY, i);
  }
}

// ─── Tint (the beacon's FINAL color, brightened toward white) ────────────────

/**
 * Convert an anchor's beacon color (linear-ish 0..1 RGB triplet, the same
 * `beacon.color` the light pipeline renders) into a 0xRRGGBB Graphics tint,
 * each channel lifted toward white by `brighten` (`c' = c + brighten·(1−c)`).
 * Clamped to [0,255] per channel. Pure — THE single tint-derivation site for
 * every particle tier (parameterized so the per-tier brighten fractions never
 * fork the math; the color table itself is never duplicated).
 */
export function moteTintWith(color: readonly [number, number, number], brighten: number): number {
  const lift = (c: number): number =>
    Math.max(0, Math.min(255, Math.round((c + (1 - c) * brighten) * 255)));
  return (lift(color[0]!) << 16) | (lift(color[1]!) << 8) | lift(color[2]!);
}

/**
 * The SPARK-tier tint (the anchor's beacon color brightened
 * {@link MOTE_TINT_BRIGHTEN} toward white).
 */
export function moteTint(color: readonly [number, number, number]): number {
  return moteTintWith(color, MOTE_TINT_BRIGHTEN);
}

// ─── Anchor derivation (from the synced MapData) ─────────────────────────────

/**
 * One mote-orbiting anchor: a beacon crystal's tile + its FINAL light color.
 */
export interface BeaconAnchorSpec {
  tileX: number;
  tileY: number;
  /** The per-anchor beacon color the LIGHT renders with (never a tier lookup). */
  color: readonly [number, number, number];
}

/**
 * Resolve the FORTRESS beacon anchor from the synced light placements.
 *
 * Why placements: the client wire `MapDataMessage` carries the fortress ONLY
 * through its beacon light placement (the server-side `MapData.fortress` is
 * never serialized to the client). The beacon placements appended by
 * `LandmarkBeaconPlacer`/`SeedMapAdapter` are: 16 hero beacons (pulse true) +
 * 2–3 minor markers (steady, `pulse` FALSE — a junction node is not a
 * destination) + exactly 1 fortress beacon (pulse true). So the fortress
 * anchor is the first `kind === 'beacon'` placement that pulses and does NOT
 * sit on a hero anchor tile. Its `color` is the synced per-anchor beacon
 * color (the sector-theme color for standard compounds, RARE violet for the
 * Citadel) — the same color the light renders with.
 *
 * Pure; returns null when no fortress placement exists (demo maps).
 */
export function findFortressBeaconPlacement(
  landmarks: LandmarkAssignment | null | undefined,
  placements: ReadonlyArray<LightPlacementTiled> | null | undefined,
): LightPlacementTiled | null {
  if (!placements) return null;
  const heroTiles = new Set<string>();
  if (landmarks?.heroes) {
    for (const row of landmarks.heroes) {
      for (const hero of row ?? []) {
        if (hero) heroTiles.add(`${hero.tileY},${hero.tileX}`);
      }
    }
  }
  for (const p of placements) {
    if (!p || p.kind !== 'beacon' || p.pulse !== true || !p.color) continue;
    if (heroTiles.has(`${p.gridY},${p.gridX}`)) continue; // a hero beacon
    return p; // the one fortress beacon
  }
  return null;
}

/**
 * Collect the mote anchors: every hero beacon (`MapData.landmarks.heroes` —
 * the same synced data `bakeLandmarkComposites` consumes) plus the fortress
 * beacon (`findFortressBeaconPlacement` over the synced light placements).
 * Minor landmark markers are EXCLUDED by design (they are junction markers,
 * not destinations). Capped at {@link MAX_ANCHORS} so the ≤170-mote budget is
 * structural. Pure — the renderer calls this once when the map data arrives.
 */
export function collectBeaconAnchors(
  landmarks: LandmarkAssignment | null | undefined,
  fortressPlacement: LightPlacementTiled | null | undefined,
): BeaconAnchorSpec[] {
  const anchors: BeaconAnchorSpec[] = [];
  if (landmarks?.heroes) {
    for (const row of landmarks.heroes) {
      for (const hero of row ?? []) {
        if (anchors.length >= MAX_ANCHORS) return anchors; // defensive cap
        if (!hero) continue;
        anchors.push({ tileX: hero.tileX, tileY: hero.tileY, color: hero.beacon.color });
      }
    }
  }
  if (fortressPlacement?.color && anchors.length < MAX_ANCHORS) {
    anchors.push({
      tileX: fortressPlacement.gridX,
      tileY: fortressPlacement.gridY,
      color: fortressPlacement.color,
    });
  }
  return anchors;
}

// ─── Camera-rect culling ─────────────────────────────────────────────────────
// The culling margin now spans the UNION of every tier's reach (sparks here +
// outer dust + the ring/ember accents in BeaconMotesTiers.ts), so the margin
// constant + the `isAnchorInView` predicate live in BeaconMotesTiers.ts next
// to the tiers that define the reach.

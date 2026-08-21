/**
 * BeaconMotesTiers — the OUTER tiers of the beacon particle system
 * (map-polish ticket 17: "particles become a first-class artistic layer").
 *
 * Ticket 02 shipped ONE subtle tier (the inner spark motes — see
 * `BeaconMotesConfig.ts`). Ticket 17 builds the full composition around
 * them, all rendered by the same single Graphics in `BeaconMotesVFX`.
 * Ticket 30 (round 3 — "washed away by the crystal light") moves the whole
 * composition ABOVE the lighting composite and re-pins the alpha bands for
 * the premultiplied slot-0 composite (see BeaconMotesVFX's header):
 *
 *   INNER SPARKS (BeaconMotesConfig)  bright tight-orbit motes near the
 *                                      crystal — the glinting core halo.
 *   OUTER DUST     (this file)        slower, larger, FAINTER motes drifting
 *                                      1.25–2.25 tiles out — colored haze in
 *                                      the moody mid falloff (where the
 *                                      ticket-17 light retune concentrates
 *                                      the mood).
 *   PULSE RING     (this file)        a rare accent — a soft expanding ring
 *                                      breathing off the crystal every 8–13 s.
 *   EMBER STREAK   (this file)        a rare accent — every 11–16 s a single
 *                                      ember spirals up out of the crystal
 *                                      with a fading trail.
 *
 * Phaser-free pure math (the `LightingAtmosphereConfig` pattern) so the
 * vitest guard pins every band + the closed-form determinism without a
 * canvas. Everything derives from the SAME pure integer hash
 * (`moteHash01`) of `(tileX, tileY, index, salt)` as the sparks — NO
 * `Math.random`, NO RNG streams (ADR-0035), so same map ⇒ identical
 * composition on every client. The ring + ember are CLOSED-FORM functions of
 * `(tileX, tileY, elapsed)`: their schedule/geometry write into caller-owned
 * scratch records, so the renderer's steady state performs ZERO allocations
 * (not even a per-frame object literal).
 *
 * Tint: every tier tints from the anchor's FINAL beacon color via
 * `moteTintWith` — dust more SATURATED (lower brighten — colored haze, not
 * white specks), accents brighter (they must read at a glance). No color
 * table is duplicated here (ticket 15 retunes `BEACON_THEME_LIGHT`; these
 * derivations survive it unchanged).
 */
import {
  BOB_AMPLITUDE_MAX,
  MAX_ANCHORS,
  MOTE_ALPHA_OFFSET,
  MOTE_BOB_AMPLITUDE_OFFSET,
  MOTE_BOB_FREQ_OFFSET,
  MOTE_BOB_PHASE_OFFSET,
  MOTE_PARAM_STRIDE,
  MOTE_PHASE_OFFSET,
  MOTE_RADIUS_OFFSET,
  MOTE_SIZE_MAX,
  MOTE_SIZE_OFFSET,
  MOTE_SPEED_OFFSET,
  ORBIT_RADIUS_MAX,
  TAU,
  moteHash01,
} from './BeaconMotesConfig.js';

// ─── OUTER DUST — slower, larger, fainter drift 1.25–2.25 tiles out ──────────

/** Dust motes per beacon crystal (12 × 17 anchors = 204 map-wide). */
export const DUST_PER_BEACON = 12;

/** Total OUTER-DUST budget map-wide (MAX_ANCHORS × DUST_PER_BEACON). */
export const DUST_TOTAL_MOTES = MAX_ANCHORS * DUST_PER_BEACON; // 204

/** Dust orbit radius band (world px) — out in the moody mid-falloff band. */
export const DUST_ORBIT_RADIUS_MIN = 160;
export const DUST_ORBIT_RADIUS_MAX = 288;

/**
 * Dust angular speed band (rad/s) — a full drift takes 2.6–7 MINUTES. The
 * dust reads as suspension hanging in the glow, not as orbiting particles
 * (the sparks own "orbit"; the dust owns "atmosphere").
 */
export const DUST_ORBIT_SPEED_MIN = 0.015;
export const DUST_ORBIT_SPEED_MAX = 0.04;

/** Dust vertical bob amplitude band (px) — wider than the sparks' ±4–8. */
export const DUST_BOB_AMPLITUDE_MIN = 6;
export const DUST_BOB_AMPLITUDE_MAX = 14;

/** Dust bob frequency band (Hz → period 5–12.5 s) — slower than the sparks'. */
export const DUST_BOB_FREQ_MIN = 0.08;
export const DUST_BOB_FREQ_MAX = 0.2;

/** Dust size band (px, fillCircle RADIUS) — larger + softer than the sparks. */
export const DUST_SIZE_MIN = 3.5;
export const DUST_SIZE_MAX = 8;

/**
 * Dust alpha band — the FAINT tier ("slower, larger, fainter outer dust"),
 * stored as the SLOT-0 draw alpha: the scene texture is premultiplied and
 * the Final composite is `mix(mapped, scene.rgb, scene.a)`, so effective
 * presence = α² (BeaconMotesVFX header). Ticket 30's intended on-screen
 * presence for the haze is 0.10–0.20 (double ticket-17's in-albedo
 * 0.05–0.14, which the wash ate) — the stored band is √-compensated to
 * 0.32–0.45 so α² lands exactly on that intent. Still fainter than every
 * spark (band ordering gate in the regression guard).
 */
export const DUST_ALPHA_MIN = 0.32;
export const DUST_ALPHA_MAX = 0.45;

/**
 * Fraction the DUST tint is brightened toward white from the anchor's beacon
 * color — deliberately LOW so the haze carries the beacon's HUE (saturated
 * colored dust) instead of reading as generic white specks.
 */
export const DUST_TINT_BRIGHTEN = 0.15;

/** Salts for the dust tier's per-mote hashes (never correlate with the sparks). */
const SALT_DUST_PHASE = 0x64757374; // "dust"
const SALT_DUST_RADIUS = 0x9e3779b1;
const SALT_DUST_SPEED = 0x85ebca6d;
const SALT_DUST_ALPHA = 0xc2b2ae31;
const SALT_DUST_SIZE = 0x27d4eb2b;
const SALT_DUST_BOB = 0x165667b3;

/** Per-dust-mote orbit start angle [0, 2π). */
export function dustPhase(tileX: number, tileY: number, index: number): number {
  return moteHash01(tileX, tileY, index, SALT_DUST_PHASE) * TAU;
}

/** Per-dust-mote orbit radius [160, 288] px. */
export function dustOrbitRadius(tileX: number, tileY: number, index: number): number {
  return (
    DUST_ORBIT_RADIUS_MIN +
    moteHash01(tileX, tileY, index, SALT_DUST_RADIUS) *
      (DUST_ORBIT_RADIUS_MAX - DUST_ORBIT_RADIUS_MIN)
  );
}

/** Per-dust-mote angular speed [0.015, 0.04] rad/s. */
export function dustSpeed(tileX: number, tileY: number, index: number): number {
  return (
    DUST_ORBIT_SPEED_MIN +
    moteHash01(tileX, tileY, index, SALT_DUST_SPEED) * (DUST_ORBIT_SPEED_MAX - DUST_ORBIT_SPEED_MIN)
  );
}

/** Per-dust-mote alpha [0.32, 0.45] slot-0 draw (≈0.10–0.20 effective presence; see DUST_ALPHA_MIN). */
export function dustAlpha(tileX: number, tileY: number, index: number): number {
  return (
    DUST_ALPHA_MIN +
    moteHash01(tileX, tileY, index, SALT_DUST_ALPHA) * (DUST_ALPHA_MAX - DUST_ALPHA_MIN)
  );
}

/** Per-dust-mote fillCircle radius [3.5, 8] px. */
export function dustSize(tileX: number, tileY: number, index: number): number {
  return (
    DUST_SIZE_MIN +
    moteHash01(tileX, tileY, index, SALT_DUST_SIZE) * (DUST_SIZE_MAX - DUST_SIZE_MIN)
  );
}

/** Per-dust-mote bob amplitude [6, 14] px. */
export function dustBobAmplitude(tileX: number, tileY: number, index: number): number {
  return (
    DUST_BOB_AMPLITUDE_MIN +
    moteHash01(tileX, tileY, index, SALT_DUST_BOB) *
      (DUST_BOB_AMPLITUDE_MAX - DUST_BOB_AMPLITUDE_MIN)
  );
}

/** Per-dust-mote bob start phase [0, 2π). */
export function dustBobPhase(tileX: number, tileY: number, index: number): number {
  return moteHash01(tileY, tileX, index, SALT_DUST_PHASE) * TAU;
}

/** Per-dust-mote bob frequency [0.08, 0.2] Hz. */
export function dustBobFreq(tileX: number, tileY: number, index: number): number {
  return (
    DUST_BOB_FREQ_MIN +
    moteHash01(tileY, tileX, index, SALT_DUST_BOB) * (DUST_BOB_FREQ_MAX - DUST_BOB_FREQ_MIN)
  );
}

/**
 * Fill one anchor's packed dust-param array (`DUST_PER_BEACON ×
 * MOTE_PARAM_STRIDE` slots — the SAME slot layout the sparks use, imported
 * from BeaconMotesConfig so one renderer loop shape serves both tiers).
 * Called ONCE per anchor at feed time; pure function of `(tileX, tileY)`.
 */
export function fillDustParams(tileX: number, tileY: number, out: Float64Array): void {
  for (let i = 0; i < DUST_PER_BEACON; i++) {
    const o = i * MOTE_PARAM_STRIDE;
    out[o + MOTE_PHASE_OFFSET] = dustPhase(tileX, tileY, i);
    out[o + MOTE_RADIUS_OFFSET] = dustOrbitRadius(tileX, tileY, i);
    out[o + MOTE_SPEED_OFFSET] = dustSpeed(tileX, tileY, i);
    out[o + MOTE_ALPHA_OFFSET] = dustAlpha(tileX, tileY, i);
    out[o + MOTE_SIZE_OFFSET] = dustSize(tileX, tileY, i);
    out[o + MOTE_BOB_AMPLITUDE_OFFSET] = dustBobAmplitude(tileX, tileY, i);
    out[o + MOTE_BOB_FREQ_OFFSET] = dustBobFreq(tileX, tileY, i);
    out[o + MOTE_BOB_PHASE_OFFSET] = dustBobPhase(tileX, tileY, i);
  }
}

// ─── PULSE RING — a rare expanding breath off the crystal ────────────────────

/** Ring emission period band (seconds) — "rare": one ring every 8–13 s. */
export const RING_PERIOD_MIN = 8;
export const RING_PERIOD_MAX = 13;

/**
 * Ring expansion reach (world px) — 2.5 tiles: the ring is born at the
 * crystal and expands INTO the moody mid-falloff band, fading as it goes
 * (never approaching the 512 px light edge — the accent must read inside
 * the beacon's own glow, not as a shockwave).
 */
export const RING_RADIUS_MAX = 320;

/**
 * Peak ring stroke alpha (at birth, post fade-in) — the SLOT-0 draw alpha.
 * Ticket 30: the ring is the ONE accent the owner could see in the washed
 * state and it MUST stay visible over the composite; the premultiplied
 * slot-0 composite squares alpha (`mix(mapped, scene.rgb, scene.a)`), so the
 * 0.22 in-albedo peak is √-compensated to 0.45 (0.45² ≈ 0.20 effective —
 * the same on-screen presence, now CRISP over the glow instead of buried
 * under the light).
 */
export const RING_ALPHA_PEAK = 0.45;

/** Ring stroke width (px). */
export const RING_WIDTH = 2.5;

/** Fraction of the expansion spent fading IN (no hard birth pop). */
export const RING_FADE_IN = 0.12;

/**
 * Fraction the ACCENT tints (ring + ember) are brightened toward white from
 * the anchor's beacon color — the brightest derivation: accents are rare and
 * must read at a glance against the glow. Ticket 30: raised with the spark
 * band (0.45 → 0.6) so the accents stay the WHITEST derivation (0.65) — the
 * per-tier monotone contract (dust ≤ sparks ≤ accents) survives the retune,
 * and the whiter tint helps the accents read through the quadratic slot-0
 * composite.
 */
export const ACCENT_TINT_BRIGHTEN = 0.65;

const SALT_RING_PERIOD = 0x72696e67; // "ring"
const SALT_RING_PHASE = 0x6e677269;

/** Scratch record the ring evaluator writes into (caller-owned, reused). */
export interface RingEval {
  /** Current ring radius (world px, anchor-relative). */
  radius: number;
  /** Current ring stroke alpha (0 when the ring has fully faded at max reach). */
  alpha: number;
}

/**
 * Evaluate the anchor's pulse ring at elapsed time `t` seconds — CLOSED FORM
 * (no state): progress `p = ((t / period) + phaseHash) mod 1`, radius grows
 * linearly to {@link RING_RADIUS_MAX}, alpha fades with expansion and eases
 * in at birth. Pure + deterministic: writes into `out`, returns nothing.
 */
export function evalPulseRing(tileX: number, tileY: number, t: number, out: RingEval): void {
  const period =
    RING_PERIOD_MIN +
    moteHash01(tileX, tileY, 0, SALT_RING_PERIOD) * (RING_PERIOD_MAX - RING_PERIOD_MIN);
  const phase = moteHash01(tileX, tileY, 0, SALT_RING_PHASE);
  const p = (t / period + phase) % 1;
  out.radius = p * RING_RADIUS_MAX;
  const fadeIn = Math.min(1, p / RING_FADE_IN);
  out.alpha = RING_ALPHA_PEAK * (1 - p) * fadeIn;
}

// ─── EMBER STREAK — a rare spiraling spark with a fading trail ───────────────

/** Ember emission period band (seconds) — "rare": one ember every 11–16 s. */
export const EMBER_PERIOD_MIN = 11;
export const EMBER_PERIOD_MAX = 16;

/** Fraction of the period the ember is ALIVE (life ≈1.5–2.2 s). */
export const EMBER_LIFE_FRACTION = 0.14;

/** Ember spawn distance from the crystal (px — just outside the crystal rim). */
export const EMBER_RADIUS_START = 88;

/** Ember final distance from the crystal (px — out into the mid falloff). */
export const EMBER_RADIUS_END = 240;

/** Upward drift over the ember's life (px — embers RISE, they do not fall). */
export const EMBER_RISE = 40;

/** Spiral sweep over the ember's life (rad — a gentle curl, not a corkscrew). */
export const EMBER_SPIN = 1.1;

/**
 * Peak ember alpha (at mid-life; eased in/out via sin) — the SLOT-0 draw
 * alpha, √-compensated for the quadratic premultiplied composite (0.7² ≈
 * 0.49 effective presence ≈ the old in-albedo 0.5 peak; ticket 30).
 */
export const EMBER_ALPHA_PEAK = 0.7;

/**
 * Ember head dot radius (px) — ticket 30 raises it with the spark band
 * (the ember IS a spark; 1.8 px would read as nothing beside 2.5–4.5 px
 * orbit sparks).
 */
export const EMBER_HEAD_SIZE = 2.2;

/** Ember trail stroke width (px). */
export const EMBER_WIDTH = 2;

/** Trail sample count (closed-form past positions — no history buffer). */
export const EMBER_TRAIL_SEGMENTS = 6;

/** Seconds between trail samples (spacing in time, sampled at past τ). */
export const EMBER_TRAIL_DT = 0.05;

const SALT_EMBER_PERIOD = 0x656d6265; // "embe"
const SALT_EMBER_PHASE = 0x6d62656d;
const SALT_EMBER_ANGLE = 0x62656d62;

/** Scratch record the ember evaluators write into (caller-owned, reused). */
export interface EmberPoint {
  /** Anchor-relative x offset (world px). */
  dx: number;
  /** Anchor-relative y offset (world px). */
  dy: number;
}

/**
 * The ember's life-progress at elapsed time `t` seconds: `q` in [0,1) while
 * alive, or `-1` while dormant (most of the period). CLOSED FORM — pure.
 */
export function emberLifeProgress(tileX: number, tileY: number, t: number): number {
  const period = emberPeriod(tileX, tileY);
  const phase = moteHash01(tileX, tileY, 0, SALT_EMBER_PHASE);
  const p = (t / period + phase) % 1;
  if (p >= EMBER_LIFE_FRACTION) return -1;
  return p / EMBER_LIFE_FRACTION;
}

/** The anchor's ember period (seconds) — the hash-derived schedule. Pure. */
export function emberPeriod(tileX: number, tileY: number): number {
  return (
    EMBER_PERIOD_MIN +
    moteHash01(tileX, tileY, 0, SALT_EMBER_PERIOD) * (EMBER_PERIOD_MAX - EMBER_PERIOD_MIN)
  );
}

/** The anchor's ember LIFE window in seconds (period × life fraction). Pure. */
export function emberLifeSeconds(tileX: number, tileY: number): number {
  return emberPeriod(tileX, tileY) * EMBER_LIFE_FRACTION;
}

/**
 * The ember's anchor-relative position at life-progress `q` — CLOSED FORM
 * (the trail samples the SAME curve at past `q`, so no position history is
 * ever stored): radius eases from {@link EMBER_RADIUS_START} to
 * {@link EMBER_RADIUS_END}, the angle curls by {@link EMBER_SPIN}, and the
 * vertical rises quadratically (an ember floats up as it fades). Writes into
 * `out`; pure.
 */
export function emberPointAt(tileX: number, tileY: number, q: number, out: EmberPoint): void {
  const angle0 = moteHash01(tileX, tileY, 0, SALT_EMBER_ANGLE) * TAU;
  const r = EMBER_RADIUS_START + (EMBER_RADIUS_END - EMBER_RADIUS_START) * q;
  const a = angle0 + EMBER_SPIN * q;
  out.dx = Math.cos(a) * r;
  out.dy = Math.sin(a) * r - EMBER_RISE * q * q;
}

/** The ember's alpha envelope at life-progress `q` — sin ease-in/out. Pure. */
export function emberAlpha(q: number): number {
  return EMBER_ALPHA_PEAK * Math.sin(Math.PI * q);
}

// ─── Union culling — the camera-rect predicate over EVERY tier's reach ───────

/** Farthest the INNER SPARKS reach from their anchor (world px). */
const SPARK_REACH = ORBIT_RADIUS_MAX + BOB_AMPLITUDE_MAX + MOTE_SIZE_MAX;
/** Farthest the OUTER DUST reaches from its anchor (world px). */
const DUST_REACH = DUST_ORBIT_RADIUS_MAX + DUST_BOB_AMPLITUDE_MAX + DUST_SIZE_MAX;
/** Farthest the PULSE RING reaches (the stroke's outer half-width). */
const RING_REACH = RING_RADIUS_MAX + RING_WIDTH;
/** Farthest the EMBER STREAK reaches (final radius + rise + head size). */
const EMBER_REACH = EMBER_RADIUS_END + EMBER_RISE + EMBER_HEAD_SIZE;

/**
 * Camera-rect culling margin (world px): the FARTHEST any particle of ANY
 * tier can sit from its anchor, so an anchor this far OUTSIDE the view rect
 * can never contribute a visible dot. Anchors outside `view ⊕ CULL_MARGIN`
 * are skipped entirely (zero draw entries). Structural: it is computed from
 * the tier constants, so a future tier retune can never silently break the
 * culling bound.
 */
export const CULL_MARGIN = Math.max(SPARK_REACH, DUST_REACH, RING_REACH, EMBER_REACH);

/**
 * Whether an anchor at `(anchorX, anchorY)` world px can contribute a visible
 * particle this frame: the anchor must lie inside the camera's world view
 * rect expanded by {@link CULL_MARGIN}. Pure — the renderer's only culling
 * decision is this predicate.
 */
export function isAnchorInView(
  anchorX: number,
  anchorY: number,
  viewX: number,
  viewY: number,
  viewW: number,
  viewH: number,
): boolean {
  return (
    anchorX >= viewX - CULL_MARGIN &&
    anchorX <= viewX + viewW + CULL_MARGIN &&
    anchorY >= viewY - CULL_MARGIN &&
    anchorY <= viewY + viewH + CULL_MARGIN
  );
}

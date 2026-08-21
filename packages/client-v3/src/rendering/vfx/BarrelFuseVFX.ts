/**
 * BarrelFuseVFX — the escalating primed-barrel fire (juice-pass-1 ticket 06).
 *
 * VISUAL SPEC (ticket 01 Resolution §3, verbatim intent): escalating,
 * ambient-only. At prime: faint embers + (via BarrelFuseLightPopulator) a
 * subtle warm light. Over the 5 s fuse the fire builds to open flame and the
 * glow brightens toward detonation — the escalation itself is the
 * player-readable fuse ("bright = leave now"). NO numeric countdown, ring, or
 * other readout on the world prop.
 *
 * SERVER-STATE DRIVEN, ZERO GAMEPLAY IMPACT: the effect renders ONLY what the
 * synced schema says. `syncPrimed` is fed from the destructible add/update
 * handlers (EntityRendererWorld) with the live `DestructibleState`; the
 * per-frame escalation is keyed off remaining fuse = synced absolute expiry
 * tick − the client's synced server-tick notion (`StateSync.getTick()`, the
 * same live-tick source the HUD power-up countdowns use). There is NO
 * client-side fuse timer to guess or drift. When the server detonates the
 * barrel, the schema removal fires `onRemove` (the destructible renderer's
 * destroy path) and the visuals stop that frame.
 *
 * RENDER SHAPE (the fire-DOT follow-the-entity pattern, `ParticleVFX.ts`
 * 250-265 + `updateFireDotPositions`): one shared Graphics object, cleared +
 * redrawn per frame — zero sprites allocated, so the shared SpritePool is
 * injected purely for lifecycle uniformity (ticket 52; same documented-unused
 * pattern as ParticleVFX/DestructionVFX). Deterministic per-barrel phases via
 * a string hash — no `Math.random()` (same discipline as the lighting
 * flicker seeds), so two clients watching one barrel see one fire.
 *
 * EVERY LOOK PARAMETER below is a named constant — the owner retune list.
 */
import Phaser from 'phaser';
import { BARREL } from '@sector-battle/shared';
import type { DestructibleState } from '../../types.js';
import { DESTRUCTIBLE_TYPE_BARREL } from '../../types.js';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

/* ── Owner retune list — escalation curve breakpoints ──────────────────── */

/**
 * Escalation breakpoints, as a fraction of the fuse elapsed (0 = the priming
 * hit, 1 = detonation). Embers ramp from the very start (faint); open flame
 * appears at FLAME_START_T and reaches full size at FLAME_FULL_T; the whole
 * look surges slightly through the final stretch (LAST_SURGE_T → 1).
 */
const EMBER_START_T = 0.0;
const FLAME_START_T = 0.45;
const FLAME_FULL_T = 0.85;
const LAST_SURGE_T = 0.9;
/** Height/alpha bonus through the final stretch (0.25 = +25% at t=1). */
const LAST_SURGE_GAIN = 0.25;

/* ── Owner retune list — embers (visible for the whole fuse) ────────────── */

const EMBER_COUNT_MIN = 3;
const EMBER_COUNT_MAX = 9;
/** Ember dot diameter range (px). */
const EMBER_SIZE_MIN = 3;
const EMBER_SIZE_MAX = 6;
/** Vertical travel of a rising ember (px, upward from the barrel rim). */
const EMBER_RISE_HEIGHT = 46;
/** One ember rise cycle (ms); per-ember deterministic jitter ±30%. */
const EMBER_CYCLE_MS = 750;
/** Horizontal sway of a rising ember (px). */
const EMBER_WOBBLE_PX = 9;
/** Peak ember opacity at prime (t=0) and at detonation (t=1). */
const EMBER_ALPHA_MIN = 0.25;
const EMBER_ALPHA_MAX = 0.7;
/** Dull ember red at prime → hot amber near detonation (packed 0xRRGGBB). */
const EMBER_COLOR_EARLY = 0xb5502a;
const EMBER_COLOR_LATE = 0xffb347;

/* ── Owner retune list — open flame (upper fuse half) ───────────────────── */

/** Flame body size range (px): width at the barrel rim, height of the tongue. */
const FLAME_WIDTH_MIN = 12;
const FLAME_WIDTH_MAX = 36;
const FLAME_HEIGHT_MIN = 20;
const FLAME_HEIGHT_MAX = 68;
/** Flame tongue flicker cadence (Hz) + amplitude (fraction of size). */
const FLAME_FLICKER_HZ = 9;
const FLAME_FLICKER_AMP = 0.16;
/** Layered flame colors, outer → core (packed 0xRRGGBB). */
const FLAME_COLOR_OUTER = 0xff5a1f;
const FLAME_COLOR_MID = 0xffaa33;
const FLAME_COLOR_CORE = 0xfff3b0;

/* ── Owner retune list — warm base glow + prime-moment puff ─────────────── */

/** Warm glow pooling at the barrel base (px radius, alpha at t=0 → t=1). */
const BASE_GLOW_RADIUS_MIN = 14;
const BASE_GLOW_RADIUS_MAX = 32;
const BASE_GLOW_ALPHA_MIN = 0.1;
const BASE_GLOW_ALPHA_MAX = 0.3;
const BASE_GLOW_COLOR = 0xff7733;
/** One-shot ignite puff when a barrel FIRST primes: sparks + duration (ms). */
const IGNITE_SPARK_COUNT = 7;
const IGNITE_SPARK_SPEED = 90;
const IGNITE_DURATION_MS = 420;

/* ── Owner retune list — placement ──────────────────────────────────────── */

/** Draw depth — matches ParticleVFX's Graphics (above entities at depth 5). */
const BARREL_FUSE_DEPTH = 17;
/** The barrel sprite is 128px; the fire sits on its upper half (px offsets). */
const BARREL_TOP_OFFSET = -26;
const FLAME_BASE_OFFSET = -18;

/** Per-primed-barrel state. Barrels are static — position is snapshotted. */
interface FuseEntry {
  /** Destructible entity key (deterministic hash input for per-barrel phases). */
  key: string;
  x: number;
  y: number;
  fuseExpiresAtTick: number;
  /** Deterministic per-barrel phase seed (string hash of the entity key). */
  seed: number;
}

/** One-shot ignite-puff spark (the prime-moment confirmation). */
interface IgniteSpark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  startTime: number;
  duration: number;
}

/** `BarrelFuseVFX.spawn` options — the one-shot prime-moment ember puff. */
export interface BarrelFuseSpawnOptions {
  kind: 'ignite';
  /** Destructible entity key (dedupes repeat ignites for one barrel). */
  key: string;
  x: number;
  y: number;
}

/** Deterministic 0..1 hash of a string + integer salt (no Math.random). */
function hash01(text: string, salt: number): number {
  let h = 0x811c9dc5 ^ (salt * 0x01000193);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  return (h >>> 0) / 4294967295;
}

/** Linear blend between two packed 0xRRGGBB colors (t in [0,1]). */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const r = Math.round(ar + (((b >> 16) & 0xff) - ar) * t);
  const g = Math.round(ag + (((b >> 8) & 0xff) - ag) * t);
  const bl = Math.round(ab + ((b & 0xff) - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Smoothstep between two curve breakpoints (clamped 0..1). */
function smoothstep(edge0: number, edge1: number, t: number): number {
  const x = Math.min(1, Math.max(0, (t - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

/**
 * Fraction of the fuse elapsed, 0 (the priming hit) → 1 (detonation).
 *
 * Pure function of SYNCED values only: the absolute expiry tick on the wire
 * minus the client's current server-tick notion. Clamped both ways — a tick
 * slightly behind the priming patch reads as 0, and a removal patch in flight
 * keeps the fire pinned at full intensity until the schema removal stops it
 * (never a client-side explosion guess).
 */
export function computeFuseElapsedFraction(serverTick: number, fuseExpiresAtTick: number): number {
  if (fuseExpiresAtTick <= 0 || serverTick <= 0) return 0;
  const t = 1 - (fuseExpiresAtTick - serverTick) / BARREL.FUSE_TICKS;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class BarrelFuseVFX implements VFXEffect<BarrelFuseSpawnOptions> {
  readonly id = 'barrel-fuse' as const;
  private gfx: Phaser.GameObjects.Graphics;
  private entries = new Map<string, FuseEntry>();
  private sparks: IgniteSpark[] = [];
  private ignitedKeys = new Set<string>();
  private getServerTick: () => number = () => 0;

  constructor(scene: Phaser.Scene, _pool: SpritePool) {
    // `_pool`: injected for lifecycle uniformity (ticket 52); this effect
    // renders via a single Graphics object and allocates no sprites (the
    // ParticleVFX fire-DOT pattern), so the reference is intentionally unused.
    this.gfx = scene.add.graphics().setDepth(BARREL_FUSE_DEPTH);
    // Additive fire: embers/flame/glow accumulate light over the scene
    // instead of alpha-blending dark over it.
    this.gfx.setBlendMode(Phaser.BlendModes.ADD);
  }

  /**
   * Inject the synced server-tick source (set once at scene setup —
   * `EntityRenderer.setServerTickProvider`). The escalation reads it every
   * frame; until it is injected (or before the first state patch) the effect
   * renders nothing rather than guess a fuse.
   *
   * @param provider returns `StateSync.getTick()` (the synced server tick).
   */
  setServerTickProvider(provider: () => number): void {
    this.getServerTick = provider;
  }

  spawn(opts: BarrelFuseSpawnOptions): void {
    this.ignite(opts.key, opts.x, opts.y);
  }

  /**
   * Server-state sync (narrow interface extension — the
   * `updateFireDotPositions` continuous-sync precedent): register/clear the
   * primed fire for one destructible from its live schema state. Fed by the
   * destructible add/update handlers; a barrel that is not primed, is
   * destroyed, or is not a barrel at all drops its entry.
   *
   * @param key destructible entity key.
   * @param d   the live (schema-synced) destructible view.
   */
  syncPrimed(key: string, d: DestructibleState): void {
    const shouldShow = d.type === DESTRUCTIBLE_TYPE_BARREL && d.primed === true && !d.isDestroyed;
    if (!shouldShow) {
      this.entries.delete(key);
      this.ignitedKeys.delete(key);
      return;
    }
    const alreadyTracked = this.entries.has(key);
    this.entries.set(key, {
      key,
      x: d.x,
      y: d.y,
      fuseExpiresAtTick: d.fuseExpiresAtTick ?? 0,
      seed: hash01(key, 1),
    });
    // The PRIME TRANSITION (untracked → tracked) fires the one-shot ignite
    // puff — the "your hit primed it" confirmation beat.
    if (!alreadyTracked) this.ignite(key, d.x, d.y);
  }

  /**
   * Targeted cancellation (`DestructionVFX.onRemove` precedent): the server
   * removed this destructible (detonation, second hit, chain) — drop just its
   * fire. Called from the destructible renderer's destroy path so the visuals
   * can never outlive the entity.
   *
   * @param key destructible entity key.
   */
  onRemove(key: string): void {
    this.entries.delete(key);
    this.ignitedKeys.delete(key);
  }

  /** One-shot prime-moment ember puff at the barrel rim. */
  private ignite(key: string, x: number, y: number): void {
    if (this.ignitedKeys.has(key)) return;
    this.ignitedKeys.add(key);
    const now = performance.now();
    const baseY = y + BARREL_TOP_OFFSET;
    for (let i = 0; i < IGNITE_SPARK_COUNT; i++) {
      const angle = hash01(key, 10 + i) * Math.PI * 2;
      const speed = IGNITE_SPARK_SPEED * (0.5 + hash01(key, 30 + i));
      this.sparks.push({
        x,
        y: baseY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        startTime: now,
        duration: IGNITE_DURATION_MS,
      });
    }
  }

  update(_dt: number): void {
    const now = performance.now();
    this.gfx.clear();

    // Retire finished ignite sparks first (they outlive nothing — they are
    // purely transient, not per-entity).
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      if (now - this.sparks[i]!.startTime > this.sparks[i]!.duration) {
        this.sparks.splice(i, 1);
      }
    }

    const serverTick = this.getServerTick();
    // No synced tick yet (or provider not wired): render nothing — never guess.
    if (serverTick <= 0) return;

    for (const e of this.entries.values()) {
      const t = computeFuseElapsedFraction(serverTick, e.fuseExpiresAtTick);
      this.drawEmbers(e, t, now);
      this.drawFlame(e, t, now);
      this.drawBaseGlow(e, t);
    }

    this.drawSparks(now);
  }

  /** Faint embers at prime, building in count + brightness with t. */
  private drawEmbers(e: FuseEntry, t: number, now: number): void {
    const ramp = smoothstep(EMBER_START_T, 1, t);
    const count = Math.round(EMBER_COUNT_MIN + (EMBER_COUNT_MAX - EMBER_COUNT_MIN) * ramp);
    if (count <= 0) return;
    const color = lerpColor(EMBER_COLOR_EARLY, EMBER_COLOR_LATE, ramp);
    const alpha = EMBER_ALPHA_MIN + (EMBER_ALPHA_MAX - EMBER_ALPHA_MIN) * ramp;
    const originY = e.y + BARREL_TOP_OFFSET;
    for (let i = 0; i < count; i++) {
      // Deterministic per-ember cycle: hashed speed jitter + phase, so the
      // rise pattern is stable per barrel (no Math.random).
      const speedJitter = 0.7 + 0.6 * hash01(e.key, 40 + i);
      const phase = hash01(e.key, 80 + i);
      const p = ((now / EMBER_CYCLE_MS) * speedJitter + phase) % 1;
      const rise = p * EMBER_RISE_HEIGHT;
      const wobble = Math.sin(p * Math.PI * 2 + phase * Math.PI * 2) * EMBER_WOBBLE_PX;
      const size = EMBER_SIZE_MIN + (EMBER_SIZE_MAX - EMBER_SIZE_MIN) * ramp * (1 - p * 0.5);
      this.gfx.fillStyle(color, alpha * (1 - p));
      this.gfx.fillCircle(e.x + wobble, originY - rise, size / 2);
    }
  }

  /** Open flame in the upper fuse half: layered flickering tongue. */
  private drawFlame(e: FuseEntry, t: number, now: number): void {
    const ft = smoothstep(FLAME_START_T, FLAME_FULL_T, t);
    if (ft <= 0) return;
    // Final-stretch surge: the fire visibly swells through the last seconds.
    const surge = 1 + LAST_SURGE_GAIN * smoothstep(LAST_SURGE_T, 1, t);
    const flicker =
      1 +
      FLAME_FLICKER_AMP *
        Math.sin((now / 1000) * Math.PI * 2 * FLAME_FLICKER_HZ + e.seed * Math.PI * 2) +
      FLAME_FLICKER_AMP * 0.5 * Math.sin((now / 1000) * Math.PI * 2 * FLAME_FLICKER_HZ * 2.7);
    const width = (FLAME_WIDTH_MIN + (FLAME_WIDTH_MAX - FLAME_WIDTH_MIN) * ft) * surge * flicker;
    const height =
      (FLAME_HEIGHT_MIN + (FLAME_HEIGHT_MAX - FLAME_HEIGHT_MIN) * ft) * surge * flicker;
    const baseX = e.x;
    const baseY = e.y + FLAME_BASE_OFFSET;
    // Three stacked blobs, outer → core: the widest sits at the rim, the
    // hottest + brightest peaks at the tongue tip.
    this.gfx.fillStyle(FLAME_COLOR_OUTER, 0.55 * ft);
    this.gfx.fillEllipse(baseX, baseY - height * 0.35, width, height);
    this.gfx.fillStyle(FLAME_COLOR_MID, 0.6 * ft);
    this.gfx.fillEllipse(baseX, baseY - height * 0.3, width * 0.66, height * 0.72);
    this.gfx.fillStyle(FLAME_COLOR_CORE, 0.75 * ft);
    this.gfx.fillEllipse(
      baseX + Math.sin(now / 90 + e.seed * 7) * width * 0.08,
      baseY - height * 0.28,
      width * 0.34,
      height * 0.45,
    );
  }

  /** Warm glow pooling at the barrel base — brightens toward detonation. */
  private drawBaseGlow(e: FuseEntry, t: number): void {
    const ramp = smoothstep(EMBER_START_T, 1, t);
    const radius = BASE_GLOW_RADIUS_MIN + (BASE_GLOW_RADIUS_MAX - BASE_GLOW_RADIUS_MIN) * ramp;
    const alpha = BASE_GLOW_ALPHA_MIN + (BASE_GLOW_ALPHA_MAX - BASE_GLOW_ALPHA_MIN) * ramp;
    this.gfx.fillStyle(BASE_GLOW_COLOR, alpha);
    this.gfx.fillEllipse(e.x, e.y + FLAME_BASE_OFFSET / 2, radius * 2, radius);
  }

  /** The transient prime-moment sparks (fly up + out, fade). */
  private drawSparks(now: number): void {
    for (const s of this.sparks) {
      const elapsed = now - s.startTime;
      const p = Math.min(1, elapsed / s.duration);
      const alpha = 1 - p;
      const travel = p * (s.duration / 1000);
      this.gfx.fillStyle(lerpColor(EMBER_COLOR_LATE, EMBER_COLOR_EARLY, p), alpha);
      this.gfx.fillCircle(
        s.x + s.vx * travel,
        s.y + s.vy * travel,
        (EMBER_SIZE_MAX / 2) * (1 - p * 0.6),
      );
    }
  }

  /** Drop every tracked fire + in-flight spark; the Graphics stays usable. */
  clear(): void {
    this.entries.clear();
    this.sparks.length = 0;
    this.ignitedKeys.clear();
    this.gfx.clear();
  }

  destroy(): void {
    this.clear();
    this.gfx.destroy();
  }
}

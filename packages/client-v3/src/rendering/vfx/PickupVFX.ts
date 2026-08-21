import type Phaser from 'phaser';
import { PLAYER } from '@sector-battle/shared';
import { DesignTokens } from '../../ui/DesignTokens.js';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

/**
 * `PickupVFX.spawn` options — this effect is a pure per-frame modifier (the
 * pickup/power-up bob + pop) with no spawn phase, so its options type is empty
 * and `spawn` is a documented no-op that exists only to satisfy the uniform
 * lifecycle contract.
 */
export interface PickupSpawnOptions {
  kind: 'none';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * POWER-UP POP — OWNER RETUNE LIST (juice-pass-1 ticket 03).
 * Everything below is a taste parameter; tune in-browser against a running
 * build. Grouped: [icon pulse] [ground glow decal] [radius sonar ping] [tints].
 * ═══════════════════════════════════════════════════════════════════════════ */

// ── Icon pulse (applied with the bob) ──
/** Bob amplitude for the power-up icon (px). Pre-existing value. */
const POWERUP_BOB_AMP = 4;
/** Icon scale pulse frequency (Hz). */
const POWERUP_ICON_PULSE_HZ = 1.1;
/** Icon scale pulse depth (± fraction of base scale). */
const POWERUP_ICON_SCALE_AMP = 0.06;
/** Icon alpha pulse center (active power-ups). */
const POWERUP_ICON_ALPHA_BASE = 0.85;
/** Icon alpha pulse depth (±). Range 0.70–1.00. */
const POWERUP_ICON_ALPHA_AMP = 0.15;
/** Icon alpha when the server-side power-up is deactivated (ghost state). */
const POWERUP_INACTIVE_ALPHA = 0.2;

// ── Ground glow decal (steady tinted light on the floor under the icon) ──
/** `vfx` atlas frame used for the decal + ping (clean radial pulse). */
const POWERUP_GLOW_FRAME = 'circle_01';
/** Decal diameter (px). */
const POWERUP_GLOW_DISPLAY = 88;
/** Decal alpha breathing center. */
const POWERUP_GLOW_ALPHA_BASE = 0.22;
/** Decal alpha breathing depth (±). */
const POWERUP_GLOW_ALPHA_AMP = 0.06;
/** Decal breathing frequency (Hz). */
const POWERUP_GLOW_BREATH_HZ = 0.8;
/** Decal size breathing depth (± fraction). */
const POWERUP_GLOW_SCALE_AMP = 0.05;
/** Decal center offset below the item's base position — reads as "on the floor". */
const POWERUP_GLOW_GROUND_OFFSET_Y = 8;
/** Render depth: just under the item icon (icons sit at depth 8). */
const POWERUP_GLOW_DEPTH = 7;

// ── Radius sonar ping (expanding ring that hints the walk-over pickup radius) ──
/** Ping loop period (ms) — one expansion per loop. */
const POWERUP_PING_PERIOD_MS = 1600;
/** Ping starts at this radius (px). */
const POWERUP_PING_INNER_RADIUS = 18;
/**
 * Ping expands to the authoritative walk-over pickup radius — the ping IS the
 * gameplay hint, so it tracks the server constant rather than a local taste
 * number. (Power-ups auto-collect at this distance; `PICKUP_RADIUS`.)
 */
const POWERUP_PING_OUTER_RADIUS = PLAYER.PICKUP_RADIUS;
/** Ping peak alpha at loop start. */
const POWERUP_PING_ALPHA_MAX = 0.5;

// ── Per-type tints (icon + decal + ping + collection burst all share these) ──
/** 0 = health pack, 1 = barrier, 2 = speed boost. Matches the icon configs. */
export const POWERUP_TINTS: Readonly<Record<number, number>> = {
  0: DesignTokens.colors.green,
  1: DesignTokens.colors.blue,
  2: DesignTokens.colors.amber,
};
/** Fallback tint for unknown power-up types. */
export const DEFAULT_POWERUP_TINT = DesignTokens.colors.green;

/** Tint for a power-up type (single source for icon, glow, and burst). */
export function powerUpTint(type: number): number {
  return POWERUP_TINTS[type] ?? DEFAULT_POWERUP_TINT;
}

/** vfx-atlas particle frames render at 64px; divide target display px by this. */
const PARTICLE_TEX_SIZE = 64;

/** Per-power-up pop state: icon pulse params + the two pooled ground sprites. */
interface PowerUpPopState {
  /** Icon pulse rides this base scale (captured after setDisplaySize at add). */
  baseScale: number;
  /** Server-authoritative active flag (deactivated → ghost icon, no glow). */
  active: boolean;
  /** Steady ground glow decal (null when the atlas frame is unavailable). */
  glow: Phaser.GameObjects.Sprite | null;
  /** Expanding radius-hint ring (null when the atlas frame is unavailable). */
  ping: Phaser.GameObjects.Sprite | null;
  /** Per-item phase offset so neighboring pings don't sync up. */
  pingPhase: number;
}

/**
 * PickupVFX — the power-up "pop": idle bob + scale/alpha pulse on the icon, a
 * tinted ground glow decal, and a sonar ping that expands to the walk-over
 * pickup radius (the legibility ask of juice-pass-1 ticket 03).
 *
 * The bob/pulse appliers are driven per entity by EntityRendererLifecycle's
 * update loop; the glow sprites are acquired from the shared pool and released
 * on detach (the item-remove path) / clear / destroy — a glow never outlives
 * its item.
 */
export class PickupVFX implements VFXEffect<PickupSpawnOptions> {
  readonly id = 'pickup' as const;
  private readonly scene: Phaser.Scene;
  private readonly pool: SpritePool;
  /** Per-item pop state, keyed by the entity registry key. */
  private readonly powerups = new Map<string, PowerUpPopState>();
  /** Lazily-resolved frame availability (after atlas preload). */
  private glowFrameAvailable: boolean | null = null;

  constructor(scene: Phaser.Scene, pool: SpritePool) {
    this.scene = scene;
    this.pool = pool;
  }

  /** No spawn phase — see {@link PickupSpawnOptions}. */
  spawn(_opts: PickupSpawnOptions): void {}

  /** Pop is applied per entity by the caller (see the appliers below). */
  update(_dt: number): void {}

  /** Release every item glow — the effect stays usable afterwards. */
  clear(): void {
    // Deleting during Map iteration is spec-safe (visited entries may vanish).
    for (const key of this.powerups.keys()) {
      this.detachPowerUpGlow(key);
    }
  }

  /** Full teardown (scene shutdown): release every item glow. */
  destroy(): void {
    this.clear();
  }

  /* ── Idle bob + pulse appliers (driven by EntityRendererLifecycle.update) ── */

  updatePickupBob(
    sprite: Phaser.GameObjects.Sprite,
    baseY: number,
    key: string,
    now: number,
  ): void {
    sprite.y = baseY + Math.sin(now / 400 + key.charCodeAt(0)) * 4;
  }

  updatePowerupBob(
    sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Arc | Phaser.GameObjects.Graphics,
    baseY: number,
    key: string,
    now: number,
  ): void {
    const st = this.powerups.get(key);
    const baseScale = st?.baseScale ?? sprite.scaleX;
    const phase = Math.sin((now * Math.PI * 2 * POWERUP_ICON_PULSE_HZ) / 1000 + key.charCodeAt(0));
    sprite.y = baseY + Math.sin((now * 3) / 1000 + key.charCodeAt(0)) * POWERUP_BOB_AMP;
    if (st && !st.active) {
      // Deactivated (server-side): ghost icon, no pulse.
      sprite.setAlpha(POWERUP_INACTIVE_ALPHA);
      return;
    }
    sprite.setScale(baseScale * (1 + POWERUP_ICON_SCALE_AMP * phase));
    sprite.setAlpha(POWERUP_ICON_ALPHA_BASE + POWERUP_ICON_ALPHA_AMP * phase);
  }

  /* ── Ground glow decal + radius ping (attach/detach from the item paths) ── */

  /**
   * Register pop state + acquire the ground sprites for a power-up entity.
   * Called from `addPowerUp` right after the icon is created (so the icon's
   * post-`setDisplaySize` scale can be captured as the pulse base).
   */
  attachPowerUpGlow(key: string, x: number, y: number, tint: number, baseScale: number): void {
    if (this.powerups.has(key)) return;
    const groundY = y + POWERUP_GLOW_GROUND_OFFSET_Y;
    let glow: Phaser.GameObjects.Sprite | null = null;
    let ping: Phaser.GameObjects.Sprite | null = null;
    if (this.isGlowFrameAvailable()) {
      glow = this.pool.acquire('vfx', POWERUP_GLOW_FRAME, x, groundY);
      glow.setDepth(POWERUP_GLOW_DEPTH).setOrigin(0.5).setTint(tint).setAlpha(0);
      ping = this.pool.acquire('vfx', POWERUP_GLOW_FRAME, x, groundY);
      ping.setDepth(POWERUP_GLOW_DEPTH).setOrigin(0.5).setTint(tint).setAlpha(0);
    }
    this.powerups.set(key, {
      baseScale,
      active: true,
      glow,
      ping,
      pingPhase: (key.charCodeAt(key.length - 1) % 16) / 16,
    });
  }

  /** Release the ground sprites + drop the pop state (item-remove path). */
  detachPowerUpGlow(key: string): void {
    const st = this.powerups.get(key);
    if (!st) return;
    if (st.glow) this.pool.release(st.glow);
    if (st.ping) this.pool.release(st.ping);
    this.powerups.delete(key);
  }

  /**
   * Sync the server-authoritative active flag (patch-driven, from
   * `updatePowerUp`): deactivated power-ups drop their glow entirely and dim
   * the icon to the ghost read.
   */
  setPowerUpActive(key: string, active: boolean): void {
    const st = this.powerups.get(key);
    if (!st) return;
    st.active = active;
    if (st.glow) st.glow.setVisible(active);
    if (st.ping) st.ping.setVisible(active);
  }

  /** Per-frame decal breathing + sonar ping expansion (lifecycle update loop). */
  updatePowerUpGlow(key: string, now: number): void {
    const st = this.powerups.get(key);
    if (!st || !st.active || !st.glow || !st.ping) return;
    const seed = key.charCodeAt(0);

    const breath = Math.sin((now * Math.PI * 2 * POWERUP_GLOW_BREATH_HZ) / 1000 + seed);
    st.glow.setAlpha(POWERUP_GLOW_ALPHA_BASE + POWERUP_GLOW_ALPHA_AMP * breath);
    st.glow.setScale(
      (POWERUP_GLOW_DISPLAY * (1 + POWERUP_GLOW_SCALE_AMP * breath)) / PARTICLE_TEX_SIZE,
    );

    const t = (now / POWERUP_PING_PERIOD_MS + st.pingPhase) % 1;
    const eased = 1 - (1 - t) * (1 - t); // easeOutQuad — fast out, slow fade
    const radius =
      POWERUP_PING_INNER_RADIUS + (POWERUP_PING_OUTER_RADIUS - POWERUP_PING_INNER_RADIUS) * eased;
    st.ping.setScale((radius * 2) / PARTICLE_TEX_SIZE);
    st.ping.setAlpha(POWERUP_PING_ALPHA_MAX * (1 - t));
  }

  /** Resolve the glow frame once (after atlas preload); missing frame → no glow. */
  private isGlowFrameAvailable(): boolean {
    if (this.glowFrameAvailable === null) {
      this.glowFrameAvailable = this.scene.textures.get('vfx').has(POWERUP_GLOW_FRAME);
    }
    return this.glowFrameAvailable;
  }
}

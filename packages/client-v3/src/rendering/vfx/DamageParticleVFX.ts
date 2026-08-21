import Phaser from 'phaser';
import { DesignTokens } from '../../ui/DesignTokens.js';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

const VFX_DEPTH = DesignTokens.depth.vfx;

/** VFX particles live in the `vfx` multipack atlas; these are frame names. */
const VFX_ATLAS = 'vfx';

const SPLAT_KEYS = Array.from({ length: 36 }, (_, i) => `splat${String(i).padStart(2, '0')}`);
const FLAME_KEYS = Array.from({ length: 6 }, (_, i) => `flame_${String(i + 1).padStart(2, '0')}`);
const MAGIC_KEYS = Array.from({ length: 5 }, (_, i) => `magic_${String(i + 1).padStart(2, '0')}`);
const STAR_KEYS = Array.from({ length: 9 }, (_, i) => `star_${String(i + 1).padStart(2, '0')}`);
const SPARK_KEYS = Array.from({ length: 7 }, (_, i) => `spark_${String(i + 1).padStart(2, '0')}`);
// Solid debris puffs — used as the "metallic impact fragments" in shield-block.
// (There is no authored metal_* particle set; dirt_* reads as chunky impact debris
// once gray/silver-tinted, which is the intended look for a weapon-vs-shield clash.)
const DEBRIS_KEYS = Array.from({ length: 3 }, (_, i) => `dirt_${String(i + 1).padStart(2, '0')}`);
// Clean radial pulses — used as the shield-block central flash ring.
const CIRCLE_KEYS = Array.from({ length: 5 }, (_, i) => `circle_${String(i + 1).padStart(2, '0')}`);

// Particle textures were downsized to 64×64 for a smaller download. The scale
// constants below were authored against the original source dimensions, so they
// must be multiplied by (sourceDim / 64) to render at the same on-screen size:
//   - 512-sourced sets (flame/magic/star/spark/dirt/circle) → ×8
//   - 256-sourced set  (splat)                              → ×4
const PARTICLE_TEX_SIZE = 64;
/** Scale multiplier for the 512×512-origin particle sets. */
const S512 = 512 / PARTICLE_TEX_SIZE; // = 8
/** Scale multiplier for the 256×256-origin splat set. */
const S256 = 256 / PARTICLE_TEX_SIZE; // = 4

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Blend `tint` toward white by `amount` (0 = unchanged, 1 = white). */
function lightenTint(tint: number, amount: number): number {
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return (mix((tint >> 16) & 0xff) << 16) | (mix((tint >> 8) & 0xff) << 8) | mix(tint & 0xff);
}

/* ── Power-up collection burst (juice-pass-1 ticket 03) ── */

// OWNER RETUNE LIST — power-up collection burst taste parameters.
/** Expanding ring: start/end diameters (px). */
const POWERUP_RING_FROM = 48;
const POWERUP_RING_TO = 150;
/** Expanding ring: peak alpha + duration (ms). */
const POWERUP_RING_ALPHA = 0.85;
const POWERUP_RING_DURATION = 380;
/** Tinted glints (magic/star frames): count, travel distance + lifetime (ms). */
const POWERUP_GLINT_COUNT = 7;
const POWERUP_GLINT_DIST_MIN = 30;
const POWERUP_GLINT_DIST_MAX = 75;
const POWERUP_GLINT_LIFE_MIN = 380;
const POWERUP_GLINT_LIFE_MAX = 560;
/** Glint display size range (px). */
const POWERUP_GLINT_SIZE_MIN = 20;
const POWERUP_GLINT_SIZE_MAX = 30;
/** Hot sparks: count + travel + lifetime (ms). */
const POWERUP_SPARK_COUNT = 4;
const POWERUP_SPARK_DIST_MIN = 25;
const POWERUP_SPARK_DIST_MAX = 60;
const POWERUP_SPARK_LIFE_MIN = 160;
const POWERUP_SPARK_LIFE_MAX = 260;
/** Spark display size range (px). */
const POWERUP_SPARK_SIZE_MIN = 14;
const POWERUP_SPARK_SIZE_MAX = 22;
/** Brightness lifts for the glint/spark variants of the base tint. */
const POWERUP_GLINT_LIGHTEN = 0.35;
const POWERUP_SPARK_LIGHTEN = 0.55;

/** `DamageParticleVFX.spawn` options — the hit-reaction particle variants. */
export type DamageSpawnOptions =
  | { kind: 'blood'; x: number; y: number }
  | { kind: 'fire'; x: number; y: number }
  | { kind: 'teleport'; x: number; y: number }
  | { kind: 'shield-block'; x: number; y: number; contactX?: number; contactY?: number }
  | { kind: 'powerup'; x: number; y: number; tint: number };

/**
 * DamageParticleVFX — spawns short-lived sprite particles for hit/fire/teleport effects.
 * Renders for ALL players (local + remote). Each burst spawns sprites, tweens them,
 * and releases them back to the shared sprite pool on complete.
 */
export class DamageParticleVFX implements VFXEffect<DamageSpawnOptions> {
  readonly id = 'damage' as const;
  private scene: Phaser.Scene;
  private readonly pool: SpritePool;
  /** Lazily-cached, texture-availability-filtered key sets. Populated on first
   * spawn (after asset preload) so the per-spawn `.filter()` is paid once. */
  private splatAvailable: readonly string[] | null = null;
  private flameAvailable: readonly string[] | null = null;
  private magicStarAvailable: readonly string[] | null = null;
  private starAvailable: readonly string[] | null = null;
  private sparkAvailable: readonly string[] | null = null;
  private debrisAvailable: readonly string[] | null = null;
  private circleAvailable: readonly string[] | null = null;

  constructor(scene: Phaser.Scene, pool: SpritePool) {
    this.scene = scene;
    this.pool = pool;
  }

  spawn(opts: DamageSpawnOptions): void {
    switch (opts.kind) {
      case 'blood':
        this.spawnBlood(opts.x, opts.y);
        return;
      case 'fire':
        this.spawnFire(opts.x, opts.y);
        return;
      case 'teleport':
        this.spawnTeleport(opts.x, opts.y);
        return;
      case 'shield-block':
        this.spawnShieldBlock(opts.x, opts.y, opts.contactX, opts.contactY);
        return;
      case 'powerup':
        this.spawnPowerupBurst(opts.x, opts.y, opts.tint);
        return;
    }
  }

  /** Filter `keys` to those that exist as frames in the `vfx` atlas. */
  private filterTex(keys: readonly string[]): readonly string[] {
    const tex = this.scene.textures.get(VFX_ATLAS);
    return keys.filter((k) => tex.has(k));
  }

  /**
   * Blood / impact splat — for melee, thrown, ranged, projectile hits.
   * Spawns 5-8 red-tinted splat sprites that fly outward and fade.
   */
  private spawnBlood(x: number, y: number): void {
    if (!this.splatAvailable) this.splatAvailable = this.filterTex(SPLAT_KEYS);
    if (this.splatAvailable.length === 0) return;
    const count = Math.floor(rand(5, 9));
    for (let i = 0; i < count; i++) {
      const key = pick(this.splatAvailable);
      const angle = rand(0, Math.PI * 2);
      const dist = rand(25, 60);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const startScale = rand(0.25, 0.4) * S256;
      const tint = Math.random() > 0.3 ? 0xcc2222 : 0x991128;

      const spr = this.pool.acquire(VFX_ATLAS, key, x, y);
      spr.setDepth(VFX_DEPTH);
      spr.setOrigin(0.5);
      spr.setScale(startScale);
      spr.setRotation(rand(0, Math.PI * 2));
      spr.setTint(tint);
      spr.setAlpha(0.9);

      this.scene.tweens.add({
        targets: spr,
        x: x + dx,
        y: y + dy,
        scale: 0,
        alpha: 0,
        duration: rand(350, 500),
        ease: 'Cubic.easeOut',
        onComplete: () => this.pool.release(spr),
      });
    }
  }

  /**
   * Fire burst — for explosion-adjacent and fire-trap damage.
   * Spawns 5-8 flame sprites that rise upward and flicker out.
   */
  private spawnFire(x: number, y: number): void {
    if (!this.flameAvailable) this.flameAvailable = this.filterTex(FLAME_KEYS);
    if (this.flameAvailable.length === 0) return;
    const fireTints = [0xff6600, 0xff8800, 0xffaa22, 0xff4400, 0xffcc44, 0xff9900];
    const count = Math.floor(rand(5, 9));
    for (let i = 0; i < count; i++) {
      const key = pick(this.flameAvailable);

      const spreadX = rand(-25, 25);
      const riseY = rand(-55, -15);
      const startScale = rand(0.3, 0.5) * S512;

      const spr = this.pool.acquire(VFX_ATLAS, key, x + rand(-15, 15), y + rand(-15, 15));
      spr.setDepth(VFX_DEPTH);
      spr.setOrigin(0.5);
      spr.setScale(startScale);
      spr.setTint(pick(fireTints));
      spr.setAlpha(0.9);
      spr.setRotation(rand(-0.3, 0.3));

      this.scene.tweens.add({
        targets: spr,
        x: x + spreadX,
        y: y + riseY,
        scale: startScale * 0.3,
        alpha: 0,
        duration: rand(400, 600),
        ease: 'Cubic.easeOut',
        onComplete: () => this.pool.release(spr),
      });
    }
  }

  /**
   * Teleport shimmer — for teleport traps and respawn.
   * Spawns 7-10 magic/star sprites in an expanding ring, converging inward then bursting outward.
   */
  private spawnTeleport(x: number, y: number): void {
    if (!this.magicStarAvailable) {
      this.magicStarAvailable = this.filterTex([...MAGIC_KEYS, ...STAR_KEYS]);
    }
    if (this.magicStarAvailable.length === 0) return;
    const tpPool = this.magicStarAvailable;

    // Ring of converging particles
    const count = Math.floor(rand(7, 11));
    for (let i = 0; i < count; i++) {
      const key = pick(tpPool);
      const angle = (i / count) * Math.PI * 2 + rand(-0.2, 0.2);
      const radius = rand(50, 80);
      const startX = x + Math.cos(angle) * radius;
      const startY = y + Math.sin(angle) * radius;
      const startScale = rand(0.25, 0.4) * S512;

      const spr = this.pool.acquire(VFX_ATLAS, key, startX, startY);
      spr.setDepth(VFX_DEPTH);
      spr.setOrigin(0.5);
      spr.setScale(startScale);
      spr.setTint(0x44ffff);
      spr.setAlpha(0.85);
      spr.setRotation(rand(0, Math.PI * 2));

      this.scene.tweens.add({
        targets: spr,
        x: x,
        y: y,
        scale: 0,
        alpha: 0,
        duration: rand(350, 500),
        ease: 'Cubic.easeIn',
        onComplete: () => this.pool.release(spr),
      });
    }

    // Central expanding flash
    if (!this.starAvailable) this.starAvailable = this.filterTex(STAR_KEYS);
    if (this.starAvailable.length > 0) {
      const flash = this.pool.acquire(VFX_ATLAS, pick(this.starAvailable), x, y);
      flash.setDepth(VFX_DEPTH);
      flash.setScale(0.35 * S512);
      flash.setTint(0x88ffff);
      flash.setAlpha(0.8);
      this.scene.tweens.add({
        targets: flash,
        scale: 0.7 * S512,
        alpha: 0,
        duration: 400,
        ease: 'Cubic.easeOut',
        onComplete: () => this.pool.release(flash),
      });
    }
  }

  /**
   * Shield block impact — for weapon-vs-shield clashes.
   * Three layers, each independently guarded so a missing texture set never
   * silently disables the others:
   *   1. Solid debris fragments (gray/silver-tinted) flung outward, tumbling.
   *   2. White-hot sparks streaking out fast and short-lived.
   *   3. A cool-blue radial flash ring expanding from the contact point.
   *
   * Impact point is the weapon/shield contact coord if provided, else the
   * defender position.
   */
  private spawnShieldBlock(x: number, y: number, contactX?: number, contactY?: number): void {
    const impactX = contactX ?? x;
    const impactY = contactY ?? y;

    // 1. Solid debris fragments
    if (!this.debrisAvailable) this.debrisAvailable = this.filterTex(DEBRIS_KEYS);
    if (this.debrisAvailable.length > 0) {
      const debrisCount = Math.floor(rand(3, 6));
      for (let i = 0; i < debrisCount; i++) {
        const key = pick(this.debrisAvailable);
        const angle = rand(0, Math.PI * 2);
        const dist = rand(15, 40);
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist;
        const startScale = rand(0.2, 0.35) * S512;
        const tint = Math.random() > 0.5 ? 0xaaaaaa : 0xcccccc;

        const spr = this.pool.acquire(VFX_ATLAS, key, impactX, impactY);
        spr.setDepth(VFX_DEPTH);
        spr.setOrigin(0.5);
        spr.setScale(startScale);
        spr.setTint(tint);
        spr.setAlpha(0.9);
        spr.setRotation(rand(0, Math.PI * 2));

        this.scene.tweens.add({
          targets: spr,
          x: impactX + dx,
          y: impactY + dy,
          scale: 0,
          alpha: 0,
          rotation: spr.rotation + rand(-Math.PI, Math.PI),
          duration: rand(200, 350),
          ease: 'Back.easeOut',
          onComplete: () => this.pool.release(spr),
        });
      }
    }

    // 2. White-hot sparks
    if (!this.sparkAvailable) this.sparkAvailable = this.filterTex(SPARK_KEYS);
    if (this.sparkAvailable.length > 0) {
      const sparkCount = Math.floor(rand(4, 8));
      for (let i = 0; i < sparkCount; i++) {
        const key = pick(this.sparkAvailable);
        const angle = rand(0, Math.PI * 2);
        const dist = rand(20, 50);
        const dx = Math.cos(angle) * dist;
        const dy = Math.sin(angle) * dist;
        const startScale = rand(0.3, 0.5) * S512;

        const spr = this.pool.acquire(VFX_ATLAS, key, impactX, impactY);
        spr.setDepth(VFX_DEPTH);
        spr.setOrigin(0.5);
        spr.setScale(startScale);
        spr.setTint(0xffffff);
        spr.setAlpha(1.0);

        this.scene.tweens.add({
          targets: spr,
          x: impactX + dx,
          y: impactY + dy,
          scale: 0.2 * S512,
          alpha: 0,
          duration: rand(150, 250),
          ease: 'Quart.easeOut',
          onComplete: () => this.pool.release(spr),
        });
      }
    }

    // 3. Central flash ring
    if (!this.circleAvailable) this.circleAvailable = this.filterTex(CIRCLE_KEYS);
    if (this.circleAvailable.length > 0) {
      const flash = this.pool.acquire(VFX_ATLAS, pick(this.circleAvailable), impactX, impactY);
      flash.setDepth(VFX_DEPTH);
      flash.setOrigin(0.5);
      flash.setScale(0.1 * S512);
      flash.setTint(0xccddff);
      flash.setAlpha(0.8);

      this.scene.tweens.add({
        targets: flash,
        scale: 0.8 * S512,
        alpha: 0,
        duration: 300,
        ease: 'Cubic.easeOut',
        onComplete: () => this.pool.release(flash),
      });
    }
  }

  /* ── Power-up collection burst (juice-pass-1 ticket 03) ── */

  /**
   * Power-up collection burst — the visual half of the pickup feedback (the
   * audio half lives in PickupEventHandler). Three tint-keyed layers, each
   * independently guarded like shield-block:
   *   1. An expanding tinted ring (the "got it" wave).
   *   2. Tinted magic/star glints flung outward.
   *   3. Near-white sparks streaking fast and short-lived.
   */
  private spawnPowerupBurst(x: number, y: number, tint: number): void {
    const d = (px: number) => px / PARTICLE_TEX_SIZE;

    // 1. Expanding tinted ring
    if (!this.circleAvailable) this.circleAvailable = this.filterTex(CIRCLE_KEYS);
    if (this.circleAvailable.length > 0) {
      const ring = this.pool.acquire(VFX_ATLAS, pick(this.circleAvailable), x, y);
      ring.setDepth(VFX_DEPTH);
      ring.setOrigin(0.5);
      ring.setScale(d(POWERUP_RING_FROM));
      ring.setTint(tint);
      ring.setAlpha(POWERUP_RING_ALPHA);
      this.scene.tweens.add({
        targets: ring,
        scale: d(POWERUP_RING_TO),
        alpha: 0,
        duration: POWERUP_RING_DURATION,
        ease: 'Cubic.easeOut',
        onComplete: () => this.pool.release(ring),
      });
    }

    // 2. Tinted glints
    if (!this.magicStarAvailable) {
      this.magicStarAvailable = this.filterTex([...MAGIC_KEYS, ...STAR_KEYS]);
    }
    if (this.magicStarAvailable.length > 0) {
      for (let i = 0; i < POWERUP_GLINT_COUNT; i++) {
        const angle = (i / POWERUP_GLINT_COUNT) * Math.PI * 2 + rand(-0.3, 0.3);
        const dist = rand(POWERUP_GLINT_DIST_MIN, POWERUP_GLINT_DIST_MAX);
        const size = rand(POWERUP_GLINT_SIZE_MIN, POWERUP_GLINT_SIZE_MAX);
        const spr = this.pool.acquire(VFX_ATLAS, pick(this.magicStarAvailable), x, y);
        spr.setDepth(VFX_DEPTH);
        spr.setOrigin(0.5);
        spr.setScale(d(size));
        spr.setTint(Math.random() > 0.4 ? tint : lightenTint(tint, POWERUP_GLINT_LIGHTEN));
        spr.setAlpha(0.9);
        spr.setRotation(rand(0, Math.PI * 2));
        this.scene.tweens.add({
          targets: spr,
          x: x + Math.cos(angle) * dist,
          y: y + Math.sin(angle) * dist,
          scale: 0,
          alpha: 0,
          duration: rand(POWERUP_GLINT_LIFE_MIN, POWERUP_GLINT_LIFE_MAX),
          ease: 'Cubic.easeOut',
          onComplete: () => this.pool.release(spr),
        });
      }
    }

    // 3. Hot sparks
    if (!this.sparkAvailable) this.sparkAvailable = this.filterTex(SPARK_KEYS);
    if (this.sparkAvailable.length > 0) {
      for (let i = 0; i < POWERUP_SPARK_COUNT; i++) {
        const angle = rand(0, Math.PI * 2);
        const dist = rand(POWERUP_SPARK_DIST_MIN, POWERUP_SPARK_DIST_MAX);
        const size = rand(POWERUP_SPARK_SIZE_MIN, POWERUP_SPARK_SIZE_MAX);
        const spr = this.pool.acquire(VFX_ATLAS, pick(this.sparkAvailable), x, y);
        spr.setDepth(VFX_DEPTH);
        spr.setOrigin(0.5);
        spr.setScale(d(size));
        spr.setTint(lightenTint(tint, POWERUP_SPARK_LIGHTEN));
        spr.setAlpha(1);
        this.scene.tweens.add({
          targets: spr,
          x: x + Math.cos(angle) * dist,
          y: y + Math.sin(angle) * dist,
          scale: d(size) * 0.3,
          alpha: 0,
          duration: rand(POWERUP_SPARK_LIFE_MIN, POWERUP_SPARK_LIFE_MAX),
          ease: 'Quart.easeOut',
          onComplete: () => this.pool.release(spr),
        });
      }
    }
  }

  /** Tween-driven effect — every sprite self-releases on tween complete. */
  update(_dt: number): void {}

  /**
   * Nothing to force-release: this effect keeps no per-sprite tracking — every
   * sprite self-releases to the pool on its tween's onComplete (the release
   * discipline is satisfied by construction; the pool owner tears the pool
   * down at scene shutdown).
   */
  clear(): void {}

  destroy(): void {
    // Sprites self-release via tween onComplete; the shared pool is owned + torn
    // down by EntityRendererVFX.
  }
}

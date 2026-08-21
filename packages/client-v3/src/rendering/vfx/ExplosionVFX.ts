import Phaser from 'phaser';
import { GRID } from '@sector-battle/shared';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

/** VFX particles live in the `vfx` multipack atlas. Frame names are bare. */
const VFX_ATLAS = 'vfx';

const MUZZLE_FRAMES = ['muzzle_01', 'muzzle_02', 'muzzle_03', 'muzzle_04', 'muzzle_05'];
const FLARE_FRAMES = ['flare_01'];
const FIRE_FRAMES = ['fire_01', 'fire_02'];
const CIRCLE_FRAMES = ['circle_01', 'circle_02', 'circle_03', 'circle_04', 'circle_05'];
const LIGHT_FRAMES = ['light_01', 'light_02', 'light_03'];
const SCORCH_FRAMES = ['scorch_01', 'scorch_02', 'scorch_03'];
const FLAME_FRAMES = ['flame_01', 'flame_02', 'flame_03', 'flame_04', 'flame_05', 'flame_06'];
const SPARK_FRAMES = [
  'spark_01',
  'spark_02',
  'spark_03',
  'spark_04',
  'spark_05',
  'spark_06',
  'spark_07',
];
const SMOKE_FRAMES = [
  'smoke_01',
  'smoke_02',
  'smoke_03',
  'smoke_04',
  'smoke_05',
  'smoke_06',
  'smoke_07',
  'smoke_08',
  'smoke_09',
  'smoke_10',
];

/* ── Off-screen cull margins (ticket #49) ──────────────────
 *
 * Every pixel this class spawns lies within `max(CORE_MAX_HALF_EXTENT,
 * radius + RAY_PARTICLE_MAX_REACH)` of the blast center, so a center outside
 * `camera.worldView` grown by that margin (+ staleness pad) can never put a
 * pixel on screen and the whole spawn storm is skipped. Each term is derived
 * from the constants in this file (do not tweak one in isolation):
 *
 *  • Ray-particle centers stop at `radius` (the `dist > radius` break in
 *    `create`); the widest particle reaches 90px beyond its center — smoke
 *    rises 30px and tweens to 1.5x of its 80px display size (30 + 80*1.5/2).
 *  • The widest center-core sprite is the shockwave ring: every `vfx` atlas
 *    frame is 64px natural and the ring tweens to absolute scale 6 → 384px
 *    display → 192px half-extent.
 *  • The pad covers `worldView` being at most one preRender stale at spawn
 *    time (a frame of camera follow at dash speed moves the view ~22px).
 */
const VFX_FRAME_NATURAL_SIZE = 64;
const RING_MAX_TWEEN_SCALE = 6;
const CORE_MAX_HALF_EXTENT = (VFX_FRAME_NATURAL_SIZE * RING_MAX_TWEEN_SCALE) / 2;
const RAY_PARTICLE_MAX_REACH = 90;
const VIEW_STALENESS_PAD = 64;

interface ExplosionParticle {
  sprite: Phaser.GameObjects.Sprite;
  expiryTime: number;
}

/** `ExplosionVFX.spawn` options (one blast). */
export interface ExplosionSpawnOptions {
  /** Server explosion-entity key; scopes the per-explosion particle tracking. */
  key: string;
  x: number;
  y: number;
  /** Blast radius in world px (drives the per-ray tile storm extent). */
  radius: number;
  /** Fires once the blast has fully played out (entity-map cleanup). */
  onExpire: () => void;
}

export class ExplosionVFX implements VFXEffect<ExplosionSpawnOptions> {
  readonly id = 'explosion' as const;
  private scene: Phaser.Scene;
  private readonly pool: SpritePool;
  private particles = new Map<string, ExplosionParticle[]>();

  constructor(scene: Phaser.Scene, pool: SpritePool) {
    this.scene = scene;
    this.pool = pool;
  }

  /**
   * Release a tracked particle back to the sprite pool and drop it from the
   * per-explosion tracking array. Splicing before release guarantees a released
   * sprite is never referenced by a stale tracking entry when re-acquired.
   */
  private releaseParticle(key: string, sprite: Phaser.GameObjects.Sprite): void {
    const arr = this.particles.get(key);
    if (arr) {
      const idx = arr.findIndex((p) => p.sprite === sprite);
      if (idx >= 0) arr.splice(idx, 1);
    }
    this.pool.release(sprite);
  }

  spawn(opts: ExplosionSpawnOptions): void {
    const { key, x, y, radius, onExpire } = opts;
    const maxTiles = Math.ceil(radius / GRID.TILE_SIZE);
    const MS_PER_TILE = 50;

    // Off-screen cull (ticket #49): when the blast center is farther than the
    // cull margin from the camera's world view (which already accounts for
    // scroll + zoom), nothing this method spawns can reach the screen, so the
    // entire visual spawn (core sprite acquisitions + tweens + the per-ray
    // delayedCall storm) is skipped. The final expiry backstop is still
    // scheduled with identical timing so the caller's cleanup
    // (EntityRendererExplosions.addExplosion's onDone deletes the entity-map
    // entry) fires exactly as it does for spawned explosions — and the later
    // `remove(key)` from the server's entity removal no-ops safely because
    // no particle array was registered. A missing camera means "cannot prove
    // off-screen" → spawn as before (never cull a possibly-visible effect).
    const view = this.scene.cameras.main?.worldView;
    if (view) {
      const cullMargin =
        Math.max(CORE_MAX_HALF_EXTENT, radius + RAY_PARTICLE_MAX_REACH) + VIEW_STALENESS_PAD;
      if (
        x < view.x - cullMargin ||
        x > view.right + cullMargin ||
        y < view.y - cullMargin ||
        y > view.bottom + cullMargin
      ) {
        this.scene.time.delayedCall(maxTiles * MS_PER_TILE + 1500, onExpire);
        return;
      }
    }

    const particles: ExplosionParticle[] = [];
    this.particles.set(key, particles);

    const pick = (arr: readonly string[]): string => arr[Math.floor(Math.random() * arr.length)]!;
    const hasFrame = (f: string): boolean => this.scene.textures.get(VFX_ATLAS).has(f);

    const flashFrame = pick(MUZZLE_FRAMES);
    if (hasFrame(flashFrame)) {
      const flash = this.pool
        .acquire(VFX_ATLAS, flashFrame, x, y)
        .setOrigin(0.5)
        .setDisplaySize(128, 128)
        .setDepth(18)
        .setAlpha(1)
        .setTint(0xffee88)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.scene.tweens.add({
        targets: flash,
        scaleX: 4,
        scaleY: 4,
        alpha: 0,
        duration: 100,
        onComplete: () => {
          this.pool.release(flash);
        },
      });
    }

    const flareFrame = pick(FLARE_FRAMES);
    if (hasFrame(flareFrame)) {
      const flare = this.pool
        .acquire(VFX_ATLAS, flareFrame, x, y)
        .setOrigin(0.5)
        .setDisplaySize(200, 200)
        .setDepth(18)
        .setAlpha(0.9)
        .setTint(0xff8800)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.scene.tweens.add({
        targets: flare,
        scaleX: 3,
        scaleY: 3,
        alpha: 0,
        duration: 150,
        onComplete: () => {
          this.pool.release(flare);
        },
      });
    }

    const fireFrame = pick(FIRE_FRAMES);
    if (hasFrame(fireFrame)) {
      const fireCore = this.pool
        .acquire(VFX_ATLAS, fireFrame, x, y)
        .setOrigin(0.5)
        .setDisplaySize(160, 160)
        .setDepth(18)
        .setAlpha(0.9)
        .setTint(0xffcc44)
        .setBlendMode(Phaser.BlendModes.ADD);
      particles.push({ sprite: fireCore, expiryTime: performance.now() + 300 });
      this.scene.tweens.add({
        targets: fireCore,
        scaleX: 0.3,
        scaleY: 0.3,
        alpha: 0,
        duration: 250,
        onComplete: () => {
          this.releaseParticle(key, fireCore);
        },
      });
    }

    const circleFrame = pick(CIRCLE_FRAMES);
    if (hasFrame(circleFrame)) {
      const ring = this.pool
        .acquire(VFX_ATLAS, circleFrame, x, y)
        .setOrigin(0.5)
        .setDisplaySize(64, 64)
        .setDepth(17)
        .setAlpha(0.7)
        .setTint(0xff8844)
        .setBlendMode(Phaser.BlendModes.ADD);
      particles.push({ sprite: ring, expiryTime: performance.now() + 400 });
      this.scene.tweens.add({
        targets: ring,
        scaleX: 6,
        scaleY: 6,
        alpha: 0,
        duration: 200,
        onComplete: () => {
          this.releaseParticle(key, ring);
        },
      });
    }

    const lightFrame = pick(LIGHT_FRAMES);
    if (hasFrame(lightFrame)) {
      const glow = this.pool
        .acquire(VFX_ATLAS, lightFrame, x, y)
        .setOrigin(0.5)
        .setDisplaySize(192, 192)
        .setDepth(17)
        .setAlpha(0.8)
        .setTint(0xffee88)
        .setBlendMode(Phaser.BlendModes.ADD);
      particles.push({ sprite: glow, expiryTime: performance.now() + 500 });
      this.scene.tweens.add({
        targets: glow,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          this.releaseParticle(key, glow);
        },
      });
    }

    const RAY_DIRS: [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];

    for (const [dx, dy] of RAY_DIRS) {
      for (let tile = 1; tile <= maxTiles; tile++) {
        const delay = tile * MS_PER_TILE;
        const px = x + dx * tile * GRID.TILE_SIZE;
        const py = y + dy * tile * GRID.TILE_SIZE;
        const dist = Math.sqrt((px - x) ** 2 + (py - y) ** 2);
        if (dist > radius) break;

        this.scene.time.delayedCall(delay, () => {
          this.spawnFlame(key, px, py, particles);
          this.spawnSparks(key, px, py, particles);
        });

        this.scene.time.delayedCall(delay + 200, () => {
          this.spawnSmoke(key, px, py, particles);
        });
      }
    }

    const scorchFrame = pick(SCORCH_FRAMES);
    if (hasFrame(scorchFrame)) {
      const scorch = this.pool
        .acquire(VFX_ATLAS, scorchFrame, x, y)
        .setOrigin(0.5)
        .setDisplaySize(192, 192)
        .setDepth(3)
        .setAlpha(0.7)
        .setTint(0x221100);
      particles.push({ sprite: scorch, expiryTime: performance.now() + 3000 });
      this.scene.tweens.add({
        targets: scorch,
        alpha: 0,
        duration: 3000,
        onComplete: () => {
          this.releaseParticle(key, scorch);
        },
      });
    }

    this.scene.time.delayedCall(maxTiles * MS_PER_TILE + 1500, () => {
      onExpire();
    });
  }

  /**
   * Targeted cancellation (narrow interface extension): the server removed the
   * explosion entity, so return that blast's still-tracked sprites to the pool
   * immediately. Not expressible as `spawn` (it ends a visual rather than
   * starting one).
   */
  remove(key: string): void {
    const parts = this.particles.get(key);
    if (parts) {
      for (const p of parts) {
        if (p.sprite && p.sprite.active) this.pool.release(p.sprite);
      }
      this.particles.delete(key);
    }
  }

  update(_dt: number): void {
    const now = performance.now();
    for (const [key, particles] of this.particles) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]!;
        if (now >= p.expiryTime && p.sprite.active) {
          this.pool.release(p.sprite);
          particles.splice(i, 1);
        }
      }
      if (particles.length === 0) this.particles.delete(key);
    }
  }

  /** Release every in-flight particle to the pool; the effect stays usable. */
  clear(): void {
    for (const particles of this.particles.values()) {
      for (const p of particles) {
        if (p.sprite && p.sprite.active) this.pool.release(p.sprite);
      }
    }
    this.particles.clear();
  }

  destroy(): void {
    this.clear();
  }

  private spawnFlame(key: string, x: number, y: number, particles: ExplosionParticle[]): void {
    const frame = FLAME_FRAMES[Math.floor(Math.random() * FLAME_FRAMES.length)]!;
    if (!this.scene.textures.get(VFX_ATLAS).has(frame)) return;
    const sprite = this.pool
      .acquire(VFX_ATLAS, frame, x, y)
      .setOrigin(0.5)
      .setDisplaySize(96, 96)
      .setDepth(18)
      .setAlpha(0.9)
      .setTint(0xff6622)
      .setBlendMode(Phaser.BlendModes.ADD);
    const expiry = performance.now() + 300;
    particles.push({ sprite, expiryTime: expiry });
    this.scene.tweens.add({
      targets: sprite,
      alpha: 0,
      scaleX: 0.3,
      scaleY: 0.3,
      duration: 200,
      onComplete: () => {
        this.releaseParticle(key, sprite);
      },
    });
  }

  private spawnSparks(key: string, x: number, y: number, particles: ExplosionParticle[]): void {
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
      const frame = SPARK_FRAMES[Math.floor(Math.random() * SPARK_FRAMES.length)]!;
      if (!this.scene.textures.get(VFX_ATLAS).has(frame)) continue;
      const offsetX = (Math.random() - 0.5) * 48;
      const offsetY = (Math.random() - 0.5) * 48;
      const sprite = this.pool
        .acquire(VFX_ATLAS, frame, x + offsetX, y + offsetY)
        .setOrigin(0.5)
        .setDisplaySize(24, 24)
        .setDepth(18)
        .setAlpha(1)
        .setTint(0xffaa33)
        .setBlendMode(Phaser.BlendModes.ADD);
      const expiry = performance.now() + 400;
      particles.push({ sprite, expiryTime: expiry });
      this.scene.tweens.add({
        targets: sprite,
        x: x + offsetX + (Math.random() - 0.5) * 80,
        y: y + offsetY + (Math.random() - 0.5) * 80,
        alpha: 0,
        duration: 200 + Math.random() * 200,
        onComplete: () => {
          this.releaseParticle(key, sprite);
        },
      });
    }
  }

  private spawnSmoke(key: string, x: number, y: number, particles: ExplosionParticle[]): void {
    const frame = SMOKE_FRAMES[Math.floor(Math.random() * SMOKE_FRAMES.length)]!;
    if (!this.scene.textures.get(VFX_ATLAS).has(frame)) return;
    const sprite = this.pool
      .acquire(VFX_ATLAS, frame, x, y)
      .setOrigin(0.5)
      .setDisplaySize(80, 80)
      .setDepth(17)
      .setAlpha(0.5)
      .setTint(0x333333);
    const expiry = performance.now() + 700;
    particles.push({ sprite, expiryTime: expiry });
    this.scene.tweens.add({
      targets: sprite,
      y: y - 30,
      alpha: 0,
      scaleX: 1.5,
      scaleY: 1.5,
      duration: 500,
      onComplete: () => {
        this.releaseParticle(key, sprite);
      },
    });
  }
}

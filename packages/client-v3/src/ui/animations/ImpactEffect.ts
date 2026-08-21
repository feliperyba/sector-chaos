import Phaser from 'phaser';
import { MenuAnim } from './MenuAnimationConfig.js';
import type { MenuDioramaTitlePalette } from '../layers/menuDioramaComposition.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORE_START_SCALE_MULT = 0.8;
const CORE_TARGET_SCALE_MULT = 0.7;
const GLOW_RING_STROKE_MULT = 2.5;
const GLOW_RING_ALPHA_MULT = 0.3;
const BRIGHT_RING_DURATION_MULT = 0.7;

/** Ember/campfire tint set for particle burst — palette A (ticket 03/07).
 *  Only the hex constants changed vs. the legacy amber/gold set; the array
 *  length, ordering role, and consumer (particle emitter tint) are unchanged. */
const BURST_TINTS = [
  0x9a2a1a, // forge/blood ember (palette A danger)
  0xc89456, // oxidized brass (palette A primary)
  0xfff4e0, // cream (palette A title text)
  0xffffff, // white-hot core
] as const;

const PARTICLE_TEXTURE_KEY = '__impact_particle';

// ---------------------------------------------------------------------------
// Color resolution (theme-adaptive)
// ---------------------------------------------------------------------------

/**
 * Resolved per-effect colors: the glow tint, one color per ring wave, and the
 * burst tint set. Computed once at construction from either the theme palette
 * (preferred — matches the diorama variant) or the legacy warm-only fallback.
 */
interface EffectColors {
  readonly glow: number;
  readonly rings: readonly number[];
  readonly burst: readonly number[];
}

/**
 * Map the theme palette to the per-effect color slots. When no palette is
 * provided, fall back to the legacy warm-only `ember` + `BURST_TINTS` values so
 * ImpactEffect stays usable standalone (and any caller that skips the palette
 * gets the original warm read).
 *
 * Slot mapping (see menuDioramaComposition.getMenuDioramaTitlePalette):
 *   glow + ring[0] → warm   (the campfire's own flare — constant identity)
 *   ring[1]        → biome  (the place accent — the adaptive read)
 *   ring[2]        → cream  (luminous highlight — constant)
 *   burst          → [deep, warm, biome, cream] (2-tone place + fire scatter)
 */
function resolveEffectColors(palette?: MenuDioramaTitlePalette): EffectColors {
  if (palette) {
    return {
      glow: palette.warm,
      rings: [palette.warm, palette.biome, palette.cream],
      burst: [palette.deep, palette.warm, palette.biome, palette.cream],
    };
  }
  const waves = MenuAnim.impact.rings.waves;
  return {
    glow: MenuAnim.impact.glow.color,
    rings: waves.map((w) => w!.color),
    burst: [...BURST_TINTS],
  };
}

// ---------------------------------------------------------------------------
// ImpactEffect
// ---------------------------------------------------------------------------

/**
 * Impact flash choreography for the main-menu title entrance.
 *
 * Spawns a glow ellipse, three expanding ring waves, and an additive
 * particle burst. Ported from pixi-gamelab's MenuImpactEffect (GSAP + PixiJS)
 * to Phaser tweens + Phaser particle emitter.
 *
 * Manages its own tween lifecycle internally — does NOT share a TweenTracker,
 * matching the reference implementation's self-contained cleanup pattern.
 *
 * @see Issue #49
 */
export class ImpactEffect {
  private readonly scene: Phaser.Scene;
  private readonly layer: Phaser.GameObjects.Container;
  /** Resolved theme-adaptive colors for glow + rings + burst. */
  private readonly effectColors: EffectColors;

  private readonly tweens: Phaser.Tweens.Tween[] = [];
  private readonly graphics: Phaser.GameObjects.Graphics[] = [];
  private emitters: Phaser.GameObjects.Particles.ParticleEmitter[] = [];
  private emitterGen = 0;
  private textureCreated = false;

  constructor(
    scene: Phaser.Scene,
    layer: Phaser.GameObjects.Container,
    /**
     * Theme-adaptive palette (resolved from the picked diorama variant by
     * MainMenuScene). When omitted, the legacy warm-only `ember` / `BURST_TINTS`
     * default is used — see `resolveEffectColors`.
     */
    palette?: MenuDioramaTitlePalette,
  ) {
    this.scene = scene;
    this.layer = layer;
    this.effectColors = resolveEffectColors(palette);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Spawn glow + 3 ring waves + particle burst. */
  fire(): void {
    this.clear();
    this.ensureParticleTexture();
    this.spawnImpactGlow();
    this.spawnRingWaves();
    this.spawnBurst();
  }

  /** Destroy all tracked graphics and particle emitters. */
  clear(): void {
    this.emitterGen++;

    // Stop all owned tweens first
    for (const tween of this.tweens) {
      tween.stop();
    }
    this.tweens.length = 0;

    // Destroy emitters
    for (const emitter of this.emitters) {
      emitter.stop();
      emitter.destroy();
    }
    this.emitters = [];

    // Destroy graphics
    for (const gfx of this.graphics) {
      gfx.destroy();
    }
    this.graphics.length = 0;
  }

  // -----------------------------------------------------------------------
  // Impact glow
  // -----------------------------------------------------------------------

  private spawnImpactGlow(): void {
    const cfg = MenuAnim.impact.glow;

    // Outer glow
    const outerGlow = this.scene.add.graphics();
    outerGlow.fillStyle(this.effectColors.glow, cfg.alpha);
    outerGlow.fillEllipse(0, 0, cfg.radiusX * 2, cfg.radiusY * 2);
    outerGlow.setScale(cfg.startScale);
    this.layer.add(outerGlow);
    this.graphics.push(outerGlow);

    this.trackTween(
      this.scene.tweens.add({
        targets: outerGlow,
        alpha: 0,
        duration: cfg.duration,
        ease: cfg.ease,
        onComplete: () => {
          this.removeGraphic(outerGlow);
        },
      }),
    );

    this.trackTween(
      this.scene.tweens.add({
        targets: outerGlow,
        scaleX: cfg.targetScale,
        scaleY: cfg.targetScale,
        duration: cfg.duration,
        ease: cfg.ease,
      }),
    );

    // Core
    const core = this.scene.add.graphics();
    core.fillStyle(0xffffff, cfg.coreAlpha);
    core.fillEllipse(0, 0, cfg.coreRadiusX * 2, cfg.coreRadiusY * 2);
    core.setScale(cfg.startScale * CORE_START_SCALE_MULT);
    this.layer.add(core);
    this.graphics.push(core);

    this.trackTween(
      this.scene.tweens.add({
        targets: core,
        alpha: 0,
        duration: cfg.coreDuration,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          this.removeGraphic(core);
        },
      }),
    );

    this.trackTween(
      this.scene.tweens.add({
        targets: core,
        scaleX: cfg.targetScale * CORE_TARGET_SCALE_MULT,
        scaleY: cfg.targetScale * CORE_TARGET_SCALE_MULT,
        duration: cfg.coreDuration,
        ease: 'Quad.easeOut',
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Ring waves
  // -----------------------------------------------------------------------

  private spawnRingWaves(): void {
    const waves = MenuAnim.impact.rings.waves;
    const ringColors = this.effectColors.rings;

    for (let i = 0; i < waves.length; i++) {
      const wave = waves[i];
      // Fall back to the wave's own cfg.color if the palette is short a slot
      // (keeps the effect intact if MenuAnim grows a 4th ring wave).
      if (wave) this.spawnRingWave(wave, ringColors[i] ?? wave.color);
    }
  }

  private spawnRingWave(
    cfg: NonNullable<typeof MenuAnim.impact.rings.waves[number]>,
    color: number,
  ): void {
    // Glow ring (wider stroke, lower alpha)
    const glowRing = this.scene.add.graphics();
    glowRing.lineStyle(
      cfg.stroke * GLOW_RING_STROKE_MULT,
      color,
      cfg.alpha * GLOW_RING_ALPHA_MULT,
    );
    glowRing.strokeEllipse(0, 0, cfg.radiusX, cfg.radiusY);
    glowRing.setScale(cfg.startScale);
    this.layer.add(glowRing);
    this.graphics.push(glowRing);

    this.trackTween(
      this.scene.tweens.add({
        targets: glowRing,
        alpha: 0,
        duration: cfg.duration,
        ease: cfg.ease,
        delay: cfg.delay,
        onComplete: () => {
          this.removeGraphic(glowRing);
        },
      }),
    );

    this.trackTween(
      this.scene.tweens.add({
        targets: glowRing,
        scaleX: cfg.targetScale,
        scaleY: cfg.targetScale,
        duration: cfg.duration,
        ease: cfg.ease,
        delay: cfg.delay,
      }),
    );

    // Bright ring (thin stroke, full alpha)
    const brightRing = this.scene.add.graphics();
    brightRing.lineStyle(cfg.stroke, color, cfg.alpha);
    brightRing.strokeEllipse(0, 0, cfg.radiusX, cfg.radiusY);
    brightRing.setScale(cfg.startScale);
    this.layer.add(brightRing);
    this.graphics.push(brightRing);

    this.trackTween(
      this.scene.tweens.add({
        targets: brightRing,
        alpha: 0,
        duration: cfg.duration * BRIGHT_RING_DURATION_MULT,
        ease: cfg.ease,
        delay: cfg.delay,
        onComplete: () => {
          this.removeGraphic(brightRing);
        },
      }),
    );

    this.trackTween(
      this.scene.tweens.add({
        targets: brightRing,
        scaleX: cfg.targetScale,
        scaleY: cfg.targetScale,
        duration: cfg.duration,
        ease: cfg.ease,
        delay: cfg.delay,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Particle burst
  // -----------------------------------------------------------------------

  private ensureParticleTexture(): void {
    if (this.textureCreated) return;

    const gfx = this.scene.add.graphics();
    gfx.fillStyle(0xffffff, 1);
    gfx.fillCircle(8, 8, 8);
    gfx.generateTexture(PARTICLE_TEXTURE_KEY, 16, 16);
    gfx.destroy();
    this.textureCreated = true;
  }

  private spawnBurst(): void {
    const cfg = MenuAnim.impact.burst;

    const emitter = this.scene.add.particles(0, 0, PARTICLE_TEXTURE_KEY, {
      lifespan: { min: cfg.lifetimeMin, max: cfg.lifetimeMax },
      speed: { min: cfg.speedStart * cfg.speedMinMult, max: cfg.speedStart },
      emitZone: {
        source: new Phaser.Geom.Rectangle(
          -cfg.spawnWidth / 2,
          -cfg.spawnHeight / 2,
          cfg.spawnWidth,
          cfg.spawnHeight,
        ),
      } as unknown as Phaser.Types.GameObjects.Particles.ParticleEmitterRandomZoneConfig,
      scale: { start: cfg.scalePeak, end: cfg.scaleEnd },
      alpha: { start: 1, end: 0 },
      tint: [...this.effectColors.burst],
      blendMode: 'ADD',
      quantity: cfg.particlesPerWave,
      frequency: -1, // single burst
      maxParticles: cfg.maxParticles,
      gravityY: cfg.gravity,
      rotate: { start: 0, end: 360 },
    });

    this.layer.add(emitter);
    this.emitters.push(emitter);

    // Single burst emit
    emitter.explode(cfg.maxParticles);

    const gen = this.emitterGen;

    // Auto-cleanup after max lifespan
    this.scene.time.delayedCall(cfg.lifetimeMax, () => {
      if (this.emitterGen === gen) {
        const idx = this.emitters.indexOf(emitter);
        if (idx >= 0) {
          this.emitters.splice(idx, 1);
        }
        emitter.destroy();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Track a tween for this effect's own lifecycle management. */
  private trackTween(tween: Phaser.Tweens.Tween): Phaser.Tweens.Tween {
    this.tweens.push(tween);
    return tween;
  }

  private removeGraphic(gfx: Phaser.GameObjects.Graphics): void {
    const idx = this.graphics.indexOf(gfx);
    if (idx >= 0) {
      this.graphics.splice(idx, 1);
    }
    gfx.destroy();
  }
}

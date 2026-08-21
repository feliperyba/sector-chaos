import { MenuAnim } from './MenuAnimationConfig.js';
import { ButtonAnimator } from './ButtonAnimator.js';
import { ImpactEffect } from './ImpactEffect.js';
import { TitleAnimator } from './TitleAnimator.js';
import { TweenTracker } from './TweenTracker.js';
import type { MenuDioramaTitlePalette } from '../layers/MenuBackground.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MenuEntranceLayout {
  readonly titleX: number;
  readonly titleY: number;
  readonly subtitleY: number;
  readonly buttonTargets: readonly { x: number; y: number }[];
}

// ---------------------------------------------------------------------------
// MenuEntranceChoreographer
// ---------------------------------------------------------------------------

/**
 * Conductor that coordinates the main-menu entrance sequence.
 *
 * Orchestrates TitleAnimator, ButtonAnimator, ImpactEffect, a fade overlay,
 * and camera shake into a ~2-second choreography.
 *
 * Ported from pixi-gamelab's MenuEntranceChoreographer (GSAP + PixiJS)
 * to Phaser tweens + Phaser GameObjects.
 *
 * Key differences from reference:
 * - GSAP → Phaser tweens
 * - Single shared TweenTracker for TitleAnimator, ButtonAnimator, and
 *   orchestrator-level tweens (fade overlay, scheduled callbacks)
 * - ImpactEffect manages its own tween lifecycle internally (no tracker)
 * - Camera shake via Phaser's camera.shake(duration, intensity)
 *
 * @see Issue #52
 */
export class MenuEntranceChoreographer {
  private readonly fadeOverlay: Phaser.GameObjects.Rectangle;
  private readonly impactLayer: Phaser.GameObjects.Container;
  private readonly buttonContainers: readonly Phaser.GameObjects.Container[];
  private readonly camera: Phaser.Cameras.Scene2D.Camera;
  private readonly onButtonsReady: () => void;

  private readonly scene: Phaser.Scene;
  private readonly tracker: TweenTracker;

  private readonly titleAnimator: TitleAnimator;
  private readonly buttonAnimator: ButtonAnimator;
  private readonly impactEffect: ImpactEffect;

  private started = false;
  private layout: MenuEntranceLayout | null = null;

  constructor(deps: {
    scene: Phaser.Scene;
    fadeOverlay: Phaser.GameObjects.Rectangle;
    titleLayer: Phaser.GameObjects.Container;
    titleSquashLayer: Phaser.GameObjects.Container;
    impactLayer: Phaser.GameObjects.Container;
    buttonContainers: readonly Phaser.GameObjects.Container[];
    camera: Phaser.Cameras.Scene2D.Camera;
    onButtonsReady: () => void;
    /**
     * Theme-adaptive palette for the impact flare (particles + ring waves +
     * glow), resolved from the picked diorama variant by MainMenuScene. When
     * omitted, ImpactEffect falls back to the legacy warm-only default.
     */
    titlePalette?: MenuDioramaTitlePalette;
  }) {
    this.scene = deps.scene;
    this.fadeOverlay = deps.fadeOverlay;
    this.impactLayer = deps.impactLayer;
    this.buttonContainers = deps.buttonContainers;
    this.camera = deps.camera;
    this.onButtonsReady = deps.onButtonsReady;

    // One shared tracker for TitleAnimator, ButtonAnimator, and orchestrator
    this.tracker = new TweenTracker(deps.scene);

    this.titleAnimator = new TitleAnimator({
      titleLayer: deps.titleLayer,
      titleSquashLayer: deps.titleSquashLayer,
      tracker: this.tracker,
      onImpact: () => {
        this.impactEffect.fire();
        this.camera.shake(MenuAnim.shake.duration, MenuAnim.shake.intensity);
      },
    });

    this.buttonAnimator = new ButtonAnimator({
      buttons: deps.buttonContainers,
      tracker: this.tracker,
      onButtonsReady: deps.onButtonsReady,
    });

    this.impactEffect = new ImpactEffect(deps.scene, deps.impactLayer, deps.titlePalette);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Play the full entrance choreography from the given layout. */
  play(layout: MenuEntranceLayout): void {
    this.stop();

    this.layout = layout;
    this.started = true;

    // Prepare animators
    this.titleAnimator.prepare({
      x: layout.titleX,
      y: layout.titleY,
    });

    this.buttonAnimator.prepare({ targets: layout.buttonTargets });
    this.fadeOverlay.setAlpha(1);

    // Fade overlay 1 → 0
    this.tracker.track(
      this.scene.tweens.add({
        targets: this.fadeOverlay,
        alpha: 0,
        duration: MenuAnim.fadeIn.duration,
        ease: MenuAnim.fadeIn.ease,
      }),
    );

    // Start title drop
    this.titleAnimator.play({
      x: layout.titleX,
      y: layout.titleY,
    });

    const config = MenuAnim.buttons;

    // Schedule button entrance
    this.tracker.delay(config.readyDelay, () => {
      this.buttonAnimator.play({ targets: layout.buttonTargets });
    });
  }

  /** Per-frame update hook (reserved for future per-frame effects). */
  update(_time: number, _delta: number): void {
    // ImpactEffect manages its own tween lifecycle internally.
    // Placeholder for any future per-frame updates.
  }

  /** Sync layout for resize — only applies when not mid-animation. */
  syncLayout(layout: MenuEntranceLayout): void {
    this.layout = layout;

    if (!this.started || this.titleAnimator.isAnimating()) {
      return;
    }

    this.titleAnimator.syncLayout({ x: layout.titleX, y: layout.titleY });
    this.buttonAnimator.syncLayout({ targets: layout.buttonTargets });
  }

  /** Stop all animations and clean up. */
  stop(): void {
    this.titleAnimator.dispose();
    this.buttonAnimator.dispose();
    this.impactEffect.clear();

    this.tracker.dispose();

    this.layout = null;
    this.started = false;
  }

  /** Full teardown — stop + release all references. */
  dispose(): void {
    this.stop();
  }
}

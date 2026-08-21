import { MenuAnim } from './MenuAnimationConfig.js';
import type { TweenTracker } from './TweenTracker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ButtonTargets {
  readonly targets: readonly { x: number; y: number }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OVERSHOOT_ROTATION_MULT = 0.5;
const UNDERSHOOT_ROTATION_MULT = 0.3;
const SETTLE_ROTATION_MULT = 0.15;

// ---------------------------------------------------------------------------
// ButtonAnimator
// ---------------------------------------------------------------------------

/**
 * Orchestrates the staggered button entrance animation for the main-menu.
 *
 * Each button flies in through 4 phases (overshoot → undershoot → settle
 * bounce → rest) with a configurable stagger delay between successive
 * buttons. Ported from pixi-gamelab's MenuCardAnimator (GSAP + PixiJS)
 * to Phaser tweens + Phaser GameObjects.
 *
 * @see Issue #51
 */
export class ButtonAnimator {
  private readonly buttons: readonly Phaser.GameObjects.Container[];
  private readonly tracker: TweenTracker;
  private readonly onButtonsReady: () => void;
  private buttonsReadyFired = false;

  constructor(deps: {
    buttons: readonly Phaser.GameObjects.Container[];
    tracker: TweenTracker;
    onButtonsReady: () => void;
  }) {
    this.buttons = deps.buttons;
    this.tracker = deps.tracker;
    this.onButtonsReady = deps.onButtonsReady;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Position buttons off-screen, ready for entrance animation. */
  prepare(layout: ButtonTargets): void {
    this.buttonsReadyFired = false;
    const config = MenuAnim.buttons;

    for (let i = 0; i < this.buttons.length; i++) {
      const target = layout.targets[i];
      if (!target) continue;

      const button = this.buttons[i];
      if (!button) continue;

      button.setAlpha(0);
      button.setPosition(target.x, target.y + config.startOffsetY);
      button.setRotation(this.resolveRotation(config, i));
      button.setScale(config.startScale);
    }
  }

  /** Play the staggered entrance animation for all buttons. */
  play(layout: ButtonTargets): void {
    const config = MenuAnim.buttons;

    for (let index = 0; index < this.buttons.length; index++) {
      const button = this.buttons[index];
      const target = layout.targets[index];
      if (!target || !button) continue;

      const rotation = this.resolveRotation(config, index);
      const delay = index * config.stagger;

      this.tracker.delay(delay, () => {
        // Phase 1: Overshoot
        this.tracker.track(
          button.scene.tweens.add({
            targets: button,
            y: target.y - config.overshoot.overshootY,
            alpha: 1,
            rotation: -rotation * OVERSHOOT_ROTATION_MULT,
            duration: config.overshoot.duration,
            ease: config.overshoot.ease,
            onComplete: () => {
              this.playUndershoot(button, target.y, rotation);
            },
          }),
        );

        this.tracker.track(
          button.scene.tweens.add({
            targets: button,
            scaleX: config.overshoot.scale,
            scaleY: config.overshoot.scale,
            duration: config.overshoot.duration,
            ease: config.overshoot.ease,
          }),
        );
      });
    }
  }

  /** Re-position buttons during animation (e.g. on resize). */
  syncLayout(layout: ButtonTargets): void {
    for (let i = 0; i < this.buttons.length; i++) {
      const target = layout.targets[i];
      if (target && this.buttons[i]) {
        this.buttons[i]!.setPosition(target.x, target.y);
      }
    }
  }

  /** Stop all tracked tweens and timers. */
  dispose(): void {
    this.tracker.dispose();
  }

  // -----------------------------------------------------------------------
  // Phase 2: Undershoot
  // -----------------------------------------------------------------------

  private playUndershoot(
    button: Phaser.GameObjects.Container,
    finalY: number,
    startRotation: number,
  ): void {
    const cfg = MenuAnim.buttons;

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        y: finalY + cfg.undershoot.undershootY,
        rotation: startRotation * UNDERSHOOT_ROTATION_MULT,
        duration: cfg.undershoot.duration,
        ease: cfg.undershoot.ease,
        onComplete: () => {
          this.playSettleBounce(button, finalY, startRotation);
        },
      }),
    );

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        scaleX: cfg.undershoot.scale,
        scaleY: cfg.undershoot.scale,
        duration: cfg.undershoot.duration,
        ease: cfg.undershoot.ease,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Phase 3: Settle bounce
  // -----------------------------------------------------------------------

  private playSettleBounce(
    button: Phaser.GameObjects.Container,
    finalY: number,
    startRotation: number,
  ): void {
    const cfg = MenuAnim.buttons;

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        y: finalY - cfg.settleBounce.settleY,
        rotation: -startRotation * SETTLE_ROTATION_MULT,
        duration: cfg.settleBounce.duration,
        ease: cfg.settleBounce.ease,
        onComplete: () => {
          this.playRest(button, finalY);
        },
      }),
    );

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        scaleX: cfg.settleBounce.scale,
        scaleY: cfg.settleBounce.scale,
        duration: cfg.settleBounce.duration,
        ease: cfg.settleBounce.ease,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Phase 4: Rest
  // -----------------------------------------------------------------------

  private playRest(button: Phaser.GameObjects.Container, finalY: number): void {
    const cfg = MenuAnim.buttons;

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        y: finalY,
        rotation: 0,
        duration: cfg.rest.duration,
        ease: cfg.rest.ease,
        onComplete: () => {
          this.playGlowPulse(button);
          if (!this.buttonsReadyFired) {
            this.buttonsReadyFired = true;
            this.onButtonsReady();
          }
        },
      }),
    );

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        scaleX: 1,
        scaleY: 1,
        duration: cfg.rest.duration,
        ease: cfg.rest.ease,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Post-entrance glow pulse (#63)
  // -----------------------------------------------------------------------

  /** Gentle scale breathing that makes resting buttons feel alive. */
  private playGlowPulse(button: Phaser.GameObjects.Container): void {
    const pulse = MenuAnim.buttons.glowPulse;

    this.tracker.track(
      button.scene.tweens.add({
        targets: button,
        scaleX: pulse.scaleX,
        scaleY: pulse.scaleY,
        duration: pulse.duration,
        ease: pulse.ease,
        yoyo: true,
        repeat: pulse.repeat,
        delay: pulse.delay,
        onComplete: () => {
          button.setScale(1, 1);
        },
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private resolveRotation(config: typeof MenuAnim.buttons, index: number): number {
    return config.rotations[index] ?? config.rotations[0] ?? 0;
  }
}

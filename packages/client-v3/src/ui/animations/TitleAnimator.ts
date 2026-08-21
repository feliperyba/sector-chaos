import { MenuAnim } from './MenuAnimationConfig.js';
import type { TweenTracker } from './TweenTracker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TitleLayout {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// TitleAnimator
// ---------------------------------------------------------------------------

/**
 * Orchestrates the title drop, squash/stretch bounce, settle wobble, and
 * subtitle reveal choreography for the main-menu entrance.
 *
 * Ported from pixi-gamelab's MenuTitleAnimator (GSAP + PixiJS) to
 * Phaser tweens + Phaser GameObjects.
 *
 * @see Issue #50
 */
export class TitleAnimator {
  private readonly titleLayer: Phaser.GameObjects.Container;
  private readonly titleSquashLayer: Phaser.GameObjects.Container;

  private readonly tracker: TweenTracker;
  private readonly onImpact: () => void;

  private subtitleBaseY = 0;

  constructor(deps: {
    titleLayer: Phaser.GameObjects.Container;
    titleSquashLayer: Phaser.GameObjects.Container;
    tracker: TweenTracker;
    onImpact: () => void;
  }) {
    this.titleLayer = deps.titleLayer;
    this.titleSquashLayer = deps.titleSquashLayer;
    this.tracker = deps.tracker;
    this.onImpact = deps.onImpact;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Position layers off-screen, ready for animation. */
  prepare(layout: TitleLayout): void {
    const title = MenuAnim.title;

    this.titleLayer.setAlpha(1);
    this.titleLayer.setPosition(layout.x, title.startY);
    this.titleLayer.setRotation(title.startRotation);
    this.titleLayer.setScale(title.startScale);
    this.titleSquashLayer.setScale(1);
  }

  /** Play the full entrance choreography. */
  play(layout: TitleLayout): void {
    this.dropTitle(layout);
  }

  /** Re-position the title during animation (e.g. on resize). */
  syncLayout(layout: TitleLayout): void {
    this.titleLayer.setPosition(layout.x, layout.y);
  }

  /** True if any tracked tween or timer is still active. */
  isAnimating(): boolean {
    return this.tracker.isActive();
  }

  /** Stop all tracked tweens and timers. */
  dispose(): void {
    this.tracker.dispose();
  }

  // -----------------------------------------------------------------------
  // Drop
  // -----------------------------------------------------------------------

  private dropTitle(layout: TitleLayout): void {
    const title = MenuAnim.title;

    this.tracker.track(
      this.titleLayer.scene.tweens.add({
        targets: this.titleLayer,
        y: layout.y + title.overshootY,
        rotation: title.bounceRotation,
        duration: title.dropDuration,
        ease: title.dropEase,
        onComplete: () => {
          this.playBounce(layout.y);
        },
      }),
    );

    this.tracker.track(
      this.titleLayer.scene.tweens.add({
        targets: this.titleLayer,
        scaleX: title.overshootScale,
        scaleY: title.overshootScale,
        duration: title.dropDuration,
        ease: title.dropEase,
      }),
    );
  }

  // -----------------------------------------------------------------------
  // Bounce phases
  // -----------------------------------------------------------------------

  private playBounce(finalY: number): void {
    const bounce = MenuAnim.bounce;
    let accumulatedDelay = 0;

    for (let i = 0; i < bounce.phases.length; i++) {
      const phase = bounce.phases[i]!;
      const phaseDelay = accumulatedDelay;

      this.tracker.delay(phaseDelay, () => {
        this.tracker.track(
          this.titleLayer.scene.tweens.add({
            targets: this.titleLayer,
            y: finalY + phase.y,
            rotation: phase.rot,
            duration: phase.dur,
            ease: 'Quad.easeOut',
          }),
        );

        this.tracker.track(
          this.titleSquashLayer.scene.tweens.add({
            targets: this.titleSquashLayer,
            scaleX: phase.squashX,
            scaleY: phase.squashY,
            duration: phase.dur * bounce.squashDurationRatio,
            ease: 'Quad.easeOut',
          }),
        );

        if (i === bounce.impactPhaseIndex) {
          this.onImpact();
        }
      });

      accumulatedDelay += phase.dur;
    }

    this.tracker.delay(accumulatedDelay, () => this.playSettle());
  }

  // -----------------------------------------------------------------------
  // Settle
  // -----------------------------------------------------------------------

  private playSettle(): void {
    const bounce = MenuAnim.bounce;

    this.tracker.track(
      this.titleSquashLayer.scene.tweens.add({
        targets: this.titleSquashLayer,
        scaleX: 1,
        scaleY: 1,
        duration: bounce.settleDuration,
        ease: bounce.settleEase,
      }),
    );

    this.playSettleRotations();
  }

  private playSettleRotations(): void {
    const steps = MenuAnim.title.settleSteps;
    let accumulatedDelay = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepDelay = accumulatedDelay;

      this.tracker.delay(stepDelay, () => {
        this.tracker.track(
          this.titleLayer.scene.tweens.add({
            targets: this.titleLayer,
            rotation: step.rotation,
            duration: step.duration,
            ease: 'Quad.easeOut',
          }),
        );
      });

      accumulatedDelay += step.duration;
    }
  }
}

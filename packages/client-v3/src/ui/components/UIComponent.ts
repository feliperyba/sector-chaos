import Phaser from 'phaser';
import { DesignTokens } from '../DesignTokens.js';

/**
 * Abstract base for all UI components.
 * Provides show/hide animations, interactability toggle, and clean destroy.
 */
export abstract class UIComponent extends Phaser.GameObjects.Container {
  private tweens: Phaser.Tweens.Tween[] = [];

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    scene.add.existing(this);
  }

  /** Show with optional entrance animation (alpha 0→1, bounce ease) */
  show(animated = true): void {
    this.setVisible(true);
    if (animated) {
      this.setAlpha(0);
      const tw = this.scene.tweens.add({
        targets: this,
        alpha: 1,
        duration: DesignTokens.duration.fast,
        ease: DesignTokens.easing.bounce,
      });
      this.tweens.push(tw);
    } else {
      this.setAlpha(1);
    }
  }

  /** Hide with optional exit animation (alpha 1→0, then visible false) */
  hide(animated = true): void {
    if (animated) {
      const tw = this.scene.tweens.add({
        targets: this,
        alpha: 0,
        duration: DesignTokens.duration.fast,
        ease: DesignTokens.easing.snappy,
        onComplete: () => {
          this.setVisible(false);
        },
      });
      this.tweens.push(tw);
    } else {
      this.setAlpha(0);
      this.setVisible(false);
    }
  }

  /** Enable or disable pointer interaction on this container */
  setInteractable(interactive: boolean): void {
    if (interactive) {
      this.setInteractive({ useHandCursor: true });
    } else {
      this.disableInteractive();
    }
  }

  /** Register a tween for cleanup tracking */
  protected trackTween(tw: Phaser.Tweens.Tween): void {
    this.tweens.push(tw);
  }

  /** Full cleanup — stops tweens, removes children, clears events */
  override destroy(fromScene?: boolean): void {
    for (const tw of this.tweens) {
      tw.stop();
    }
    this.tweens = [];
    this.removeAll(true);
    this.removeAllListeners();
    super.destroy(fromScene);
  }
}

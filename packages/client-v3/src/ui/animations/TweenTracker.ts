import Phaser from 'phaser';

/**
 * TweenTracker — lifecycle manager for Phaser tweens and timers.
 *
 * Tracks tweens and delayed callbacks so they can be stopped/removed
 * in one call via dispose(). Prevents orphaned animations on scene shutdown.
 *
 * Port of pixi-gamelab's GSAP-based TweenTracker, adapted for Phaser tweens.
 */
export class TweenTracker {
  private readonly tweens: Phaser.Tweens.Tween[] = [];
  private readonly timers: Phaser.Time.TimerEvent[] = [];
  private readonly scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Track a tween for later cleanup. Returns the same tween for chaining. */
  track(tween: Phaser.Tweens.Tween): Phaser.Tweens.Tween {
    this.tweens.push(tween);
    return tween;
  }

  /** Schedule a delayed callback, tracked for cleanup. */
  delay(ms: number, callback: () => void): Phaser.Time.TimerEvent {
    const timer = this.scene.time.delayedCall(ms, callback);
    this.timers.push(timer);
    return timer;
  }

  /** True if any tracked tween or timer is still active. */
  isActive(): boolean {
    for (const t of this.tweens) {
      if (t.isPlaying()) return true;
    }
    for (const timer of this.timers) {
      if (timer.getProgress() < 1) return true;
    }
    return false;
  }

  /** Stop all tracked tweens and remove all timers. */
  dispose(): void {
    for (const t of this.tweens) {
      t.stop();
    }
    this.tweens.length = 0;

    for (const timer of this.timers) {
      timer.remove(false);
    }
    this.timers.length = 0;
  }
}

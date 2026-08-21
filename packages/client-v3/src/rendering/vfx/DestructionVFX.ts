import type Phaser from 'phaser';
import type { SpritePool } from './SpritePool.js';
import type { VFXEffect } from './VFXEffect.js';

/** `DestructionVFX.spawn` options — the damage-feedback shake. */
export interface DestructionSpawnOptions {
  kind: 'shake';
  /** Destructible entity key (scopes the active shake tween). */
  key: string;
  /** The destructible's own sprite — shaken in place, never owned here. */
  sprite: Phaser.GameObjects.Sprite;
}

export class DestructionVFX implements VFXEffect<DestructionSpawnOptions> {
  readonly id = 'destruction' as const;
  private scene: Phaser.Scene;
  private activeShakeTweens = new Map<string, Phaser.Tweens.Tween>();

  constructor(scene: Phaser.Scene, _pool: SpritePool) {
    // `_pool`: injected for lifecycle uniformity (ticket 52); this effect only
    // tweens caller-owned sprites and allocates none of its own.
    this.scene = scene;
  }

  spawn(opts: DestructionSpawnOptions): void {
    this.shake(opts.key, opts.sprite);
  }

  private shake(key: string, sprite: Phaser.GameObjects.Sprite): void {
    const existing = this.activeShakeTweens.get(key);
    if (existing) {
      existing.stop();
      this.activeShakeTweens.delete(key);
    }
    const baseX = sprite.x;
    const tween = this.scene.tweens.add({
      targets: sprite,
      x: baseX + 4,
      duration: 38,
      yoyo: true,
      repeat: 3,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        sprite.x = baseX;
        this.activeShakeTweens.delete(key);
      },
    });
    this.activeShakeTweens.set(key, tween);
  }

  /**
   * Targeted cancellation (narrow interface extension): the destructible was
   * removed, so stop just its shake — not every active shake.
   */
  onRemove(key: string): void {
    const tween = this.activeShakeTweens.get(key);
    if (tween) {
      tween.stop();
      this.activeShakeTweens.delete(key);
    }
  }

  /** Tween-driven effect — nothing to tick per frame. */
  update(_dt: number): void {}

  /** Stop every active shake tween; the effect stays usable. */
  clear(): void {
    for (const tween of this.activeShakeTweens.values()) {
      tween.stop();
    }
    this.activeShakeTweens.clear();
  }

  destroy(): void {
    this.clear();
  }
}

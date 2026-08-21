import type Phaser from 'phaser';

/** `Phaser.BlendModes.NORMAL` — spelled out so this file stays type-only. */
const BLEND_MODE_NORMAL = 0;

/**
 * Phaser sprite pool — acquire/release pattern, zero per-frame allocation after
 * warmup.
 *
 * Sprites are pooled per-texture: a released sprite is hidden + deactivated and
 * returned to its texture's free-list; acquire pops one (or creates a new
 * sprite) and re-shows it. Because textures are now multipack atlases, acquire
 * also re-applies the requested frame on every call — a reused sprite would
 * otherwise keep showing whatever frame it last held. Release also kills any
 * in-flight tweens targeting the sprite so a pooled sprite is never animated by
 * a stale tween.
 *
 * Since ticket 52 the pool is shared by ALL seven VFX effects, so a reused
 * sprite carries whatever the previous effect left on it (an explosion flash's
 * ADD blend, a blood splat's red tint, a fragment's faded alpha, a rotated
 * spark). acquire() therefore resets EVERY property a fresh Phaser Sprite is
 * born with — a pooled sprite is indistinguishable from a newly allocated one
 * before the caller applies its own visual state.
 *
 * Re-texturing discipline: acquire names the pool bucket via `texture`+`frame`.
 * A caller that swaps in an ad-hoc texture afterwards (weapon-shatter's
 * per-fragment canvas crops) MUST restore the atlas texture BEFORE release so
 * the sprite files back under the bucket it was acquired from.
 */
export class SpritePool {
  private readonly scene: Phaser.Scene;
  private readonly pools = new Map<string, Phaser.GameObjects.Sprite[]>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Acquire a sprite for `texture`+`frame` positioned at (x, y). Reuses a
   * pooled sprite when available, otherwise creates a new one.
   *
   * The `frame` is required because textures are now multipack atlases (many
   * frames per texture). Without it, a reused sprite would keep showing
   * whatever frame it last held — `setTexture('vfx')` alone does NOT reset the
   * frame, so the caller must name the frame on every acquire.
   */
  acquire(texture: string, frame: string, x: number, y: number): Phaser.GameObjects.Sprite {
    let pool = this.pools.get(texture);
    const spr = pool && pool.length > 0 ? pool.pop()! : this.scene.add.sprite(x, y, texture, frame);
    spr.setPosition(x, y);
    spr.setTexture(texture, frame);
    // Full fresh-sprite state reset (ticket 52): pooled sprites are shared
    // across effects, so cross-effect residue must never leak into the next
    // spawn. Every property below is the default a new Phaser Sprite gets at
    // construction — resetting them makes a reused slot render exactly like a
    // fresh allocation before the caller chains its own setters.
    spr.setVisible(true);
    spr.setActive(true);
    spr.setAlpha(1);
    spr.setTint(0xffffff);
    spr.setBlendMode(BLEND_MODE_NORMAL);
    spr.setRotation(0);
    spr.setScale(1, 1);
    spr.setOrigin(0.5, 0.5);
    spr.setDepth(0);
    return spr;
  }

  /**
   * Return a sprite to the pool. Kills any active tweens on it (so a pooled
   * sprite is never animated by a stale tween), then hides + deactivates it.
   *
   * The `setAlpha(0)` is the albedo ghost-guard (the ticket-47 DamageNumber
   * pool discipline): the lighting world-capture list has no visibility check
   * and Phaser's DynamicTexture.draw pushes every entry regardless of
   * visibility, so a released sprite with residual alpha would linger as a
   * faint ghost in the lit composite until its slot is reused. Alpha 0
   * guarantees a pooled slot contributes nothing; acquire() restores 1.
   */
  release(spr: Phaser.GameObjects.Sprite): void {
    this.scene.tweens.killTweensOf(spr);
    spr.setVisible(false);
    spr.setActive(false);
    spr.setAlpha(0);
    const texture = spr.texture.key;
    let pool = this.pools.get(texture);
    if (!pool) {
      pool = [];
      this.pools.set(texture, pool);
    }
    pool.push(spr);
  }

  /** Destroy every pooled sprite (scene shutdown). */
  destroy(): void {
    for (const pool of this.pools.values()) {
      for (const spr of pool) {
        if (spr && spr.active) spr.destroy();
      }
    }
    this.pools.clear();
  }
}

import type Phaser from 'phaser';

/** `Phaser.BlendModes.NORMAL` — spelled out so this file stays type-only. */
const BLEND_MODE_NORMAL = 0;

/**
 * Per-texture retention cap (perf ticket 22). Ground weapons alone seed
 * ~48-96 sprites (16 sectors × 3-6 placements), and death drops / crate
 * breaks stack bursts on top — 128 parked slots covers steady-state loot
 * concurrency with headroom, while bounding what the pool retains after a
 * spike. Releases beyond the cap destroy the sprite instead of parking it:
 * growth is capped, worst case is a rare construct/destroy pair.
 */
export const ITEM_SPRITE_POOL_MAX_PER_TEXTURE = 128;

/**
 * Entity sprite pool for loot-burst items (perf ticket 22) — the acquire/
 * release pattern of `vfx/SpritePool` applied to the item-entity sprites
 * (`game`-atlas weapon pickups, `ui`/`vfx`-atlas power-up icons) that loot
 * bursts create and expiry destroys. A chest break or death drop used to
 * allocate N display objects synchronously in one patch; after warm-up the
 * burst is pure pool hits — zero net sprite constructions.
 *
 * The pool is texture-keyed (a released sprite parks on its texture's
 * free-list) and a SEPARATE instance from the VFX pool: the item lifecycle
 * (EntityRendererItems add/remove) owns it, so VFX behavior and budgeting
 * are untouched.
 *
 * Reset discipline (the ticket's no-visual-bleed requirement): release
 * fully resets the sprite — tweens killed, hidden + deactivated, alpha 0
 * (the lighting world-capture ghost-guard — that list draws entries
 * regardless of visibility), and scale/rotation/depth/tint/blend/origin
 * back to fresh-construction defaults — so a parked slot holds no residue
 * even before reuse. acquire re-applies texture + frame (multipack-atlas
 * discipline: `setTexture(tex)` alone does NOT reset the frame) and the
 * full fresh-sprite state, making a reused slot indistinguishable from a
 * new allocation before the caller chains its own setters.
 *
 * Re-texturing discipline (inherited from `vfx/SpritePool`): release files
 * a sprite under its CURRENT `texture.key`. A caller that swaps textures
 * after acquire must restore the atlas texture before release so the
 * sprite parks under the bucket it was acquired from.
 */
export class EntitySpritePool {
  private readonly scene: Phaser.Scene;
  private readonly pools = new Map<string, Phaser.GameObjects.Sprite[]>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Acquire a sprite for `texture`+`frame` positioned at (x, y). Reuses a
   * parked sprite when available, otherwise creates a new one. The `frame`
   * is required (multipack atlases): a reused sprite would otherwise keep
   * showing whatever frame it last held.
   */
  acquire(texture: string, frame: string, x: number, y: number): Phaser.GameObjects.Sprite {
    let pool = this.pools.get(texture);
    const spr = pool && pool.length > 0 ? pool.pop()! : this.scene.add.sprite(x, y, texture, frame);
    spr.setPosition(x, y);
    spr.setTexture(texture, frame);
    // Fresh-sprite state: a parked slot must be indistinguishable from a new
    // allocation before the caller applies its own visual state.
    this.resetResidue(spr);
    spr.setVisible(true);
    spr.setActive(true);
    spr.setAlpha(1);
    return spr;
  }

  /**
   * Return a sprite to the pool: kill any in-flight tweens, then fully reset
   * it and park it on its texture's free-list. The sprite keeps its bucket
   * texture while parked (that key IS the filing slot); acquire re-applies
   * texture + frame on the way out.
   *
   * Beyond the per-texture cap the sprite is destroyed instead of parked —
   * unbounded retention is never allowed. The tween kill precedes the cap
   * branch so BOTH paths share it: an overflow-destroyed sprite must not
   * keep animating between release and its destruction either.
   */
  release(spr: Phaser.GameObjects.Sprite): void {
    const texture = spr.texture.key;
    let pool = this.pools.get(texture);
    this.scene.tweens.killTweensOf(spr);
    if (pool && pool.length >= ITEM_SPRITE_POOL_MAX_PER_TEXTURE) {
      spr.destroy();
      return;
    }
    this.resetResidue(spr);
    // Parked ≠ fresh: hidden, out of the update list, and alpha 0 so the
    // visibility-blind lighting capture list never draws the ghost.
    spr.setVisible(false);
    spr.setActive(false);
    spr.setAlpha(0);
    if (!pool) {
      pool = [];
      this.pools.set(texture, pool);
    }
    pool.push(spr);
  }

  /** Destroy every parked sprite (scene shutdown — no leak across matches). */
  destroy(): void {
    for (const pool of this.pools.values()) {
      for (const spr of pool) {
        if (spr) spr.destroy();
      }
    }
    this.pools.clear();
  }

  /**
   * Reset every property a fresh Phaser Sprite is born with that a previous
   * user of the slot could have changed: tint, blend mode, rotation, scale,
   * origin, depth. (Texture/frame/position/visibility/alpha are handled by
   * the callers — acquire re-shows, release parks.)
   */
  private resetResidue(spr: Phaser.GameObjects.Sprite): void {
    spr.setTint(0xffffff);
    spr.setBlendMode(BLEND_MODE_NORMAL);
    spr.setRotation(0);
    spr.setScale(1, 1);
    spr.setOrigin(0.5, 0.5);
    spr.setDepth(0);
  }
}

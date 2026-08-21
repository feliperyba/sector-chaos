/**
 * Perf ticket 22 (loot-burst item sprite pool) regression tests.
 *
 * WHY THIS TEST EXISTS:
 * loot bursts (crate breaks, death drops, ground-weapon rolls) used to
 * create + destroy one display object per item — unlike the pooled VFX
 * sprites (evidence: .scratch/perf-arc-neo/issues/01, loot-burst churn
 * finding). `EntitySpritePool` applies the SpritePool house pattern to the
 * item-entity icons so bursts are pool hits after warm-up.
 *
 * WHAT THIS PINS:
 *   1. ZERO NET CONSTRUCTIONS after warm-up — an acquire/release/acquire
 *      burst constructs sprites only on the first pass (pool hits after).
 *   2. FULL RESET on release (no visual bleed between reuses): tweens
 *      killed, hidden + deactivated, alpha 0, and scale/rotation/depth/
 *      tint/blend/origin back to fresh-construction defaults; acquire
 *      re-applies texture + frame (multipack discipline) and fresh state.
 *   3. Texture-keyed buckets never cross; per-texture retention is capped
 *      (releases beyond the cap destroy instead of parking).
 *   4. Scene shutdown (lifecycle.destroy) frees both live item sprites and
 *      every parked pool slot — no pooled memory survives the match.
 *   5. Integration: addWeaponPickup/addPowerUp acquire from the pool and
 *      the remove paths park the icon back (not destroyed).
 *
 * Phaser is globally mocked in tests/setup.ts; the scene/sprite fakes
 * below are plain objects with the single `as unknown as` cast per helper.
 */
import { describe, it, expect, vi } from 'vitest';
import type Phaser from 'phaser';
import { EntitySpritePool, ITEM_SPRITE_POOL_MAX_PER_TEXTURE } from '../EntitySpritePool.js';
import { EntityRendererLifecycle } from '../EntityRendererLifecycle.js';
import { PickupVFX } from '../vfx/PickupVFX.js';
import type { SpritePool } from '../vfx/SpritePool.js';
import type { EntityRendererVFX } from '../EntityRendererVFX.js';
import type { WeaponPickupState, PowerUpState } from '../../types.js';

/* ── Fakes ─────────────────────────────────────────────────────────────── */

/** Sprite fake tracking every property the pool resets. */
function makeSpriteFake(texture = '', frame: string | undefined = undefined) {
  const spr = {
    x: 0,
    y: 0,
    visible: true,
    active: true,
    alpha: 1,
    tint: 0xffffff,
    blendMode: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.5,
    depth: 0,
    texture: { key: texture },
    frameKey: frame,
    destroyed: false,
    setPosition(x: number, y: number) {
      spr.x = x;
      spr.y = y;
      return spr;
    },
    setTexture(tex: string, frm: string | undefined) {
      spr.texture.key = tex;
      spr.frameKey = frm;
      return spr;
    },
    setVisible(v: boolean) {
      spr.visible = v;
      return spr;
    },
    setActive(a: boolean) {
      spr.active = a;
      return spr;
    },
    setAlpha(a: number) {
      spr.alpha = a;
      return spr;
    },
    setTint(t: number) {
      spr.tint = t;
      return spr;
    },
    setBlendMode(m: number) {
      spr.blendMode = m;
      return spr;
    },
    setRotation(r: number) {
      spr.rotation = r;
      return spr;
    },
    setScale(sx: number, sy = sx) {
      spr.scaleX = sx;
      spr.scaleY = sy;
      return spr;
    },
    setOrigin(x = 0.5, y = x) {
      spr.originX = x;
      spr.originY = y;
      return spr;
    },
    setDepth(d: number) {
      spr.depth = d;
      return spr;
    },
    setDisplaySize() {
      return spr;
    },
    destroy() {
      spr.destroyed = true;
    },
  };
  return spr;
}

type SpriteFake = ReturnType<typeof makeSpriteFake>;

/** Fake → pool-argument shape (the one `as unknown as` for this direction). */
function asSprite(spr: SpriteFake): Phaser.GameObjects.Sprite {
  return spr as unknown as Phaser.GameObjects.Sprite;
}

/**
 * Scene fake whose `add.sprite` CONSTRUCTIONS array is the warm-up oracle:
 * a pooled burst must stop growing it. `tweens.killTweensOf` is spied so
 * the release-reset assertion can prove stale tweens die.
 */
function makeSceneStub() {
  const constructions: SpriteFake[] = [];
  const killTweensOf = vi.fn();
  const scene = {
    add: {
      sprite: (x: number, y: number, texture: string, frame: string | undefined) => {
        const spr = makeSpriteFake(texture, frame);
        spr.setPosition(x, y);
        constructions.push(spr);
        return spr;
      },
    },
    textures: { get: () => ({ has: () => true }) },
    tweens: { killTweensOf },
  };
  return {
    scene: scene as unknown as Phaser.Scene,
    constructions,
    killTweensOf,
  };
}

/** Lifecycle with the REAL item pool (its own constructions oracle). */
function makeLifecycle() {
  const { scene, constructions } = makeSceneStub();
  const vfxPool = { acquire: () => makeSpriteFake(), release: () => {} } as unknown as SpritePool;
  const vfx = { pickup: new PickupVFX(scene, vfxPool) } as unknown as EntityRendererVFX;
  return { lifecycle: new EntityRendererLifecycle(scene, vfx, null), constructions };
}

function makeWeaponPickup(overrides: Partial<WeaponPickupState> = {}): WeaponPickupState {
  return {
    id: 'wp-1',
    weaponType: 0,
    tier: 1,
    ammo: 10,
    maxAmmo: 10,
    x: 100,
    y: 200,
    lifetime: 60_000,
    textureKey: 'weapon_sword',
    rotation: 0,
    flipH: false,
    flipV: false,
    ...overrides,
  };
}

function makePowerUp(overrides: Partial<PowerUpState> = {}): PowerUpState {
  return { id: 'pu-1', type: 0, x: 300, y: 400, isActive: true, ...overrides };
}

/* ── Pool unit behavior ────────────────────────────────────────────────── */

describe('EntitySpritePool (perf ticket 22)', () => {
  it('first acquire constructs with texture+frame+position and fresh state', () => {
    const { scene, constructions } = makeSceneStub();
    const pool = new EntitySpritePool(scene);
    const spr = pool.acquire('game', 'weapon_sword', 10, 20) as unknown as SpriteFake;
    expect(constructions).toHaveLength(1);
    expect(spr.texture.key).toBe('game');
    expect(spr.frameKey).toBe('weapon_sword');
    expect(spr.x).toBe(10);
    expect(spr.y).toBe(20);
    expect(spr.visible).toBe(true);
    expect(spr.active).toBe(true);
    expect(spr.alpha).toBe(1);
    expect(spr.destroyed).toBe(false);
  });

  it('post-warm-up burst is ZERO net constructions and pure pool hits', () => {
    const { scene, constructions } = makeSceneStub();
    const pool = new EntitySpritePool(scene);
    const burst1 = Array.from({ length: 5 }, (_, i) =>
      pool.acquire('game', `weapon_${i}`, i * 10, 0),
    );
    for (const spr of burst1) pool.release(spr);
    const burst2 = Array.from({ length: 5 }, (_, i) =>
      pool.acquire('game', `weapon_${i}`, i * 10, 0),
    );
    // Only the first burst constructed; the second reused every slot.
    expect(constructions).toHaveLength(5);
    expect(new Set(burst2)).toEqual(new Set(burst1));
  });

  it('release fully resets the slot — no visual bleed between reuses', () => {
    const { scene, killTweensOf } = makeSceneStub();
    const pool = new EntitySpritePool(scene);
    const dirty = pool.acquire('game', 'weapon_sword', 0, 0) as unknown as SpriteFake;
    // Simulate everything a previous user of the slot could leave behind.
    dirty.setTint(0xff0000).setAlpha(0.3).setScale(2, 3).setRotation(1.2).setDepth(9);
    dirty.setBlendMode(1).setOrigin(0.25, 0.75);

    pool.release(asSprite(dirty));

    expect(killTweensOf).toHaveBeenCalledWith(dirty);
    expect(dirty.destroyed).toBe(false); // parked, not destroyed
    expect(dirty.visible).toBe(false);
    expect(dirty.active).toBe(false);
    expect(dirty.alpha).toBe(0); // lighting ghost-guard
    expect(dirty.tint).toBe(0xffffff);
    expect(dirty.scaleX).toBe(1);
    expect(dirty.scaleY).toBe(1);
    expect(dirty.rotation).toBe(0);
    expect(dirty.depth).toBe(0);
    expect(dirty.blendMode).toBe(0);
    expect(dirty.originX).toBe(0.5);
    expect(dirty.originY).toBe(0.5);

    // Re-acquire: same slot, fresh state, requested frame re-applied.
    const reused = pool.acquire('game', 'weapon_axe', 5, 6) as unknown as SpriteFake;
    expect(reused).toBe(dirty);
    expect(reused.frameKey).toBe('weapon_axe');
    expect(reused.visible).toBe(true);
    expect(reused.active).toBe(true);
    expect(reused.alpha).toBe(1);
  });

  it('texture buckets never cross (game vs ui park separately)', () => {
    const { scene } = makeSceneStub();
    const pool = new EntitySpritePool(scene);
    const game = pool.acquire('game', 'weapon_sword', 0, 0);
    const ui = pool.acquire('ui', 'icon_cross', 0, 0);
    pool.release(game);
    pool.release(ui);
    expect(pool.acquire('ui', 'icon_shield', 0, 0)).toBe(ui);
    expect(pool.acquire('game', 'weapon_axe', 0, 0)).toBe(game);
  });

  it('releases beyond the per-texture cap destroy instead of parking', () => {
    const { scene, killTweensOf } = makeSceneStub();
    const pool = new EntitySpritePool(scene);
    const live = Array.from({ length: ITEM_SPRITE_POOL_MAX_PER_TEXTURE + 1 }, (_, i) =>
      pool.acquire('game', `weapon_${i}`, 0, 0),
    );
    for (const spr of live) pool.release(spr);
    // The tween kill precedes the cap branch: BOTH paths shared it (cap
    // parked + 1 overflow-destroyed = cap+1 kills).
    expect(killTweensOf).toHaveBeenCalledTimes(ITEM_SPRITE_POOL_MAX_PER_TEXTURE + 1);
    // Cap parked; the overflow slot was destroyed, not retained.
    const parked = live.filter((s) => !(s as unknown as SpriteFake).destroyed);
    expect(parked).toHaveLength(ITEM_SPRITE_POOL_MAX_PER_TEXTURE);
    // Next burst: cap hits + exactly ONE new construction for the overflow.
    const again = Array.from({ length: ITEM_SPRITE_POOL_MAX_PER_TEXTURE + 1 }, (_, i) =>
      pool.acquire('game', `weapon_${i}`, 0, 0),
    );
    const destroyedSlot = live.find((s) => (s as unknown as SpriteFake).destroyed)!;
    expect(again).not.toContain(destroyedSlot);
    expect(again.filter((s) => !parked.includes(s))).toHaveLength(1);
  });

  it('destroy() frees every parked slot (scene shutdown)', () => {
    const { scene } = makeSceneStub();
    const pool = new EntitySpritePool(scene);
    const a = pool.acquire('game', 'weapon_sword', 0, 0) as unknown as SpriteFake;
    const b = pool.acquire('ui', 'icon_cross', 0, 0) as unknown as SpriteFake;
    pool.release(asSprite(a));
    pool.release(asSprite(b));
    pool.destroy();
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
  });
});

/* ── Item add/remove integration (EntityRendererItems via the lifecycle) ── */

describe('item-entity lifecycle pooling (perf ticket 22)', () => {
  it('addWeaponPickup acquires pooled; removeWeaponPickup parks (no destroy)', () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.addWeaponPickup('wp-1', makeWeaponPickup());
    const entry = lifecycle.entities.get('wp-1');
    expect(entry && entry.sprite).toBeTruthy();
    const spr = entry!.sprite as unknown as SpriteFake;
    expect(spr.texture.key).toBe('game');
    expect(spr.frameKey).toBe('weapon_sword');
    expect(spr.depth).toBe(8);
    expect(spr.destroyed).toBe(false);

    lifecycle.removeWeaponPickup('wp-1');
    expect(lifecycle.entities.has('wp-1')).toBe(false);
    expect(spr.destroyed).toBe(false); // parked on the pool, not destroyed
    expect(spr.visible).toBe(false);
    expect(spr.alpha).toBe(0);
  });

  it('a loot burst add→remove→add cycle performs zero net constructions', () => {
    const { lifecycle, constructions } = makeLifecycle();
    const N = 4;
    const burst = (phase: number) => {
      // Real loot-burst shape: N drops land concurrently, then expire together.
      for (let i = 0; i < N; i++) {
        lifecycle.addWeaponPickup(`wp-${i}`, makeWeaponPickup({ id: `wp-${i}` }));
      }
      for (let i = 0; i < N; i++) {
        lifecycle.updateWeaponPickup(
          `wp-${i}`,
          makeWeaponPickup({ id: `wp-${i}`, lifetime: phase * 1000 }),
        );
      }
      for (let i = 0; i < N; i++) {
        lifecycle.removeWeaponPickup(`wp-${i}`);
      }
    };
    burst(1);
    const afterWarmUp = constructions.length;
    burst(2);
    expect(afterWarmUp).toBe(N); // warm-up constructed exactly one sprite per slot
    expect(constructions.length).toBe(N); // the second burst was pure pool hits
  });

  it('addPowerUp acquires pooled + attaches glow; removePowerUp parks + detaches', () => {
    const { lifecycle } = makeLifecycle();
    const detachSpy = vi.spyOn(lifecycle.vfx.pickup, 'detachPowerUpGlow');
    lifecycle.addPowerUp('pu-1', makePowerUp());
    const entry = lifecycle.entities.get('pu-1');
    const spr = entry!.sprite as unknown as SpriteFake;
    expect(spr.texture.key).toBe('ui');
    expect(spr.frameKey).toBe('icon_cross');
    expect(spr.depth).toBe(8);
    expect(spr.alpha).toBe(0.9);

    lifecycle.removePowerUp('pu-1');
    expect(detachSpy).toHaveBeenCalledWith('pu-1');
    expect(lifecycle.entities.has('pu-1')).toBe(false);
    expect(spr.destroyed).toBe(false); // parked
    expect(spr.visible).toBe(false);
  });

  it('lifecycle.destroy() destroys live item sprites AND parked pool slots', () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.addWeaponPickup('wp-live', makeWeaponPickup({ id: 'wp-live' }));
    lifecycle.addWeaponPickup('wp-parked', makeWeaponPickup({ id: 'wp-parked' }));
    const live = lifecycle.entities.get('wp-live')!.sprite as unknown as SpriteFake;
    const parked = lifecycle.entities.get('wp-parked')!.sprite as unknown as SpriteFake;
    lifecycle.removeWeaponPickup('wp-parked');

    lifecycle.destroy();

    expect(live.destroyed).toBe(true); // live entity sprite
    expect(parked.destroyed).toBe(true); // pooled slot memory
    expect(lifecycle.entities.size).toBe(0);
  });
});

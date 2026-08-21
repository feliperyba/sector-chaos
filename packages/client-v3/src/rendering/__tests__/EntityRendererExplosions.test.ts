/**
 * Ticket #50 (gpu-explosion-placeholder-drop) regression tests.
 *
 * WHY THIS TEST EXISTS:
 * Before ticket #50, `addExplosion` allocated a placeholder
 * `scene.add.graphics().setDepth(18)` per explosion entity purely to satisfy
 * the required-`sprite` shape of `EntityVisual`. It was NEVER drawn to (no
 * fillStyle/strokeStyle/draw calls anywhere) — all visuals the player sees
 * come from the VFX layer (`ExplosionVFX`). Each placeholder cost a GameObject
 * allocation, a display-list entry (scanned every frame by the lighting
 * albedo capture `buildWorldCaptureList`, which iterates `scene.children.list`
 * — LightingPipeline.ts), and — when the VFX expiry callback fired before the
 * server removed the schema entity — an ORPHAN, because `onDone` deletes the
 * registry entry without destroying the sprite.
 *
 * WHAT THIS PINS:
 *   1. addExplosion creates NO Graphics/GameObject and registers a
 *      sprite-less `{ type: 'explosion', x, y }` record, while still
 *      delegating the real visuals to the VFX layer.
 *   2. The VFX expiry callback (onDone) still cleans up the registry entry —
 *      the natural-expiry path.
 *   3. removeExplosion (server-driven removal path) cleans up without
 *      touching any sprite (absent sprite = clean skip, not a null crash).
 *   4. The generic lifecycle paths (removeEntity/destroy/update) tolerate a
 *      sprite-less entry in the registry AND still destroy sprite-bearing
 *      entries' sprites (other entity kinds' contracts unchanged).
 */
import { describe, it, expect, vi } from 'vitest';
import type Phaser from 'phaser';
import { EntityRendererLifecycle } from '../EntityRendererLifecycle.js';
import { addExplosion, removeExplosion } from '../EntityRendererExplosions.js';
import type { EntityRendererVFX } from '../EntityRendererVFX.js';
import type { EntityVisual } from '../EntityTypes.js';
import type { ExplosionState } from '../../types.js';

/** Headless scene stub — only what the lifecycle touches for explosions. */
function makeSceneStub() {
  return {
    add: { graphics: vi.fn() },
  } as unknown as Phaser.Scene;
}

/** Headless VFX stub — records the explosion delegation (ticket 52: the VFX
 * facade is a registry, so the lifecycle reaches the effect through the typed
 * `explosion` accessor). */
function makeVfxStub() {
  return {
    explosion: { spawn: vi.fn(), remove: vi.fn() },
  } as unknown as EntityRendererVFX;
}

function makeExplosion(overrides: Partial<ExplosionState> = {}): ExplosionState {
  return {
    id: 'exp-1',
    ownerId: 'p1',
    x: 1024,
    y: 2048,
    radius: 256,
    damage: 60,
    ...overrides,
  };
}

function makeLifecycle() {
  const scene = makeSceneStub();
  const vfx = makeVfxStub();
  const lifecycle = new EntityRendererLifecycle(scene, vfx, null);
  return { scene, vfx, lifecycle };
}

/**
 * Chainable sprite stub with a destroy spy (for sprite-bearing entries).
 * The literal only implements `destroy` — the one method the lifecycle
 * touches — and the single `as unknown as` escape hatch is confined to THIS
 * helper so inline test code stays honestly typed against the real union.
 */
function makeSpriteStub(): EntityVisual['sprite'] {
  return { destroy: vi.fn() } as unknown as EntityVisual['sprite'];
}

describe('EntityRendererExplosions (ticket #50 — no placeholder Graphics)', () => {
  it('addExplosion allocates NO Graphics/GameObject and registers a sprite-less record', () => {
    const { scene, vfx, lifecycle } = makeLifecycle();
    const e = makeExplosion();

    addExplosion(lifecycle, 'exp-1', e);

    // THE ticket assertion: no per-explosion Graphics placeholder.
    expect(scene.add.graphics).not.toHaveBeenCalled();
    // The registry entry exists, with no sprite to speak of.
    const entry = lifecycle.entities.get('exp-1');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('explosion');
    expect(entry!.sprite).toBeUndefined();
    expect(entry!.x).toBe(e.x);
    expect(entry!.y).toBe(e.y);
    // The real visuals still go through the VFX layer.
    expect(vfx.explosion.spawn).toHaveBeenCalledTimes(1);
    expect(vfx.explosion.spawn).toHaveBeenCalledWith({
      key: 'exp-1',
      x: e.x,
      y: e.y,
      radius: e.radius,
      onExpire: expect.any(Function),
    });
  });

  it('addExplosion is idempotent per key (no duplicate VFX, no duplicate entry)', () => {
    const { vfx, lifecycle } = makeLifecycle();
    addExplosion(lifecycle, 'exp-1', makeExplosion());
    addExplosion(lifecycle, 'exp-1', makeExplosion({ x: 99 }));
    expect(vfx.explosion.spawn).toHaveBeenCalledTimes(1);
    expect(lifecycle.entities.size).toBe(1);
  });

  it('the VFX expiry callback (onDone) deletes the registry entry — natural-expiry cleanup', () => {
    const { vfx, lifecycle } = makeLifecycle();
    addExplosion(lifecycle, 'exp-1', makeExplosion());

    const onDone = vi.mocked(vfx.explosion.spawn).mock.calls[0]![0].onExpire;
    onDone();

    expect(lifecycle.entities.has('exp-1')).toBe(false);
    // And nothing was ever allocated that would now be orphaned.
  });

  it('removeExplosion (server removal path) cleans up cleanly with the absent sprite', () => {
    const { vfx, lifecycle } = makeLifecycle();
    addExplosion(lifecycle, 'exp-1', makeExplosion());

    expect(() => removeExplosion(lifecycle, 'exp-1')).not.toThrow();

    expect(vfx.explosion.remove).toHaveBeenCalledWith('exp-1');
    expect(lifecycle.entities.has('exp-1')).toBe(false);
  });

  it('generic destroy() skips the absent sprite AND still destroys sprite-bearing entries', () => {
    const { lifecycle } = makeLifecycle();
    addExplosion(lifecycle, 'exp-1', makeExplosion());
    // A sprite-bearing entry of another kind shares the same registry.
    const sprite = makeSpriteStub();
    lifecycle.entities.set('trap-1', { sprite, type: 'trap' });

    expect(() => lifecycle.destroy()).not.toThrow();

    expect(sprite.destroy).toHaveBeenCalledTimes(1);
    expect(lifecycle.entities.size).toBe(0);
  });

  it('generic removeEntity() on an explosion entry is a clean skip, not a null crash', () => {
    const { lifecycle } = makeLifecycle();
    addExplosion(lifecycle, 'exp-1', makeExplosion());

    expect(() => lifecycle.removeEntity('exp-1')).not.toThrow();
    expect(lifecycle.entities.has('exp-1')).toBe(false);
  });

  it('the per-frame update() loop tolerates a sprite-less explosion entry', () => {
    const { lifecycle } = makeLifecycle();
    addExplosion(lifecycle, 'exp-1', makeExplosion());
    // A trap entry exercises the sprite-bearing path alongside it (flashTime
    // unset + no fireAreaGraphics → its helpers no-op; the loop still runs).
    lifecycle.entities.set('trap-1', { sprite: makeSpriteStub(), type: 'trap' });

    expect(() => lifecycle.update()).not.toThrow();
    // Both entries survive — update() only animates; it never removes.
    expect(lifecycle.entities.has('exp-1')).toBe(true);
    expect(lifecycle.entities.has('trap-1')).toBe(true);
  });
});

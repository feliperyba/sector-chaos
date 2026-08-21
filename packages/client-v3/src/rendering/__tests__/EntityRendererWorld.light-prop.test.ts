/**
 * Map-polish ticket 08 — RENDER OWNERSHIP regression tests.
 *
 * A converted light prop (destructible wire type 4, hydrated by ticket 07)
 * must NEVER enter the generic destructible sprite path: its fixture art
 * lives in the `lightProps` atlas and is owned by `LightPropRenderer` (the
 * campfire precedent — fixture sprites are placement-owned). Before this
 * ticket, `addDestructible` resolved any unknown wire type to the
 * `'crate_small'` fallback in the `game` atlas, double-rendering a bogus
 * crate under every sconce/crystal fixture.
 *
 * WHAT THIS PINS:
 *   1. addDestructible(type 4) spawns NO sprite — it registers a sprite-less
 *      `{ type: 'light-prop', x, y }` record (the ExplosionEntityVisual
 *      pattern) so the destroy→light-off chain can still read the tile.
 *   2. getDestructiblePosition resolves the server-authoritative position for
 *      the sprite-less record (the removal handler's dust cloud + tile-keyed
 *      light-off hook depend on it).
 *   3. isLightPropDestructible flags light-prop records (and ONLY those).
 *   4. The generic path is UNCHANGED for crates (fallback sprite still
 *      spawns) — render ownership is a skip, not a rewrite.
 *   5. update/remove/destroy tolerate the sprite-less record.
 */
import { describe, it, expect, vi } from 'vitest';
import type Phaser from 'phaser';
import { EntityRendererLifecycle } from '../EntityRendererLifecycle.js';
import {
  addDestructible,
  removeDestructible,
  updateDestructible,
  isLightPropEntity,
} from '../EntityRendererWorld.js';
import type { EntityRendererVFX } from '../EntityRendererVFX.js';
import type { DestructibleState } from '../../types.js';
import { DESTRUCTIBLE_TYPE_LIGHT } from '../../types.js';

/** Wire-type-4 entity from the ticket-07 hydration (tile center, hp 1/1). */
function makeLight(overrides: Partial<DestructibleState> = {}): DestructibleState {
  return {
    id: 'dest_light_3_5',
    type: DESTRUCTIBLE_TYPE_LIGHT,
    hp: 1,
    maxHp: 1,
    // Tile (col=5, row=3) center at tileSize 128 — the coords the removal
    // handler floors back to (5,3).
    x: 5 * 128 + 64,
    y: 3 * 128 + 64,
    isDestroyed: false,
    primed: false,
    fuseExpiresAtTick: 0,
    textureKey: '',
    rotation: 0,
    flipH: false,
    flipV: false,
    ...overrides,
  };
}

function makeCrate(overrides: Partial<DestructibleState> = {}): DestructibleState {
  return {
    id: 'dest_crate_7_2',
    type: 0,
    hp: 2,
    maxHp: 2,
    x: 2 * 128 + 64,
    y: 7 * 128 + 64,
    isDestroyed: false,
    primed: false,
    fuseExpiresAtTick: 0,
    textureKey: '',
    rotation: 0,
    flipH: false,
    flipV: false,
    ...overrides,
  };
}

/** Chainable sprite stub — every setter the generic path touches. */
function makeSpriteStub() {
  const sprite = {
    x: 0,
    y: 0,
    setOrigin: vi.fn(() => sprite),
    setDisplaySize: vi.fn(() => sprite),
    setDepth: vi.fn(() => sprite),
    setRotation: vi.fn(() => sprite),
    setScale: vi.fn(() => sprite),
    setTint: vi.fn(() => sprite),
    setAlpha: vi.fn(() => sprite),
    destroy: vi.fn(),
  };
  return sprite;
}

/**
 * Headless scene stub. `add.sprite` is a SPY — the render-ownership assertion
 * is exactly "the light branch never reaches it".
 */
function makeSceneStub() {
  const addSprite = vi.fn(() => makeSpriteStub());
  const scene = {
    add: { sprite: addSprite },
    textures: { get: (_key: string) => ({ has: () => true }) },
  } as unknown as Phaser.Scene;
  return { scene, addSprite };
}

function makeVfxStub() {
  return {
    destruction: { onRemove: vi.fn() },
    // Juice-pass-1 ticket 06 — the primed-barrel fire sync/teardown hooks the
    // destructible paths now drive.
    barrelFuse: { syncPrimed: vi.fn(), onRemove: vi.fn() },
  } as unknown as EntityRendererVFX;
}

function makeLifecycle() {
  const { scene, addSprite } = makeSceneStub();
  const vfx = makeVfxStub();
  const lifecycle = new EntityRendererLifecycle(scene, vfx, null);
  return { lifecycle, addSprite, vfx };
}

describe('EntityRendererWorld — light-prop render ownership (ticket 08)', () => {
  it('spawns NO sprite for wire type 4 (no crate/crate_small fallback)', () => {
    const { lifecycle, addSprite } = makeLifecycle();
    addDestructible(lifecycle, 'dest_light_3_5', makeLight());
    // THE render-ownership assertion: the generic destructible sprite path
    // (which would resolve type 4 → 'crate_small' fallback) never runs.
    expect(addSprite).not.toHaveBeenCalled();
    expect(lifecycle.entities.size).toBe(1);
  });

  it('registers a sprite-less record carrying the server position', () => {
    const { lifecycle } = makeLifecycle();
    const light = makeLight();
    addDestructible(lifecycle, light.id, light);
    const record = lifecycle.entities.get(light.id);
    expect(record).toBeDefined();
    expect(record!.sprite).toBeUndefined();
    expect(record!.type).toBe('light-prop');
  });

  it('getDestructiblePosition resolves the record coords (dust + light-off chain)', () => {
    const { lifecycle } = makeLifecycle();
    const light = makeLight();
    addDestructible(lifecycle, light.id, light);
    expect(lifecycle.getDestructiblePosition(light.id)).toEqual({ x: light.x, y: light.y });
  });

  it('isLightPropDestructible flags light props and only light props', () => {
    const { lifecycle } = makeLifecycle();
    const light = makeLight();
    const crate = makeCrate();
    addDestructible(lifecycle, light.id, light);
    addDestructible(lifecycle, crate.id, crate);
    expect(lifecycle.isLightPropDestructible(light.id)).toBe(true);
    expect(lifecycle.isLightPropDestructible(crate.id)).toBe(false);
    expect(lifecycle.isLightPropDestructible('dest_unknown_0_0')).toBe(false);
    expect(isLightPropEntity(lifecycle, light.id)).toBe(true);
  });

  it('the generic fallback sprite path is UNCHANGED for crates (ownership is a skip)', () => {
    const { lifecycle, addSprite } = makeLifecycle();
    addDestructible(lifecycle, 'dest_crate_7_2', makeCrate());
    expect(addSprite).toHaveBeenCalledTimes(1);
    expect(lifecycle.entities.get('dest_crate_7_2')!.type).toBe('destructible');
  });

  it('a duplicate add is idempotent (no double record)', () => {
    const { lifecycle } = makeLifecycle();
    const light = makeLight();
    addDestructible(lifecycle, light.id, light);
    addDestructible(lifecycle, light.id, makeLight({ x: 999, y: 999 }));
    expect(lifecycle.entities.size).toBe(1);
    // First record wins — position unchanged by the duplicate.
    expect(lifecycle.getDestructiblePosition(light.id)).toEqual({ x: light.x, y: light.y });
  });

  it('updateDestructible on a light record is a clean no-op (no sprite crash)', () => {
    const { lifecycle } = makeLifecycle();
    const light = makeLight();
    addDestructible(lifecycle, light.id, light);
    expect(() =>
      updateDestructible(lifecycle, light.id, makeLight({ hp: 0, isDestroyed: true })),
    ).not.toThrow();
    // Record survives (removal is the schema's job, not the updater's).
    expect(lifecycle.entities.has(light.id)).toBe(true);
  });

  it('removeDestructible cleans the record up without touching a sprite', () => {
    const { lifecycle, vfx } = makeLifecycle();
    const light = makeLight();
    addDestructible(lifecycle, light.id, light);
    expect(() => removeDestructible(lifecycle, light.id)).not.toThrow();
    expect(lifecycle.entities.has(light.id)).toBe(false);
    // The VFX-layer teardown still runs (registry-keyed, sprite-agnostic).
    expect(
      (vfx as unknown as { destruction: { onRemove: ReturnType<typeof vi.fn> } }).destruction
        .onRemove,
    ).toHaveBeenCalledWith(light.id);
  });

  it('the per-frame lifecycle update tolerates a light record in the registry', () => {
    const { lifecycle } = makeLifecycle();
    addDestructible(lifecycle, 'dest_light_3_5', makeLight());
    expect(() => lifecycle.update()).not.toThrow();
  });
});

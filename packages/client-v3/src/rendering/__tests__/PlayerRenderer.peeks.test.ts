/**
 * Regression test for perf ticket 21 — allocation-free telemetry peeks.
 *
 * The per-frame telemetry deps (TelemetrySampler.sampleFrame via
 * GameSceneHelpers) used to call `getSpriteState(state.myId)` twice per frame,
 * paying a fresh 8-field SpriteState per call just to read `isMoving` /
 * `animState`. The peeks (`peekIsMoving` / `peekAnimState`) must return the
 * SAME primitives the old `getSpriteState(...)?.field ?? fallback` chain
 * coalesced to, for every input class:
 *
 *  - bundle present with a live driver state → the driver/visual value;
 *  - bundle present with a NULLISH driver.animState → AnimationState.IDLE
 *    (numerically 0 — the enum's first member);
 *  - NO bundle (unknown id / pre-spawn) → false / 0.
 *
 * Same stub-scene convention as PlayerRenderer.hide.test.ts (Phaser has no
 * headless mode in vitest); the bundles map is pre-seeded through the
 * test-only escape hatch so the Phaser-bound factory is never touched.
 */
import { describe, it, expect } from 'vitest';
import { PlayerRenderer } from '../PlayerRenderer.js';
import { AnimationState } from '../../types.js';
import type { PlayerRenderBundle } from '../PlayerRendererTypes.js';

function makeChainableGameObject() {
  const chain = function () {} as unknown as Record<string, unknown>;
  for (const m of [
    'setDepth',
    'setOrigin',
    'setScale',
    'setTint',
    'setAlpha',
    'setVisible',
    'setRotation',
    'setPosition',
    'setTexture',
    'setScrollFactor',
    'clearTint',
    'setDisplaySize',
    'setFlipX',
    'setFlipY',
  ]) {
    chain[m] = () => chain;
  }
  chain.clear = () => chain;
  chain.destroy = () => {};
  chain.getContext = () => ({ fillStyle: '', fillRect: () => {} });
  chain.refresh = () => chain;
  return chain;
}

function makeSceneStub() {
  return {
    add: {
      graphics: () => makeChainableGameObject(),
      sprite: () => makeChainableGameObject(),
      text: () => makeChainableGameObject(),
      image: () => makeChainableGameObject(),
    },
    textures: {
      get: () => ({ has: () => false }),
      exists: () => true,
      createCanvas: () => makeChainableGameObject(),
    },
    cameras: { main: { scrollX: 0, width: 0, scrollY: 0, height: 0 } },
    events: { on: () => {}, off: () => {}, emit: () => {} },
  };
}

/** Pre-seed one bundle with the two fields the peeks read. */
function makeRendererWithPlayer(
  key: string,
  opts: { isMoving: boolean; animState: number | undefined },
): PlayerRenderer {
  const renderer = new PlayerRenderer(makeSceneStub() as never);
  const bundle = {
    visual: {
      isMoving: opts.isMoving,
      facingAngle: 0,
      // getSpriteState reads the body's render fields — minimal numbers.
      body: { x: 0, y: 0, visible: true, alpha: 1, depth: 0 },
    },
    driver: { animState: opts.animState },
  } as unknown as PlayerRenderBundle;
  (renderer as unknown as { bundles: Map<string, PlayerRenderBundle> }).bundles.set(key, bundle);
  return renderer;
}

describe('ticket 21 — PlayerRenderer allocation-free peeks', () => {
  it('peekIsMoving matches the former getSpriteState coalescing on every input class', () => {
    const moving = makeRendererWithPlayer('a', { isMoving: true, animState: 1 });
    const idle = makeRendererWithPlayer('b', { isMoving: false, animState: 0 });
    const none = makeRendererWithPlayer('c', { isMoving: false, animState: 0 });

    expect(moving.peekIsMoving('a')).toBe(true);
    expect(moving.getSpriteState('a')!.isMoving).toBe(true);
    expect(idle.peekIsMoving('b')).toBe(false);
    expect(none.peekIsMoving('missing')).toBe(false); // old: ?.isMoving ?? false
  });

  it('peekAnimState matches the former getSpriteState coalescing on every input class', () => {
    const walking = makeRendererWithPlayer('a', { isMoving: true, animState: AnimationState.WALK });
    expect(walking.peekAnimState('a')).toBe(AnimationState.WALK);
    expect(walking.getSpriteState('a')!.animState).toBe(AnimationState.WALK);

    // Nullish driver state → IDLE (the getSpriteState fallback; IDLE === 0,
    // which the telemetry closure's `?? 0` coalesced to identically).
    const nullish = makeRendererWithPlayer('b', { isMoving: false, animState: undefined });
    expect(nullish.peekAnimState('b')).toBe(AnimationState.IDLE);
    expect(nullish.peekAnimState('b')).toBe(0);
    expect(nullish.getSpriteState('b')!.animState).toBe(AnimationState.IDLE);

    // Missing bundle → 0 (old: `spriteState?.animState ?? 0`).
    expect(nullish.peekAnimState('missing')).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas implementation, and loading the real phaser bundle
// through this module graph (phaser + @sector-battle/shared) trips phaser's
// module-scope Device.init canvas probe. The suite drives ExplosionVFX against
// a stub scene/pool and only needs `Phaser.BlendModes.ADD` at runtime.
vi.mock('phaser', () => ({
  default: { BlendModes: { ADD: 1 } },
}));

import { ExplosionVFX } from '../../src/rendering/vfx/ExplosionVFX.js';
import type { SpritePool } from '../../src/rendering/vfx/SpritePool.js';

/**
 * Ticket #49 — gpu-explosion-offscreen-cull.
 *
 * ExplosionVFX.spawn() gained an off-screen cull: when the blast center is
 * outside the camera's world view grown by the effect's true visual extent,
 * the entire spawn storm (core sprite acquisitions, tweens, and the per-ray
 * delayedCall storm) is skipped — nothing was visible to lose. The final
 * expiry backstop timer is still scheduled with identical timing so the
 * caller's entity-map cleanup (`addExplosion`'s onDone) fires for culled
 * explosions too, and a later `remove(key)` no-ops safely.
 *
 * The suite drives the real ExplosionVFX against a stub scene/pool and counts
 * the side effects (acquire / tween / delayedCall) — "spawn work happened vs
 * was skipped" is directly observable.
 */

type Scene = ConstructorParameters<typeof ExplosionVFX>[0];

const VIEW = { x: 0, y: 0, right: 1920, bottom: 1080 };
// Mirrors COMBAT.EXPLOSION_RADIUS (barrel blast). maxTiles = ceil(256/128) = 2
// → final expiry backstop delay = 2 * 50 + 1500 = 1600ms.
const RADIUS = 256;
const EXPIRY_DELAY = 2 * 50 + 1500;

interface SpriteStub {
  active: boolean;
  setOrigin: ReturnType<typeof vi.fn>;
  setDisplaySize: ReturnType<typeof vi.fn>;
  setDepth: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
  setTint: ReturnType<typeof vi.fn>;
  setBlendMode: ReturnType<typeof vi.fn>;
}

function createSpriteStub(): SpriteStub {
  const sprite: SpriteStub = {
    active: true,
    setOrigin: vi.fn(),
    setDisplaySize: vi.fn(),
    setDepth: vi.fn(),
    setAlpha: vi.fn(),
    setTint: vi.fn(),
    setBlendMode: vi.fn(),
  };
  for (const fn of [
    sprite.setOrigin,
    sprite.setDisplaySize,
    sprite.setDepth,
    sprite.setAlpha,
    sprite.setTint,
    sprite.setBlendMode,
  ]) {
    (fn as { mockReturnValue: (v: unknown) => void }).mockReturnValue(sprite);
  }
  return sprite;
}

function createMocks() {
  const sprites: SpriteStub[] = [];
  const pool = {
    acquire: vi.fn(() => {
      const s = createSpriteStub();
      sprites.push(s);
      return s;
    }),
    release: vi.fn(),
  } as unknown as SpritePool;

  const time = {
    // Capture (delay, cb) pairs so tests can fire the expiry backstop.
    delayedCall: vi.fn(),
  };
  const scene = {
    cameras: { main: { worldView: { ...VIEW } } },
    textures: { get: () => ({ has: () => true }) },
    tweens: { add: vi.fn() },
    time,
  } as unknown as Scene;

  return { scene, pool, sprites, time };
}

describe('ExplosionVFX off-screen cull (ticket #49)', () => {
  let mocks: ReturnType<typeof createMocks>;
  let vfx: ExplosionVFX;

  beforeEach(() => {
    mocks = createMocks();
    vfx = new ExplosionVFX(mocks.scene, mocks.pool);
  });

  it('spawns the full visual storm for an on-screen explosion', () => {
    vfx.spawn({ key: 'k1', x: 960, y: 540, radius: RADIUS, onExpire: vi.fn() });

    // 6 core sprites: flash, flare, fireCore, ring, glow, scorch.
    expect(mocks.pool.acquire).toHaveBeenCalledTimes(6);
    expect(mocks.scene.tweens.add).toHaveBeenCalledTimes(6);
    // Ray storm: 4 cardinal dirs reach tile 2 (dist 128, 256 ≤ 256) → 4*2*2
    // calls; 4 diagonal dirs break at tile 2 (dist ~362 > 256) → 4*1*2; plus
    // the final expiry backstop = 16 + 8 + 1.
    expect(mocks.time.delayedCall).toHaveBeenCalledTimes(25);
    // The expiry backstop is scheduled with the same delay as before.
    expect(mocks.time.delayedCall).toHaveBeenCalledWith(EXPIRY_DELAY, expect.any(Function));
  });

  it('skips all spawn work for an off-screen explosion', () => {
    vfx.spawn({ key: 'k2', x: 960 + 5000, y: 540, radius: RADIUS, onExpire: vi.fn() });

    expect(mocks.pool.acquire).not.toHaveBeenCalled();
    expect(mocks.scene.tweens.add).not.toHaveBeenCalled();
    // Only the expiry backstop survives (lifecycle coordination).
    expect(mocks.time.delayedCall).toHaveBeenCalledTimes(1);
    expect(mocks.time.delayedCall).toHaveBeenCalledWith(EXPIRY_DELAY, expect.any(Function));
  });

  it('still fires onExpire for a culled explosion (identical timing)', () => {
    const onExpire = vi.fn();
    vfx.spawn({ key: 'k3', x: 960, y: 540 + 5000, radius: RADIUS, onExpire });
    expect(onExpire).not.toHaveBeenCalled();

    const [delay, cb] = mocks.time.delayedCall.mock.calls[0] as [number, () => void];
    expect(delay).toBe(EXPIRY_DELAY);
    cb();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('spawns a partially-visible explosion (center off-view but within the margin)', () => {
    // 100px past the right edge — far inside the smallest possible cull
    // margin (CORE_MAX_HALF_EXTENT 192 + pad 64 = 256 even for radius 0).
    vfx.spawn({ key: 'k4', x: VIEW.right + 100, y: 540, radius: RADIUS, onExpire: vi.fn() });
    expect(mocks.pool.acquire).toHaveBeenCalledTimes(6);
    expect(mocks.time.delayedCall).toHaveBeenCalledTimes(25);
  });

  it('culls vertically off-screen explosions too', () => {
    vfx.spawn({ key: 'k5', x: 960, y: VIEW.bottom + 5000, radius: RADIUS, onExpire: vi.fn() });
    expect(mocks.pool.acquire).not.toHaveBeenCalled();
    vfx.spawn({ key: 'k6', x: 960, y: VIEW.y - 5000, radius: RADIUS, onExpire: vi.fn() });
    expect(mocks.scene.tweens.add).not.toHaveBeenCalled();
  });

  it('remove/update/destroy after a culled explosion are safe no-ops', () => {
    vfx.spawn({ key: 'k7', x: 960 + 5000, y: 540, radius: RADIUS, onExpire: vi.fn() });

    expect(() => {
      vfx.remove('k7');
      vfx.update(16);
      vfx.destroy();
      // A second destroy (EntityRendererVFX.destroy path) must also be safe.
      vfx.destroy();
    }).not.toThrow();
    expect(mocks.pool.release).not.toHaveBeenCalled();
  });

  it('spawns as before when no camera view is available (never cull unprovable)', () => {
    const bare = {
      cameras: {},
      textures: { get: () => ({ has: () => true }) },
      tweens: { add: vi.fn() },
      time: { delayedCall: vi.fn() },
    } as unknown as Scene;
    const barePool = { acquire: vi.fn(createSpriteStub), release: vi.fn() } as unknown as SpritePool;
    const bareVfx = new ExplosionVFX(bare, barePool);

    bareVfx.spawn({ key: 'k8', x: 999_999, y: 999_999, radius: RADIUS, onExpire: vi.fn() });
    expect(barePool.acquire).toHaveBeenCalledTimes(6);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeaponShatterVFX } from '../../src/rendering/vfx/WeaponShatterVFX.js';
import type { SpritePool } from '../../src/rendering/vfx/SpritePool.js';

/**
 * Ticket #46 — gpu-shatter-texture-leak (re-anchored by ticket 52).
 *
 * WeaponShatterVFX uploads one canvas texture per Voronoi fragment per weapon
 * break (3-5 per break). Before the fix these were only freed at scene
 * shutdown, so the texture manager grew unboundedly across a match. The fix
 * tracks the texture key on each fragment and releases it (sprite already
 * returned to the pool first) when the fragment expires.
 *
 * Ticket #52 — gpu-vfxeffect-interface: the fragment and spark SPRITES now
 * come from the shared SpritePool instead of direct scene allocation, and
 * expiry returns them to the pool (the unique canvas texture still cannot
 * pool — it is freed per the ticket-46 discipline; the sprite's atlas texture
 * is restored BEFORE release so the slot files back under the 'game' bucket).
 *
 * This suite drives the real WeaponShatterVFX against a mock scene whose
 * texture manager is a Map — "entry count returns to baseline" is observable
 * directly. The 2d canvas context is stubbed (jsdom has no canvas impl) and
 * the clock is controllable via performance.now, so fragment expiry is
 * deterministic.
 */

type Scene = ConstructorParameters<typeof WeaponShatterVFX>[0];

const WEAPON_FRAME = 'weapon_sword';
const VFX_FRAMES = ['spark_02', 'spark_03', 'spark_04', 'star_01'];

interface SpriteStub {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  active: boolean;
  texture: { key: string };
  setTexture: ReturnType<typeof vi.fn>;
  setOrigin: ReturnType<typeof vi.fn>;
  setScale: ReturnType<typeof vi.fn>;
  setDepth: ReturnType<typeof vi.fn>;
  setTint: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  setRotation: ReturnType<typeof vi.fn>;
  setAlpha: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function createSpriteStub(): SpriteStub {
  const sprite: SpriteStub = {
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    active: true,
    texture: { key: '' },
    setTexture: vi.fn(),
    setOrigin: vi.fn(),
    setScale: vi.fn(),
    setDepth: vi.fn(),
    setTint: vi.fn(),
    setPosition: vi.fn(),
    setRotation: vi.fn(),
    setAlpha: vi.fn(),
    setVisible: vi.fn(),
    setActive: vi.fn(),
    destroy: vi.fn(),
  };
  // Track the sprite's current texture so the release-time re-texture
  // discipline (atlas frame restored before pool release) is assertable.
  sprite.setTexture.mockImplementation((key: string) => {
    sprite.texture.key = key;
    return sprite;
  });
  for (const fn of [
    sprite.setOrigin,
    sprite.setScale,
    sprite.setDepth,
    sprite.setTint,
    sprite.setPosition,
    sprite.setRotation,
    sprite.setAlpha,
    sprite.setVisible,
    sprite.setActive,
  ]) {
    (fn as { mockReturnValue: (v: unknown) => void }).mockReturnValue(sprite);
  }
  return sprite;
}

function createMockScene() {
  // The fake texture manager: fragment canvas textures live here. The two
  // atlases ('game' / 'vfx') are NOT entries — the manager count below is the
  // fragment-texture count, i.e. the leak metric.
  const entries = new Map<string, unknown>();
  const addedKeys: string[] = [];
  const removeCalls: string[] = [];
  const sprites: SpriteStub[] = [];
  /** {sprite, textureKey} at the moment of each pool.release call. */
  const releases: { sprite: SpriteStub; textureKey: string }[] = [];

  const makeFrame = () => ({
    width: 48,
    height: 96,
    cutX: 10,
    cutY: 20,
    cutWidth: 48,
    cutHeight: 96,
    // Real Phaser Frames carry a back-reference to their texture.
    texture: { getSourceImage: () => ({}) },
  });

  const makeAtlas = (frameNames: string[]) => ({
    has: (name: string) => frameNames.includes(name),
    get: (name: string) => (frameNames.includes(name) ? makeFrame() : null),
  });

  const gameAtlas = makeAtlas([WEAPON_FRAME]);
  const vfxAtlas = makeAtlas(VFX_FRAMES);

  // Ticket 52: sprites are acquired from the shared pool — the scene's own
  // add.sprite factory must NEVER be called by the effect. `sceneAddSprite`
  // records any (illegal) direct allocation.
  const sceneAddSprite = vi.fn(createSpriteStub);

  // Minimal SpritePool fake: acquire mints a stub sprite (recording it),
  // release records {sprite, texture at release} and deactivates it.
  const pool = {
    acquire: vi.fn((texture: string) => {
      const s = createSpriteStub();
      s.texture.key = texture;
      sprites.push(s);
      return s;
    }),
    release: vi.fn((s: SpriteStub) => {
      releases.push({ sprite: s, textureKey: s.texture.key });
      s.active = false;
    }),
  } as unknown as SpritePool;

  const scene = {
    textures: {
      get: (key: string) => (key === 'game' ? gameAtlas : key === 'vfx' ? vfxAtlas : null),
      addCanvas: (key: string, canvas: unknown) => {
        entries.set(key, canvas);
        addedKeys.push(key);
        return {};
      },
      exists: (key: string) => entries.has(key),
      remove: (key: string) => {
        entries.delete(key);
        removeCalls.push(key);
      },
    },
    add: {
      sprite: sceneAddSprite,
    },
  };

  return {
    scene: scene as unknown as Scene,
    pool,
    entries,
    addedKeys,
    removeCalls,
    sprites,
    releases,
    sceneAddSprite,
  };
}

describe('WeaponShatterVFX — fragment texture lifecycle (ticket 46) + sprite pool (ticket 52)', () => {
  let mockNow: number;
  let realCreateElement: typeof document.createElement;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Deterministic clock for fragment expiry (fragments live 600-800ms).
    mockNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);

    // jsdom has no canvas 2d implementation — stub the context the fragment
    // cropper uses. All geometry math still runs for real.
    realCreateElement = document.createElement.bind(document);
    const ctx2d = {
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn(),
    };
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (String(tagName).toLowerCase() === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ctx2d,
        } as unknown as HTMLCanvasElement;
      }
      return realCreateElement(tagName as never);
    }) as unknown as typeof document.createElement);

    // The exists-guard exists to keep the runtime console clean — assert it.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const advancePastExpiry = (vfx: WeaponShatterVFX) => {
    mockNow += 2000; // fragment lifetime is 600 + rand*200 ms
    for (let i = 0; i < 4; i++) vfx.update(16);
  };

  it('stress: repeated weapon breaks return the texture-manager count to baseline after expiry', () => {
    const mock = createMockScene();
    const vfx = new WeaponShatterVFX(mock.scene, mock.pool);

    expect(mock.entries.size).toBe(0); // baseline

    const BREAKS = 30;
    for (let i = 0; i < BREAKS; i++) {
      vfx.spawn({ x: 100 + i * 8, y: 100, textureKey: WEAPON_FRAME, facingAngle: 0.5, tint: 0xffffff, weaponScale: 1 });
      mockNow += 5; // spreads keys across timestamps like real frames would
    }

    // 3-5 fragments per break → the leak used to accumulate all of these.
    expect(mock.addedKeys.length).toBeGreaterThan(BREAKS);
    expect(mock.entries.size).toBe(mock.addedKeys.length);
    expect(mock.removeCalls.length).toBe(0); // nothing freed while spawning

    advancePastExpiry(vfx);

    expect(mock.entries.size).toBe(0); // back to baseline — leak fixed
    // Every fragment texture was removed exactly once (no leaks, no doubles).
    expect(mock.removeCalls.length).toBe(mock.addedKeys.length);
    expect(new Set(mock.removeCalls)).toEqual(new Set(mock.addedKeys));
    expect(new Set(mock.removeCalls).size).toBe(mock.removeCalls.length);
    // Ticket 52: every fragment+spark sprite went back to the POOL (exactly
    // once each, never destroyed) — no direct scene allocation happened.
    expect(mock.sceneAddSprite).not.toHaveBeenCalled();
    expect(mock.releases.length).toBe(mock.sprites.length);
    expect(new Set(mock.releases.map((r) => r.sprite)).size).toBe(mock.releases.length);
    expect(mock.sprites.every((s) => s.destroy.mock.calls.length === 0)).toBe(true);
    // Fragment sprites were re-textured to the 'game' atlas BEFORE release, so
    // their pool slots file back under the 'game' bucket (their unique canvas
    // texture is gone by then).
    const fragmentReleases = mock.releases.filter((r) =>
      mock.addedKeys.some((k) => r.sprite.setTexture.mock.calls.some(([key]) => key === k)),
    );
    expect(fragmentReleases.length).toBeGreaterThan(0);
    expect(fragmentReleases.every((r) => r.textureKey === 'game')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('no texture is freed while fragments are still alive (visual identity)', () => {
    const mock = createMockScene();
    const vfx = new WeaponShatterVFX(mock.scene, mock.pool);

    vfx.spawn({ x: 0, y: 0, textureKey: WEAPON_FRAME, facingAngle: 0, tint: 0xffffff, weaponScale: 1 });
    const aliveCount = mock.entries.size;
    expect(aliveCount).toBeGreaterThan(0);

    mockNow += 100; // well inside the 600-800ms lifetime
    for (let i = 0; i < 6; i++) vfx.update(16);

    expect(mock.entries.size).toBe(aliveCount);
    expect(mock.removeCalls.length).toBe(0);
    expect(mock.sprites.every((s) => s.destroy.mock.calls.length === 0)).toBe(true);
    expect(mock.releases.length).toBe(0); // nothing returned to the pool either
  });

  it('destroy() sweeps textures of in-flight fragments (scene shutdown)', () => {
    const mock = createMockScene();
    const vfx = new WeaponShatterVFX(mock.scene, mock.pool);

    for (let i = 0; i < 3; i++) {
      vfx.spawn({ x: i * 10, y: 0, textureKey: WEAPON_FRAME, facingAngle: i, tint: 0xffffff, weaponScale: 1 });
    }
    expect(mock.entries.size).toBe(mock.addedKeys.length);
    expect(mock.addedKeys.length).toBeGreaterThan(0);

    vfx.destroy(); // no update() — fragments still mid-flight

    expect(mock.entries.size).toBe(0);
    expect(new Set(mock.removeCalls)).toEqual(new Set(mock.addedKeys));
    // Ticket 52: in-flight sprites are returned to the pool, not destroyed.
    expect(mock.releases.length).toBe(mock.sprites.length);
    expect(mock.sprites.every((s) => s.destroy.mock.calls.length === 0)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('destroy() after natural expiry does not double-remove (guarded, console clean)', () => {
    const mock = createMockScene();
    const vfx = new WeaponShatterVFX(mock.scene, mock.pool);

    vfx.spawn({ x: 0, y: 0, textureKey: WEAPON_FRAME, facingAngle: 0, tint: 0xffffff, weaponScale: 1 });
    advancePastExpiry(vfx);

    const removesAfterExpiry = mock.removeCalls.length;
    const releasesAfterExpiry = mock.releases.length;
    expect(removesAfterExpiry).toBe(mock.addedKeys.length);

    vfx.destroy(); // shutdown sweep over an already-drained key list

    expect(mock.removeCalls.length).toBe(removesAfterExpiry); // no re-remove
    expect(mock.releases.length).toBe(releasesAfterExpiry); // no double-release
    expect(mock.entries.size).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled(); // no 'No texture found matching key'
  });

  it('expiry of an externally-removed texture is a guarded no-op (no warn, no crash)', () => {
    const mock = createMockScene();
    const vfx = new WeaponShatterVFX(mock.scene, mock.pool);

    vfx.spawn({ x: 0, y: 0, textureKey: WEAPON_FRAME, facingAngle: 0, tint: 0xffffff, weaponScale: 1 });
    // Simulate Phaser having already dropped one entry behind our back.
    const victim = mock.addedKeys[0]!;
    mock.entries.delete(victim);

    advancePastExpiry(vfx);

    expect(mock.entries.size).toBe(0);
    expect(mock.removeCalls).not.toContain(victim); // exists() guard skipped it
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('every fragment mints a unique texture key (per-fragment removal is authoritative)', () => {
    const mock = createMockScene();
    const vfx = new WeaponShatterVFX(mock.scene, mock.pool);

    // Same-millisecond bursts (two breaks inside one frame) plus spread-out
    // breaks — both key-generation regimes.
    for (let i = 0; i < 40; i++) {
      vfx.spawn({ x: 0, y: 0, textureKey: WEAPON_FRAME, facingAngle: i * 0.1, tint: 0xffffff, weaponScale: 1 });
      if (i % 2 === 0) mockNow += 1;
    }

    expect(mock.addedKeys.length).toBeGreaterThan(40);
    expect(new Set(mock.addedKeys).size).toBe(mock.addedKeys.length);

    vfx.destroy();
    expect(mock.entries.size).toBe(0);
  });
});

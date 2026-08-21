import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas implementation, and loading the real phaser bundle
// through this module graph trips phaser's module-scope Device.init canvas
// probe. The suites below drive the real effects against stub scenes/pools
// and only need enums/easings at runtime.
vi.mock('phaser', () => ({
  default: {
    BlendModes: { ADD: 1, NORMAL: 0 },
    Math: { Easing: { Quadratic: { In: 1 }, Sine: { InOut: 2 } } },
  },
}));

import { EntityRendererVFX } from '../../src/rendering/EntityRendererVFX.js';
import { ExplosionVFX } from '../../src/rendering/vfx/ExplosionVFX.js';
import { ParticleVFX } from '../../src/rendering/vfx/ParticleVFX.js';
import { SiegeVFX } from '../../src/rendering/vfx/SiegeVFX.js';
import { DestructionVFX } from '../../src/rendering/vfx/DestructionVFX.js';
import { PickupVFX } from '../../src/rendering/vfx/PickupVFX.js';
import { WeaponShatterVFX } from '../../src/rendering/vfx/WeaponShatterVFX.js';
import { DamageParticleVFX } from '../../src/rendering/vfx/DamageParticleVFX.js';
import { BarrelFuseVFX } from '../../src/rendering/vfx/BarrelFuseVFX.js';
import { SpritePool } from '../../src/rendering/vfx/SpritePool.js';
import type { VFXEffect, VFXEffectId } from '../../src/rendering/vfx/VFXEffect.js';

/**
 * Ticket #52 — gpu-vfxeffect-interface.
 *
 * One VFX lifecycle contract + shared sprite pool + registry facade. This
 * suite pins the three structural acceptance criteria:
 *
 *   1. INTERFACE CONFORMANCE — every one of the eight effect classes
 *      implements VFXEffect (id + spawn/update/clear/destroy) and the
 *      spawn→update→clear→destroy lifecycle never throws.
 *   2. POOL ROUTING — no effect allocates sprites directly (static source
 *      scan of the vfx directory: only SpritePool may call `add.sprite`);
 *      live acquisition goes through the shared pool and expiry returns
 *      sprites to it.
 *   3. REGISTRY FACADE — EntityRendererVFX is a Map<effect id, effect>:
 *      constructor registers the seven map-independent effects, siege is
 *      late-registered via initSiege, update/destroy iterate the registry,
 *      and the pool is torn down by the facade.
 */

const ALL_EFFECT_IDS: VFXEffectId[] = [
  'explosion',
  'particle',
  'siege',
  'destruction',
  'pickup',
  'weapon-shatter',
  'damage',
  'barrel-fuse',
];

/** Chainable GameObject stub covering every setter the effects chain. */
function makeGameObjectStub() {
  const obj: Record<string, unknown> = {
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    active: true,
    visible: true,
    texture: { key: '' },
    destroy: vi.fn(),
  };
  for (const method of [
    'setTexture',
    'setPosition',
    'setVisible',
    'setActive',
    'setAlpha',
    'setTint',
    'setBlendMode',
    'setRotation',
    'setScale',
    'setDisplaySize',
    'setOrigin',
    'setDepth',
    'setTintFill',
  ]) {
    obj[method] = vi.fn((...args: unknown[]) => {
      if (method === 'setTexture') obj.texture = { key: String(args[0]) };
      return obj;
    });
  }
  return obj;
}

/** Chainable Rectangle-ish stub for siege warnings. */
function makeRectStub() {
  const rect = { destroy: vi.fn(), setDepth: vi.fn(() => rect) };
  return rect;
}

/** Graphics stub for ParticleVFX/BarrelFuseVFX — chainable setters + the draw calls. */
function makeGraphicsStub() {
  const gfx: Record<string, unknown> = {
    clear: vi.fn(),
    fillStyle: vi.fn(() => gfx),
    fillRect: vi.fn(),
    lineStyle: vi.fn(() => gfx),
    lineBetween: vi.fn(),
    fillCircle: vi.fn(),
    strokeCircle: vi.fn(),
    fillEllipse: vi.fn(),
    destroy: vi.fn(),
    setDepth: vi.fn(() => gfx),
    setBlendMode: vi.fn(() => gfx),
  };
  return gfx;
}

function makeSceneStub() {
  const tweens: { targets: unknown; onComplete?: () => void }[] = [];
  // Fake texture-manager entries for WeaponShatterVFX's fragment canvases.
  const canvasEntries = new Map<string, unknown>();
  const scene = {
    cameras: { main: { worldView: { x: 0, y: 0, right: 1920, bottom: 1080 } } },
    textures: {
      get: () => ({
        has: () => true,
        // Frame stub for WeaponShatterVFX's Voronoi cropper.
        get: () => ({
          width: 48,
          height: 96,
          cutX: 10,
          cutY: 20,
          cutWidth: 48,
          cutHeight: 96,
          texture: { getSourceImage: () => ({}) },
        }),
      }),
      addCanvas: (key: string, canvas: unknown) => canvasEntries.set(key, canvas),
      exists: (key: string) => canvasEntries.has(key),
      remove: (key: string) => canvasEntries.delete(key),
    },
    tweens: {
      add: vi.fn((cfg: { targets: unknown; onComplete?: () => void }) => {
        tweens.push(cfg);
        return { ...cfg, stop: vi.fn() };
      }),
      killTweensOf: vi.fn(),
    },
    time: { delayedCall: vi.fn() },
    add: {
      graphics: vi.fn(() => makeGraphicsStub()),
      sprite: vi.fn(() => makeGameObjectStub()),
      rectangle: vi.fn(() => makeRectStub()),
    },
  };
  return { scene, tweens };
}

function makePoolStub() {
  const acquired: { texture: string; frame: string }[] = [];
  const released: { textureKey: string }[] = [];
  const pool = {
    acquire: vi.fn((texture: string, frame: string) => {
      acquired.push({ texture, frame });
      const spr = makeGameObjectStub();
      spr.texture = { key: texture };
      return spr;
    }),
    release: vi.fn((spr: { texture: { key: string } }) => {
      released.push({ textureKey: spr.texture.key });
    }),
  };
  return { pool, acquired, released };
}

describe('VFXEffect interface conformance (ticket 52)', () => {
  let mockNow: number;
  let realCreateElement: typeof document.createElement;

  beforeEach(() => {
    mockNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
    // WeaponShatterVFX's fragment cropper needs a canvas; a spawn with a
    // missing texture never reaches it, but stub anyway so any path is safe.
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('every effect class implements the four lifecycle methods + id', () => {
    const { scene } = makeSceneStub();
    const { pool } = makePoolStub();
    const instances: VFXEffect[] = [
      new ExplosionVFX(scene as never, pool as never),
      new ParticleVFX(scene as never, pool as never),
      new SiegeVFX(scene as never, pool as never, 128),
      new DestructionVFX(scene as never, pool as never),
      new PickupVFX(scene as never, pool as never),
      new WeaponShatterVFX(scene as never, pool as never),
      new DamageParticleVFX(scene as never, pool as never),
      new BarrelFuseVFX(scene as never, pool as never),
    ];

    for (const effect of instances) {
      const name = effect.id;
      expect(typeof effect.spawn, `${name}.spawn`).toBe('function');
      expect(typeof effect.update, `${name}.update`).toBe('function');
      expect(typeof effect.clear, `${name}.clear`).toBe('function');
      expect(typeof effect.destroy, `${name}.destroy`).toBe('function');
      expect(ALL_EFFECT_IDS, `${name} is a registry id`).toContain(effect.id);
    }
    // All eight registry ids are covered, each by exactly one effect class.
    expect(new Set(instances.map((i) => i.id)).size).toBe(8);
  });

  it('spawn → update → clear → destroy never throws for any effect', () => {
    const { scene } = makeSceneStub();
    const { pool } = makePoolStub();

    const explosion = new ExplosionVFX(scene as never, pool as never);
    explosion.spawn({ key: 'k', x: 100, y: 100, radius: 256, onExpire: vi.fn() });

    const particle = new ParticleVFX(scene as never, pool as never);
    particle.spawn({ kind: 'trap', trapType: 0, x: 1, y: 2 });
    particle.spawn({ kind: 'break', x: 1, y: 2, type: 1 });
    particle.spawn({ kind: 'teleport', playerId: 'p', x: 0, y: 0, destX: 9, destY: 9 });
    particle.spawn({ kind: 'fire-dot', playerId: 'p', active: true });

    const siege = new SiegeVFX(scene as never, pool as never, 128);
    siege.spawn({ kind: 'warning', gridX: 1, gridY: 2, solidifyAt: 1 });
    siege.spawn({ kind: 'confirm', gridX: 1, gridY: 2, mapRenderer: null });
    siege.spawn({ kind: 'dust', x: 5, y: 5 });

    const destruction = new DestructionVFX(scene as never, pool as never);
    destruction.spawn({ kind: 'shake', key: 'd', sprite: makeGameObjectStub() as never });

    const pickup = new PickupVFX(scene as never, pool as never);
    pickup.spawn({ kind: 'none' });
    pickup.updatePickupBob(makeGameObjectStub() as never, 10, 'key', 100);
    pickup.updatePowerupBob(makeGameObjectStub() as never, 10, 'key', 100);

    const shatter = new WeaponShatterVFX(scene as never, pool as never);
    shatter.spawn({
      x: 0,
      y: 0,
      textureKey: 'weapon_sword',
      facingAngle: 0,
      tint: 0xffffff,
      weaponScale: 1,
    });

    const damage = new DamageParticleVFX(scene as never, pool as never);
    damage.spawn({ kind: 'blood', x: 0, y: 0 });
    damage.spawn({ kind: 'fire', x: 0, y: 0 });
    damage.spawn({ kind: 'teleport', x: 0, y: 0 });
    damage.spawn({ kind: 'shield-block', x: 0, y: 0, contactX: 1, contactY: 1 });

    // BarrelFuseVFX (ticket 06): the prime-moment puff through spawn + a
    // server-state sync (no tick provider wired → update renders nothing,
    // which must also be throw-free).
    const barrelFuse = new BarrelFuseVFX(scene as never, pool as never);
    barrelFuse.spawn({ kind: 'ignite', key: 'dest_barrel_1', x: 64, y: 64 });
    barrelFuse.syncPrimed('dest_barrel_1', {
      id: 'dest_barrel_1',
      type: 1,
      hp: 1,
      maxHp: 2,
      x: 64,
      y: 64,
      isDestroyed: false,
      textureKey: '',
      rotation: 0,
      flipH: false,
      flipV: false,
      primed: true,
      fuseExpiresAtTick: 900,
    });

    const effects = [
      explosion,
      particle,
      siege,
      destruction,
      pickup,
      shatter,
      damage,
      barrelFuse,
    ];

    for (const effect of effects) {
      expect(() => {
        effect.update(16);
        effect.clear();
        effect.destroy();
        // The facade's destroy path + defensive double-destroy must be safe.
        effect.destroy();
      }, `${effect.id} lifecycle`).not.toThrow();
    }
  });

  it('pool routing: effects acquire through the shared pool and release on expiry', () => {
    const { scene, tweens } = makeSceneStub();
    const { pool, acquired, released } = makePoolStub();

    // Siege dust: 7 puffs, all acquired from the pool; firing each puff's
    // tween onComplete returns it to the pool.
    const siege = new SiegeVFX(scene as never, pool as never, 128);
    const dustTweensBefore = tweens.length;
    siege.spawn({ kind: 'dust', x: 0, y: 0 });
    expect(acquired.length).toBe(7);
    expect(acquired.every((a) => a.texture === 'vfx')).toBe(true);
    expect(released.length).toBe(0);

    const dustTweens = tweens.slice(dustTweensBefore);
    for (const t of dustTweens) t.onComplete?.();
    expect(released.length).toBe(7);
    expect(pool.release).toHaveBeenCalledTimes(7);

    // Siege coffin: acquired from the pool under the 'game' atlas, released on
    // the fall tween's completion.
    const confirmTweensBefore = tweens.length;
    siege.spawn({ kind: 'confirm', gridX: 0, gridY: 0, mapRenderer: null });
    expect(acquired.at(-1)).toMatchObject({ texture: 'game', frame: 'coffin' });
    const confirmTweens = tweens.slice(confirmTweensBefore);
    confirmTweens[0]!.onComplete?.();
    expect(released.at(-1)).toMatchObject({ textureKey: 'game' });
  });

  it('pool routing (static): only SpritePool allocates sprites in the vfx directory', () => {
    const vfxDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/rendering/vfx');
    const files = readdirSync(vfxDir).filter((f) => f.endsWith('.ts') && f !== 'SpritePool.ts');
    // 13 = 8 effects + the VFXEffect contract + ticket-02 (2f8b388) beacon
    // motes: BeaconMotesConfig + BeaconMotesVFX (standalone — wired in
    // GameSceneSetup, not a VFXEffect-registry effect) + ticket-17's
    // BeaconMotesTiers (the outer-dust + accent tiers of the same standalone
    // system — Phaser-free pure math) + ticket-06's BarrelFuseVFX
    // (Graphics-drawn, zero sprites) + ticket-03's PowerAuraVFX (standalone
    // pooled aura layer — owns its own SpritePool, driven by
    // StatusEffectRenderer, not a registry effect).
    expect(files.length).toBe(13);
    for (const file of files) {
      const source = readFileSync(join(vfxDir, file), 'utf-8');
      expect(
        source,
        `${file} must acquire sprites through the shared SpritePool (ticket 52)`,
      ).not.toMatch(/\.add\.sprite\s*\(/);
    }
  });
});

describe('EntityRendererVFX registry (ticket 52)', () => {
  it('is a Map<effect id, effect> — seven effects at construction, siege late via initSiege', () => {
    const { scene } = makeSceneStub();
    const vfx = new EntityRendererVFX(scene as never);

    // The eight ids, with siege absent until the map renderer exists.
    expect(vfx.has('explosion')).toBe(true);
    expect(vfx.has('particle')).toBe(true);
    expect(vfx.has('damage')).toBe(true);
    expect(vfx.has('destruction')).toBe(true);
    expect(vfx.has('pickup')).toBe(true);
    expect(vfx.has('weapon-shatter')).toBe(true);
    expect(vfx.has('barrel-fuse')).toBe(true);
    expect(vfx.has('siege')).toBe(false);
    expect(vfx.get('siege')).toBeUndefined();
    expect(vfx.siege).toBeNull();

    const mapRenderer = { getTileSize: () => 128 };
    vfx.initSiege(mapRenderer as never);
    expect(vfx.has('siege')).toBe(true);
    expect(vfx.siege).toBeInstanceOf(SiegeVFX);

    // Typed accessors are views over the SAME registry entries.
    expect(vfx.explosion).toBeInstanceOf(ExplosionVFX);
    expect(vfx.explosion).toBe(vfx.get('explosion'));
    expect(vfx.particle).toBeInstanceOf(ParticleVFX);
    expect(vfx.damage).toBeInstanceOf(DamageParticleVFX);
    expect(vfx.destruction).toBeInstanceOf(DestructionVFX);
    expect(vfx.pickup).toBeInstanceOf(PickupVFX);
    expect(vfx.shatter).toBeInstanceOf(WeaponShatterVFX);
    expect(vfx.barrelFuse).toBeInstanceOf(BarrelFuseVFX);

    // Register/get round-trip for an arbitrary id (the registry is the facade).
    const sentinel = {
      id: 'siege',
      spawn: vi.fn(),
      update: vi.fn(),
      clear: vi.fn(),
      destroy: vi.fn(),
    };
    vfx.register(sentinel as never);
    expect(vfx.get('siege')).toBe(sentinel);

    vfx.destroy();
  });

  it('update drives every registered effect; destroy destroys them all + the pool', () => {
    const { scene } = makeSceneStub();
    const poolDestroySpy = vi.spyOn(SpritePool.prototype, 'destroy');

    const vfx = new EntityRendererVFX(scene as never);
    vfx.initSiege({ getTileSize: () => 128 } as never);

    const effects = ALL_EFFECT_IDS.map((id) => vfx.get(id)!) as VFXEffect<never>[];
    const updateSpies = effects.map((e) => vi.spyOn(e, 'update'));
    const destroySpies = effects.map((e) => vi.spyOn(e, 'destroy'));

    vfx.update(16);
    for (const spy of updateSpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(updateSpies[0]).toHaveBeenCalledWith(16);

    vfx.destroy();
    for (const spy of destroySpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(poolDestroySpy).toHaveBeenCalledTimes(1);

    // Registry is drained — repeated lifecycle calls are safe no-ops.
    expect(() => {
      vfx.update(16);
      vfx.destroy();
    }).not.toThrow();
  });
});

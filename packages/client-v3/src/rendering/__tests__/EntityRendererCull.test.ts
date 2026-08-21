/**
 * Perf ticket 19 (entity view culling + trap Graphics gating) regression tests.
 *
 * WHY THIS TEST EXISTS:
 * `EntityRendererLifecycle.update()` iterates EVERY entity each frame and
 * Phaser 4.1 has no automatic frustum cull — so off-camera pickups, powerups
 * and exits still ran their bob/pulse transforms, and every ACTIVE fire trap
 * re-issued its clear + 9 fillRect Graphics vertex re-upload, every frame:
 * O(total entities) CPU that grows with map loot, not with visible action
 * (evidence: .scratch/perf-arc-neo/issues/01, finding #2).
 *
 * WHAT THIS PINS:
 *   1. Off-camera (beyond camera worldView + 192px margin) pickups, powerups
 *      and active exits skip their per-frame transforms; on-camera ones are
 *      animated exactly as before (same calls, same values).
 *   2. PHASE CONSISTENCY — the ticket's critical constraint: every gated
 *      animation is a pure function of absolute `performance.now()`, so an
 *      entity culled N seconds and re-entering view shows EXACTLY the
 *      position/scale/alpha a never-culled entity shows at the same instant.
 *      Proven twin-style (never-culled twin vs culled-then-returned twin,
 *      bit-for-bit) and directly against the absolute-time formulas.
 *   3. Off-screen fire traps issue ZERO per-frame Graphics rebuilds; the
 *      arm → fire transition (updateTrap) still triggers EXACTLY ONE rebuild
 *      while off-screen; fire expiry keeps clearing the overlay
 *      (event-driven, visibility-independent); the on-screen per-frame pulse
 *      redraw is unchanged.
 *   4. A missing camera (headless stub) means "cannot prove off-screen" →
 *      animate everything — the pre-cull fallback (ExplosionVFX parity).
 *
 * Phaser is globally mocked in tests/setup.ts; scene/sprite/graphics stubs
 * below are plain fakes with the single `as unknown as` cast per helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Phaser from 'phaser';
import { EntityRendererLifecycle } from '../EntityRendererLifecycle.js';
import { updateTrap } from '../EntityRendererTraps.js';
import { PickupVFX } from '../vfx/PickupVFX.js';
import type { SpritePool } from '../vfx/SpritePool.js';
import type { EntityRendererVFX } from '../EntityRendererVFX.js';
import type { EntityVisual } from '../EntityTypes.js';
import type { TrapState } from '../../types.js';

/* ── Stubs ─────────────────────────────────────────────────────────────── */

interface ViewRect {
  x: number;
  y: number;
  right: number;
  bottom: number;
}

/**
 * Headless scene stub with a MUTABLE main-camera worldView. Omitting
 * `initialView` yields a camera-less scene (the headless fallback case).
 * `textures` satisfies PickupVFX's glow-frame probe (map every frame → the
 * pooled glow/ping path runs, as it does in production).
 */
function makeSceneStub(initialView?: ViewRect) {
  const worldView = initialView ? { ...initialView } : undefined;
  const scene = {
    cameras: worldView ? { main: { worldView } } : {},
    textures: { get: () => ({ has: () => true }) },
  };
  return { scene: scene as unknown as Phaser.Scene, worldView };
}

/** Chainable sprite fake — tracks the transforms the bob/pulse paths write. */
function makeSpriteStub(x = 0, y = 0): EntityVisual['sprite'] {
  const sprite = {
    x,
    y,
    alpha: 1,
    scaleX: 1,
    scaleY: 1,
    visible: true,
    setAlpha(a: number) {
      sprite.alpha = a;
      return sprite;
    },
    setScale(sx: number) {
      sprite.scaleX = sx;
      return sprite;
    },
    setVisible(v: boolean) {
      sprite.visible = v;
      return sprite;
    },
    setTint() {
      return sprite;
    },
    clearTint() {
      return sprite;
    },
    setDepth() {
      return sprite;
    },
    setOrigin() {
      return sprite;
    },
    destroy() {},
  };
  return sprite as unknown as EntityVisual['sprite'];
}

/** Graphics fake recording the fire-area rebuild primitives. */
function makeGraphicsStub(): Phaser.GameObjects.Graphics {
  return {
    clear: vi.fn(),
    fillStyle: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as Phaser.GameObjects.Graphics;
}

/** Pool fake handing out sprite stubs for the powerup glow/ping pair. */
function makePoolStub(): SpritePool {
  return {
    acquire: () => makeSpriteStub(),
    release: () => {},
  } as unknown as SpritePool;
}

/**
 * Lifecycle with the REAL PickupVFX: the bob/pulse appliers are pure
 * functions of (now, key, baseY/baseScale) and never touch scene/pool beyond
 * the glow/ping acquisition, so the phase-consistency proofs below exercise
 * the production math, not a mock of it.
 */
function makeLifecycle(initialView?: ViewRect) {
  const { scene, worldView } = makeSceneStub(initialView);
  const pickup = new PickupVFX(scene, makePoolStub());
  const vfx = { pickup } as unknown as EntityRendererVFX;
  const lifecycle = new EntityRendererLifecycle(scene, vfx, null);
  return { scene, worldView, pickup, lifecycle };
}

function makeTrap(overrides: Partial<TrapState> = {}): TrapState {
  return {
    id: 'trap-1',
    type: 1,
    x: 0,
    y: 0,
    isRevealed: true,
    cooldownRemaining: 0,
    textureKey: '',
    rotation: 0,
    flipH: false,
    flipV: false,
    fireAreaActive: false,
    fireAreaRemainingMs: 0,
    ...overrides,
  };
}

/* ── Deterministic time (the animations phase off performance.now()) ────── */

let setNow: (t: number) => void;

beforeEach(() => {
  const mock = vi.spyOn(performance, 'now');
  setNow = (t: number) => mock.mockReturnValue(t);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── Tests ─────────────────────────────────────────────────────────────── */

describe('EntityRendererLifecycle.update — entity view cull (perf ticket 19)', () => {
  // Camera world view covers [1000..2000]×[1000..2000]; the cull bounds pad
  // it by 192px → [808..2192]. Entities beyond that band are "off-camera".
  const VIEW: ViewRect = { x: 1000, y: 1000, right: 2000, bottom: 2000 };
  const ON_CAM = { x: 1500, y: 1500 };
  const OFF_CAM = { x: 5000, y: 5000 };

  it('skips the pickup bob off-camera; on-camera the call is unchanged', () => {
    const { pickup, lifecycle } = makeLifecycle(VIEW);
    const off = makeSpriteStub(OFF_CAM.x, OFF_CAM.y);
    const on = makeSpriteStub(ON_CAM.x, ON_CAM.y);
    lifecycle.entities.set('wpn-off', { sprite: off, type: 'weaponpickup', baseY: OFF_CAM.y });
    lifecycle.entities.set('wpn-on', { sprite: on, type: 'weaponpickup', baseY: ON_CAM.y });
    const spy = vi.spyOn(pickup, 'updatePickupBob');

    setNow(10_000);
    lifecycle.update();

    // Only the on-camera entity animates — same args as pre-cull.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(on, ON_CAM.y, 'wpn-on', 10_000);
    // The off-camera transform stays frozen at its pre-cull value.
    expect(off.y).toBe(OFF_CAM.y);
  });

  it('skips the powerup bob + glow pulse off-camera; on-camera both still run', () => {
    const { pickup, lifecycle } = makeLifecycle(VIEW);
    const off = makeSpriteStub(OFF_CAM.x, OFF_CAM.y);
    const on = makeSpriteStub(ON_CAM.x, ON_CAM.y);
    lifecycle.entities.set('pu-off', { sprite: off, type: 'powerup', baseY: OFF_CAM.y });
    lifecycle.entities.set('pu-on', { sprite: on, type: 'powerup', baseY: ON_CAM.y });
    const bobSpy = vi.spyOn(pickup, 'updatePowerupBob');
    const glowSpy = vi.spyOn(pickup, 'updatePowerUpGlow');

    setNow(10_000);
    lifecycle.update();

    expect(bobSpy).toHaveBeenCalledTimes(1);
    expect(bobSpy).toHaveBeenCalledWith(on, ON_CAM.y, 'pu-on', 10_000);
    expect(glowSpy).toHaveBeenCalledTimes(1);
    expect(glowSpy).toHaveBeenCalledWith('pu-on', 10_000);
    expect(off.y).toBe(OFF_CAM.y);
    expect(off.alpha).toBe(1);
    expect(off.scaleX).toBe(1);
  });

  it('skips the exit alpha pulse off-camera; on-camera it matches the formula', () => {
    const { lifecycle } = makeLifecycle(VIEW);
    const off = makeSpriteStub(OFF_CAM.x, OFF_CAM.y);
    const on = makeSpriteStub(ON_CAM.x, ON_CAM.y);
    lifecycle.entities.set('exit-off', { sprite: off, type: 'exit', active: true });
    lifecycle.entities.set('exit-on', { sprite: on, type: 'exit', active: true });

    setNow(12_345);
    lifecycle.update();

    expect(on.alpha).toBe(Math.sin(12_345 / 600) * 0.15 + 0.85);
    expect(off.alpha).toBe(1);
  });

  it('animates the 192px margin band (pop-in guard) but not beyond it', () => {
    const { pickup, lifecycle } = makeLifecycle(VIEW);
    // 100px left of the view edge: outside worldView, inside the margin.
    const near = makeSpriteStub(VIEW.x - 100, 1500);
    // 250px left of the view edge: beyond the 192px margin.
    const past = makeSpriteStub(VIEW.x - 250, 1500);
    lifecycle.entities.set('wpn-near', { sprite: near, type: 'weaponpickup', baseY: 1500 });
    lifecycle.entities.set('wpn-past', { sprite: past, type: 'weaponpickup', baseY: 1500 });
    const spy = vi.spyOn(pickup, 'updatePickupBob');

    setNow(1000);
    lifecycle.update();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(near, 1500, 'wpn-near', 1000);
  });

  it('missing camera → cannot prove off-screen → animates everything (pre-cull fallback)', () => {
    const { pickup, lifecycle } = makeLifecycle(undefined);
    const far = makeSpriteStub(500_000, 500_000);
    lifecycle.entities.set('wpn-far', { sprite: far, type: 'weaponpickup', baseY: 500_000 });
    const spy = vi.spyOn(pickup, 'updatePickupBob');

    setNow(1000);
    expect(() => lifecycle.update()).not.toThrow();
    expect(spy).toHaveBeenCalledWith(far, 500_000, 'wpn-far', 1000);
  });

  /* ── Phase consistency (the ticket's CRITICAL constraint) ── */

  it('pickup culled 29s resumes the EXACT bob a never-culled twin shows', () => {
    const never = makeLifecycle(VIEW);
    const culled = makeLifecycle(VIEW);
    const spriteNever = makeSpriteStub(ON_CAM.x, 1000);
    const spriteCulled = makeSpriteStub(ON_CAM.x, 1000);
    never.lifecycle.entities.set('wpn-x', {
      sprite: spriteNever,
      type: 'weaponpickup',
      baseY: 1000,
    });
    culled.lifecycle.entities.set('wpn-x', {
      sprite: spriteCulled,
      type: 'weaponpickup',
      baseY: 1000,
    });

    const t0 = 1_000;
    const tEnd = 30_000;
    setNow(t0);
    never.lifecycle.update();
    culled.lifecycle.update();

    // Camera pans away for 29 seconds — the twin is fully culled mid-window.
    const wv = culled.worldView!;
    const parked = { x: 100_000, y: 100_000, right: 101_000, bottom: 101_000 };
    Object.assign(wv, parked);
    for (let t = t0 + 250; t < tEnd; t += 250) {
      setNow(t);
      never.lifecycle.update();
      culled.lifecycle.update();
    }
    // Culled twin froze at its t0 pose (proves the cull actually engaged).
    expect(spriteCulled.y).toBe(1000 + Math.sin(t0 / 400 + 'wpn-x'.charCodeAt(0)) * 4);
    expect(spriteCulled.y).not.toBe(spriteNever.y);

    // Camera returns for the final frame.
    Object.assign(wv, VIEW);
    setNow(tEnd);
    never.lifecycle.update();
    culled.lifecycle.update();

    // EXACT resume — bit-for-bit the never-culled value...
    expect(spriteCulled.y).toBe(spriteNever.y);
    // ...which is itself the absolute-time formula at tEnd.
    expect(spriteNever.y).toBe(1000 + Math.sin(tEnd / 400 + 'wpn-x'.charCodeAt(0)) * 4);
  });

  it('powerup culled 29s resumes the EXACT y/scale/alpha of a never-culled twin', () => {
    const never = makeLifecycle(VIEW);
    const culled = makeLifecycle(VIEW);
    const spriteNever = makeSpriteStub(ON_CAM.x, 1000);
    const spriteCulled = makeSpriteStub(ON_CAM.x, 1000);
    never.lifecycle.entities.set('pu-x', { sprite: spriteNever, type: 'powerup', baseY: 1000 });
    culled.lifecycle.entities.set('pu-x', { sprite: spriteCulled, type: 'powerup', baseY: 1000 });
    // Attach pop-state exactly as addPowerUp does in production, so the icon
    // pulse rides a FIXED baseScale captured at add (the stateless fallback
    // reads the live scaleX, which is self-referential and never hit for a
    // real powerup).
    never.pickup.attachPowerUpGlow('pu-x', ON_CAM.x, 1000, 0x00ff00, 1);
    culled.pickup.attachPowerUpGlow('pu-x', ON_CAM.x, 1000, 0x00ff00, 1);

    const t0 = 1_000;
    const tEnd = 30_000;
    setNow(t0);
    never.lifecycle.update();
    culled.lifecycle.update();
    Object.assign(culled.worldView!, { x: 100_000, y: 100_000, right: 101_000, bottom: 101_000 });
    for (let t = t0 + 250; t < tEnd; t += 250) {
      setNow(t);
      never.lifecycle.update();
      culled.lifecycle.update();
    }
    Object.assign(culled.worldView!, VIEW);
    setNow(tEnd);
    never.lifecycle.update();
    culled.lifecycle.update();

    expect(spriteCulled.y).toBe(spriteNever.y);
    expect(spriteCulled.scaleX).toBe(spriteNever.scaleX);
    expect(spriteCulled.alpha).toBe(spriteNever.alpha);
  });

  it('exit culled 29s resumes the EXACT pulse alpha of a never-culled twin', () => {
    const never = makeLifecycle(VIEW);
    const culled = makeLifecycle(VIEW);
    const spriteNever = makeSpriteStub(ON_CAM.x, 1500);
    const spriteCulled = makeSpriteStub(ON_CAM.x, 1500);
    never.lifecycle.entities.set('exit-x', { sprite: spriteNever, type: 'exit', active: true });
    culled.lifecycle.entities.set('exit-x', { sprite: spriteCulled, type: 'exit', active: true });

    const t0 = 1_000;
    const tEnd = 30_000;
    setNow(t0);
    never.lifecycle.update();
    culled.lifecycle.update();
    Object.assign(culled.worldView!, { x: 100_000, y: 100_000, right: 101_000, bottom: 101_000 });
    for (let t = t0 + 250; t < tEnd; t += 250) {
      setNow(t);
      never.lifecycle.update();
      culled.lifecycle.update();
    }
    Object.assign(culled.worldView!, VIEW);
    setNow(tEnd);
    never.lifecycle.update();
    culled.lifecycle.update();

    expect(spriteCulled.alpha).toBe(spriteNever.alpha);
    expect(spriteNever.alpha).toBe(Math.sin(tEnd / 600) * 0.15 + 0.85);
  });
});

describe('Fire-trap Graphics gating (perf ticket 19)', () => {
  const VIEW: ViewRect = { x: 1000, y: 1000, right: 2000, bottom: 2000 };
  const OFF_CAM = { x: 5000, y: 5000 };

  it('an off-screen ACTIVE fire trap issues ZERO per-frame Graphics rebuilds', () => {
    const { lifecycle } = makeLifecycle(VIEW);
    const gfx = makeGraphicsStub();
    lifecycle.entities.set('trap-off', {
      sprite: makeSpriteStub(OFF_CAM.x, OFF_CAM.y),
      type: 'trap',
      active: true,
      fireAreaGraphics: gfx,
    });

    for (let i = 0; i < 5; i++) {
      setNow(1000 + i * 16);
      lifecycle.update();
    }

    expect(vi.mocked(gfx.clear)).not.toHaveBeenCalled();
    expect(vi.mocked(gfx.fillRect)).not.toHaveBeenCalled();
  });

  it('an on-screen ACTIVE fire trap still rebuilds every frame (pulse unchanged)', () => {
    const { lifecycle } = makeLifecycle(VIEW);
    const gfx = makeGraphicsStub();
    lifecycle.entities.set('trap-on', {
      sprite: makeSpriteStub(1500, 1500),
      type: 'trap',
      active: true,
      fireAreaGraphics: gfx,
    });

    for (let i = 0; i < 3; i++) {
      setNow(1000 + i * 16);
      lifecycle.update();
    }

    // 3 frames × (1 clear + 9 fillRect) — byte-identical to the pre-gate loop.
    expect(vi.mocked(gfx.clear)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(gfx.fillRect)).toHaveBeenCalledTimes(27);
  });

  it('arm → fire while off-screen triggers EXACTLY ONE rebuild, then silence', () => {
    const { scene, lifecycle } = makeLifecycle(VIEW);
    const gfx = makeGraphicsStub();
    lifecycle.entities.set('trap-1', {
      sprite: makeSpriteStub(OFF_CAM.x, OFF_CAM.y),
      type: 'trap',
      active: false,
      fireAreaGraphics: gfx,
    });

    // Server patch: the fire area arms while the trap is off-camera.
    updateTrap(
      lifecycle.entities,
      scene,
      lifecycle.resolver,
      'trap-1',
      makeTrap({ fireAreaActive: true }),
    );

    setNow(1000);
    lifecycle.update(); // dirty → the one state-change rebuild
    expect(vi.mocked(gfx.clear)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gfx.fillRect)).toHaveBeenCalledTimes(9);

    // Further off-screen frames: still exactly one — zero per-frame rebuilds.
    for (let i = 1; i <= 4; i++) {
      setNow(1000 + i * 16);
      lifecycle.update();
    }
    expect(vi.mocked(gfx.clear)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gfx.fillRect)).toHaveBeenCalledTimes(9);
    const entry = lifecycle.entities.get('trap-1')!;
    expect(entry.type === 'trap' && entry.fireAreaDirty).toBeFalsy();
  });

  it('fire expiry (updateTrap) clears the overlay while off-screen and drops the flag', () => {
    const { scene, lifecycle } = makeLifecycle(VIEW);
    const gfx = makeGraphicsStub();
    lifecycle.entities.set('trap-1', {
      sprite: makeSpriteStub(OFF_CAM.x, OFF_CAM.y),
      type: 'trap',
      active: true,
      fireAreaGraphics: gfx,
      fireAreaDirty: true,
    });

    updateTrap(
      lifecycle.entities,
      scene,
      lifecycle.resolver,
      'trap-1',
      makeTrap({ fireAreaActive: false }),
    );

    // The event-driven expire clear is visibility-independent (unchanged).
    expect(vi.mocked(gfx.clear)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gfx.fillRect)).not.toHaveBeenCalled();
    const entry = lifecycle.entities.get('trap-1')!;
    expect(entry.type === 'trap' && entry.fireAreaDirty).toBeFalsy();

    // And the per-frame loop adds no rebuild on top of it.
    setNow(1000);
    lifecycle.update();
    expect(vi.mocked(gfx.clear)).toHaveBeenCalledTimes(1);
  });

  it('a fire trap re-entering view resumes the per-frame pulse redraw', () => {
    const { worldView, lifecycle } = makeLifecycle(VIEW);
    const gfx = makeGraphicsStub();
    lifecycle.entities.set('trap-1', {
      sprite: makeSpriteStub(OFF_CAM.x, OFF_CAM.y),
      type: 'trap',
      active: true,
      fireAreaGraphics: gfx,
    });

    setNow(1000);
    lifecycle.update(); // off-screen → nothing
    expect(vi.mocked(gfx.clear)).not.toHaveBeenCalled();

    // Camera pans onto the trap: per-frame redraws resume immediately.
    Object.assign(worldView!, {
      x: OFF_CAM.x - 500,
      y: OFF_CAM.y - 500,
      right: OFF_CAM.x + 500,
      bottom: OFF_CAM.y + 500,
    });
    setNow(1016);
    lifecycle.update();
    expect(vi.mocked(gfx.clear)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gfx.fillRect)).toHaveBeenCalledTimes(9);
  });
});

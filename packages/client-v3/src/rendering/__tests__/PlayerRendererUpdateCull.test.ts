/**
 * Regression guard for the "ghost arms" cull bug.
 *
 * When a REMOTE player goes off-screen, the view-cull branch in
 * `updateAllPlayerFrames` must hide ALL of that player's sprites — including
 * the 4 IK arm segments drawn by `ArmRenderer` (which live on the scene root,
 * NOT inside any player container, so they will not inherit a parent's
 * visibility). If the arms are not explicitly hidden they freeze at their last
 * on-screen world position and "linger" as ghost arms after the body has moved
 * off-screen.
 *
 * The original fix used a one-shot hide (`if (!v.culled) { hide; culled=true }`).
 * That design had a hole: event-driven writers `resetForRespawn` and
 * `updateWeapon` call `setVisible(true)` on a culled player's sprites without
 * consulting `culled`, and the one-shot guard then refused to re-hide them
 * (because `culled` was already true) — so the re-shown arms lingered
 * persistently. The fix is an AUTHORITATIVE per-frame re-assert: hide every
 * off-screen frame regardless of `culled`, so any writer's re-show is overridden
 * next frame. These tests pin both the hide and the per-frame re-assert so the
 * one-shot design cannot be reintroduced.
 *
 * Phaser is globally mocked in tests/setup.ts, so the sprites here are plain
 * fakes cast to the Phaser types. The animation driver is also a fake — these
 * tests exercise the CULL decision + visibility wiring, not the pose math.
 */
import { describe, it, expect } from 'vitest';
import { AnimPhase, PlayerStatus } from '@sector-battle/shared';

import { updateAllPlayerFrames } from '../PlayerRendererUpdate.js';
import type {
  PlayerFrameContext,
  PlayerRenderBundle,
  PlayerVisual,
} from '../PlayerRendererTypes.js';
import type { ArmJoints, ArmRenderer, PlayerArmSprites } from '../ArmRenderer.js';
import type { WeaponTrailRenderer } from '../WeaponTrailRenderer.js';
import type { GhostTailRenderer } from '../GhostTailRenderer.js';
import type { AnimSimDriver } from '../../animation/AnimSimDriver.js';
import type { PlayerAnimationController } from '../PlayerAnimationController.js';
import { AnimationState } from '../../types.js';

/** Minimal chainable sprite fake. Tracks setVisible so tests can assert on it. */
function makeFakeSprite(x = 0, y = 0) {
  const sprite = {
    x,
    y,
    visible: true,
    alpha: 1,
    depth: 0,
    rotation: 0,
    tint: 0xffffff,
    scaleX: 1,
    setVisible(this: unknown, v: boolean) {
      (sprite as { visible: boolean }).visible = v;
      return sprite;
    },
    setAlpha(this: unknown, a: number) {
      (sprite as { alpha: number }).alpha = a;
      return sprite;
    },
    setPosition(this: unknown, px: number, py: number) {
      (sprite as { x: number }).x = px;
      (sprite as { y: number }).y = py;
      return sprite;
    },
    setRotation() {
      return sprite;
    },
    setScale() {
      return sprite;
    },
    setTint() {
      return sprite;
    },
    clearTint() {
      return sprite;
    },
    setDisplaySize() {
      return sprite;
    },
    setOrigin() {
      return sprite;
    },
    setDepth() {
      return sprite;
    },
    setFlipX() {
      return sprite;
    },
    setTexture() {
      return sprite;
    },
    setText() {
      return sprite;
    },
    setStyle() {
      return sprite;
    },
    destroy() {},
  };
  return sprite;
}

/**
 * Fake ArmRenderer that records every setVisible(arms, visible) call. Each
 * player's fake `arms` object carries a `_key` marker so the recording stays
 * assertable per player (the real ArmRenderer is key-less — it operates on the
 * sprite set hanging off the bundle).
 */
function makeFakeArmRenderer() {
  const setVisibleCalls: { key: string; visible: boolean }[] = [];
  const armRenderer = {
    setVisible(arms: PlayerArmSprites & { _key?: string }, visible: boolean) {
      setVisibleCalls.push({ key: arms._key ?? '?', visible });
    },
    setAlpha() {},
    updateArms() {},
    setTint() {},
    positionAtBody() {},
    createArms(key: string) {
      return { _key: key } as unknown as PlayerArmSprites;
    },
    destroyArms() {},
  };
  return { armRenderer: armRenderer as unknown as ArmRenderer, setVisibleCalls };
}

/** Fake driver: IDLE phase, sample() → null so the active path short-circuits. */
function makeFakeDriver() {
  return {
    phase: AnimPhase.IDLE,
    update() {},
    sample() {
      return null;
    },
  } as unknown as AnimSimDriver;
}

function makeFakeTrailRenderer() {
  return {
    stopTrail() {},
    removeTrail() {},
    captureFrame() {},
    setCameraCenter() {},
    render() {},
    startTrail() {},
  } as unknown as WeaponTrailRenderer;
}

function makeFakeGhostTailRenderer() {
  return {
    triggerDash() {},
    setSpeedBoost() {},
    capture() {},
    render() {},
    removeGhosts() {},
    destroy() {},
  } as unknown as GhostTailRenderer;
}

function makeFakeController() {
  return {
    update() {
      return { hitFlashActive: false, hitFlashExpired: false };
    },
    reset() {},
    triggerHitFlash() {},
  } as unknown as PlayerAnimationController;
}

/** Build a complete PlayerVisual (all fields the cull/active paths touch). */
function makeVisual(x: number, y: number): PlayerVisual {
  return {
    body: makeFakeSprite(x, y) as unknown as PlayerVisual['body'],
    leftHand: makeFakeSprite() as unknown as PlayerVisual['leftHand'],
    rightHand: makeFakeSprite() as unknown as PlayerVisual['rightHand'],
    weapon: makeFakeSprite() as unknown as PlayerVisual['weapon'],
    label: makeFakeSprite() as unknown as PlayerVisual['label'],
    targetX: x,
    targetY: y,
    prevBodyX: x,
    prevBodyY: y,
    smoothVelX: 0,
    smoothVelY: 0,
    facingAngle: 0,
    prevSpeed: 0,
    prevStatus: PlayerStatus.ALIVE,
    prevHealth: 100,
    baseScale: 1.0,
    lastMoveTime: 0,
    isMoving: false,
    freshSpawn: false,
    equippedWeaponType: -1,
    weaponHidden: true,
    lastTier: -1,
    bodyOffsetX: 0,
    bodyOffsetY: 0,
    bodyOffsetVelX: 0,
    bodyOffsetVelY: 0,
    bodyScaleX: 1.0,
    bodyScaleY: 1.0,
    bodyScaleVelX: 0,
    bodyScaleVelY: 0,
    hitStopRemaining: 0,
    prevAnimState: AnimationState.IDLE,
    trailCategory: null,
    victimImpactTime: 0,
    victimImpactDirX: 1,
    victimImpactDirY: 0,
    victimImpactHeft: 0,
    victimOffsetX: 0,
    victimOffsetY: 0,
    victimOffsetVelX: 0,
    victimOffsetVelY: 0,
    culled: false,
  };
}

/** Build the single-owner render bundle for one fake player. */
function makeBundle(key: string, x: number, y: number): PlayerRenderBundle {
  return {
    visual: makeVisual(x, y),
    controller: makeFakeController(),
    driver: makeFakeDriver(),
    arms: { _key: key } as unknown as PlayerArmSprites,
    armJoints: {} as ArmJoints,
    frameInput: {} as PlayerRenderBundle['frameInput'],
    trail: null,
    ghostTail: { lastCaptureAt: 0, dashUntil: 0, speedBoostActive: false },
  };
}

function makeCtx(opts: {
  bundles: Map<string, PlayerRenderBundle>;
  armRenderer: ArmRenderer;
  view: { minX: number; maxX: number; minY: number; maxY: number };
}): PlayerFrameContext {
  return {
    bundles: opts.bundles,
    armRenderer: opts.armRenderer,
    trailRenderer: makeFakeTrailRenderer(),
    ghostTailRenderer: makeFakeGhostTailRenderer(),
    worldBlocked: null,
    viewMinX: opts.view.minX,
    viewMinY: opts.view.minY,
    viewMaxX: opts.view.maxX,
    viewMaxY: opts.view.maxY,
  };
}

const PLAYER = 'remote-1';
const NOW = 1000;
const DT = 0.016;

describe('updateAllPlayerFrames — view cull hides IK arms', () => {
  it('hides arm segments when a remote player is outside the cull bounds', () => {
    const { armRenderer, setVisibleCalls } = makeFakeArmRenderer();
    const bundles = new Map<string, PlayerRenderBundle>([[PLAYER, makeBundle(PLAYER, 5000, 5000)]]);
    const ctx = makeCtx({
      bundles,
      armRenderer,
      // Player at (5000,5000) is well outside [0,1000]×[0,1000].
      view: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
    });

    updateAllPlayerFrames(ctx, 'local-player', DT, NOW);

    // Arms MUST be hidden alongside the body — they are scene-root sprites and
    // would otherwise linger at their last world position.
    expect(setVisibleCalls.filter((c) => c.key === PLAYER && c.visible === false).length).toBe(1);
    expect(bundles.get(PLAYER)!.visual.culled).toBe(true);
    expect((bundles.get(PLAYER)!.visual.body as unknown as { visible: boolean }).visible).toBe(
      false,
    );
  });

  it('re-asserts arm invisibility every off-screen frame (regression: one-shot guard)', () => {
    // This is the smoking-gun regression: a one-shot `if (!v.culled)` hide
    // would NOT re-hide after an event-driven writer (resetForRespawn) flipped
    // the arms back to visible, because `culled` was already true. The
    // per-frame re-assert overrides any such writer on the next frame.
    const { armRenderer, setVisibleCalls } = makeFakeArmRenderer();
    const bundles = new Map<string, PlayerRenderBundle>([[PLAYER, makeBundle(PLAYER, 5000, 5000)]]);
    const ctx = makeCtx({
      bundles,
      armRenderer,
      view: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
    });

    // Frame 1: player off-screen → hide.
    updateAllPlayerFrames(ctx, 'local-player', DT, NOW);
    expect(setVisibleCalls.at(-1)).toEqual({ key: PLAYER, visible: false });

    // Simulate resetForRespawn firing between frames: it unconditionally
    // re-shows arms without consulting `culled`.
    armRenderer.setVisible(bundles.get(PLAYER)!.arms, true);

    // Frame 2: still off-screen → the per-frame re-assert MUST hide again.
    updateAllPlayerFrames(ctx, 'local-player', DT, NOW);
    expect(setVisibleCalls.at(-1)).toEqual({ key: PLAYER, visible: false });
    // The re-show was overridden (not left lingering as a ghost).
    const hides = setVisibleCalls.filter((c) => c.key === PLAYER && c.visible === false);
    expect(hides.length).toBe(2);
  });

  it('never culls the local player, even when outside the cull bounds', () => {
    const { armRenderer, setVisibleCalls } = makeFakeArmRenderer();
    const bundles = new Map<string, PlayerRenderBundle>([[PLAYER, makeBundle(PLAYER, 5000, 5000)]]);
    const ctx = makeCtx({
      bundles,
      armRenderer,
      view: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
    });

    // PLAYER IS the local player — cull must be skipped (input owner).
    updateAllPlayerFrames(ctx, PLAYER, DT, NOW);

    expect(setVisibleCalls.filter((c) => c.key === PLAYER && c.visible === false)).toHaveLength(0);
    expect(bundles.get(PLAYER)!.visual.culled).toBe(false);
    expect((bundles.get(PLAYER)!.visual.body as unknown as { visible: boolean }).visible).toBe(
      true,
    );
  });

  it('re-shows arms when a culled player re-enters the view', () => {
    const { armRenderer, setVisibleCalls } = makeFakeArmRenderer();
    const bundles = new Map<string, PlayerRenderBundle>([[PLAYER, makeBundle(PLAYER, 500, 500)]]);
    let ctx = makeCtx({
      bundles,
      armRenderer,
      view: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
    });

    // Force the player into the culled state first (pretend they were off-screen).
    bundles.get(PLAYER)!.visual.culled = true;

    // Player is now at (500,500) — inside the view bounds → re-entry path.
    ctx = makeCtx({
      bundles,
      armRenderer,
      view: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
    });
    updateAllPlayerFrames(ctx, 'local-player', DT, NOW);

    // Re-entry block must restore arm visibility.
    expect(setVisibleCalls.some((c) => c.key === PLAYER && c.visible === true)).toBe(true);
    expect(bundles.get(PLAYER)!.visual.culled).toBe(false);
  });
});

/**
 * Regression test for ticket D1 — per-frame weapon visibility invariant.
 *
 * WHY THIS TEST EXISTS (and why it is NOT covered by PlayerRenderer.hide.test.ts):
 * The C1 test (`PlayerRenderer.hide.test.ts`) pins the `PlayerRenderer.updateWeapon`
 * seam: stale same-weapon patches must not re-arm the weapon after a throw/break
 * event. That test drives `updateWeapon` in ISOLATION. The D1 bug is NOT in
 * `updateWeapon` — it is in the PER-FRAME visibility block in
 * `PlayerRendererUpdate.updateAllPlayerFrames` (lines ~339-354). That block had
 * no `equippedWeaponType < 0 → setVisible(false)` branch, so ANY other writer
 * that called `setVisible(true)` (notably `resetForRespawn`, line 203) left the
 * dagger-textured sprite visible at body center for one RTT — exactly the
 * match-start / post-respawn scenario the user reported.
 *
 * THE BUG THIS PINS:
 *   Per-frame visibility must enforce "no real weapon ⇒ invisible" as a
 *   structural invariant. The decision tree (in priority order):
 *     1. THROWN strike/recover → hide
 *     2. equippedWeaponType < 0 → hide   (D1 — the missing branch)
 *     3. equippedWeaponType >= 0 && !weaponHidden → show
 *   Removing branch 2 leaves the weapon visible whenever any writer re-shows it
 *   while the slot is empty (respawn, stale patch). The load-bearing check
 *   (revert Change 1) confirms branches "empty/fists" and "respawn-with-empty"
 *   FAIL without it.
 *
 * HOW THIS DRIVES THE PER-FRAME BLOCK (not updateWeapon):
 * This test calls `updateAllPlayerFrames` directly — the real per-frame entry
 * point — with a full stub pipeline (driver.sample() returns a pose, controller,
 * armRenderer, trailRenderer are no-ops). The weapon sprite is a recording stub
 * whose `setVisible`/`visible` mirror Phaser. We pre-seed `equippedWeaponType` +
 * `weaponHidden` to set up each scenario, run ONE per-frame tick, and assert the
 * resulting `weapon.visible`. This is the exact code path that ships — the
 * visibility block runs inside `updateAllPlayerFrames` every frame.
 *
 * Reference: `.scratch/lighting-system-4/01-findings/D1-weapon-on-head.md`
 */
import { describe, it, expect } from 'vitest';
import { updateAllPlayerFrames } from '../PlayerRendererUpdate.js';
import { AnimationState } from '../../types.js';
import type { PlayerFrameContext } from '../PlayerRendererTypes.js';
import type { PlayerRenderBundle, PlayerVisual } from '../PlayerRendererTypes.js';
import { createArmJoints } from '../PlayerRendererUpdateHelpers.js';

/**
 * Recording weapon-sprite stub. `setVisible` mutates `visible` (mirroring how a
 * real Phaser `Sprite.setVisible(v)` updates the `.visible` flag the per-frame
 * pipeline and `getWeaponWorldState` read) so the test can assert visibility
 * transitions. `setAlpha` records the last alpha so we can assert the secondary
 * defense. Other mutators are no-ops; the per-frame pipeline doesn't read back
 * from them.
 */
function makeWeaponSpriteStub() {
  const sprite = {
    visible: true,
    alpha: 1,
    x: 0,
    y: 0,
    rotation: 0,
    setVisible(v: boolean) {
      sprite.visible = v;
      return sprite;
    },
    setAlpha(a: number) {
      sprite.alpha = a;
      return sprite;
    },
    setTexture: () => sprite,
    setScale: () => sprite,
    setOrigin: () => sprite,
    setFlipX: () => sprite,
    setTint: () => sprite,
    setRotation: () => sprite,
    setPosition: () => sprite,
    destroy: () => {},
  };
  return sprite;
}

/** Chainable no-op stub for body/hand/label sprites. */
function makeSpriteStub() {
  const sprite = {
    visible: true,
    alpha: 1,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    setAlpha: () => sprite,
    setVisible: () => sprite,
    setScale: () => sprite,
    setRotation: () => sprite,
    setPosition: () => sprite,
    setTint: () => sprite,
    clearTint: () => sprite,
    setOrigin: () => sprite,
    setDepth: () => sprite,
    destroy: () => {},
  };
  return sprite;
}

/**
 * Minimal `PlayerVisual` carrying chainable stub sprites for every field the
 * per-frame pipeline dereferences. Cast through `unknown` (test-only escape
 * hatch — same idiom as PlayerRenderer.hide.test.ts's `makeMinimalVisual`).
 */
function makeVisual(over: Partial<PlayerVisual> = {}): PlayerVisual {
  const base = {
    body: makeSpriteStub(),
    leftHand: makeSpriteStub(),
    rightHand: makeSpriteStub(),
    weapon: makeWeaponSpriteStub() as unknown as PlayerVisual['weapon'],
    label: { setPosition: () => {}, setAlpha: () => {}, setVisible: () => {}, destroy: () => {} },
    targetX: 0,
    targetY: 0,
    prevBodyX: 0,
    prevBodyY: 0,
    smoothVelX: 0,
    smoothVelY: 0,
    facingAngle: 0,
    prevSpeed: 0,
    prevStatus: 0,
    prevHealth: 100,
    baseScale: 1.0,
    lastMoveTime: 0,
    isMoving: false,
    freshSpawn: false,
    equippedWeaponType: -1,
    weaponHidden: true,
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
  };
  return { ...(base as unknown as PlayerVisual), ...over };
}

/**
 * Driver stub returning a fixed pose + idle anim state. The per-frame pipeline
 * reads `animState`, `atkType`, `phaseProgress`, `attackWeaponType`,
 * `deathProgress`, and calls `update()` + `sample()`. We pin IDLE + '' so the
 * THROWN hide branch never fires and the empty/real branches are exercised in
 * isolation. `attackWeaponType < 0` keeps the poseWeaponType fallback honest.
 */
function makeDriverStub(over: { animState?: AnimationState; atkType?: string } = {}) {
  const pose = {
    leftArm: {
      shoulder: { x: 0, y: 0 },
      elbow: { x: 0, y: 0 },
      hand: { x: 10, y: 0 },
      shoulderAngle: 0,
      elbowAngle: 0,
      reachable: true,
    },
    rightArm: {
      shoulder: { x: 0, y: 0 },
      elbow: { x: 0, y: 0 },
      hand: { x: 20, y: 0 },
      shoulderAngle: 0,
      elbowAngle: 0,
      reachable: true,
    },
    weaponX: 0,
    weaponY: 0,
    weaponRotation: 0,
    grip: { x: 0, y: 0 },
    tip: { x: 0, y: 0 },
    attackBlend: 0,
    bodyLean: 0,
    phaseProgress: 0,
    wallContact: false,
    wallContactX: 0,
    wallContactY: 0,
    wallPenetration: 0,
  };
  return {
    animState: over.animState ?? AnimationState.IDLE,
    atkType: over.atkType ?? '',
    phaseProgress: 0,
    attackWeaponType: -1,
    deathProgress: 0,
    update: () => {},
    sample: () => pose,
  };
}

/** Builds a `PlayerFrameContext` seeded with one player's render bundle. */
function makeContext(
  key: string,
  visual: PlayerVisual,
  driverOver: { animState?: AnimationState; atkType?: string } = {},
): PlayerFrameContext {
  const bundle: PlayerRenderBundle = {
    visual,
    controller: {
      update: () => ({ hitFlashActive: false, hitFlashExpired: false }),
    } as unknown as PlayerRenderBundle['controller'],
    driver: makeDriverStub(driverOver) as unknown as PlayerRenderBundle['driver'],
    arms: {} as PlayerRenderBundle['arms'],
    armJoints: createArmJoints(),
    frameInput: {} as PlayerRenderBundle['frameInput'],
    trail: null,
    ghostTail: { lastCaptureAt: 0, dashUntil: 0, speedBoostActive: false },
  };
  const ctx = {
    bundles: new Map([[key, bundle]]),
    worldBlocked: null,
    // View cull bounds (B4 perf C1). Default to infinity so the player at
    // (0,0) is always processed — these tests target the weapon-visibility
    // invariant, NOT culling. Cull behaviour is covered by the dedicated
    // visibility-cull test.
    viewMinX: -Infinity,
    viewMinY: -Infinity,
    viewMaxX: Infinity,
    viewMaxY: Infinity,
    armRenderer: {
      updateArms: () => {},
      setAlpha: () => {},
      setVisible: () => {},
      positionAtBody: () => {},
    },
    trailRenderer: {
      captureFrame: () => {},
      stopTrail: () => {},
    },
    ghostTailRenderer: { capture: () => {} },
  };
  return ctx as unknown as PlayerFrameContext;
}

/** Runs one per-frame tick and returns the resulting weapon visibility. */
function runFrame(
  ctx: PlayerFrameContext,
  key: string,
  visual: PlayerVisual,
): { visible: boolean; alpha: number } {
  updateAllPlayerFrames(ctx, null, 1 / 60, 1000);
  const w = visual.weapon as unknown as { visible: boolean; alpha: number };
  return { visible: w.visible, alpha: w.alpha };
}

const DAGGER = 1; // a real weaponType (WeaponType.DAGGER)

describe('ticket D1 — per-frame weapon visibility invariant (regression of C1)', () => {
  it('empty/fists: equippedWeaponType < 0 ⇒ weapon hidden after a per-frame tick', () => {
    // Match-start scenario: player spawns with FISTS, no real weapon. Even if
    // some earlier writer left `visible = true`, the per-frame empty-hide
    // branch must force it to false. THIS IS THE MISSING BRANCH (Change 1).
    const key = 'p1';
    const visual = makeVisual({ equippedWeaponType: -1, weaponHidden: true });
    // Simulate a stale/buggy writer leaving the sprite visible coming into the
    // frame — the bug condition is precisely "visible despite empty slot".
    (visual.weapon as unknown as { visible: boolean }).visible = true;
    const ctx = makeContext(key, visual);

    const after = runFrame(ctx, key, visual);
    expect(after.visible).toBe(false);
  });

  it('equipped: equippedWeaponType >= 0 && !weaponHidden ⇒ weapon visible', () => {
    // Sanity: a real weapon that is NOT event-hidden must stay visible. The
    // empty-hide branch must NOT suppress the genuine-weapon path.
    const key = 'p1';
    const visual = makeVisual({ equippedWeaponType: DAGGER, weaponHidden: false });
    const ctx = makeContext(key, visual);

    const after = runFrame(ctx, key, visual);
    expect(after.visible).toBe(true);
  });

  it('throw: THROWN strike/recover ⇒ weapon hidden even if equippedWeaponType is still positive', () => {
    // Post-throw scenario: the throw event fires (weaponHidden armed,
    // equippedWeaponType not yet cleared to -1 by the patch). During the throw
    // STRIKE/RECOVER window the held weapon must hide (the projectile is the
    // visible weapon). This is the existing THROWN branch — must still win.
    const key = 'p1';
    const visual = makeVisual({ equippedWeaponType: DAGGER, weaponHidden: true });
    const ctx = makeContext(key, visual, {
      animState: AnimationState.ATTACK_IMPACT,
      atkType: 'thrown',
    });

    const after = runFrame(ctx, key, visual);
    expect(after.visible).toBe(false);
  });

  it('respawn-with-empty: a writer re-shows the weapon, but slot is empty ⇒ per-frame hides it', () => {
    // Post-respawn scenario: `resetForRespawn` (pre-D1) did
    // `v.weapon.setVisible(true)` + `weaponHidden = false` without checking
    // inventory, then the slot-clear patch carrying FISTS arrived ~1 RTT
    // later. During that window equippedWeaponType was reset to -1 but the
    // sprite was visibly true. The per-frame empty-hide must mask the bug.
    // (Post-D1, resetForRespawn itself no longer re-shows; this test pins the
    // per-frame invariant as the structural guarantee either way.)
    const key = 'p1';
    const visual = makeVisual({ equippedWeaponType: -1, weaponHidden: false });
    // Simulate the buggy respawn writer forcing visible + flag clear.
    (visual.weapon as unknown as { visible: boolean }).visible = true;
    const ctx = makeContext(key, visual);

    const after = runFrame(ctx, key, visual);
    expect(after.visible).toBe(false);
  });

  it('respawn-with-weapon: a real weapon is equipped post-respawn ⇒ weapon visible', () => {
    // The post-respawn inventory patch arrives carrying a real weapon. The
    // per-frame real-weapon branch re-arms visibility. respawn-with-weapon
    // must NOT be broken by the empty-hide branch.
    const key = 'p1';
    const visual = makeVisual({ equippedWeaponType: DAGGER, weaponHidden: false });
    const ctx = makeContext(key, visual);

    const after = runFrame(ctx, key, visual);
    expect(after.visible).toBe(true);
  });
});

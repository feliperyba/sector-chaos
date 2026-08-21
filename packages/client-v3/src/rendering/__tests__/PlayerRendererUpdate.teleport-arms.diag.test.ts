/**
 * Diagnostic probe — IK arms frozen at the teleport-trap location.
 *
 * WHY THIS PROBE EXISTS:
 * The user reports that when a player steps on a teleport trap, ~90% of the
 * time their IK arms stay rendered at the trap's old position after the player
 * has gone. Git archaeology traces the regression to the "culling performance
 * patch" (1dbd3aa) which, for off-screen players, replaced the full per-frame
 * arm update with a bare `continue` — freezing arm sprites (independent
 * scene-root objects, NOT children of the body) at their last on-screen pose.
 * Later commits added a per-frame hide (dfc7cb1 → 43d53fb) that re-asserts
 * `setVisible(false)` for culled players, which *should* make "not updated"
 * invisible. This probe verifies whether the current code actually prevents
 * arms from being VISIBLE while POSITIONED FAR FROM THEIR BODY across a
 * teleport — the symptom the user sees.
 *
 * Unlike `PlayerRendererUpdate.arms-linger.diag.test.ts`, this probe:
 *   • drives the REAL `EntityInterpolator` (so the remote body glides exactly
 *     as in production — no stubbed glide), and
 *   • RECORDS ARM WORLD POSITIONS each frame (the sibling probe only tracks
 *     visible/alpha, so it cannot detect "arms stuck at coordinate A").
 *
 * The feedback signal: max(arm-centroid ↔ body) distance over all frames where
 * the arms are visible. A clean teleport keeps that distance small (arms track
 * the gliding body, then get hidden once off-screen). A lingering-arm bug
 * leaves the distance large (arms visible at the trap while the body is
 * elsewhere).
 */
import { describe, it, expect } from 'vitest';
import { updateAllPlayerFrames } from '../PlayerRendererUpdate.js';
import { AnimationState } from '../../types.js';
import type {
  PlayerFrameContext,
  PlayerRenderBundle,
  PlayerVisual,
} from '../PlayerRendererTypes.js';
import type { ArmJoints, PlayerArmSprites } from '../ArmRenderer.js';
import { createArmJoints } from '../PlayerRendererUpdateHelpers.js';
import { EntityInterpolator } from '../../prediction/EntityInterpolator.js';
import { AnimSimDriver } from '../../animation/AnimSimDriver.js';

/** Sprite stub recording x/y/visible/alpha/scale/rotation for position asserts. */
function makeSpriteStub() {
  const s = {
    visible: true,
    alpha: 1,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    setAlpha(a: number) {
      s.alpha = a;
      return s;
    },
    setVisible(v: boolean) {
      s.visible = v;
      return s;
    },
    setScale: () => s,
    setRotation: () => s,
    setPosition: () => s,
    setTint: () => s,
    clearTint: () => s,
    setOrigin: () => s,
    setDepth: () => s,
    destroy: () => {},
  };
  return s;
}

function makeVisual(over: Partial<PlayerVisual> = {}): PlayerVisual {
  const base = {
    body: makeSpriteStub(),
    leftHand: makeSpriteStub(),
    rightHand: makeSpriteStub(),
    weapon: makeSpriteStub(),
    label: {
      setPosition: () => {},
      setAlpha: () => {},
      setVisible: () => {},
      destroy: () => {},
    },
    targetX: 0,
    targetY: 0,
    prevBodyX: 0,
    prevBodyY: 0,
    smoothVelX: 0,
    smoothVelY: 0,
    facingAngle: 0,
    prevSpeed: 0,
    prevStatus: 0,
    prevHealth: 0,
    baseScale: 1,
    lastMoveTime: 0,
    isMoving: false,
    freshSpawn: false,
    equippedWeaponType: -1,
    weaponHidden: true,
    bodyOffsetX: 0,
    bodyOffsetY: 0,
    bodyOffsetVelX: 0,
    bodyOffsetVelY: 0,
    bodyScaleX: 1,
    bodyScaleY: 1,
    bodyScaleVelX: 0,
    bodyScaleVelY: 0,
    hitStopRemaining: 0,
    prevAnimState: AnimationState.IDLE,
    trailCategory: null,
    victimImpactTime: 0,
    victimImpactDirX: 0,
    victimImpactDirY: 0,
    victimImpactHeft: 0,
    victimOffsetX: 0,
    victimOffsetY: 0,
    victimOffsetVelX: 0,
    victimOffsetVelY: 0,
    culled: false,
  };
  return { ...(base as unknown as PlayerVisual), ...over };
}

// NOTE: we use the REAL AnimSimDriver (not a pose stub) so the sampled pose is
// body-centered on the driver's bodyX/bodyY input — exactly as in production.
// A fixed stub pose anchored at the origin would falsely leave arms "at 0,0"
// while the body glides, masking or faking the symptom under test.

interface ArmRecord {
  visible: boolean;
  alpha: number;
  /** Centroid of the 6 joints (where the arms are drawn). */
  cx: number;
  cy: number;
}

/**
 * armRenderer stub that RECORDS the joint positions fed to `updateArms` so we
 * can assert "arms at coordinate A while body at coordinate B". Methods take
 * the bundle's arms object; each fake arms carries a `_key` marker for the
 * per-key recording (the real ArmRenderer is key-less).
 */
function makeArmRendererStub() {
  const perKey = new Map<
    string,
    { visible: boolean; alpha: number; joints: { x: number; y: number }[] }
  >();
  const ensure = (arms: PlayerArmSprites & { _key?: string }) => {
    const key = arms._key ?? '?';
    let s = perKey.get(key);
    if (!s) {
      s = { visible: true, alpha: 1, joints: [] };
      perKey.set(key, s);
    }
    return s;
  };
  return {
    updateArms(arms: PlayerArmSprites & { _key?: string }, joints: ArmJoints) {
      const s = ensure(arms);
      s.joints = [
        joints.leftShoulder,
        joints.leftElbow,
        joints.leftHand,
        joints.rightShoulder,
        joints.rightElbow,
        joints.rightHand,
      ].map((p) => ({ x: p.x, y: p.y }));
    },
    setVisible(arms: PlayerArmSprites & { _key?: string }, v: boolean) {
      ensure(arms).visible = v;
    },
    setAlpha(arms: PlayerArmSprites & { _key?: string }, a: number) {
      ensure(arms).alpha = a;
    },
    setTint: () => {},
    // Cull-path pin: collapse all 6 joints to (x,y) so record()'s centroid
    // reads the pinned body coord — lets a regression test assert a CULLED
    // player's arms sit on the body, not frozen at the teleport source.
    positionAtBody(arms: PlayerArmSprites & { _key?: string }, x: number, y: number) {
      const s = ensure(arms);
      s.joints = Array.from({ length: 6 }, () => ({ x, y }));
    },
    record(key: string): ArmRecord | null {
      const s = perKey.get(key);
      if (!s || s.joints.length === 0) return null;
      const cx = s.joints.reduce((a, p) => a + p.x, 0) / s.joints.length;
      const cy = s.joints.reduce((a, p) => a + p.y, 0) / s.joints.length;
      return { visible: s.visible, alpha: s.alpha, cx, cy };
    },
  };
}

interface FrameSample {
  bodyX: number;
  bodyY: number;
  bodyVisible: boolean;
  arm: ArmRecord | null;
  culled: boolean;
}

/**
 * Drive one remote player through a teleport with the REAL EntityInterpolator
 * + REAL updateAllPlayerFrames. `localPlayerId` is null so the player is
 * treated as remote (subject to the viewport cull).
 */
function runTeleport(opts: {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  vx: number;
  vy: number;
  viewMinX: number;
  viewMinY: number;
  viewMaxX: number;
  viewMaxY: number;
  /** ticks at A before the teleport patch fires */
  settleTicks: number;
  /** ticks after the teleport patch */
  postTicks: number;
  /** render-frame dt in seconds (default 1/60). At >60Hz the anim sim does
   * NOT step every frame — this is what triggers the stale-pose arm desync. */
  dtSec?: number;
}): { samples: FrameSample[]; visual: PlayerVisual } {
  const interpolator = new EntityInterpolator();
  const armStub = makeArmRendererStub();
  const visual = makeVisual({ targetX: opts.ax, targetY: opts.ay });
  visual.body.x = opts.ax;
  visual.body.y = opts.ay;
  visual.prevBodyX = opts.ax;
  visual.prevBodyY = opts.ay;
  const driver = new AnimSimDriver(0);
  const bundle: PlayerRenderBundle = {
    visual,
    controller: {
      update: () => ({ hitFlashActive: false, hitFlashExpired: false }),
    } as unknown as PlayerRenderBundle['controller'],
    driver,
    arms: { _key: 'bot' } as unknown as PlayerArmSprites,
    armJoints: createArmJoints(),
    frameInput: {} as PlayerRenderBundle['frameInput'],
    trail: null,
    ghostTail: { lastCaptureAt: 0, dashUntil: 0, speedBoostActive: false },
  };
  const ctx = {
    bundles: new Map<string, PlayerRenderBundle>([['bot', bundle]]),
    worldBlocked: null,
    viewMinX: opts.viewMinX,
    viewMinY: opts.viewMinY,
    viewMaxX: opts.viewMaxX,
    viewMaxY: opts.viewMaxY,
    armRenderer: armStub,
    trailRenderer: { captureFrame: () => {}, stopTrail: () => {} },
    ghostTailRenderer: { capture: () => {} },
  } as unknown as PlayerFrameContext;

  const out = { x: 0, y: 0 };
  const samples: FrameSample[] = [];
  const dt = opts.dtSec ?? 1 / 60;
  const frameMs = dt * 1000;
  let nowMs = performance.now();

  const step = () => {
    // InterpolationService.update() remote path: sample → updatePosition.
    if (interpolator.getInterpolatedPosition('bot', out, nowMs)) {
      visual.targetX = out.x;
      visual.targetY = out.y;
    }
    updateAllPlayerFrames(ctx, null, dt, nowMs);
    samples.push({
      bodyX: visual.body.x,
      bodyY: visual.body.y,
      bodyVisible: (visual.body as unknown as { visible: boolean }).visible,
      arm: armStub.record('bot'),
      culled: visual.culled,
    });
    nowMs += frameMs;
  };

  // Initial patch at A; settle so the body + arms are established at the trap.
  interpolator.push('bot', opts.ax, opts.ay, opts.vx, opts.vy);
  for (let i = 0; i < opts.settleTicks; i++) step();

  // Teleport patch: server moved the player to B (normal authoritative path).
  interpolator.push('bot', opts.bx, opts.by, opts.vx, opts.vy);
  for (let i = 0; i < opts.postTicks; i++) step();

  return { samples, visual };
}

describe('teleport arms — IK arms must not stay visible at the trap', () => {
  it('OFF-SCREEN destination (the ~90% case): arms are never visible far from the body', () => {
    // Trap at (0,0) inside the view; destination far off-screen.
    const { samples } = runTeleport({
      ax: 0,
      ay: 0,
      bx: 5000,
      by: 5000,
      vx: 0,
      vy: 0,
      viewMinX: -500,
      viewMinY: -500,
      viewMaxX: 500,
      viewMaxY: 500,
      settleTicks: 5,
      postTicks: 30,
    });

    // The symptom: arms VISIBLE while POSITIONED FAR from the body.
    let worstVisibleDrift = 0;
    let worstVisibleDriftFrame = -1;
    let armsEverVisibleAfterLeaving = false;
    const leftTrapAt = samples.findIndex((s) => Math.hypot(s.bodyX, s.bodyY) > 600);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      if (!s.arm || !s.arm.visible) continue;
      const drift = Math.hypot(s.arm.cx - s.bodyX, s.arm.cy - s.bodyY);
      if (drift > worstVisibleDrift) {
        worstVisibleDrift = drift;
        worstVisibleDriftFrame = i;
      }
      // Arms visible at the trap AFTER the body has already left it = the bug.
      if (leftTrapAt >= 0 && i > leftTrapAt) {
        const armStillAtTrap = Math.hypot(s.arm.cx, s.arm.cy) < 200;
        if (armStillAtTrap) armsEverVisibleAfterLeaving = true;
      }
    }

    // Diagnostic: log the worst frame so a failure pinpoints the leak.
    if (worstVisibleDrift > 150) {
      // eslint-disable-next-line no-console
      console.log('ARMS DRIFT SAMPLES', samples);
    }

    expect(
      worstVisibleDrift,
      `arms visible ${worstVisibleDrift.toFixed(0)}px from body at frame ${worstVisibleDriftFrame}`,
    ).toBeLessThan(150);
    expect(armsEverVisibleAfterLeaving, 'arms stayed visible at the trap after the body left').toBe(
      false,
    );
  });

  it('ON-SCREEN destination: arms follow the gliding body to B', () => {
    const { samples } = runTeleport({
      ax: 0,
      ay: 0,
      bx: 200,
      by: 0,
      vx: 0,
      vy: 0,
      viewMinX: -500,
      viewMinY: -500,
      viewMaxX: 500,
      viewMaxY: 500,
      settleTicks: 5,
      postTicks: 30,
    });

    const last = samples[samples.length - 1]!;
    // Body reaches near B.
    expect(last.bodyX).toBeGreaterThan(180);
    // Arms end up near the body (followed the glide), not stuck at A.
    expect(last.arm).not.toBeNull();
    const drift = last.arm ? Math.hypot(last.arm.cx - last.bodyX, last.arm.cy - last.bodyY) : 999;
    expect(drift, 'arms tracked the body to the on-screen destination').toBeLessThan(150);
  });

  it('144Hz ON-SCREEN teleport glide: arms track the body (stale-pose re-anchor fix)', () => {
    // THE ROOT-CAUSE REGRESSION: the anim sim steps on a fixed 1/60 accumulator.
    // At 144Hz it does NOT step every render frame (~2 of every 3 frames skip),
    // so between steps the sampled pose stays centred on the body position from
    // the LAST step. During the fast interpolation glide that follows a
    // teleport-trap jump (100s of px/frame), that lag is large and the shoulder
    // joints — which used the raw (stale) pose position — trailed hundreds of
    // px behind the live body, lingering near the teleport source. The fix
    // re-anchors the pose to the live body each frame (shiftX/Y in
    // PlayerRendererUpdate). This test drives the REAL AnimSimDriver at 144Hz
    // through an on-screen teleport glide and asserts the arms stay close to the
    // body. WITHOUT the re-anchor fix the worst-frame drift exceeds 300px.
    const { samples } = runTeleport({
      ax: -400,
      ay: 0,
      bx: 400,
      by: 0,
      vx: 0,
      vy: 0,
      viewMinX: -500,
      viewMinY: -500,
      viewMaxX: 500,
      viewMaxY: 500,
      settleTicks: 10,
      postTicks: 80,
      dtSec: 1 / 144,
    });

    // Every frame the arms are visible, they must be close to the live body —
    // NOT trailing behind at the teleport source.
    let worstDrift = 0;
    let worstFrame = -1;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      if (!s.arm || !s.arm.visible) continue;
      const drift = Math.hypot(s.arm.cx - s.bodyX, s.arm.cy - s.bodyY);
      if (drift > worstDrift) {
        worstDrift = drift;
        worstFrame = i;
      }
    }
    // Threshold accounts for the normal arm-reach centroid offset (hands are
    // pushed outward from the body by HAND_DISTANCE_SCALE, so the 6-joint
    // centroid sits ~50-70px from the body centre even with a perfect pose).
    // WITHOUT the re-anchor fix the worst-frame drift exceeds 250px (the stale
    // pose trails the gliding body). 120px is comfortably above normal reach,
    // well below the bug.
    expect(
      worstDrift,
      `at 144Hz, arms drifted ${worstDrift.toFixed(0)}px from the body at frame ${worstFrame} (stale-pose re-anchor failed)`,
    ).toBeLessThan(120);
  });

  it('OFF-SCREEN teleport: culled arms are PINNED to the gliding body (never frozen at the trap)', () => {
    // THE CULL-PIN REGRESSION. The IK arm segments are independent scene-root
    // sprites, NOT children of the body. The original culling perf patch
    // (1dbd3aa) replaced the off-screen arm update with a bare `continue`,
    // freezing those sprites at their last on-screen pose — i.e. the teleport
    // trap the player just left. A later per-frame hide makes frozen geometry
    // invisible, but if any frame drops the hide (a re-show race, a stale
    // build, a one-shot writer) the arms flash back at the trap. The fix pins
    // the arms to the LIVE body every culled frame (positionAtBody) so, hidden
    // or not, they can never linger at a stale coordinate.
    //
    // This asserts the pin directly: across the WHOLE off-screen glide the arm
    // centroid stays within reach of the body. WITHOUT the pin, the centroid
    // freezes at the trap (0,0) while the body glides to (5000,5000) → drift
    // ~7000px. WITH the pin, culled frames collapse the centroid onto the body
    // → drift ~0, and the worst frame is an in-view active frame (~normal reach).
    const { samples } = runTeleport({
      ax: 0,
      ay: 0,
      bx: 5000,
      by: 5000,
      vx: 0,
      vy: 0,
      viewMinX: -500,
      viewMinY: -500,
      viewMaxX: 500,
      viewMaxY: 500,
      settleTicks: 5,
      postTicks: 30,
    });

    let worstPinDrift = 0;
    let worstFrame = -1;
    let leftTrapAt = -1;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      if (Math.hypot(s.bodyX, s.bodyY) > 600 && leftTrapAt < 0) leftTrapAt = i;
      if (!s.arm) continue;
      // Arm centroid vs body — must stay close EVEN while culled/hidden.
      const drift = Math.hypot(s.arm.cx - s.bodyX, s.arm.cy - s.bodyY);
      if (drift > worstPinDrift) {
        worstPinDrift = drift;
        worstFrame = i;
      }
    }

    expect(leftTrapAt, 'body did leave the trap').toBeGreaterThanOrEqual(0);
    expect(
      worstPinDrift,
      `culled arms drifted ${worstPinDrift.toFixed(0)}px from the body at frame ${worstFrame} (pin-to-body failed — arms frozen at the trap)`,
    ).toBeLessThan(120);
  });
});

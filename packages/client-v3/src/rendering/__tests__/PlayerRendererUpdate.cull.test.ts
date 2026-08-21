/**
 * Regression test for B4 perf C1 — per-player view culling.
 *
 * WHY THIS TEST EXISTS:
 * Before C1, `updateAllPlayerFrames` ran the full per-player work (anim sim
 * substeps, spring integration, ~10 sprite mutators, 4-arm IK) for EVERY
 * player every frame — including off-screen ones and dead corpses. In a
 * zoomed-in top-down camera with 64 players, ~80% are off-screen at any
 * instant, all burning CPU for nothing. This was the root cause of the
 * "heavy/sluggish" feel that lifted as bots died (fewer players = less work).
 *
 * C1 adds a viewport-rect cull: off-screen REMOTE players skip the heavy work
 * but still get their body position updated (so they don't teleport on
 * re-entry). The LOCAL player and players mid-death-fade are always processed
 * (local = input owner; death-fade must complete so the corpse despawns).
 *
 * WHAT THIS PINS:
 *   1. An off-screen remote player's body position IS updated (targetX/Y → body).
 *   2. An off-screen remote player's anim sim IS stepped (driver.update called
 *      once per frame — keeps the sim warm so re-entry doesn't produce a pose
 *      discontinuity / ghost arms). The EXPENSIVE render work (springs, arm IK,
 *      sprite mutations) is still skipped — verified by asserting sprites stay
 *      hidden and armRenderer.updateArms is NOT called.
 *   3. The local player is always fully processed regardless of view bounds.
 *   4. A player in DYING phase is always fully processed (death-fade continuity).
 *   5. An off-screen player that re-enters the view bounds resumes full processing.
 */
import { describe, it, expect } from 'vitest';
import { AnimPhase } from '@sector-battle/shared';
import { updateAllPlayerFrames } from '../PlayerRendererUpdate.js';
import { AnimationState } from '../../types.js';
import type {
  PlayerFrameContext,
  PlayerRenderBundle,
  PlayerVisual,
} from '../PlayerRendererTypes.js';
import type { ArmJoints, PlayerArmSprites } from '../ArmRenderer.js';
import { createArmJoints } from '../PlayerRendererUpdateHelpers.js';

/** Chainable no-op stub for body/hand/label sprites. setVisible mutates visible. */
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
    setVisible(v: boolean) {
      sprite.visible = v;
      return sprite;
    },
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
    setAlpha: () => sprite,
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

/**
 * Driver stub that COUNTS update() calls — the load-bearing assertion for the
 * cull: an off-screen player must not step its anim sim. `phase` drives the
 * death-fade exception (AnimPhase.DYING always processed).
 */
function makeCountingDriverStub(opts: { phase?: number; animState?: AnimationState } = {}) {
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
  let updateCalls = 0;
  return {
    phase: opts.phase ?? AnimPhase.IDLE, // on-screen by default
    animState: opts.animState ?? AnimationState.IDLE,
    atkType: '',
    phaseProgress: 0,
    attackWeaponType: -1,
    deathProgress: 0,
    update: () => {
      updateCalls++;
    },
    sample: () => pose,
    _updateCalls: () => updateCalls,
  };
}

function makeContext(
  entries: {
    key: string;
    visual: PlayerVisual;
    driver: ReturnType<typeof makeCountingDriverStub>;
  }[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  localPlayerId: string | null = null,
): {
  ctx: PlayerFrameContext;
  armVisible: Map<string, boolean>;
  armUpdateCalls: Map<string, number>;
} {
  const bundles = new Map<string, PlayerRenderBundle>();
  for (const e of entries) {
    bundles.set(e.key, {
      visual: e.visual,
      controller: {
        update: () => ({ hitFlashActive: false, hitFlashExpired: false }),
      } as unknown as PlayerRenderBundle['controller'],
      driver: e.driver as unknown as PlayerRenderBundle['driver'],
      arms: { _key: e.key } as unknown as PlayerArmSprites,
      armJoints: createArmJoints() as ArmJoints,
      frameInput: {} as PlayerRenderBundle['frameInput'],
      trail: null,
      ghostTail: { lastCaptureAt: 0, dashUntil: 0, speedBoostActive: false },
    });
  }
  // Track arm visibility + updateArms calls per-key so we can assert the
  // ghost-arms fix: culled players hide arms and do NOT run updateArms (the
  // expensive IK), but DO step the anim sim (driver.update) to keep the
  // pose warm for re-entry. The fake arms object carries a `_key` marker so
  // the key-less ArmRenderer stub can record per player.
  const armVisible = new Map<string, boolean>();
  const armUpdateCalls = new Map<string, number>();
  for (const e of entries) {
    armVisible.set(e.key, true);
    armUpdateCalls.set(e.key, 0);
  }
  const ctx = {
    bundles,
    worldBlocked: null,
    viewMinX: bounds.minX,
    viewMinY: bounds.minY,
    viewMaxX: bounds.maxX,
    viewMaxY: bounds.maxY,
    armRenderer: {
      updateArms: (arms: PlayerArmSprites & { _key?: string }) => {
        const key = arms._key ?? '?';
        armUpdateCalls.set(key, (armUpdateCalls.get(key) ?? 0) + 1);
      },
      setAlpha: () => {},
      setVisible: (arms: PlayerArmSprites & { _key?: string }, vis: boolean) => {
        armVisible.set(arms._key ?? '?', vis);
      },
      positionAtBody: () => {},
    },
    trailRenderer: {
      captureFrame: () => {},
      stopTrail: () => {},
    },
    ghostTailRenderer: { capture: () => {} },
  };
  // localPlayerId is passed as a function arg, not stored on ctx — but we need
  // it here only so callers can build entries; the actual arg goes to the call.
  void localPlayerId;
  return { ctx: ctx as unknown as PlayerFrameContext, armVisible, armUpdateCalls };
}

describe('B4 perf C1 — per-player view culling', () => {
  it('off-screen remote player: body + sim stepped, render work skipped, sprites hidden', () => {
    // Player is far outside the view bounds. The body position must still
    // track targetX/Y (so it doesn't teleport on re-entry), and the anim sim
    // IS stepped (keeps the pose warm — the ghost-arms fix), but the EXPENSIVE
    // render work (springs, arm IK, sprite mutations) is skipped AND all
    // sprites are hidden so nothing lingers at the viewport edge.
    const visual = makeVisual({ targetX: 5000, targetY: 5000 });
    const driver = makeCountingDriverStub();
    const { ctx, armVisible, armUpdateCalls } = makeContext([{ key: 'remote1', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });

    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);

    // Body position updated (cheap path runs for everyone).
    expect(visual.body.x).toBe(5000);
    expect(visual.body.y).toBe(5000);
    // Anim sim IS stepped (1 call) — keeps the pose warm for re-entry. This is
    // the ghost-arms fix: without it the driver freezes and re-entry produces a
    // pose discontinuity that reads as arms snapping from their frozen position.
    expect(driver._updateCalls()).toBe(1);
    // Expensive render work is still skipped — arm IK (updateArms) NOT called.
    expect(armUpdateCalls.get('remote1')).toBe(0);
    // Ghost-arms fix: all sprites hidden on the cull transition.
    expect(visual.body.visible).toBe(false);
    expect(visual.leftHand.visible).toBe(false);
    expect(visual.rightHand.visible).toBe(false);
    expect(visual.weapon.visible).toBe(false);
    expect(armVisible.get('remote1')).toBe(false);
    // Culled flag set — drives the one-shot re-show on re-entry (see re-entry test).
    expect(visual.culled).toBe(true);
  });

  it('on-screen remote player: full processing (anim sim stepped), sprites visible', () => {
    const visual = makeVisual({ targetX: 100, targetY: 100 });
    const driver = makeCountingDriverStub();
    const { ctx, armVisible } = makeContext([{ key: 'remote1', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });

    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);

    expect(visual.body.x).toBe(100);
    expect(visual.body.y).toBe(100);
    expect(driver._updateCalls()).toBe(1);
    // Never culled → sprites stay visible.
    expect(visual.culled).toBe(false);
    expect(armVisible.get('remote1')).toBe(true);
  });

  it('local player: always fully processed even when off-screen', () => {
    // The local player is the input owner — prediction drives its anim, so it
    // must always run the full update regardless of view bounds.
    const visual = makeVisual({ targetX: 9999, targetY: 9999 });
    const driver = makeCountingDriverStub();
    const { ctx } = makeContext([{ key: 'me', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });

    updateAllPlayerFrames(ctx, 'me', 1 / 60, 1000);

    expect(visual.body.x).toBe(9999);
    expect(driver._updateCalls()).toBe(1);
    // Local player is never culled.
    expect(visual.culled).toBe(false);
  });

  it('DYING player off-screen: culled (sprites + arms hidden) but sim still advances (ghost-arms fix)', () => {
    // AnimPhase.DYING. Previously DYING was exempt from the cull (isDying ||
    // inView), which kept the active path running for off-screen corpses —
    // re-positioning their arms at the stale spot every frame. That was the
    // root cause of the "IK arms stay at the teleport trap" regression: a
    // dying player whose body moved off-screen (e.g. teleported) still had
    // their arms rendered at the old position. The user's invariant: "IF the
    // player is OUT of the culling we should not be rendering their arms at
    // all."
    //
    // Now DYING is culled like any off-screen player: all sprites + arms are
    // hidden, the expensive IK (updateArms) is skipped, BUT the anim sim is
    // still stepped (driver.update) so deathProgress keeps advancing — the
    // fade state stays correct for re-entry and there's nothing off-screen to
    // fade visually anyway.
    const visual = makeVisual({ targetX: 5000, targetY: 5000 });
    const driver = makeCountingDriverStub({
      phase: AnimPhase.DYING,
      animState: AnimationState.DYING,
    });
    const { ctx, armVisible, armUpdateCalls } = makeContext([{ key: 'dying1', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });

    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);

    expect(visual.body.x).toBe(5000);
    // Sim still steps in the cull path (deathProgress advances off-screen).
    expect(driver._updateCalls()).toBe(1);
    // DYING IS culled when off-screen now — no arms rendered outside the view.
    expect(visual.culled).toBe(true);
    expect(armVisible.get('dying1')).toBe(false);
    // The expensive arm IK is skipped (the whole point of the cull).
    expect(armUpdateCalls.get('dying1')).toBe(0);
  });

  it('re-entry: culled sprites are re-shown when the player re-enters view', () => {
    // The ghost-arms regression: on cull, sprites hide; on re-entry, they must
    // come back. This pins the full visible→hidden→visible round trip.
    const visual = makeVisual({ targetX: 5000, targetY: 0 });
    const driver = makeCountingDriverStub();
    const { ctx, armVisible } = makeContext([{ key: 'remote1', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });

    // Tick 1: off-screen → culled + hidden. Sim IS stepped (ghost-arms fix).
    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);
    expect(driver._updateCalls()).toBe(1);
    expect(visual.culled).toBe(true);
    expect(visual.body.visible).toBe(false);
    expect(armVisible.get('remote1')).toBe(false);

    // Player moves into view.
    visual.targetX = 0;
    visual.body.x = 5000; // body was at the old position
    visual.prevBodyX = 5000;

    // Tick 2: now in view → full processing resumes + sprites re-shown.
    updateAllPlayerFrames(ctx, null, 1 / 60, 1016);
    expect(driver._updateCalls()).toBe(2); // 1 cull + 1 re-entry
    expect(visual.body.x).toBe(0);
    expect(visual.culled).toBe(false);
    expect(visual.body.visible).toBe(true);
    expect(visual.leftHand.visible).toBe(true);
    expect(visual.rightHand.visible).toBe(true);
    expect(armVisible.get('remote1')).toBe(true);
  });

  it('cull is authoritative: re-asserts hidden state every off-screen frame, but skips expensive arm IK', () => {
    // The cull hide is AUTHORITATIVE per-frame — re-asserted every off-screen
    // tick so no event-driven writer (resetForRespawn / updateWeapon) can leave
    // a sprite visible on a culled player (the ghost-arms symptom). Two
    // off-screen ticks → TWO hide calls. The expensive arm IK (updateArms) is
    // still NEVER called for culled players — that is the O(N) → O(visible)
    // perf win the cull delivers; only the cheap visibility flag is re-set.
    const visual = makeVisual({ targetX: 5000, targetY: 0 });
    const driver = makeCountingDriverStub();
    let armHideCalls = 0;
    const { ctx, armUpdateCalls } = makeContext([{ key: 'remote1', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });
    // Wrap setVisible to count hide calls.
    const origSetVisible = ctx.armRenderer.setVisible.bind(ctx.armRenderer);
    ctx.armRenderer.setVisible = (arms: PlayerArmSprites, vis: boolean) => {
      if (!vis) armHideCalls++;
      origSetVisible(arms, vis);
    };

    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);
    updateAllPlayerFrames(ctx, null, 1 / 60, 1016);

    // Hide re-asserted every off-screen frame (authoritative).
    expect(armHideCalls).toBe(2);
    // Expensive arm IK still NEVER called for culled players (the perf win).
    expect(armUpdateCalls.get('remote1')).toBe(0);
  });

  it('mixed: in a 3-player scene only the on-screen one steps its sim', () => {
    // The headline scenario: most players off-screen, one on-screen. Only the
    // on-screen player pays the anim-sim cost. This is the O(N) → O(visible)
    // win the cull delivers.
    const offscreenA = makeVisual({ targetX: 5000, targetY: 0 });
    const driverA = makeCountingDriverStub();
    const onscreen = makeVisual({ targetX: 0, targetY: 0 });
    const driverOn = makeCountingDriverStub();
    const offscreenB = makeVisual({ targetX: 0, targetY: 9000 });
    const driverB = makeCountingDriverStub();
    const { ctx, armVisible } = makeContext(
      [
        { key: 'a', visual: offscreenA, driver: driverA },
        { key: 'on', visual: onscreen, driver: driverOn },
        { key: 'b', visual: offscreenB, driver: driverB },
      ],
      { minX: -200, minY: -200, maxX: 200, maxY: 200 },
    );

    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);

    expect(driverA._updateCalls()).toBe(1); // sim stepped (ghost-arms fix)
    expect(driverOn._updateCalls()).toBe(1);
    expect(driverB._updateCalls()).toBe(1); // sim stepped (ghost-arms fix)
    // All bodies still track their targets (cheap path runs for all).
    expect(offscreenA.body.x).toBe(5000);
    expect(onscreen.body.x).toBe(0);
    expect(offscreenB.body.y).toBe(9000);
    // Only off-screen players are hidden + culled.
    expect(offscreenA.culled).toBe(true);
    expect(onscreen.culled).toBe(false);
    expect(offscreenB.culled).toBe(true);
    expect(armVisible.get('a')).toBe(false);
    expect(armVisible.get('on')).toBe(true);
    expect(armVisible.get('b')).toBe(false);
  });

  // =========================================================================
  // GHOST-ARMS-ON-EVENT regression — the user-visible symptom: a culled
  // (off-screen) remote player's arms/hands/weapon linger as ghosts after an
  // event-driven writer re-shows them. resetForRespawn (off-screen respawn)
  // and updateWeapon (off-screen weapon swap) both call setVisible(true) on a
  // player's sprites without consulting `culled`. The cull path MUST re-assert
  // hidden state every off-screen frame, or those writers leave a sprite
  // visible at its frozen stale position — "ghost arms lingering / swapping
  // weapons across the map". The fix makes the cull hide authoritative per-frame.
  // =========================================================================
  it('REGRESSION: event-driven re-show (respawn/weapon-swap) on a CULLED player is re-hidden next frame', () => {
    const visual = makeVisual({ targetX: 5000, targetY: 0 });
    const driver = makeCountingDriverStub();
    const { ctx, armVisible } = makeContext([{ key: 'remote1', visual, driver }], {
      minX: -200,
      minY: -200,
      maxX: 200,
      maxY: 200,
    });

    // Tick 1: off-screen → culled + all sprites hidden.
    updateAllPlayerFrames(ctx, null, 1 / 60, 1000);
    expect(visual.culled).toBe(true);
    expect(visual.body.visible).toBe(false);
    expect(visual.weapon.visible).toBe(false);
    expect(armVisible.get('remote1')).toBe(false);

    // Simulate an event-driven writer firing while the player is STILL off-screen
    // (resetForRespawn on an off-screen respawn, or updateWeapon on an off-screen
    // weapon swap). These call setVisible(true) unconditionally today.
    visual.body.setVisible(true);
    visual.leftHand.setVisible(true);
    visual.rightHand.setVisible(true);
    visual.weapon.setVisible(true);
    ctx.armRenderer.setVisible(
      (ctx as unknown as { bundles: Map<string, PlayerRenderBundle> }).bundles.get('remote1')!.arms,
      true,
    );
    // The player has NOT moved back into view.
    expect(visual.body.visible).toBe(true);

    // Tick 2: still off-screen → the cull path must re-assert hidden state,
    // overriding the event-driven re-show. Before the fix (one-shot hide gated
    // by `if (!v.culled)`) these stay visible — the ghost.
    updateAllPlayerFrames(ctx, null, 1 / 60, 1016);
    expect(visual.body.visible).toBe(false);
    expect(visual.leftHand.visible).toBe(false);
    expect(visual.rightHand.visible).toBe(false);
    expect(visual.weapon.visible).toBe(false);
    expect(armVisible.get('remote1')).toBe(false);
  });
});

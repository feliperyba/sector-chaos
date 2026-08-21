/**
 * Diagnostic probe — floating / lingering arms (Bug 2).
 *
 * WHY THIS PROBE EXISTS:
 * `ArmRenderer` sprites are independent scene-root objects at depth 9 (NOT
 * children of the body sprite), so hiding the body never cascades to the arms —
 * every hide must be explicit. The cull path hides arms every off-screen frame,
 * and the DYING block fades+hidees arms with the body. But the user still sees
 * (2) arms floating where a player died, and (4) orphaned arms with no body.
 *
 * This probe drives the REAL `updateAllPlayerFrames` through the death / cull /
 * re-entry state machine with FULL per-key alpha + visible tracking (the
 * existing cull harness stubs `setAlpha` as a no-op, so the death-fade arm fade
 * was never actually asserted). The scenarios pinpoint which transition leaks.
 *
 * All scenarios use a controllable driver stub (phase / animState / deathProgress
 * advanced in update()) so we can drive the death lifecycle deterministically.
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
import type { PlayerArmSprites } from '../ArmRenderer.js';
import { createArmJoints } from '../PlayerRendererUpdateHelpers.js';

/** Sprite stub that records visible + alpha so we can assert the death fade. */
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

function makeWeaponStub() {
  const s = {
    visible: true,
    alpha: 1,
    x: 0,
    y: 0,
    rotation: 0,
    setAlpha(a: number) {
      s.alpha = a;
      return s;
    },
    setVisible(v: boolean) {
      s.visible = v;
      return s;
    },
    setTexture: () => s,
    setScale: () => s,
    setOrigin: () => s,
    setFlipX: () => s,
    setTint: () => s,
    setRotation: () => s,
    setPosition: () => s,
    destroy: () => {},
  };
  return s;
}

function makeVisual(over: Partial<PlayerVisual> = {}): PlayerVisual {
  const base = {
    body: makeSpriteStub(),
    leftHand: makeSpriteStub(),
    rightHand: makeSpriteStub(),
    weapon: makeWeaponStub() as unknown as PlayerVisual['weapon'],
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

const POSE = {
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

/**
 * Controllable driver. deathProgress advances in update() while phase=DYING,
 * reaching 1 after DEATH_DURATION_FRAMES. `transitionTo` flips the phase
 * (simulating the driver leaving DYING after the fade) — the prime suspect for
 * "arms reappear after the corpse should be gone".
 */
function makeDriver(startPhase: AnimPhase = AnimPhase.IDLE) {
  const DEATH_DURATION_FRAMES = 10;
  let deathFrame = 0;
  const d = {
    phase: startPhase,
    animState: startPhase === AnimPhase.DYING ? AnimationState.DYING : AnimationState.IDLE,
    atkType: '',
    phaseProgress: 0,
    attackWeaponType: -1,
    deathProgress: 0,
    update() {
      if (d.phase === AnimPhase.DYING) {
        deathFrame++;
        d.deathProgress = Math.min(1, deathFrame / DEATH_DURATION_FRAMES);
      }
    },
    transitionTo(phase: AnimPhase) {
      d.phase = phase;
      d.animState = phase === AnimPhase.DYING ? AnimationState.DYING : AnimationState.IDLE;
      deathFrame = 0;
      d.deathProgress = phase === AnimPhase.DYING ? 0 : d.deathProgress;
    },
    sample() {
      return POSE;
    },
  };
  return d;
}

interface ArmState {
  visible: boolean;
  alpha: number;
}

function makeContext(
  entries: { key: string; visual: PlayerVisual; driver: ReturnType<typeof makeDriver> }[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
) {
  const bundles = new Map<string, PlayerRenderBundle>();
  const armState = new Map<string, ArmState>();
  for (const e of entries) {
    bundles.set(e.key, {
      visual: e.visual,
      controller: {
        update: () => ({ hitFlashActive: false, hitFlashExpired: false }),
      } as unknown as PlayerRenderBundle['controller'],
      driver: e.driver as unknown as PlayerRenderBundle['driver'],
      arms: { _key: e.key } as unknown as PlayerArmSprites,
      armJoints: createArmJoints(),
      frameInput: {} as PlayerRenderBundle['frameInput'],
      trail: null,
      ghostTail: { lastCaptureAt: 0, dashUntil: 0, speedBoostActive: false },
    });
    armState.set(e.key, { visible: true, alpha: 1 });
  }
  const ctx = {
    bundles,
    worldBlocked: null,
    viewMinX: bounds.minX,
    viewMinY: bounds.minY,
    viewMaxX: bounds.maxX,
    viewMaxY: bounds.maxY,
    armRenderer: {
      updateArms: () => {},
      setAlpha: (arms: PlayerArmSprites & { _key?: string }, a: number) => {
        const st = armState.get(arms._key ?? '?');
        if (st) st.alpha = a;
      },
      setVisible: (arms: PlayerArmSprites & { _key?: string }, v: boolean) => {
        const st = armState.get(arms._key ?? '?');
        if (st) st.visible = v;
      },
      positionAtBody: () => {},
    },
    trailRenderer: { captureFrame: () => {}, stopTrail: () => {} },
    ghostTailRenderer: { capture: () => {} },
  };
  return { ctx: ctx as unknown as PlayerFrameContext, armState };
}

const IN_VIEW = { minX: -500, minY: -500, maxX: 500, maxY: 500 };
const OFF_SCREEN = (visual: PlayerVisual) => {
  visual.targetX = 99999;
  visual.body.x = 99999;
  visual.prevBodyX = 99999;
};
const ON_SCREEN = (visual: PlayerVisual) => {
  visual.targetX = 0;
  visual.body.x = 0;
  visual.prevBodyX = 0;
};

describe('Bug 2 — lingering arms diagnosis', () => {
  it('S1 baseline: on-screen DYING fade hides body AND arms at t=1', () => {
    const visual = makeVisual({ targetX: 0, targetY: 0 });
    const driver = makeDriver(AnimPhase.DYING);
    const { ctx, armState } = makeContext([{ key: 'p', visual, driver }], IN_VIEW);

    // Advance past death duration so deathProgress reaches 1.
    for (let i = 0; i < 12; i++) updateAllPlayerFrames(ctx, null, 1 / 60, 1000 + i * 16);

    expect(driver.deathProgress).toBe(1);
    expect(visual.body.visible).toBe(false);
    expect(armState.get('p')!.visible).toBe(false);
    expect(armState.get('p')!.alpha).toBe(0);
  });

  it('S2 REPRODUCES (option 2/4): dead player whose driver NEVER enters DYING stays fully visible (arms + body)', () => {
    // This is the reconnect-as-spectator / added-already-dead seam: onPlayerAdd
    // creates the visual + arms, but triggerDeath only fires from
    // onPlayerChange → handlePlayerChange. If no onChange arrives (server keeps
    // the corpse frozen), the driver stays IDLE → no DYING block → nothing fades.
    const visual = makeVisual({ targetX: 0, targetY: 0 });
    const driver = makeDriver(AnimPhase.IDLE); // triggerDeath missed
    const { ctx, armState } = makeContext([{ key: 'corpse', visual, driver }], IN_VIEW);

    for (let i = 0; i < 20; i++) updateAllPlayerFrames(ctx, null, 1 / 60, 1000 + i * 16);

    // Nothing ever hides the corpse — arms + body linger at full alpha.
    expect(armState.get('corpse')!.visible).toBe(true);
    expect(armState.get('corpse')!.alpha).toBe(1);
    expect(visual.body.visible).toBe(true);
    expect(visual.body.alpha).toBe(1);
  });

  it('S3: post-death re-entry (fade done, driver→IDLE, off→on screen) keeps arms hidden (alpha 0)', () => {
    const visual = makeVisual({ targetX: 0, targetY: 0 });
    const driver = makeDriver(AnimPhase.DYING);
    const { ctx, armState } = makeContext([{ key: 'p', visual, driver }], IN_VIEW);

    // Fade to completion on-screen.
    for (let i = 0; i < 12; i++) updateAllPlayerFrames(ctx, null, 1 / 60, 1000 + i * 16);
    expect(armState.get('p')!.visible).toBe(false);
    expect(armState.get('p')!.alpha).toBe(0);

    // Driver leaves DYING (the corpse's sim phase ends). Now isDying=false.
    driver.transitionTo(AnimPhase.IDLE);

    // Corpse drifts off-screen (cull), then back on-screen (re-entry).
    OFF_SCREEN(visual);
    updateAllPlayerFrames(ctx, null, 1 / 60, 1200);
    expect(visual.culled).toBe(true);

    ON_SCREEN(visual);
    updateAllPlayerFrames(ctx, null, 1 / 60, 1216);

    // The re-entry block sets setVisible(true) for !isDying, but alpha is still
    // 0 from the death fade → arms remain INVISIBLE. This documents the current
    // behavior (no leak here). If a future change resets arm alpha on re-entry,
    // this assertion will catch it.
    expect(armState.get('p')!.alpha).toBe(0);
  });

  it('S4: dead player on-screen with driver IDLE — the cull does NOT help (on-screen → inView)', () => {
    // Same as S2 but makes the point that being ON-SCREEN means the cull never
    // fires — so only the DYING fade (which needs triggerDeath) can hide them.
    // Confirms the fix must NOT rely on the cull for dead players.
    const visual = makeVisual({ targetX: 0, targetY: 0 });
    const driver = makeDriver(AnimPhase.IDLE);
    const { ctx, armState } = makeContext([{ key: 'p', visual, driver }], IN_VIEW);
    for (let i = 0; i < 5; i++) updateAllPlayerFrames(ctx, null, 1 / 60, 1000 + i * 16);
    expect(visual.culled).toBe(false);
    expect(armState.get('p')!.visible).toBe(true);
  });

  it('S5 REGRESSION (ghost-arms teleport trap): off-screen DYING player must be culled, not rendered', () => {
    // The user's invariant: "IF the player is OUT of the culling we should not
    // be rendering their arms at all." The teleport trap moves players abruptly;
    // a dying player whose body is off-screen (e.g. teleported away, or died
    // outside the viewport) must NOT have their arms rendered at the old spot.
    //
    // At HEAD this FAILS: the cull's `isDying ||` exception force-keeps
    // off-screen DYING players `inView`, so the active path runs and the DYING
    // block keeps re-positioning + alpha-fading their arms every frame even
    // though the body is off-screen — exactly the "arms stay at the teleport
    // trap" symptom. The fix removes `isDying ||` from the inView check; death
    // progress still advances via the cull path's stepDriver.
    const visual = makeVisual({ targetX: 99999, targetY: 99999 });
    visual.body.x = 99999;
    visual.body.y = 99999;
    visual.prevBodyX = 99999;
    visual.prevBodyY = 99999;
    const driver = makeDriver(AnimPhase.DYING);
    const { ctx, armState } = makeContext([{ key: 'corpse', visual, driver }], IN_VIEW);

    // 5 frames → deathProgress = 0.5 (< 1, so the t>=1 hide doesn't fire and
    // mask the bug; the only thing that should hide arms here is the cull).
    for (let i = 0; i < 5; i++) updateAllPlayerFrames(ctx, null, 1 / 60, 1000 + i * 16);

    expect(driver.deathProgress).toBe(0.5);
    expect(visual.culled).toBe(true);
    expect(armState.get('corpse')!.visible).toBe(false);
  });
});

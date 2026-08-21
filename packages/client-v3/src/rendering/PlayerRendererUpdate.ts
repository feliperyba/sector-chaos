/**
 * Per-frame update for all player visuals.
 *
 * Pose truth comes from the shared deterministic animation sim (AnimSimDriver
 * stepping packages/shared stepAnimation at fixed 1/60, interpolated for the
 * render rate). This file is the JUICE layer on top: body interpolation,
 * hit-stop, squash/stretch, trails, hit flash, death fade — render-rate
 * effects that never feed back into the simulation.
 */
import { AnimPhase, AttackType, getAttackCategory, getMotionSpec } from '@sector-battle/shared';
import { AnimationState, MOVE_ENTER_THRESHOLD, MOVE_EXIT_THRESHOLD } from '../types.js';
import { JUICE_CONFIGS, type JuiceParams } from './JuiceConfig.js';
import { applyBodyScaleSpring, stepDriver } from './PlayerRendererUpdateHelpers.js';
import type { PlayerFrameContext } from './PlayerRendererTypes.js';

// Re-export so existing `import type { PlayerVisual } from './PlayerRendererUpdate.js'`
// (PlayerRenderer, PlayerRendererReactions, PlayerRendererFactory) keeps working.
// The canonical home is now PlayerRendererTypes.ts, which breaks the Update ↔
// UpdateHelpers cycle (Helpers imports the type from PlayerRendererTypes, not here).
export type { PlayerVisual } from './PlayerRendererTypes.js';

const FISTS_IDLE = getMotionSpec(0).idle;
export const IDLE_LEFT = FISTS_IDLE.left;
export const IDLE_RIGHT = FISTS_IDLE.right;

/**
 * Visual-only radial multiplier on hand distance from the body centre. The new
 * character art is larger than the old circles, so the authored pose offsets
 * (e.g. fists idle at ~72px radius) sit the hands too close to the body. This
 * scales the body→hand vector at render time only — the simulation, IK, and
 * hitboxes are untouched (they read the sim's own hand positions). Tune by eye:
 * 1.0 = authored distance, 1.15 ≈ +15% reach.
 */
const HAND_DISTANCE_SCALE = 1.15;

/**
 * Body-lean commitment tuning. Multiplies how far the body leans into a strike
 * and how snappy the spring returns. Higher impactScale = more commitment;
 * lower impactDamping = more overshoot/punch. Tune by eye.
 */
const BODY_LEAN = {
  impactScale: 1.3,
  impactStiffness: 260,
  impactDamping: 0.62,
  cooldownStiffness: 90,
  cooldownDamping: 0.85,
} as const;

/**
 * Hoisted spring coefficients (perf ticket 21) — formerly recomputed per
 * in-view player per frame; identical expressions, bit-identical products.
 */
const IMPACT_OMEGA = Math.sqrt(BODY_LEAN.impactStiffness);
const IMPACT_DAMP = 2 * BODY_LEAN.impactDamping * IMPACT_OMEGA;
const COOLDOWN_OMEGA = Math.sqrt(BODY_LEAN.cooldownStiffness);
const COOLDOWN_DAMP = 2 * BODY_LEAN.cooldownDamping * COOLDOWN_OMEGA;
const RECOIL_STIFFNESS = 250;
const RECOIL_OMEGA = Math.sqrt(RECOIL_STIFFNESS);
const RECOIL_DAMP = 2 * 0.82 * RECOIL_OMEGA;

/**
 * Rotation added to `facingAngle` when orienting the hand sprites. The hand
 * art faces UP (−Y) in its source frame; `facingAngle` uses 0 = +X (right).
 * Rotating an UP-facing sprite clockwise by π/2 points it along the aim.
 *
 * NOTE: the body (`*_character`) art is drawn facing the OPPOSITE way to the
 * hands — confirmed visually: hands track the aim correctly with this offset,
 * the body ended up 180° off. So the body gets an extra π on top. See
 * docs/wayfinder/player-art-and-skins.md.
 */
const FACING_ART_OFFSET = Math.PI / 2;
/** Body faces 180° opposite to the hands in its source frame. */
const BODY_FACING_ART_OFFSET = FACING_ART_OFFSET + Math.PI;

function getJuiceForWeapon(weaponType: number): JuiceParams {
  const cat = getAttackCategory(weaponType);
  return JUICE_CONFIGS[cat];
}

export function updateAllPlayerFrames(
  ctx: PlayerFrameContext,
  localPlayerId: string | null,
  clampedDt: number,
  now: number,
): void {
  const WALK_GRACE_MS = 80;
  // Perf ticket 21: dt-only factor — one Math.pow per frame, not per player.
  const velSmooth = 1 - Math.pow(0.05, clampedDt);

  for (const [key, bundle] of ctx.bundles) {
    const v = bundle.visual;
    const ctrl = bundle.controller;
    const driver = bundle.driver;

    const isLocal = key === localPlayerId;

    if (isLocal && v.hitStopRemaining > 0) {
      v.hitStopRemaining -= clampedDt * 1000;
      if (v.hitStopRemaining < 0) v.hitStopRemaining = 0;
    }

    // ── Body position: always update (cheap, keeps off-screen players at the
    //    correct world coord so they don't teleport when they re-enter view). ──
    v.body.x = v.targetX;
    v.body.y = v.targetY;

    // ── View cull (B4 perf C1): skip the expensive per-frame work for
    //    off-screen REMOTE players. In a zoomed-in top-down camera ~80% of 64
    //    players are off-screen at any instant, yet previously every one of
    //    them ran the full anim sim (≤4 fixed substeps), spring integration,
    //    ~10 sprite mutators and 4-arm IK every frame — the dominant O(N)
    //    cost and the root cause of the "heavy/sluggish" feel that lifted as
    //    bots died.
    //
    //    The ONLY exception that always runs the full update is the local
    //    player — input owner, prediction drives its anim.
    //
    //    DYING players are NO LONGER exempt: if a dying player's body is
    //    off-screen, their death-fade visual is irrelevant (nothing to render)
    //    and rendering their arms off-screen is exactly the "ghost arms at the
    //    teleport trap" bug. The cull path below hides ALL their sprites +
    //    arms and STILL advances deathProgress via stepDriver, so the fade
    //    state stays correct for re-entry. This was the root cause of the IK
    //    arms regression introduced by the culling performance patch: an
    //    `isDying ||` exemption here force-kept off-screen DYING players
    //    inView, so the active path kept re-positioning their arms at the
    //    stale spot. ──
    const driverPhase = driver.phase;
    const isDying = driverPhase === AnimPhase.DYING;
    const inView =
      isLocal ||
      (v.body.x >= ctx.viewMinX &&
        v.body.x <= ctx.viewMaxX &&
        v.body.y >= ctx.viewMinY &&
        v.body.y <= ctx.viewMaxY);

    if (!inView) {
      // AUTHORITATIVE per-frame hide: re-assert invisible EVERY off-screen frame
      // so no event-driven writer can leave a sprite visible on a culled player.
      // resetForRespawn (off-screen respawn) and updateWeapon (off-screen weapon
      // swap) both call setVisible(true) without consulting `culled`; a one-shot
      // hide (the former `if (!v.culled)` design) let those re-shown sprites
      // linger as "ghost arms swapping weapons across the map". Re-asserting
      // hidden state every frame overrides any such writer next frame.
      //
      // Safe: the effects a one-shot hide was meant to protect — death-fade,
      // fresh-spawn flicker, hit-flash — all run in the in-view ACTIVE path
      // below (which is skipped for culled players via `continue`). For DYING
      // players the cull path is correct: their corpse is off-screen (nothing
      // to fade visually), and stepDriver below still advances deathProgress so
      // the fade state is correct if they re-enter view mid-death.
      // setVisible is a cheap flag-set; the EXPENSIVE render work (arm IK,
      // springs, sprite mutations) remains skipped via `continue`.
      v.body.setVisible(false);
      v.leftHand.setVisible(false);
      v.rightHand.setVisible(false);
      v.weapon.setVisible(false);
      v.label.setVisible(false);
      ctx.armRenderer.setVisible(bundle.arms, false);
      // Pin every independent sprite (arms + hands + weapon + label) onto the
      // LIVE body every off-screen frame. These are scene-root objects, NOT
      // children of the body, so without this they freeze at whatever world
      // coord the in-view active path last wrote — after a teleport that is the
      // trap the player just left, i.e. the "ghost arms / lingering names stay
      // at the teleport trap" regression. The hide above makes stale geometry
      // invisible; this reposition is defence-in-depth so these sprites can
      // NEVER linger at a stale spot even if a hide is dropped (re-show race,
      // stale build, one-shot writer). It is NOT the IK pose — just a few cheap
      // setPosition calls per culled player, so it does not reintroduce the
      // O(N) IK cost the cull exists to avoid. The label uses the same -60px
      // offset as the active path (bodyWorldY - 60, set further below).
      ctx.armRenderer.positionAtBody(bundle.arms, v.body.x, v.body.y);
      v.leftHand.setPosition(v.body.x, v.body.y);
      v.rightHand.setPosition(v.body.x, v.body.y);
      v.weapon.setPosition(v.body.x, v.body.y);
      v.label.setPosition(v.body.x, v.body.y - 60);
      v.culled = true;
      // Keep the velocity smoothing baseline synced so re-entry doesn't spike.
      v.prevBodyX = v.body.x;
      v.prevBodyY = v.body.y;
      // Step the anim sim (CHEAP: just the fixed-timestep pose advance) so the
      // driver's simTick + pose stay aligned with the server phase clock while
      // off-screen. Without this, the driver freezes during cull and re-entry
      // produces a pose discontinuity (the "ghost arms lingering at the
      // viewport edge with a delayed update" symptom). We skip ALL the
      // expensive render work (springs, arm IK, sprite mutations) — only the
      // sim advances. frameInput uses the live body pos + zero velocity; the
      // pose is re-derived from the live position on re-entry.
      const cullFrozenByHitStop = isLocal && v.hitStopRemaining > 0;
      stepDriver(ctx, bundle, driver, cullFrozenByHitStop ? 0 : clampedDt, 0, 0, false);
      continue;
    }

    if (v.culled) {
      // Transition hidden → visible: re-show sprites. The active path below
      // re-positions + re-evaluates weapon visibility the same frame, so we
      // only restore the base visibility here.
      v.body.setVisible(true);
      v.leftHand.setVisible(true);
      v.rightHand.setVisible(true);
      v.label.setVisible(true);
      // Arms: always re-show on re-entry. The DYING block below owns the death
      // fade (it sets arm alpha = 1-t and hides at t>=1), so re-showing here
      // lets it correctly drive a mid-fade re-entry; for non-DYING players the
      // active path's updateArms re-positions them the same frame.
      ctx.armRenderer.setVisible(bundle.arms, true);
      // NOTE: weapon visibility is NOT blindly restored here — the active
      // path's weapon-visibility block (empty/throw/real) runs below and
      // re-derives it.
      v.culled = false;
    }

    const angle = v.facingAngle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    // Smoothed velocity from actual body position delta (not target delta)
    const rawDx = v.body.x - v.prevBodyX;
    const rawDy = v.body.y - v.prevBodyY;
    v.smoothVelX += (rawDx - v.smoothVelX) * velSmooth;
    v.smoothVelY += (rawDy - v.smoothVelY) * velSmooth;
    // Speed in px/s — px-per-frame deltas are frame-rate dependent and at
    // high refresh rates never cross a fixed per-frame threshold.
    const dtSafe = Math.max(clampedDt, 1e-3);
    const velPxSecX = v.smoothVelX / dtSafe;
    const velPxSecY = v.smoothVelY / dtSafe;
    const smoothSpeedSq = velPxSecX * velPxSecX + velPxSecY * velPxSecY;

    // Same velocity criterion for local and remote — the walk state must
    // match what the server derives from its own velocity threshold, or the
    // local player walks (or idles) while every other client disagrees.
    if (smoothSpeedSq > MOVE_ENTER_THRESHOLD * MOVE_ENTER_THRESHOLD) {
      v.lastMoveTime = now;
      v.isMoving = true;
    } else if (smoothSpeedSq < MOVE_EXIT_THRESHOLD * MOVE_EXIT_THRESHOLD) {
      if (now - v.lastMoveTime >= WALK_GRACE_MS) {
        v.isMoving = false;
      }
    }
    const isMoving = v.isMoving;

    v.prevBodyX = v.body.x;
    v.prevBodyY = v.body.y;

    if (v.freshSpawn) {
      const flickerAlpha = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((now * Math.PI * 2 * 5) / 1000));
      v.body.setAlpha(flickerAlpha);
      v.leftHand.setAlpha(flickerAlpha);
      v.rightHand.setAlpha(flickerAlpha);
      // D1: only flicker the weapon when a real weapon is equipped. Match start
      // is the fresh-spawn window, and players spawn with FISTS — flickering
      // the (still-dagger-textured) weapon sprite here would override the
      // alpha-0 secondary defense set by updateWeapon/resetForRespawn. The
      // per-frame empty-hide below keeps it invisible regardless; this guard
      // keeps the alpha-0 defense intact for the exact match-start scenario.
      if (v.equippedWeaponType >= 0) v.weapon.setAlpha(flickerAlpha);
      ctx.armRenderer.setAlpha(bundle.arms, flickerAlpha);
    }

    const flags = ctrl.update(now);
    const frozenByHitStop = isLocal && v.hitStopRemaining > 0;
    const effectiveDt = frozenByHitStop ? 0 : clampedDt;

    // ── Step the shared animation sim (fixed 1/60, world velocity in px/s) ──
    stepDriver(ctx, bundle, driver, effectiveDt, velPxSecX, velPxSecY, isMoving);
    const pose = driver.sample();
    if (!pose) continue;

    const animState = driver.animState;
    const progress = driver.phaseProgress;
    const poseWeaponType =
      driver.attackWeaponType >= 0
        ? driver.attackWeaponType
        : v.equippedWeaponType >= 0
          ? v.equippedWeaponType
          : 0;
    const juice = getJuiceForWeapon(poseWeaponType);

    // ── Juice transitions keyed on legacy state mapping ──
    if (animState !== v.prevAnimState) {
      if (
        v.prevAnimState === AnimationState.ATTACK_IMPACT &&
        animState === AnimationState.COOLDOWN
      ) {
        v.bodyScaleVelX += (juice.recoverySquashY - v.bodyScaleX) * 3;
        v.bodyScaleVelY += (v.bodyScaleY - juice.recoverySquashY) * 5;
        ctx.trailRenderer.stopTrail(bundle);
        v.trailCategory = null;
      }
      if (animState === AnimationState.IDLE || animState === AnimationState.WALK) {
        if (v.prevAnimState !== AnimationState.IDLE && v.prevAnimState !== AnimationState.WALK) {
          v.bodyOffsetX = 0;
          v.bodyOffsetY = 0;
          v.bodyOffsetVelX = 0;
          v.bodyOffsetVelY = 0;
        }
      }
      v.prevAnimState = animState;
    }

    // ── Body lean (render offset along facing, spring-driven juice) ──
    // BODY_LEAN boosts how far the body commits into a strike and how snappy
    // the spring is (more overshoot = punchier). Tune by eye.
    if (!frozenByHitStop) {
      if (animState === AnimationState.ATTACK_IMPACT) {
        const targetLeanX = juice.bodyLean * BODY_LEAN.impactScale;
        const accX =
          -BODY_LEAN.impactStiffness * (v.bodyOffsetX - targetLeanX) -
          IMPACT_DAMP * v.bodyOffsetVelX;
        v.bodyOffsetVelX += accX * clampedDt;
        v.bodyOffsetX += v.bodyOffsetVelX * clampedDt;
      } else if (animState === AnimationState.COOLDOWN) {
        const accX =
          -BODY_LEAN.cooldownStiffness * v.bodyOffsetX - COOLDOWN_DAMP * v.bodyOffsetVelX;
        v.bodyOffsetVelX += accX * clampedDt;
        v.bodyOffsetX += v.bodyOffsetVelX * clampedDt;
      }

      // ── Victim recoil offset spring (runs for ALL states) ──
      // Independent of animation — the body gets shoved and springs back.
      const recoilAccX = -RECOIL_STIFFNESS * v.victimOffsetX - RECOIL_DAMP * v.victimOffsetVelX;
      const recoilAccY = -RECOIL_STIFFNESS * v.victimOffsetY - RECOIL_DAMP * v.victimOffsetVelY;
      v.victimOffsetVelX += recoilAccX * clampedDt;
      v.victimOffsetVelY += recoilAccY * clampedDt;
      v.victimOffsetX += v.victimOffsetVelX * clampedDt;
      v.victimOffsetY += v.victimOffsetVelY * clampedDt;
    }

    // Render offset shifts ALL drawn elements equally (sim stays offset-free)
    const offsetX =
      (v.bodyOffsetX + v.victimOffsetX) * cosA - (v.bodyOffsetY + v.victimOffsetY) * sinA;
    const offsetY =
      (v.bodyOffsetX + v.victimOffsetX) * sinA + (v.bodyOffsetY + v.victimOffsetY) * cosA;
    const bodyWorldX = v.body.x + offsetX;
    const bodyWorldY = v.body.y + offsetY;

    // ── Pose re-anchor (ghost-arms-at-teleport-trap fix) ──
    // The anim sim steps on a fixed 1/60 accumulator. At >60Hz it does NOT step
    // every render frame, so between steps the sampled pose is centred on the
    // body position from the LAST step, not the live one. During fast body
    // movement — the interpolation glide that follows a teleport-trap jump
    // (100s of px/frame) — that lag is large and the arm joints, which
    // re-anchor to the LIVE body below, stretch between the stale pose anchor
    // and the live body: the shoulders (and thus the arm base) trail behind,
    // lingering near the teleport source. shiftX/Y is the body delta since the
    // last step; adding it to every pose position re-anchors the stale pose to
    // the live body so the joints stay attached. At 60Hz a step runs every
    // frame, poseAnchor == live body, and shiftX/Y is always 0 (no-op).
    // Number.isFinite guards test driver stubs that don't expose the anchor.
    const anchorX = driver.poseAnchorX;
    const anchorY = driver.poseAnchorY;
    const shiftX = Number.isFinite(anchorX) ? v.body.x - anchorX : 0;
    const shiftY = Number.isFinite(anchorY) ? v.body.y - anchorY : 0;

    // Hand positions come from the sim as absolute world coords (body-centred,
    // facing-resolved). Push them radially outward from the body centre by
    // HAND_DISTANCE_SCALE to suit the larger new art — visual only, the sim's
    // own hand positions (and thus hitboxes) are unaffected.
    const leftDx = pose.leftArm.hand.x + shiftX - bodyWorldX;
    const leftDy = pose.leftArm.hand.y + shiftY - bodyWorldY;
    const rightDx = pose.rightArm.hand.x + shiftX - bodyWorldX;
    const rightDy = pose.rightArm.hand.y + shiftY - bodyWorldY;
    const leftHandX = bodyWorldX + leftDx * HAND_DISTANCE_SCALE;
    const leftHandY = bodyWorldY + leftDy * HAND_DISTANCE_SCALE;
    const rightHandX = bodyWorldX + rightDx * HAND_DISTANCE_SCALE;
    const rightHandY = bodyWorldY + rightDy * HAND_DISTANCE_SCALE;
    v.leftHand.setPosition(leftHandX, leftHandY);
    v.rightHand.setPosition(rightHandX, rightHandY);

    // Orient body + hands to face the aim direction. The body and hand art
    // face opposite ways in their source frames (see offset constants above),
    // so they take different rotations. Hands keep their IK-driven positions
    // (above) — only their sprite angle changes.
    v.body.setRotation(angle + BODY_FACING_ART_OFFSET);
    v.leftHand.setRotation(angle + FACING_ART_OFFSET);
    v.rightHand.setRotation(angle + FACING_ART_OFFSET);

    if (
      v.trailCategory != null &&
      (animState === AnimationState.ATTACK_IMPACT || animState === AnimationState.WINDUP)
    ) {
      ctx.trailRenderer.captureFrame(
        bundle,
        pose.grip.x + shiftX + offsetX,
        pose.grip.y + shiftY + offsetY,
        pose.tip.x + shiftX + offsetX,
        pose.tip.y + shiftY + offsetY,
      );
    }

    // Per-player ArmJoints scratch — allocated once with the bundle (ADR-0026
    // zero-allocation rendering: reused every frame, freed with the bundle).
    const joints = bundle.armJoints;
    // Shoulders stay anchored to the body; elbows + hands extend radially with
    // HAND_DISTANCE_SCALE so the arm segments still connect naturally. shiftX/Y
    // re-anchors the (possibly stale, >60Hz) pose to the live body.
    joints.leftShoulder.x = pose.leftArm.shoulder.x + shiftX + offsetX;
    joints.leftShoulder.y = pose.leftArm.shoulder.y + shiftY + offsetY;
    joints.leftElbow.x =
      bodyWorldX + (pose.leftArm.elbow.x + shiftX - bodyWorldX) * HAND_DISTANCE_SCALE;
    joints.leftElbow.y =
      bodyWorldY + (pose.leftArm.elbow.y + shiftY - bodyWorldY) * HAND_DISTANCE_SCALE;
    joints.leftHand.x = leftHandX;
    joints.leftHand.y = leftHandY;
    joints.rightShoulder.x = pose.rightArm.shoulder.x + shiftX + offsetX;
    joints.rightShoulder.y = pose.rightArm.shoulder.y + shiftY + offsetY;
    joints.rightElbow.x =
      bodyWorldX + (pose.rightArm.elbow.x + shiftX - bodyWorldX) * HAND_DISTANCE_SCALE;
    joints.rightElbow.y =
      bodyWorldY + (pose.rightArm.elbow.y + shiftY - bodyWorldY) * HAND_DISTANCE_SCALE;
    joints.rightHand.x = rightHandX;
    joints.rightHand.y = rightHandY;
    ctx.armRenderer.updateArms(bundle.arms, joints);

    // Render-only grip re-alignment. The sim anchors melee weapons at
    // gripHand + handOffset (past the hand, toward the blade tip), which reads
    // as the weapon floating at the hand's tip instead of gripped in its center.
    // For arc/line weapons, anchor the rendered weapon on the right hand so the
    // fist wraps the handle. Ranged/shield keep the sim's pose position — their
    // handOffset pushes the weapon FORWARD along facing (in front of the player),
    // which is the desired placement, not a tip-float. Sim/hitbox keep their own
    // anchor (untouched).
    const gripCat = v.equippedWeaponType >= 0 ? getAttackCategory(v.equippedWeaponType) : 'fists';
    if (gripCat === 'arc' || gripCat === 'line') {
      v.weapon.setPosition(rightHandX, rightHandY);
    } else {
      v.weapon.setPosition(pose.weaponX + shiftX + offsetX, pose.weaponY + shiftY + offsetY);
    }
    v.weapon.setRotation(pose.weaponRotation);

    // Per-frame weapon visibility invariant (D1). Three layers, in priority
    // order — each is defense-in-depth for "no real weapon ⇒ invisible":
    //   1. THROWN release: hide during throw strike/recover (the flying
    //      projectile entity is the visible weapon). Defensive backup — the
    //      authoritative hide is event-driven (onThrow / WeaponBroken call
    //      PlayerRenderer.hideWeapon, which arms weaponHidden).
    //   2. EMPTY slot: `equippedWeaponType < 0` ⇒ ALWAYS hide. This is the
    //      structural fix for the D1 regression — no re-show path (respawn's
    //      unconditional `setVisible(true)`, a stale patch, anything) may leave
    //      the weapon visible when no real weapon is equipped. The factory's
    //      dagger fallback texture would otherwise pop at body center.
    //   3. REAL weapon + no event-driven hide: re-arm. The `!weaponHidden`
    //      guard stops this branch re-arming the sprite on a stale
    //      equippedWeaponType during the throw/break → patch RTT window (B1).
    if (
      driver.atkType === AttackType.THROWN &&
      (animState === AnimationState.ATTACK_IMPACT || animState === AnimationState.COOLDOWN)
    ) {
      v.weapon.setVisible(false);
    } else if (v.equippedWeaponType < 0) {
      v.weapon.setVisible(false);
    } else if (!v.weaponHidden) {
      v.weapon.setVisible(true);
    }

    v.label.setPosition(bodyWorldX, bodyWorldY - 60);

    if (flags.hitFlashActive) {
      v.body.setTint(0xffffff);
      v.leftHand.setTint(0xffffff);
      v.rightHand.setTint(0xffffff);
    } else if (flags.hitFlashExpired) {
      v.body.clearTint();
      v.leftHand.clearTint();
      v.rightHand.clearTint();
    }

    // Dash stretch is active for the first ~40% of the dash (legacy 200/500ms)
    const dashStretchActive = animState === AnimationState.DASH && progress < 0.4;
    applyBodyScaleSpring(v, dashStretchActive, animState, frozenByHitStop, clampedDt);

    // Ghost tail (ticket 04): snapshot the finalized body sprite (position,
    // rotation, dash-stretch scale above) as a pooled afterimage while dash /
    // speed boost is active. Lives AFTER the scale spring so the captured
    // scale is the current one. Render-only — params + lifecycle in
    // GhostTailRenderer.
    if (animState !== AnimationState.DYING) {
      ctx.ghostTailRenderer.capture(bundle, v.body, Math.sqrt(smoothSpeedSq), now);
    }

    if (animState === AnimationState.DYING) {
      const t = driver.deathProgress;
      v.body.setAlpha(1 - t);
      v.body.setScale(v.baseScale * (1 - t * 0.5));
      v.leftHand.setAlpha(1 - t);
      v.rightHand.setAlpha(1 - t);
      v.weapon.setAlpha(1 - t);
      v.label.setAlpha(1 - t);
      ctx.armRenderer.setAlpha(bundle.arms, 1 - t);
      if (t >= 1) {
        v.body.setVisible(false);
        v.leftHand.setVisible(false);
        v.rightHand.setVisible(false);
        v.weapon.setVisible(false);
        ctx.armRenderer.setVisible(bundle.arms, false);
      }
    }
  }
}

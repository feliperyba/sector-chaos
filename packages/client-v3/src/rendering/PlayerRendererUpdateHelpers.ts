import { AnimationState } from '../types.js';
import type { PlayerVisual, PlayerFrameContext, PlayerRenderBundle } from './PlayerRendererTypes.js';
import type { ArmJoints } from './ArmRenderer.js';
import type { AnimSimDriver } from '../animation/AnimSimDriver.js';

/** Allocate a fresh ArmJoints zero-init object (pooled per-player in the update loop). */
export function createArmJoints(): ArmJoints {
  return {
    leftShoulder: { x: 0, y: 0 },
    leftElbow: { x: 0, y: 0 },
    leftHand: { x: 0, y: 0 },
    rightShoulder: { x: 0, y: 0 },
    rightElbow: { x: 0, y: 0 },
    rightHand: { x: 0, y: 0 },
  };
}

/**
 * Fill the bundle's pre-allocated DriverFrameInput and step the anim sim. Used
 * by both the active render path and the cull path (where we keep the sim warm
 * so re-entry doesn't produce a pose discontinuity). Extracted to a helper to
 * keep PlayerRendererUpdate.ts under the file-length lint cap.
 */
export function stepDriver(
  ctx: PlayerFrameContext,
  bundle: PlayerRenderBundle,
  driver: AnimSimDriver,
  effectiveDt: number,
  bodyVelX: number,
  bodyVelY: number,
  isMoving: boolean,
): void {
  const v: PlayerVisual = bundle.visual;
  const frameInput = bundle.frameInput;
  frameInput.facingAngle = v.facingAngle;
  frameInput.bodyX = v.body.x;
  frameInput.bodyY = v.body.y;
  frameInput.bodyVelX = bodyVelX;
  frameInput.bodyVelY = bodyVelY;
  frameInput.isMoving = isMoving;
  frameInput.weaponType = v.equippedWeaponType >= 0 ? v.equippedWeaponType : 0;
  frameInput.isWorldBlocked = ctx.worldBlocked ?? undefined;
  driver.update(effectiveDt, frameInput);
}

/**
 * Squash/stretch tuning for attack impact/recovery. Exaggerated targets +
 * snappier springs make hits land harder (more "juice"). Tune by eye:
 * higher stretch/squash = more cartoonish; higher stiffness = snappier.
 */
const SQUASH_STRETCH = {
  impactStretch: 0.22, // was 0.15 — stretch further into the swing
  impactSquash: 0.16, // was 0.10 — squash flatter perpendicular
  impactStiffness: 380, // was 300 — snap to target faster
  impactDamping: 0.72, // was 0.80 — slightly more ring/overshoot
  cooldownStiffness: 140, // was 120 — snappier recovery
  cooldownDamping: 0.68, // was 0.70 — bounce-back on recovery
} as const;

/**
 * Body squash/stretch spring — render-rate juice on top of the shared sim.
 * (The old weapon-vs-wall contact offset was removed: the server's swept
 * melee now physically interrupts swings on walls — WeaponWallHit — and the
 * recoil arrives as a deterministic arm impulse instead of a sprite offset.)
 */
export function applyBodyScaleSpring(
  v: PlayerVisual,
  dashStretchActive: boolean,
  animState: AnimationState,
  frozenByHitStop: boolean,
  clampedDt: number,
): void {
  if (dashStretchActive) {
    v.body.setScale(v.baseScale * 1.3, v.baseScale * 0.8);
  } else if (animState === AnimationState.ATTACK_IMPACT) {
    if (!frozenByHitStop) {
      const stretchTarget = 1.0 + SQUASH_STRETCH.impactStretch;
      const squashTarget = 1.0 - SQUASH_STRETCH.impactSquash;
      const scaleStiffness = SQUASH_STRETCH.impactStiffness;
      const omega = Math.sqrt(scaleStiffness);
      const dampCoeff = 2 * SQUASH_STRETCH.impactDamping * omega;
      const accX = -scaleStiffness * (v.bodyScaleX - stretchTarget) - dampCoeff * v.bodyScaleVelX;
      const accY = -scaleStiffness * (v.bodyScaleY - squashTarget) - dampCoeff * v.bodyScaleVelY;
      v.bodyScaleVelX += accX * clampedDt;
      v.bodyScaleVelY += accY * clampedDt;
      v.bodyScaleX += v.bodyScaleVelX * clampedDt;
      v.bodyScaleY += v.bodyScaleVelY * clampedDt;
    }
    v.body.setScale(v.baseScale * v.bodyScaleX, v.baseScale * v.bodyScaleY);
  } else if (animState === AnimationState.COOLDOWN) {
    if (!frozenByHitStop) {
      const scaleStiffness = SQUASH_STRETCH.cooldownStiffness;
      const scaleZeta = SQUASH_STRETCH.cooldownDamping;
      const omega = Math.sqrt(scaleStiffness);
      const dampCoeff = 2 * scaleZeta * omega;
      const accX = -scaleStiffness * (v.bodyScaleX - 1.0) - dampCoeff * v.bodyScaleVelX;
      const accY = -scaleStiffness * (v.bodyScaleY - 1.0) - dampCoeff * v.bodyScaleVelY;
      v.bodyScaleVelX += accX * clampedDt;
      v.bodyScaleVelY += accY * clampedDt;
      v.bodyScaleX += v.bodyScaleVelX * clampedDt;
      v.bodyScaleY += v.bodyScaleVelY * clampedDt;
    }
    v.body.setScale(v.baseScale * v.bodyScaleX, v.baseScale * v.bodyScaleY);
  } else if (animState !== AnimationState.DYING) {
    if (!frozenByHitStop) {
      const scaleStiffness = 200;
      const scaleZeta = 1.0;
      const omega = Math.sqrt(scaleStiffness);
      const dampCoeff = 2 * scaleZeta * omega;
      const accX = -scaleStiffness * (v.bodyScaleX - 1.0) - dampCoeff * v.bodyScaleVelX;
      const accY = -scaleStiffness * (v.bodyScaleY - 1.0) - dampCoeff * v.bodyScaleVelY;
      v.bodyScaleVelX += accX * clampedDt;
      v.bodyScaleVelY += accY * clampedDt;
      v.bodyScaleX += v.bodyScaleVelX * clampedDt;
      v.bodyScaleY += v.bodyScaleVelY * clampedDt;
    }
    v.body.setScale(v.baseScale * v.bodyScaleX, v.baseScale * v.bodyScaleY);
  }
}

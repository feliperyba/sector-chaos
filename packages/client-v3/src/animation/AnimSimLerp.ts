/**
 * AnimSimLerp — pose interpolation helpers for AnimSimDriver.
 *
 * Mechanical extraction from AnimSimDriver.ts (max-lines cap): the four
 * module-private lerp helpers, verbatim. Only `lerpResultInto` is consumed by
 * the driver's `sample()`; the scalar/arm helpers stay module-private here.
 */
import { shortestAngleDelta, type AnimStepResult, type ArmPose } from '@sector-battle/shared';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + shortestAngleDelta(a, b) * t;
}

function lerpArmInto(a: ArmPose, b: ArmPose, t: number, out: ArmPose): void {
  out.shoulder.x = lerp(a.shoulder.x, b.shoulder.x, t);
  out.shoulder.y = lerp(a.shoulder.y, b.shoulder.y, t);
  out.elbow.x = lerp(a.elbow.x, b.elbow.x, t);
  out.elbow.y = lerp(a.elbow.y, b.elbow.y, t);
  out.hand.x = lerp(a.hand.x, b.hand.x, t);
  out.hand.y = lerp(a.hand.y, b.hand.y, t);
  out.shoulderAngle = lerpAngle(a.shoulderAngle, b.shoulderAngle, t);
  out.elbowAngle = lerp(a.elbowAngle, b.elbowAngle, t);
  out.reachable = b.reachable;
}

export function lerpResultInto(
  a: AnimStepResult,
  b: AnimStepResult,
  t: number,
  out: AnimStepResult,
): void {
  lerpArmInto(a.leftArm, b.leftArm, t, out.leftArm);
  lerpArmInto(a.rightArm, b.rightArm, t, out.rightArm);
  out.weaponX = lerp(a.weaponX, b.weaponX, t);
  out.weaponY = lerp(a.weaponY, b.weaponY, t);
  out.weaponRotation = lerpAngle(a.weaponRotation, b.weaponRotation, t);
  out.grip.x = lerp(a.grip.x, b.grip.x, t);
  out.grip.y = lerp(a.grip.y, b.grip.y, t);
  out.tip.x = lerp(a.tip.x, b.tip.x, t);
  out.tip.y = lerp(a.tip.y, b.tip.y, t);
  out.attackBlend = lerp(a.attackBlend, b.attackBlend, t);
  out.bodyLean = lerp(a.bodyLean, b.bodyLean, t);
  out.phaseProgress = lerp(a.phaseProgress, b.phaseProgress, t);
  out.wallContact = b.wallContact;
  out.wallContactX = b.wallContactX;
  out.wallContactY = b.wallContactY;
  out.wallPenetration = b.wallPenetration;
}

/**
 * stepAnimation.ts — The pure, tick-based pose stepper.
 *
 * One call = one 60Hz tick. Runs identically on the server (authoritative —
 * its weapon segment output IS the melee hitbox) and the client (local
 * prediction + remote reconstruction). See AnimTypes.ts for the determinism
 * contract.
 *
 * Ported from the client's AnimationTargetSolver/PlayerAnimationController
 * with all wall-clock time and variable-dt behavior replaced by tick math.
 *
 * ORCHESTRATOR ONLY — the phase machine, target/spring-profile/lean
 * computation, and wall-collision live in AnimationPhase.ts,
 * AnimationTargets.ts, and AnimationCollision.ts respectively. This file
 * holds the rig constants, the weapon scratch singletons, and the main
 * stepAnimation body that wires those helpers together in the original
 * order. Every calculation/constant/formula/conditional/operation is
 * byte-identical to the pre-decomposition file; only the file locations of
 * the helpers changed.
 */
import {
  AnimPhase,
  createAnimStepResult,
  type AnimSimState,
  type AnimStepInput,
  type AnimStepResult,
} from './AnimTypes.js';
import type { Vec2 } from '../math/Vec2.js';
import { applyImpulse, stepAngleSpring, stepSpring, stepSpring1D } from './DetSpring.js';
import { IKArmSolver } from './IKArmSolver.js';
import { computeWeaponSegment, solveWeaponPosition } from './WeaponPose.js';
import type { WeaponPositionInput, WeaponPositionOutput } from './WeaponPose.js';
import { WeaponType } from '../enums/WeaponType.js';
import { weaponRegistry } from '../weapons/WeaponRegistry.js';
import { autoAdvancePhase, getActiveSpec, phaseProgress } from './AnimationPhase.js';
import {
  WALK_DIR_MIN_SPEED,
  computeRawTarget,
  currentLean,
  getPhaseAuthority,
  getSpringProfile,
  getSwayAmplitude,
} from './AnimationTargets.js';
import { WALL_MARGIN, WALL_SAMPLE_STEP, clampHandAgainstWalls } from './AnimationCollision.js';

// Re-export the public API so existing `import { ... } from '../stepAnimation.js'`
// (and `export * from './stepAnimation.js'` in index.ts) keep working
// byte-for-byte. Originally these symbols were defined in this file; they have
// been MOVED (not changed) into AnimationPhase.ts / AnimationTargets.ts.
export {
  createAnimSimState,
  snapToPose,
  getPhaseDurationTicks,
  setAnimPhase,
  startAttack,
  startStagger,
  onWeaponChanged,
  autoAdvancePhase,
  getActiveSpec,
  phaseProgress,
  DASH_TICKS,
  DYING_TICKS,
} from './AnimationPhase.js';

// ─── Rig constants (match the legacy client rig) ────────────────────────────

export const LEFT_SHOULDER_LOCAL: Vec2 = { x: 14.4, y: -26.4 };
export const RIGHT_SHOULDER_LOCAL: Vec2 = { x: 14.4, y: 26.4 };
export const UPPER_ARM_LEN = 30;
export const FOREARM_LEN = 26;

const leftArmSolver = new IKArmSolver(UPPER_ARM_LEN, FOREARM_LEN, -1);
const rightArmSolver = new IKArmSolver(UPPER_ARM_LEN, FOREARM_LEN, +1);

/** Elbow targets are velocity-advanced for livelier bends (legacy parity). */
const ELBOW_ADVANCE = 0.08;

const FIXED_DT = 1 / 60;

/** Max visual pull back of the weapon anchor against a wall (px). */
const WEAPON_WALL_PULLBACK_MAX = 16;

/**
 * Weapon angular-inertia ("whip") tuning. The blade angle lags the commanded
 * angle by a spring; these knobs control how strongly weight class differentiates
 * the feel — heavy weapons (wc 2-3) drag and trail, light weapons (wc 0-1) snap.
 * Tune by eye: raise `weightClassLag` for more contrast, lower `strikeStiffness`
 * for a floppier strike. Baselines (strike 3600 / windup 1800 / carry 900) match
 * the pre-juice values at weightClass 0.
 */
const WEAPON_WHIP = {
  strikeStiffness: 3600,
  /** Heavy weapons muscle through the strike slightly less rigidly. */
  strikeWeightDivisor: 0.35,
  windupStiffness: 1800,
  carryStiffness: 900,
  /** Per-weight-class lag multiplier applied to windup/carry stiffness. */
  weightClassLag: 0.6,
  lagDamping: 0.8,
} as const;

const _ikTarget: Vec2 = { x: 0, y: 0 };
const _weaponInput: WeaponPositionInput = {
  leftHand: { x: 0, y: 0 },
  rightHand: { x: 0, y: 0 },
  bodyX: 0,
  bodyY: 0,
  angle: 0,
  handOffset: 0,
  rotOffset: 0,
  strategy: 'hidden',
  attackBlend: 0,
};
const _laggedPos: WeaponPositionOutput = { x: 0, y: 0, rotation: 0, pointAngle: 0 };

/**
 * Advance the sim one tick and produce the world-space pose.
 *
 * Order: auto-advance phase → compute spring targets (local) → step springs →
 * IK + weapon segment (world). The caller (server combat / client renderer)
 * reads segments from the RESULT; reactions apply impulses via reactions.ts
 * between steps.
 */
export function stepAnimation(
  state: AnimSimState,
  input: AnimStepInput,
  out?: AnimStepResult,
): AnimStepResult {
  const result = out ?? createAnimStepResult();
  autoAdvancePhase(state, input);

  const spec = getActiveSpec(state, input.weaponType);
  const progress = phaseProgress(state, input.tick);

  // Stride accumulation (deterministic walk cycle)
  if (input.isMoving) {
    const speed = Math.sqrt(input.bodyVelX ** 2 + input.bodyVelY ** 2);
    state.strideDistance += speed * FIXED_DT;
    // Smooth the WORLD-space walk direction so the swing axis is stable —
    // instantaneous velocity (especially client-side, derived from render
    // deltas) is too noisy to drive the swing directly. Only meaningful
    // speeds steer it; near-zero velocity keeps the last good direction.
    if (speed > WALK_DIR_MIN_SPEED) {
      const blend = 0.25;
      state.walkDirX += (input.bodyVelX / speed - state.walkDirX) * blend;
      state.walkDirY += (input.bodyVelY / speed - state.walkDirY) * blend;
      const len = Math.sqrt(state.walkDirX ** 2 + state.walkDirY ** 2);
      if (len > 1e-6) {
        state.walkDirX /= len;
        state.walkDirY /= len;
      }
    }
  }

  // Body velocity in LOCAL aim space (targets/springs live in local space)
  const cosA = Math.cos(input.facingAngle);
  const sinA = Math.sin(input.facingAngle);
  const localVelX = input.bodyVelX * cosA + input.bodyVelY * sinA;
  const localVelY = -input.bodyVelX * sinA + input.bodyVelY * cosA;

  const rawTarget = computeRawTarget(state, spec, input, progress);

  // Momentum sway from body acceleration. Velocity arrives in px/s but the
  // legacy-tuned factors expect px/TICK displacements — scale by FIXED_DT or
  // the sway/inherit effects are ~60× too strong (violent hand jitter).
  const tickVelX = localVelX * FIXED_DT;
  const tickVelY = localVelY * FIXED_DT;
  const swayAmp = getSwayAmplitude(state, spec, input.isMoving);
  const ax = tickVelX - state.prevBodyVelX;
  const ay = tickVelY - state.prevBodyVelY;
  state.prevBodyVelX = tickVelX;
  state.prevBodyVelY = tickVelY;
  if (swayAmp > 0) {
    const swingX = -ax * 0.4 * swayAmp;
    const swingY = -ay * 0.4 * swayAmp;
    rawTarget.left.x += swingX;
    rawTarget.left.y += swingY;
    rawTarget.right.x -= swingX;
    rawTarget.right.y -= swingY;
  }

  // Hands trail body movement slightly while idle/walking
  if (state.phase === AnimPhase.IDLE || state.phase === AnimPhase.WALK) {
    const inheritFactor = 0.15;
    applyImpulse(state.left, -tickVelX * inheritFactor, -tickVelY * inheritFactor);
    applyImpulse(state.right, -tickVelX * inheritFactor, -tickVelY * inheritFactor);
  }

  // Step the hand springs
  const profile = getSpringProfile(state, spec);
  // Post-impulse absorption: near-critical damping while a reaction impulse
  // is being soaked up, so the arms deflect once and settle instead of
  // ringing at the stiff strike-spring frequency (reads as jitter).
  const damping = state.reactionDampTicks > 0 ? Math.max(profile.damping, 0.95) : profile.damping;
  stepSpring(state.left, rawTarget.left.x, rawTarget.left.y, profile.stiffness, damping);
  stepSpring(state.right, rawTarget.right.x, rawTarget.right.y, profile.stiffness, damping);
  if (state.recoveryDampTicks > 0) state.recoveryDampTicks--;
  if (state.reactionDampTicks > 0) state.reactionDampTicks--;

  // Pin the pose onto the authored path — strikes must traverse their arcs
  const w = spec.weightClass / 3;
  const authority = getPhaseAuthority(state.phase, progress, w);
  if (authority > 0) {
    state.left.x += (rawTarget.left.x - state.left.x) * authority;
    state.left.y += (rawTarget.left.y - state.left.y) * authority;
    state.right.x += (rawTarget.right.x - state.right.x) * authority;
    state.right.y += (rawTarget.right.y - state.right.y) * authority;
  }

  // Wall containment: hands never reach into solid tiles
  if (input.isWorldBlocked) {
    clampHandAgainstWalls(state.left, input.bodyX, input.bodyY, cosA, sinA, input.isWorldBlocked);
    clampHandAgainstWalls(state.right, input.bodyX, input.bodyY, cosA, sinA, input.isWorldBlocked);
  }

  // Body lean toward the strike (keyframe lean channel, default 0)
  const leanTarget = currentLean(state, spec, progress);
  stepSpring1D(state.bodyLean, leanTarget, 200, 0.7);

  // ── World-space outputs ──
  result.leftArm.hand.x = input.bodyX + state.left.x * cosA - state.left.y * sinA;
  result.leftArm.hand.y = input.bodyY + state.left.x * sinA + state.left.y * cosA;
  result.rightArm.hand.x = input.bodyX + state.right.x * cosA - state.right.y * sinA;
  result.rightArm.hand.y = input.bodyY + state.right.x * sinA + state.right.y * cosA;

  // IK targets advanced by spring velocity for livelier elbows (legacy parity)
  _ikTarget.x = state.left.x + state.left.vx * ELBOW_ADVANCE;
  _ikTarget.y = state.left.y + state.left.vy * ELBOW_ADVANCE;
  const leftIK = leftArmSolver.solve(LEFT_SHOULDER_LOCAL, _ikTarget);
  _ikTarget.x = state.right.x + state.right.vx * ELBOW_ADVANCE;
  _ikTarget.y = state.right.y + state.right.vy * ELBOW_ADVANCE;
  const rightIK = rightArmSolver.solve(RIGHT_SHOULDER_LOCAL, _ikTarget);

  result.leftArm.shoulder.x =
    input.bodyX + LEFT_SHOULDER_LOCAL.x * cosA - LEFT_SHOULDER_LOCAL.y * sinA;
  result.leftArm.shoulder.y =
    input.bodyY + LEFT_SHOULDER_LOCAL.x * sinA + LEFT_SHOULDER_LOCAL.y * cosA;
  result.leftArm.elbow.x = input.bodyX + leftIK.elbow.x * cosA - leftIK.elbow.y * sinA;
  result.leftArm.elbow.y = input.bodyY + leftIK.elbow.x * sinA + leftIK.elbow.y * cosA;
  result.leftArm.shoulderAngle = leftIK.shoulderAngle + input.facingAngle;
  result.leftArm.elbowAngle = leftIK.elbowAngle;
  result.leftArm.reachable = leftIK.reachable;

  result.rightArm.shoulder.x =
    input.bodyX + RIGHT_SHOULDER_LOCAL.x * cosA - RIGHT_SHOULDER_LOCAL.y * sinA;
  result.rightArm.shoulder.y =
    input.bodyY + RIGHT_SHOULDER_LOCAL.x * sinA + RIGHT_SHOULDER_LOCAL.y * cosA;
  result.rightArm.elbow.x = input.bodyX + rightIK.elbow.x * cosA - rightIK.elbow.y * sinA;
  result.rightArm.elbow.y = input.bodyY + rightIK.elbow.x * sinA + rightIK.elbow.y * cosA;
  result.rightArm.shoulderAngle = rightIK.shoulderAngle + input.facingAngle;
  result.rightArm.elbowAngle = rightIK.elbowAngle;
  result.rightArm.reachable = rightIK.reachable;

  // Carry → radial blend for radial weapons
  let attackBlend = 0;
  if (state.phase === AnimPhase.WINDUP) attackBlend = progress;
  else if (state.phase === AnimPhase.STRIKE) attackBlend = 1;
  else if (state.phase === AnimPhase.RECOVER) attackBlend = Math.max(0, 1 - progress);

  const visualType = state.attackWeaponType >= 0 ? state.attackWeaponType : input.weaponType;
  // Re-look up the weapon visual config only when the effective visual type
  // changes (weapon swap, attack begin/end). The static per-type offsets are
  // cached on AnimSimState so the hot path avoids a Map lookup + try/catch.
  if (visualType !== state.cachedVisualType) {
    state.cachedVisualType = visualType;
    state.cachedHandOffset = 0;
    state.cachedRotationOffset = Math.PI / 2;
    try {
      const def = weaponRegistry.getDefinition(visualType as WeaponType);
      state.cachedHandOffset = def.visual.handOffset;
      state.cachedRotationOffset = def.visual.rotationOffset;
    } catch {
      // defaults already set above
    }
  }
  const visualHandOffset = state.cachedHandOffset;
  const visualRotationOffset = state.cachedRotationOffset;
  _weaponInput.leftHand = result.leftArm.hand;
  _weaponInput.rightHand = result.rightArm.hand;
  _weaponInput.bodyX = input.bodyX;
  _weaponInput.bodyY = input.bodyY;
  _weaponInput.angle = input.facingAngle;
  _weaponInput.handOffset = visualHandOffset;
  _weaponInput.rotOffset = visualRotationOffset;
  _weaponInput.strategy = spec.strategy;
  _weaponInput.attackBlend = attackBlend;
  const weaponPos = solveWeaponPosition(_weaponInput);

  // Weapon angular inertia: the blade angle lags the commanded angle —
  // heavier weapons whip later. During the STRIKE the blade is muscled
  // through the arc (near-rigid), otherwise the swing would never cover its
  // authored sweep within a handful of ticks; lag lives in carry/recover.
  // Weight class amplifies the whip: heavy weapons (wc 2-3) trail and drag,
  // light weapons (wc 0-1) snap crisp. Tune WEAPON_WHIP to intensify or
  // flatten the differential across the roster.
  const whip = 1 + spec.weightClass * WEAPON_WHIP.weightClassLag;
  const lagStiffness =
    state.phase === AnimPhase.STRIKE
      ? WEAPON_WHIP.strikeStiffness / (1 + spec.weightClass * WEAPON_WHIP.strikeWeightDivisor)
      : state.phase === AnimPhase.WINDUP
        ? WEAPON_WHIP.windupStiffness / whip
        : WEAPON_WHIP.carryStiffness / whip;
  stepAngleSpring(state.weaponLag, weaponPos.pointAngle, lagStiffness, WEAPON_WHIP.lagDamping);
  const laggedAngle = state.weaponLag.value;
  _laggedPos.x = weaponPos.x;
  _laggedPos.y = weaponPos.y;
  _laggedPos.pointAngle = laggedAngle;
  _laggedPos.rotation = laggedAngle + visualRotationOffset;

  const segment = computeWeaponSegment(_laggedPos, _weaponInput, spec.bladeLength);
  let segGripX = segment.grip.x;
  let segGripY = segment.grip.y;
  let segTipX = segment.tip.x;
  let segTipY = segment.tip.y;

  // Blade containment: clamp the segment at the first solid tile along the
  // blade and pull the sprite anchor back so steel doesn't render inside
  // walls. The contact is reported so combat can interrupt the swing.
  let wallContact = false;
  let wallContactX = 0;
  let wallContactY = 0;
  let wallPenetration = 0;
  if (input.isWorldBlocked) {
    const bladeDx = segTipX - segGripX;
    const bladeDy = segTipY - segGripY;
    const bladeLen = Math.sqrt(bladeDx * bladeDx + bladeDy * bladeDy);
    if (bladeLen > WALL_SAMPLE_STEP) {
      const bux = bladeDx / bladeLen;
      const buy = bladeDy / bladeLen;
      for (let d = WALL_SAMPLE_STEP; d <= bladeLen; d += WALL_SAMPLE_STEP) {
        const sx = segGripX + bux * Math.min(d, bladeLen);
        const sy = segGripY + buy * Math.min(d, bladeLen);
        if (input.isWorldBlocked(sx, sy)) {
          wallContact = true;
          wallContactX = sx;
          wallContactY = sy;
          const penetration = bladeLen - (d - WALL_SAMPLE_STEP) + WALL_MARGIN;
          wallPenetration = penetration;
          const pullback = Math.min(penetration, WEAPON_WALL_PULLBACK_MAX);
          _laggedPos.x -= bux * pullback;
          _laggedPos.y -= buy * pullback;
          const clampLen = Math.max(0, d - WALL_SAMPLE_STEP - WALL_MARGIN);
          segGripX -= bux * pullback;
          segGripY -= buy * pullback;
          segTipX = segGripX + bux * clampLen;
          segTipY = segGripY + buy * clampLen;
          break;
        }
      }
    }
  }

  // Record the strike segment so next tick's sweep has a (prev, cur) pair.
  // Consumers must read prevGrip/prevTip BEFORE calling stepAnimation.
  if (state.phase === AnimPhase.STRIKE) {
    state.prevGrip.x = segGripX;
    state.prevGrip.y = segGripY;
    state.prevTip.x = segTipX;
    state.prevTip.y = segTipY;
    state.hasPrevSegment = true;
  } else {
    state.hasPrevSegment = false;
  }

  result.weaponX = _laggedPos.x;
  result.weaponY = _laggedPos.y;
  result.weaponRotation = _laggedPos.rotation;
  result.grip.x = segGripX;
  result.grip.y = segGripY;
  result.tip.x = segTipX;
  result.tip.y = segTipY;
  result.attackBlend = attackBlend;
  result.bodyLean = state.bodyLean.value;
  result.phaseProgress = progress;
  result.wallContact = wallContact;
  result.wallContactX = wallContactX;
  result.wallContactY = wallContactY;
  result.wallPenetration = wallPenetration;
  return result;
}

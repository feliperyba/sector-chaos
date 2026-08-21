/**
 * AnimationTargets.ts — Spring target computation, spring profile selection,
 * phase authority, body lean, and the scratch singletons shared by
 * computePhaseTarget + computeRawTarget.
 *
 * Extracted VERBATIM from stepAnimation.ts — no calculation, constant, formula,
 * conditional, or operation order has been changed. The module-level scratch
 * objects (`_springProfile`, `_kfOut`, `_rawTargets`) remain module-level
 * singletons (zero-allocation hot path).
 *
 * NOTE: `RECOVERY_DAMP_ZETA` lives here (not in AnimationPhase) because
 * `getSpringProfile` (in this module) reads it. Keeping it in AnimationPhase
 * would require this module to import from AnimationPhase, which would form a
 * cycle (AnimationPhase already imports computePhaseTarget from here). The
 * value/usage is byte-identical to the original; only the file location changed.
 */
import { AnimPhase, type AnimSimState, type AnimStepInput, type HandTargets } from './AnimTypes.js';
import type { Vec2 } from '../math/Vec2.js';
import { interpolateKeyframesInto } from './AnimEasing.js';
import {
  type WeaponMotionSpec,
  type SpringProfile,
  getAttackCategoryForAttack,
  dashPose,
  staggerPose,
  dyingPose,
  blockPose,
} from './poses/index.js';

/** One full arm-swing cycle per this many px of travel. */
const STRIDE_LENGTH_PX = 140;

/** Min speed (px/s) before velocity is trusted to steer the walk direction. */
export const WALK_DIR_MIN_SPEED = 30;

/** Loose-damping zeta after a strike ends (legacy 0.12s ≈ 7 ticks). */
// Loose enough for follow-through life, tight enough not to wobble/jitter
const RECOVERY_DAMP_ZETA = 0.5;

/** DYING spring profile — limbs go floppy. */
const DYING_SPRING: SpringProfile = { stiffness: 20, damping: 0.25 };

const _springProfile: SpringProfile = { stiffness: 0, damping: 0 };
const _rawTargets: HandTargets = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
const _kfOut: { left: Vec2; right: Vec2 } = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

export function shouldMirror(state: AnimSimState): boolean {
  if (state.attackWeaponType < 0) return false;
  const cat = getAttackCategoryForAttack(state.attackWeaponType, state.attackType);
  return cat === 'fists' && state.comboIndex > 0 && (state.comboIndex & 1) === 0;
}

export function computePhaseTarget(
  state: AnimSimState,
  spec: WeaponMotionSpec,
  phaseSpec: {
    keyframes: WeaponMotionSpec['windup']['keyframes'];
    easing: WeaponMotionSpec['windup']['easing'];
  },
  progress: number,
): HandTargets {
  interpolateKeyframesInto(_kfOut, phaseSpec.keyframes, progress, phaseSpec.easing);
  if (shouldMirror(state)) {
    _rawTargets.left.x = _kfOut.right.x;
    _rawTargets.left.y = -_kfOut.right.y;
    _rawTargets.right.x = _kfOut.left.x;
    _rawTargets.right.y = -_kfOut.left.y;
  } else {
    _rawTargets.left.x = _kfOut.left.x;
    _rawTargets.left.y = _kfOut.left.y;
    _rawTargets.right.x = _kfOut.right.x;
    _rawTargets.right.y = _kfOut.right.y;
  }
  return _rawTargets;
}

export function computeRawTarget(
  state: AnimSimState,
  spec: WeaponMotionSpec,
  input: AnimStepInput,
  progress: number,
): HandTargets {
  switch (state.phase) {
    case AnimPhase.IDLE:
    case AnimPhase.WALK: {
      _rawTargets.left.x = spec.idle.left.x;
      _rawTargets.left.y = spec.idle.left.y;
      _rawTargets.right.x = spec.idle.right.x;
      _rawTargets.right.y = spec.idle.right.y;
      if (input.isMoving) {
        // Hand targets live in LOCAL aim space (+X = facing) — the smoothed
        // WORLD walk direction (state.walkDirX/Y, always unit length) must be
        // rotated into that frame, or the swing axis is only correct when
        // facing world-east.
        const cosF = Math.cos(input.facingAngle);
        const sinF = Math.sin(input.facingAngle);
        const moveDirX = state.walkDirX * cosF + state.walkDirY * sinF;
        const moveDirY = -state.walkDirX * sinF + state.walkDirY * cosF;
        // The stance is held — walking only ADDS a modest pump on top of the
        // idle pose. Swing axis is the walk direction, but the lateral
        // (local-Y) component is damped so strafing doesn't drag the hands
        // across the body.
        const axisX = moveDirX;
        const axisY = moveDirY * 0.35;
        const stridePhase = (state.strideDistance / STRIDE_LENGTH_PX) * Math.PI * 2;
        const swing = Math.sin(stridePhase);
        const swingAmp = 14 * spec.walkAmplitude;
        const twoHandGrip =
          spec.strategy === 'along-hands' || spec.strategy === 'follow-both-hands';
        if (twoHandGrip) {
          // Both hands share the weapon — they bob together (in phase) so the
          // grip stays rigid and the weapon glides instead of see-sawing.
          const bob = swing * swingAmp * 0.5;
          _rawTargets.left.x += axisX * bob;
          _rawTargets.left.y += axisY * bob;
          _rawTargets.right.x += axisX * bob;
          _rawTargets.right.y += axisY * bob;
        } else {
          const leftSwing = swing * swingAmp * spec.walkSwing.left;
          const rightSwing = -swing * swingAmp * spec.walkSwing.right;
          _rawTargets.left.x += axisX * leftSwing;
          _rawTargets.left.y += axisY * leftSwing;
          _rawTargets.right.x += axisX * rightSwing;
          _rawTargets.right.y += axisY * rightSwing;
        }
        // Subtle shared torso bob at double stride frequency (life, no wiggle)
        const bob2 = Math.sin(stridePhase * 2) * 1.5 * spec.walkAmplitude;
        _rawTargets.left.y += bob2;
        _rawTargets.right.y += bob2;
      } else {
        // Idle breathe: legacy sin(now/800) at 16.67ms/tick → sin(tick/48)
        const breathe = Math.sin(input.tick / 48) * 3;
        _rawTargets.left.y += breathe;
        _rawTargets.right.y += breathe;
        _rawTargets.left.x += breathe * 0.3;
        _rawTargets.right.x += breathe * 0.3;
      }
      return _rawTargets;
    }
    case AnimPhase.WINDUP:
      return computePhaseTarget(state, spec, spec.windup, progress);
    case AnimPhase.STRIKE:
      return computePhaseTarget(state, spec, spec.strike, progress);
    case AnimPhase.RECOVER:
      return computePhaseTarget(state, spec, spec.recover, progress);
    case AnimPhase.DASH: {
      const pose = dashPose(progress);
      _rawTargets.left.x = pose.left.x;
      _rawTargets.left.y = pose.left.y;
      _rawTargets.right.x = pose.right.x;
      _rawTargets.right.y = pose.right.y;
      return _rawTargets;
    }
    case AnimPhase.STAGGER: {
      const pose = staggerPose(progress, input.tick);
      _rawTargets.left.x = pose.left.x;
      _rawTargets.left.y = pose.left.y;
      _rawTargets.right.x = pose.right.x;
      _rawTargets.right.y = pose.right.y;
      return _rawTargets;
    }
    case AnimPhase.DYING: {
      const pose = dyingPose(progress);
      _rawTargets.left.x = pose.left.x;
      _rawTargets.left.y = pose.left.y;
      _rawTargets.right.x = pose.right.x;
      _rawTargets.right.y = pose.right.y;
      return _rawTargets;
    }
    case AnimPhase.BLOCK: {
      const pose = blockPose(spec.block.hold, input.tick);
      _rawTargets.left.x = pose.left.x;
      _rawTargets.left.y = pose.left.y;
      _rawTargets.right.x = pose.right.x;
      _rawTargets.right.y = pose.right.y;
      return _rawTargets;
    }
    default:
      _rawTargets.left.x = spec.idle.left.x;
      _rawTargets.left.y = spec.idle.left.y;
      _rawTargets.right.x = spec.idle.right.x;
      _rawTargets.right.y = spec.idle.right.y;
      return _rawTargets;
  }
}

export function getSpringProfile(state: AnimSimState, spec: WeaponMotionSpec): SpringProfile {
  const w = spec.weightClass / 3;
  switch (state.phase) {
    case AnimPhase.WINDUP:
      _springProfile.stiffness = spec.windup.spring.stiffness * (0.5 + 0.5 * w);
      _springProfile.damping = spec.windup.spring.damping;
      return _springProfile;
    case AnimPhase.STRIKE:
      _springProfile.stiffness = spec.strike.spring.stiffness * (0.5 + 0.5 * w);
      _springProfile.damping = spec.strike.spring.damping;
      return _springProfile;
    case AnimPhase.RECOVER:
      _springProfile.stiffness = spec.recover.spring.stiffness;
      _springProfile.damping =
        state.recoveryDampTicks > 0 ? RECOVERY_DAMP_ZETA : spec.recover.spring.damping;
      return _springProfile;
    case AnimPhase.BLOCK:
      return spec.block.spring;
    case AnimPhase.DYING:
      return DYING_SPRING;
    default:
      return spec.idleSpring;
  }
}

/**
 * Pose authority: how hard the pose is pinned to the authored keyframe path,
 * blended on top of the springs each tick. This is what makes strikes
 * actually TRAVERSE their arcs (the hitbox follows the simulated blade — a
 * lagging spring alone never covers the swing within a 5–16 tick strike) and
 * what separates windup anticipation from the hit. Springs keep the residual
 * life: reactions/impulses still deflect the pose and get pulled back.
 * Pure function of phase/progress/weight — deterministic on both sides.
 * (Port of the legacy client's SpringVec2 `authority` snap.)
 */
export function getPhaseAuthority(phase: AnimPhase, progress: number, w: number): number {
  switch (phase) {
    case AnimPhase.WINDUP:
      return 0.35 * progress;
    case AnimPhase.STRIKE: {
      const peak = 0.6 + 0.15 * w;
      if (progress < 0.55) return peak;
      // Release the pose into the springs toward the end of the strike
      return peak - ((progress - 0.55) / 0.45) * (peak - 0.15);
    }
    case AnimPhase.BLOCK:
      return 0.3;
    default:
      return 0;
  }
}

export function getSwayAmplitude(
  state: AnimSimState,
  spec: WeaponMotionSpec,
  isMoving: boolean,
): number {
  if (!isMoving) return 0;
  switch (state.phase) {
    case AnimPhase.IDLE:
    case AnimPhase.WALK:
      // Half strength — full acceleration sway on top of the stride pump
      // reads as wiggle, not weight.
      return spec.walkAmplitude * 0.5;
    case AnimPhase.WINDUP:
    case AnimPhase.STRIKE:
    case AnimPhase.RECOVER:
      return spec.walkAmplitude * 0.2;
    case AnimPhase.BLOCK:
      return spec.walkAmplitude * 0.1;
    default:
      return 0;
  }
}

export function currentLean(state: AnimSimState, spec: WeaponMotionSpec, progress: number): number {
  let phaseSpec;
  switch (state.phase) {
    case AnimPhase.WINDUP:
      phaseSpec = spec.windup;
      break;
    case AnimPhase.STRIKE:
      phaseSpec = spec.strike;
      break;
    case AnimPhase.RECOVER:
      phaseSpec = spec.recover;
      break;
    default:
      return 0;
  }
  // Lean channel: piecewise-linear over keyframes that define it.
  // Iterate keyframes directly (no .filter().map() allocation), tracking
  // consecutive lean-bearing entries as (prev, cur) segments.
  const keyframes = phaseSpec.keyframes;
  let prevProgress = 0;
  let prevValue = 0;
  let lastValue = 0;
  let hasAny = false;
  for (let i = 0; i < keyframes.length; i++) {
    const k = keyframes[i]!;
    if (k.lean === undefined) continue;
    const curProgress = k.progress;
    const curValue = k.lean;
    lastValue = curValue;
    if (!hasAny) {
      hasAny = true;
      prevProgress = curProgress;
      prevValue = curValue;
      if (progress <= curProgress) return curValue;
      continue;
    }
    if (progress <= curProgress) {
      const t = (progress - prevProgress) / Math.max(1e-6, curProgress - prevProgress);
      return prevValue + (curValue - prevValue) * t;
    }
    prevProgress = curProgress;
    prevValue = curValue;
  }
  if (!hasAny) return 0;
  return lastValue;
}

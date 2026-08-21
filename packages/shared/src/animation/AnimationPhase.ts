/**
 * AnimationPhase.ts — Animation state lifecycle + phase machine.
 *
 * Extracted VERBATIM from stepAnimation.ts — no calculation, constant, formula,
 * conditional, or operation order has been changed.
 *
 * One-directional dependency: this module imports `computePhaseTarget` +
 * `shouldMirror` from `./AnimationTargets.js` (setAnimPhase calls
 * computePhaseTarget during WINDUP/STRIKE transitions). AnimationTargets does
 * NOT import from this module — no cycle.
 */
import { AnimPhase, type AnimSimState, type AnimStepInput, type HandTargets } from './AnimTypes.js';
import { applyImpulse, createSpringState, createSpringState1D, snapSpring } from './DetSpring.js';
import { WEAPON_MOTIONS, getMotionSpec, type WeaponMotionSpec } from './poses/index.js';
import { getWindupTicks, getCooldownTicks } from './AnimTiming.js';
import { AttackType } from '../enums/AttackType.js';
import { WeaponType } from '../enums/WeaponType.js';
import { PLAYER } from '../constants/player.js';
import { COMBAT } from '../constants/combat.js';
import { computePhaseTarget, shouldMirror } from './AnimationTargets.js';

export const DASH_TICKS = PLAYER.DASH_DURATION_TICKS;
export const DYING_TICKS = Math.round(COMBAT.DEATH_ANIMATION_DURATION * 60);

/** Loose-damping window after a strike ends (legacy 0.12s ≈ 7 ticks). */
const RECOVERY_DAMP_TICKS = 7;

// ─── State lifecycle ─────────────────────────────────────────────────────────

export function createAnimSimState(weaponType: number, tick: number): AnimSimState {
  const spec = WEAPON_MOTIONS[weaponType as WeaponType] ?? WEAPON_MOTIONS[WeaponType.FISTS];
  return {
    phase: AnimPhase.IDLE,
    phaseStartTick: tick,
    comboIndex: 0,
    strideDistance: 0,
    walkDirX: 1,
    walkDirY: 0,
    left: createSpringState(spec.idle.left.x, spec.idle.left.y),
    right: createSpringState(spec.idle.right.x, spec.idle.right.y),
    weaponLag: createSpringState1D(0),
    bodyLean: createSpringState1D(0),
    prevBodyVelX: 0,
    prevBodyVelY: 0,
    prevGrip: { x: 0, y: 0 },
    prevTip: { x: 0, y: 0 },
    hasPrevSegment: false,
    attackWeaponType: -1,
    attackType: '',
    swingInterrupted: false,
    phaseDurationTicks: 0,
    recoveryDampTicks: 0,
    reactionDampTicks: 0,
    cachedVisualType: -1,
    cachedHandOffset: 0,
    cachedRotationOffset: Math.PI / 2,
  };
}

/** Snap springs to the current keyframe target (late join / large desync). */
export function snapToPose(state: AnimSimState, targets: HandTargets): void {
  snapSpring(state.left, targets.left.x, targets.left.y);
  snapSpring(state.right, targets.right.x, targets.right.y);
}

// ─── Phase machine ───────────────────────────────────────────────────────────

export function getActiveSpec(state: AnimSimState, weaponType: number): WeaponMotionSpec {
  const inAttack =
    state.phase === AnimPhase.WINDUP ||
    state.phase === AnimPhase.STRIKE ||
    state.phase === AnimPhase.RECOVER;
  if (inAttack && state.attackWeaponType >= 0) {
    return getMotionSpec(state.attackWeaponType, state.attackType);
  }
  return getMotionSpec(weaponType);
}

export function getPhaseDurationTicks(state: AnimSimState): number {
  switch (state.phase) {
    case AnimPhase.WINDUP:
      return getWindupTicks(
        state.attackWeaponType,
        state.attackType ? (state.attackType as AttackType) : undefined,
      );
    case AnimPhase.STRIKE:
      return getMotionSpec(state.attackWeaponType, state.attackType).strike.ticks;
    case AnimPhase.RECOVER: {
      const spec = getMotionSpec(state.attackWeaponType, state.attackType);
      return Math.max(1, getCooldownTicks(state.attackWeaponType) - spec.strike.ticks);
    }
    case AnimPhase.DASH:
      return DASH_TICKS;
    case AnimPhase.STAGGER:
      return Math.max(1, state.phaseDurationTicks);
    case AnimPhase.DYING:
      return DYING_TICKS;
    default:
      return 0; // IDLE / WALK / BLOCK have no fixed duration
  }
}

export function phaseProgress(state: AnimSimState, tick: number): number {
  const duration = getPhaseDurationTicks(state);
  if (duration <= 0) return 0;
  return Math.min(1, Math.max(0, (tick - state.phaseStartTick) / duration));
}

/**
 * Transition the sim to a new phase at `tick`, applying the same momentum
 * impulses both sides (legacy onStateTransition parity, weight from spec).
 */
export function setAnimPhase(state: AnimSimState, phase: AnimPhase, tick: number): void {
  const from = state.phase;
  if (from === phase) return;
  state.phase = phase;
  state.phaseStartTick = tick;

  const spec = getMotionSpec(
    state.attackWeaponType >= 0 ? state.attackWeaponType : WeaponType.FISTS,
    state.attackType,
  );
  const w = spec.weightClass / 3;

  // WINDUP → STRIKE: commitment kick toward the strike hand's travel direction
  if (from === AnimPhase.WINDUP && phase === AnimPhase.STRIKE) {
    const strikeMid = computePhaseTarget(state, spec, spec.strike, 0.35);
    const punchHand = shouldMirror(state) ? strikeMid.left : strikeMid.right;
    const idleHand = shouldMirror(state) ? spec.idle.left : spec.idle.right;
    const dx = punchHand.x - idleHand.x;
    const dy = punchHand.y - idleHand.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0.01) {
      const impulseMag = dist * (1.5 + w * 2.5);
      const dirX = dx / dist;
      const dirY = dy / dist;
      applyImpulse(state.left, dirX * impulseMag, dirY * impulseMag * 0.5);
      applyImpulse(state.right, dirX * impulseMag, dirY * impulseMag * 0.5);
    }
  }

  // STRIKE → RECOVER: overshoot along current velocity + pull-home, loose damping
  if (from === AnimPhase.STRIKE && phase === AnimPhase.RECOVER) {
    const overshoot = (10 + spec.weightClass * 4) * 3;
    const speed = Math.sqrt(state.right.vx * state.right.vx + state.right.vy * state.right.vy);
    if (speed > 1) {
      const dirX = state.right.vx / speed;
      const dirY = state.right.vy / speed;
      applyImpulse(state.right, dirX * overshoot, dirY * overshoot);
      applyImpulse(state.left, dirX * overshoot * 0.5, dirY * overshoot * 0.5);
    }
    const impulseScale = 0.3 + w * 0.7;
    applyImpulse(
      state.left,
      (spec.idle.left.x - state.left.x) * impulseScale,
      (spec.idle.left.y - state.left.y) * impulseScale,
    );
    applyImpulse(
      state.right,
      (spec.idle.right.x - state.right.x) * impulseScale,
      (spec.idle.right.y - state.right.y) * impulseScale,
    );
    state.recoveryDampTicks = RECOVERY_DAMP_TICKS;
  }

  // entering STAGGER: arms fling
  if (phase === AnimPhase.STAGGER) {
    const flingMag = 90 * (1 + w * 0.5);
    applyImpulse(state.left, -flingMag, -flingMag * 0.6);
    applyImpulse(state.right, -flingMag, flingMag * 0.6);
  }

  // IDLE/WALK → WINDUP: anticipation pull opposite the chamber direction
  if ((from === AnimPhase.IDLE || from === AnimPhase.WALK) && phase === AnimPhase.WINDUP) {
    const windupEnd = computePhaseTarget(state, spec, spec.windup, 1.0);
    const punchHand = shouldMirror(state) ? windupEnd.left : windupEnd.right;
    const idleHand = shouldMirror(state) ? spec.idle.left : spec.idle.right;
    const dx = punchHand.x - idleHand.x;
    const dy = punchHand.y - idleHand.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0.01) {
      const impulseMag = dist * 0.5;
      applyImpulse(state.left, (-dx / dist) * impulseMag, (-dy / dist) * impulseMag * 0.3);
      applyImpulse(state.right, (-dx / dist) * impulseMag, (-dy / dist) * impulseMag * 0.3);
    }
  }

  if (phase !== AnimPhase.STRIKE) {
    state.hasPrevSegment = false;
  }
  if (phase === AnimPhase.STRIKE) {
    state.swingInterrupted = false;
    state.hasPrevSegment = false;
  }
}

/** Begin an attack cycle: WINDUP with the given weapon/attack context. */
export function startAttack(
  state: AnimSimState,
  tick: number,
  weaponType: number,
  attackType: string,
): void {
  state.attackWeaponType = weaponType;
  state.attackType = attackType;
  state.comboIndex++;
  setAnimPhase(state, AnimPhase.WINDUP, tick);
}

/** Begin a stagger with an explicit duration (weapon break vs shield break). */
export function startStagger(state: AnimSimState, tick: number, durationTicks: number): void {
  state.phaseDurationTicks = durationTicks;
  setAnimPhase(state, AnimPhase.STAGGER, tick);
}

/**
 * The equipped weapon changed (swap, break, throw release, pickup) — react
 * identically on server and client:
 *  - Mid-throw, the weapon leaving the hand IS the authored cycle — let it
 *    finish (the segment is not a damage hitbox during throws).
 *  - Any other mid-cycle change (break / hot-swap) cancels the swing: the
 *    weapon that defined the motion and hitbox no longer exists.
 *  - Outside combat, snap the hands to the new weapon's ready stance.
 */
export function onWeaponChanged(state: AnimSimState, tick: number, newWeaponType: number): void {
  const inAttackCycle =
    state.phase === AnimPhase.WINDUP ||
    state.phase === AnimPhase.STRIKE ||
    state.phase === AnimPhase.RECOVER;

  if (inAttackCycle) {
    if (state.attackType === AttackType.THROWN) return;
    if (state.attackWeaponType === newWeaponType) return;
    state.attackWeaponType = -1;
    state.attackType = '';
    setAnimPhase(state, AnimPhase.IDLE, tick);
    return;
  }

  // A held block dies with the weapon that provided it — exit immediately
  // rather than waiting for a blockHeld release that may never arrive.
  if (state.phase === AnimPhase.BLOCK) {
    setAnimPhase(state, AnimPhase.IDLE, tick);
  }

  snapToPose(state, getMotionSpec(Math.max(0, newWeaponType)).idle);
}

// ─── Per-tick step ───────────────────────────────────────────────────────────

export function autoAdvancePhase(state: AnimSimState, input: AnimStepInput): void {
  const tick = input.tick;
  const duration = getPhaseDurationTicks(state);
  const elapsed = tick - state.phaseStartTick;

  switch (state.phase) {
    case AnimPhase.WINDUP:
      if (elapsed >= duration) setAnimPhase(state, AnimPhase.STRIKE, tick);
      break;
    case AnimPhase.STRIKE:
      if (state.swingInterrupted || elapsed >= duration) {
        setAnimPhase(state, AnimPhase.RECOVER, tick);
      }
      break;
    case AnimPhase.RECOVER:
      if (elapsed >= duration) {
        state.attackWeaponType = -1;
        state.attackType = '';
        setAnimPhase(state, input.isMoving ? AnimPhase.WALK : AnimPhase.IDLE, tick);
      }
      break;
    case AnimPhase.DASH:
    case AnimPhase.STAGGER:
      if (elapsed >= duration) {
        setAnimPhase(state, input.isMoving ? AnimPhase.WALK : AnimPhase.IDLE, tick);
      }
      break;
    case AnimPhase.DYING:
      break; // terminal — holds until the entity is removed
    case AnimPhase.BLOCK:
      if (!input.blockHeld) {
        setAnimPhase(state, input.isMoving ? AnimPhase.WALK : AnimPhase.IDLE, tick);
      }
      break;
    case AnimPhase.IDLE:
    case AnimPhase.WALK:
      if (input.blockHeld) {
        setAnimPhase(state, AnimPhase.BLOCK, tick);
      } else if (input.isMoving && state.phase === AnimPhase.IDLE) {
        setAnimPhase(state, AnimPhase.WALK, tick);
      } else if (!input.isMoving && state.phase === AnimPhase.WALK) {
        setAnimPhase(state, AnimPhase.IDLE, tick);
      }
      break;
  }
}

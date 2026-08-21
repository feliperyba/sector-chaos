/**
 * AnimTypes.ts — Core types for the shared deterministic animation simulation.
 *
 * The animation sim runs identically on server (authoritative) and client
 * (prediction + remote reconstruction). Everything here is plain serializable
 * data — no classes, no timers, no wall-clock time. One step = one 60Hz tick.
 *
 * Local pose space: +X = forward (aim direction), +Y = perpendicular right.
 * World space: standard map coordinates; local poses are rotated by
 * facingAngle and translated by body position.
 *
 * DETERMINISM CONTRACT (same pattern as simulatePhysicsStep):
 *  - no Date.now / performance.now — oscillators derive from tick counters
 *  - no Math.random — variation derives from comboIndex / tick hashes
 *  - fixed substep count per tick (see DetSpring)
 *  - cross-engine Math.sin/cos float variance is acceptable: the server is
 *    authoritative and client reconciliation corrects drift.
 */

import type { Vec2 } from '../math/Vec2.js';

/** Plain spring state — position + velocity, serializable. */
export interface SpringState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Scalar spring state (used for weapon-lag angle, body lean). */
export interface SpringState1D {
  value: number;
  vel: number;
}

/**
 * Animation phases. Numeric values are synced over the wire (uint8) —
 * never reorder, only append.
 */
export enum AnimPhase {
  IDLE = 0,
  WALK = 1,
  WINDUP = 2,
  STRIKE = 3,
  RECOVER = 4,
  BLOCK = 5,
  DASH = 6,
  STAGGER = 7,
  DYING = 8,
}

export interface HandTargets {
  left: Vec2;
  right: Vec2;
}

/**
 * Full per-player animation simulation state.
 * Plain data — can be serialized, snapshotted, and restored mid-run.
 */
export interface AnimSimState {
  phase: AnimPhase;
  /** Tick at which the current phase began. */
  phaseStartTick: number;
  /** Attack alternation counter (fists parity, combo variants). */
  comboIndex: number;
  /** Accumulated stride distance (px) driving the walk cycle. */
  strideDistance: number;
  /** Smoothed walk direction in WORLD space (unit length; swing axis). */
  walkDirX: number;
  walkDirY: number;
  /** Hand springs in LOCAL aim space. */
  left: SpringState;
  right: SpringState;
  /** Weapon angular lag spring (radians, relative to commanded angle). */
  weaponLag: SpringState1D;
  /** Body lean spring (radians). */
  bodyLean: SpringState1D;
  /** Previous body velocity, for momentum-sway differencing. */
  prevBodyVelX: number;
  prevBodyVelY: number;
  /** Previous-tick weapon segment in WORLD space (for sweep tests). */
  prevGrip: Vec2;
  prevTip: Vec2;
  /** True once prevGrip/prevTip hold a valid previous-tick segment. */
  hasPrevSegment: boolean;
  /**
   * Attack context for the current WINDUP/STRIKE/RECOVER cycle.
   * Set when the attack starts; phases read durations from here.
   */
  attackWeaponType: number;
  /** AttackType string enum of the current attack ('' when none). */
  attackType: string;
  /** Swing interrupted (wall/clash) — STRIKE exits early to RECOVER. */
  swingInterrupted: boolean;
  /** Externally-set duration for variable phases (STAGGER), in ticks. */
  phaseDurationTicks: number;
  /** Remaining ticks of the post-strike loose-damping window. */
  recoveryDampTicks: number;
  /**
   * Remaining ticks of the post-impulse absorption window: reaction impulses
   * (recoil/flinch/clash) temporarily raise spring damping toward critical so
   * the arms deflect once and settle — underdamped strike springs would ring
   * at high frequency, which reads as jitter.
   */
  reactionDampTicks: number;
  /**
   * Cached visual config for the currently-rendered weapon type. Re-looked-up
   * only when the effective visual type changes (weapon swap, attack start/end)
   * to avoid a per-tick `weaponRegistry.getDefinition()` Map lookup + try/catch
   * in the hot path.
   */
  cachedVisualType: number;
  cachedHandOffset: number;
  cachedRotationOffset: number;
}

/** Per-tick input to the animation step — everything external the sim reads. */
export interface AnimStepInput {
  tick: number;
  facingAngle: number;
  bodyX: number;
  bodyY: number;
  /** Body velocity in WORLD space (px/s) from the movement sim. */
  bodyVelX: number;
  bodyVelY: number;
  isMoving: boolean;
  blockHeld: boolean;
  /** Currently equipped weapon type. */
  weaponType: number;
  /**
   * World-point blocking query (true = solid tile at this world position).
   * Both sides derive it from the SAME seeded tile grid, so pose containment
   * stays deterministic. Omitted → no wall containment.
   */
  isWorldBlocked?: (x: number, y: number) => boolean;
}

/** Solved arm joint output (world space). */
export interface ArmPose {
  shoulder: Vec2;
  elbow: Vec2;
  hand: Vec2;
  shoulderAngle: number;
  elbowAngle: number;
  reachable: boolean;
}

/** Per-tick output of the animation step — everything the renderer/combat reads. */
export interface AnimStepResult {
  leftArm: ArmPose;
  rightArm: ArmPose;
  /** Weapon sprite anchor + rotation (world space). */
  weaponX: number;
  weaponY: number;
  weaponRotation: number;
  /** Weapon hitbox segment in WORLD space (grip → tip). */
  grip: Vec2;
  tip: Vec2;
  /** 0..1 — carry-to-radial blend used by radial weapons. */
  attackBlend: number;
  /** Body lean (radians) for the renderer. */
  bodyLean: number;
  /** Normalized progress (0..1) within the current phase. */
  phaseProgress: number;
  /** The blade was clamped against a blocking tile this tick. */
  wallContact: boolean;
  /** Wall contact point (world), valid when wallContact is true. */
  wallContactX: number;
  wallContactY: number;
  /** How far (px) the unclamped blade would have run past the contact —
   *  distinguishes a graze (keep swinging) from a slam (interrupt). */
  wallPenetration: number;
}

/** Per-tick weapon animation segments exposed to melee sweep resolution. */
export interface TickSegments {
  /** Previous tick's strike segment (valid only when hasPrev). */
  prevGrip: Vec2;
  prevTip: Vec2;
  hasPrev: boolean;
  /** This tick's pose result (segment, hands, weapon transform). */
  result: AnimStepResult;
}

export function createArmPose(): ArmPose {
  return {
    shoulder: { x: 0, y: 0 },
    elbow: { x: 0, y: 0 },
    hand: { x: 0, y: 0 },
    shoulderAngle: 0,
    elbowAngle: 0,
    reachable: true,
  };
}

export function createAnimStepResult(): AnimStepResult {
  return {
    leftArm: createArmPose(),
    rightArm: createArmPose(),
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
}

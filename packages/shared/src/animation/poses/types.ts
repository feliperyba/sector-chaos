/**
 * poses/types.ts — WeaponMotionSpec: the authoring schema for per-weapon
 * procedural motion. Pure data; consumed by stepAnimation (both sides).
 *
 * Positions are in LOCAL aim space: +X = forward (aim direction),
 * +Y = perpendicular right. Designed for shoulder anchors at (+14.4, ±26.4)
 * with arm segments 30 + 26 px (hands may exceed IK reach — "rubber arms":
 * the hand/weapon follow the spring value; IK only shapes the elbow).
 */
import type { Vec2 } from '../../math/Vec2.js';
import type { HandTargets } from '../AnimTypes.js';
import type { EasingName } from '../AnimEasing.js';
import type { WeaponPositionStrategy } from '../WeaponPose.js';

export interface MotionKeyframe {
  progress: number;
  left: Vec2;
  right: Vec2;
  /** Per-segment easing: applies from THIS keyframe to the next one. */
  easing?: EasingName;
  /** Body lean (radians) at this keyframe (interpolated). */
  lean?: number;
  /** STRIKE only: clear the swing's hit set at this keyframe — re-arms
   *  multi-hit weapons (e.g. Double Axe return sweep). */
  clearsHitSet?: boolean;
}

export interface SpringProfile {
  stiffness: number;
  /** Damping ratio zeta. */
  damping: number;
}

export interface PhaseSpec {
  keyframes: MotionKeyframe[];
  easing: EasingName;
  spring: SpringProfile;
}

export interface StrikeSpec extends PhaseSpec {
  /** Strike duration in 60Hz ticks. Must be ≤ the weapon's cooldown ticks. */
  ticks: number;
  /** 0..1 of strike progress when the weapon hitbox goes live. */
  activeFrom: number;
  /** 0..1 of strike progress when the weapon hitbox ends. */
  activeTo: number;
}

export interface WeaponReactionScales {
  /** Victim arm flinch when this weapon's wielder is hit. */
  flinchScale: number;
  /** Clash recoil when this weapon is blocked / blocks. */
  clashScale: number;
  /** Recoil when this weapon strikes a wall. */
  wallScale: number;
  /** Attacker recoil on landing a hit. */
  recoilScale: number;
}

export interface WeaponMotionSpec {
  /** 0 = featherweight (dagger) … 3 = massive (hammer). */
  weightClass: 0 | 1 | 2 | 3;
  strategy: WeaponPositionStrategy;
  /**
   * Hitbox blade length (px) from the weapon anchor to the tip.
   * Authored (via solveBladeLength) so the tip's apex radius during the
   * strike equals the weapon's gameplay range — balance parity with the
   * legacy instant arc/line hitboxes.
   */
  bladeLength: number;
  /**
   * Hitbox blade thickness radius (px). The swept segment is tested against
   * an AABB expanded by this amount on all sides, so the effective hitbox
   * matches the visual weapon width. Per-category default from buildSpec.
   */
  bladeRadius: number;
  idle: HandTargets;
  idleSpring: SpringProfile;
  walkAmplitude: number;
  walkSwing: { left: number; right: number };
  windup: PhaseSpec;
  strike: StrikeSpec;
  recover: PhaseSpec;
  block: { hold: HandTargets; spring: SpringProfile };
  reactions: WeaponReactionScales;
}

export type AttackCategory = 'fists' | 'arc' | 'line' | 'ranged' | 'shield' | 'thrown';

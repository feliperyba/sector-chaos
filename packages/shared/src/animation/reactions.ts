/**
 * reactions.ts — Pure, deterministic reaction impulses.
 *
 * Server computes these inside the simulation at tick T and emits the
 * triggering event stamped T; clients apply the SAME pure function at their
 * sim's tick T. Both sides converge on identical poses because the inputs
 * (knockback vectors, contact normals, weight scales) travel in the events.
 *
 * All impulses are in LOCAL aim space (+X forward, +Y right) — use
 * worldToLocalVec to convert event-space vectors.
 */
import type { AnimSimState } from './AnimTypes.js';
import type { Vec2 } from '../math/Vec2.js';
import { applyImpulse } from './DetSpring.js';
import type { WeaponReactionScales } from './poses/types.js';

export interface ArmImpulses {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

/** Rotate a world-space vector into local aim space for `facingAngle`. */
export function worldToLocalVec(facingAngle: number, x: number, y: number): Vec2 {
  const cosA = Math.cos(facingAngle);
  const sinA = Math.sin(facingAngle);
  return { x: x * cosA + y * sinA, y: -x * sinA + y * cosA };
}

/** Ticks of raised damping after an impulse — one deflection, no ringing. */
export const REACTION_DAMP_TICKS = 10;

export function applyArmImpulses(state: AnimSimState, imp: ArmImpulses): void {
  applyImpulse(state.left, imp.leftX, imp.leftY);
  applyImpulse(state.right, imp.rightX, imp.rightY);
  state.reactionDampTicks = REACTION_DAMP_TICKS;
}

/**
 * Victim arm flinch from taking a hit. `localKb` is the knockback vector
 * rotated into the VICTIM's aim space; magnitude scales the flinch
 * (saturating at full knockback force).
 */
export function computeHitFlinch(
  localKbX: number,
  localKbY: number,
  victimWeightClass: number,
): ArmImpulses {
  const mag = Math.sqrt(localKbX * localKbX + localKbY * localKbY);
  if (mag < 0.001) return { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
  const ux = localKbX / mag;
  const uy = localKbY / mag;
  // Saturate at the standard knockback force; heavier bodies flinch less
  const strength = Math.min(mag, 400) * 0.3 * (1 - victimWeightClass * 0.15);
  // Slight asymmetry — arms fling with a perpendicular splay
  return {
    leftX: ux * strength - uy * strength * 0.35,
    leftY: uy * strength + ux * strength * 0.35,
    rightX: ux * strength + uy * strength * 0.35,
    rightY: uy * strength - ux * strength * 0.35,
  };
}

/**
 * Attacker recoil on landing a hit — the weapon "bites" and the arms get
 * pulled back against the swing direction.
 */
export function computeAttackerRecoil(
  localSwingDirX: number,
  localSwingDirY: number,
  scales: WeaponReactionScales,
): ArmImpulses {
  const mag = Math.sqrt(localSwingDirX * localSwingDirX + localSwingDirY * localSwingDirY);
  if (mag < 0.001) return { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
  const ux = localSwingDirX / mag;
  const uy = localSwingDirY / mag;
  const strength = 60 * scales.recoilScale;
  return {
    leftX: -ux * strength * 0.5,
    leftY: -uy * strength * 0.5,
    rightX: -ux * strength,
    rightY: -uy * strength,
  };
}

export interface ClashImpulses {
  attacker: ArmImpulses;
  defender: ArmImpulses;
}

/**
 * Weapon-vs-shield clash: attacker's swing bounces back along its travel
 * direction; defender's guard compresses along the contact normal (which
 * points FROM the attacker's weapon INTO the defender).
 */
export function computeBlockClash(
  attackerLocalSwingDirX: number,
  attackerLocalSwingDirY: number,
  defenderLocalNormalX: number,
  defenderLocalNormalY: number,
  attackerScales: WeaponReactionScales,
  defenderScales: WeaponReactionScales,
): ClashImpulses {
  const aMag = Math.sqrt(
    attackerLocalSwingDirX * attackerLocalSwingDirX +
      attackerLocalSwingDirY * attackerLocalSwingDirY,
  );
  const dMag = Math.sqrt(
    defenderLocalNormalX * defenderLocalNormalX + defenderLocalNormalY * defenderLocalNormalY,
  );
  const aStrength = 150 * attackerScales.clashScale;
  const dStrength = 100 * defenderScales.clashScale;
  const attacker: ArmImpulses =
    aMag < 0.001
      ? { leftX: 0, leftY: 0, rightX: 0, rightY: 0 }
      : {
          leftX: (-attackerLocalSwingDirX / aMag) * aStrength * 0.5,
          leftY: (-attackerLocalSwingDirY / aMag) * aStrength * 0.5,
          rightX: (-attackerLocalSwingDirX / aMag) * aStrength,
          rightY: (-attackerLocalSwingDirY / aMag) * aStrength,
        };
  const defender: ArmImpulses =
    dMag < 0.001
      ? { leftX: 0, leftY: 0, rightX: 0, rightY: 0 }
      : {
          leftX: (defenderLocalNormalX / dMag) * dStrength,
          leftY: (defenderLocalNormalY / dMag) * dStrength,
          rightX: (defenderLocalNormalX / dMag) * dStrength,
          rightY: (defenderLocalNormalY / dMag) * dStrength,
        };
  return { attacker, defender };
}

/**
 * Weapon hits a wall mid-swing: the blade stops dead and the arms recoil
 * against the swing's travel direction.
 */
export function computeWallRecoil(
  localSwingDirX: number,
  localSwingDirY: number,
  scales: WeaponReactionScales,
): ArmImpulses {
  const mag = Math.sqrt(localSwingDirX * localSwingDirX + localSwingDirY * localSwingDirY);
  if (mag < 0.001) return { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
  const ux = localSwingDirX / mag;
  const uy = localSwingDirY / mag;
  const strength = 120 * scales.wallScale;
  return {
    leftX: -ux * strength * 0.4,
    leftY: -uy * strength * 0.4,
    rightX: -ux * strength,
    rightY: -uy * strength,
  };
}

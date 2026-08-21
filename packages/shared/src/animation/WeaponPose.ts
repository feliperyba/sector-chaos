/**
 * WeaponPose.ts — Weapon position/rotation from hand positions, plus the
 * weapon hitbox segment (grip → tip) used by the server's swept melee.
 *
 * solveWeaponPosition moved from client-v3 WeaponPositionSolver.ts.
 *
 * Rotation-aware strategies:
 *   radial-right      → weapon at right hand; carry tilt at rest, radial during attack (arc, thrown)
 *   along-hands       → weapon anchored at butt hand, rotation follows hand-to-hand shaft angle (line/spears)
 *   follow-left       → weapon at left hand (grip) + handOffset in facing dir (ranged/bows)
 *   follow-both-hands → weapon at midpoint + handOffset forward (shields)
 *   hidden            → weapon at body center, invisible (fists)
 */
import type { Vec2 } from '../math/Vec2.js';
import { shortestAngleDelta } from '../math/ArcCalculation.js';

export type WeaponPositionStrategy =
  | 'radial-right'
  | 'along-hands'
  | 'follow-left'
  | 'follow-both-hands'
  | 'hidden';

export interface WeaponPositionInput {
  leftHand: Vec2;
  rightHand: Vec2;
  bodyX: number;
  bodyY: number;
  angle: number;
  handOffset: number;
  rotOffset: number;
  strategy: WeaponPositionStrategy;
  /**
   * radial-right only: 0 = carry orientation (facing + CARRY_TILT, weapon
   * rests tilted LEFT over the front like the equipped spec images),
   * 1 = full radial (weapon points out through the hand during the sweep).
   * Defaults to 1.
   */
  attackBlend?: number;
}

export interface WeaponPositionOutput {
  x: number;
  y: number;
  rotation: number;
  /** Direction the blade points (rotation without sprite rotOffset). */
  pointAngle: number;
}

/**
 * Carry tilt for radial weapons at rest: the weapon leans to the LEFT of the
 * facing direction (negative = counterclockwise), instead of pointing radially
 * out past the right hand. Tune by eye: more negative = steeper lean.
 */
export const CARRY_TILT = -0.6;

/** Reach of an unarmed strike beyond the knuckles (px). */
export const FIST_SEGMENT_LENGTH = 14;

/** Module-level scratches — callers must read values before the next call. */
const _weaponOutput: WeaponPositionOutput = { x: 0, y: 0, rotation: 0, pointAngle: 0 };
const _weaponSegment: WeaponSegment = { grip: { x: 0, y: 0 }, tip: { x: 0, y: 0 } };

/**
 * Compute weapon anchor world position + rotation from hand positions and
 * strategy. Writes into a module-level scratch — caller must read before
 * the next call. Pure math — no side effects beyond the scratch. O(1).
 */
export function solveWeaponPosition(input: WeaponPositionInput): WeaponPositionOutput {
  const cosA = Math.cos(input.angle);
  const sinA = Math.sin(input.angle);

  switch (input.strategy) {
    case 'radial-right': {
      // Pointing direction blends from the carry tilt (rest) to the radial
      // direction FROM body TO right hand (attack sweep)
      const dx = input.rightHand.x - input.bodyX;
      const dy = input.rightHand.y - input.bodyY;
      const radialAngle = Math.atan2(dy, dx);
      const blend = input.attackBlend ?? 1;
      const carryAngle = input.angle + CARRY_TILT;
      _weaponOutput.pointAngle =
        blend >= 1 ? radialAngle : carryAngle + shortestAngleDelta(carryAngle, radialAngle) * blend;
      _weaponOutput.x = input.rightHand.x + input.handOffset * Math.cos(_weaponOutput.pointAngle);
      _weaponOutput.y = input.rightHand.y + input.handOffset * Math.sin(_weaponOutput.pointAngle);
      _weaponOutput.rotation = _weaponOutput.pointAngle + input.rotOffset;
      return _weaponOutput;
    }

    case 'along-hands': {
      // Shaft runs from the right hand (butt) through the left hand (grip).
      // Anchor the sprite at the butt hand so BOTH hands lie on the shaft.
      const dx = input.leftHand.x - input.rightHand.x;
      const dy = input.leftHand.y - input.rightHand.y;
      const shaftAngle = Math.atan2(dy, dx);
      _weaponOutput.x = input.rightHand.x + input.handOffset * Math.cos(shaftAngle);
      _weaponOutput.y = input.rightHand.y + input.handOffset * Math.sin(shaftAngle);
      _weaponOutput.rotation = shaftAngle + input.rotOffset;
      _weaponOutput.pointAngle = shaftAngle;
      return _weaponOutput;
    }

    case 'follow-left':
      // Bow rides the left (grip) hand, facing direction for rotation
      _weaponOutput.x = input.leftHand.x + input.handOffset * cosA;
      _weaponOutput.y = input.leftHand.y + input.handOffset * sinA;
      _weaponOutput.rotation = input.angle + input.rotOffset;
      _weaponOutput.pointAngle = input.angle;
      return _weaponOutput;

    case 'follow-both-hands': {
      const mx = (input.leftHand.x + input.rightHand.x) / 2;
      const my = (input.leftHand.y + input.rightHand.y) / 2;
      _weaponOutput.x = mx + input.handOffset * cosA;
      _weaponOutput.y = my + input.handOffset * sinA;
      _weaponOutput.rotation = input.angle + input.rotOffset;
      _weaponOutput.pointAngle = input.angle;
      return _weaponOutput;
    }

    case 'hidden':
      _weaponOutput.x = input.bodyX;
      _weaponOutput.y = input.bodyY;
      _weaponOutput.rotation = input.angle + input.rotOffset;
      _weaponOutput.pointAngle = input.angle;
      return _weaponOutput;
  }
}

export interface WeaponSegment {
  grip: Vec2;
  tip: Vec2;
}

/**
 * Compute the weapon hitbox segment (grip → tip) in world space.
 * Writes into a module-level scratch — caller must read before the next call.
 *
 * `bladeLength` comes from the weapon's motion spec, authored so the tip's
 * apex radius equals the weapon's gameplay range.
 *
 * Strategy semantics:
 *   radial-right / along-hands → blade extends from the anchor along pointAngle
 *   follow-left (bows)         → short segment from grip hand along facing
 *   follow-both-hands (shield) → shield FACE: perpendicular to facing, centered
 *                                on the anchor, total width = bladeLength
 *   hidden (fists)             → short segment from the striking hand outward
 *                                (radial from body through the hand)
 */
export function computeWeaponSegment(
  pos: WeaponPositionOutput,
  input: WeaponPositionInput,
  bladeLength: number,
): WeaponSegment {
  switch (input.strategy) {
    case 'follow-both-hands': {
      // Shield face spans perpendicular to facing
      const px = Math.cos(input.angle + Math.PI / 2);
      const py = Math.sin(input.angle + Math.PI / 2);
      const half = bladeLength / 2;
      _weaponSegment.grip.x = pos.x - px * half;
      _weaponSegment.grip.y = pos.y - py * half;
      _weaponSegment.tip.x = pos.x + px * half;
      _weaponSegment.tip.y = pos.y + py * half;
      return _weaponSegment;
    }
    case 'hidden': {
      // Fist: strike segment extends radially from the body through the
      // FORWARD-most hand (the puncher) — callers pass hands already mirrored.
      const lf =
        (input.leftHand.x - input.bodyX) * Math.cos(input.angle) +
        (input.leftHand.y - input.bodyY) * Math.sin(input.angle);
      const rf =
        (input.rightHand.x - input.bodyX) * Math.cos(input.angle) +
        (input.rightHand.y - input.bodyY) * Math.sin(input.angle);
      const hand = lf > rf ? input.leftHand : input.rightHand;
      const dx = hand.x - input.bodyX;
      const dy = hand.y - input.bodyY;
      const len = Math.sqrt(dx * dx + dy * dy);
      const ux = len > 0.001 ? dx / len : Math.cos(input.angle);
      const uy = len > 0.001 ? dy / len : Math.sin(input.angle);
      const reach = bladeLength > 0 ? bladeLength : FIST_SEGMENT_LENGTH;
      _weaponSegment.grip.x = hand.x;
      _weaponSegment.grip.y = hand.y;
      _weaponSegment.tip.x = hand.x + ux * reach;
      _weaponSegment.tip.y = hand.y + uy * reach;
      return _weaponSegment;
    }
    default: {
      const ux = Math.cos(pos.pointAngle);
      const uy = Math.sin(pos.pointAngle);
      _weaponSegment.grip.x = pos.x;
      _weaponSegment.grip.y = pos.y;
      _weaponSegment.tip.x = pos.x + ux * bladeLength;
      _weaponSegment.tip.y = pos.y + uy * bladeLength;
      return _weaponSegment;
    }
  }
}

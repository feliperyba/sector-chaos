/**
 * categoryTemplates.ts — v1 motion templates, one per legacy attack category,
 * cloned from the client's POSE_CONFIGS. Each of the 16 weapon specs starts
 * from its category template (instant behavior parity with the old client
 * animations) and is then differentiated weapon-by-weapon.
 *
 * Phase mapping from the legacy system: windup → windup, impact → strike,
 * cooldown → recover.
 */
import type { AttackCategory, MotionKeyframe, SpringProfile, WeaponMotionSpec } from './types.js';
import type { EasingName } from '../AnimEasing.js';
import type { HandTargets } from '../AnimTypes.js';
import type { WeaponPositionStrategy } from '../WeaponPose.js';
import {
  solveBladeLength,
  solveStrikeExtension,
  scaleStrikeKeyframes,
} from './solveBladeLength.js';
import { getSpriteBladeLength, getSpriteBladeRadius } from './spriteBladeLengths.js';
import type { WeaponType } from '../../enums/WeaponType.js';

interface CategoryTemplate {
  strategy: WeaponPositionStrategy;
  idle: HandTargets;
  idleSpring: SpringProfile;
  walkAmplitude: number;
  walkSwing: { left: number; right: number };
  windup: { keyframes: MotionKeyframe[]; easing: EasingName; spring: SpringProfile };
  strike: { keyframes: MotionKeyframe[]; easing: EasingName; spring: SpringProfile };
  recover: { keyframes: MotionKeyframe[]; easing: EasingName; spring: SpringProfile };
  blockHold: HandTargets;
}

/** Keyframe authoring shorthand: progress, left x/y, right x/y, extras. */
export function kf(
  progress: number,
  lx: number,
  ly: number,
  rx: number,
  ry: number,
  extras?: Partial<Pick<MotionKeyframe, 'easing' | 'lean' | 'clearsHitSet'>>,
): MotionKeyframe {
  return { progress, left: { x: lx, y: ly }, right: { x: rx, y: ry }, ...extras };
}

/** Fresh template per call — specs must not share mutable keyframe objects. */
export function getCategoryTemplate(category: AttackCategory): CategoryTemplate {
  switch (category) {
    case 'fists':
      return {
        strategy: 'hidden',
        idle: { left: { x: 42, y: -58 }, right: { x: 42, y: 58 } },
        idleSpring: { stiffness: 200, damping: 0.7 },
        walkAmplitude: 1.0,
        walkSwing: { left: 1, right: 1 },
        windup: {
          easing: 'easeInCubic',
          spring: { stiffness: 2000, damping: 0.65 },
          keyframes: [
            kf(0, 42, -58, 42, 58),
            kf(0.3, 48, -52, 20, 52),
            kf(0.6, 54, -46, -8, 48),
            kf(1, 58, -44, -24, 44),
          ],
        },
        strike: {
          easing: 'easeOutExpo',
          spring: { stiffness: 8000, damping: 0.5 },
          keyframes: [
            kf(0, 58, -44, -24, 44),
            kf(0.2, 48, -54, 102, 36),
            kf(0.6, 46, -58, 96, 40),
            kf(1, 45, -58, 90, 42),
          ],
        },
        recover: {
          easing: 'easeOutCubic',
          spring: { stiffness: 200, damping: 0.75 },
          keyframes: [
            kf(0, 45, -58, 90, 42),
            kf(0.35, 44, -58, 58, 52),
            kf(0.7, 43, -58, 46, 56),
            kf(1, 42, -58, 42, 58),
          ],
        },
        blockHold: { left: { x: 33.6, y: -14.4 }, right: { x: 33.6, y: 14.4 } },
      };

    case 'arc':
      return {
        strategy: 'radial-right',
        idle: { left: { x: 36, y: -62 }, right: { x: 38, y: 60 } },
        idleSpring: { stiffness: 160, damping: 0.8 },
        walkAmplitude: 0.7,
        walkSwing: { left: 1, right: 0.4 },
        windup: {
          easing: 'easeInCubic',
          spring: { stiffness: 1500, damping: 0.7 },
          keyframes: [
            kf(0, 36, -62, 38, 60),
            kf(0.4, 28, -58, 30, -6),
            kf(0.7, 24, -64, 16, -44),
            kf(1, 20, -70, 8, -64),
          ],
        },
        strike: {
          easing: 'easeOutCubic',
          spring: { stiffness: 3400, damping: 0.5 },
          keyframes: [
            kf(0, 20, -70, 8, -64),
            kf(0.25, 28, -66, 58, -56),
            kf(0.5, 34, -62, 82, 0),
            kf(0.75, 36, -60, 58, 56),
            kf(1, 36, -62, 24, 88),
          ],
        },
        recover: {
          easing: 'easeOutElastic',
          spring: { stiffness: 150, damping: 0.85 },
          keyframes: [
            kf(0, 36, -62, 24, 88),
            kf(0.35, 36, -62, 34, 70),
            kf(0.7, 36, -62, 40, 62),
            kf(1, 36, -62, 38, 60),
          ],
        },
        blockHold: { left: { x: 33.6, y: -14.4 }, right: { x: 33.6, y: 14.4 } },
      };

    case 'line':
      return {
        strategy: 'along-hands',
        idle: { left: { x: 78, y: -16 }, right: { x: 26, y: 58 } },
        idleSpring: { stiffness: 180, damping: 0.85 },
        walkAmplitude: 0.4,
        walkSwing: { left: 0.3, right: 0.3 },
        windup: {
          easing: 'easeInCubic',
          spring: { stiffness: 1200, damping: 0.7 },
          keyframes: [
            kf(0, 78, -16, 26, 58),
            kf(0.4, 66, 28, 0, 52),
            kf(0.7, 58, 40, -18, 50),
            kf(1, 54, 46, -26, 48),
          ],
        },
        strike: {
          // Reference thrust (IK_LINE_*): both hands drive FORWARD together,
          // sliding to the shaft butt — the whole weapon length projects ahead
          // of the arms, then a partial draw-back.
          easing: 'easeOutExpo',
          spring: { stiffness: 4500, damping: 0.45 },
          keyframes: [
            kf(0, 54, 46, -26, 48),
            kf(0.22, 180, 18, 154, 23, { lean: 0.12 }),
            kf(0.6, 174, 19, 148, 24, { lean: 0.09 }),
            kf(1, 96, 36, 40, 44, { lean: 0.03 }),
          ],
        },
        recover: {
          easing: 'easeOutElastic',
          spring: { stiffness: 180, damping: 0.8 },
          keyframes: [
            kf(0, 96, 36, 40, 44),
            kf(0.35, 88, 12, 32, 52),
            kf(0.7, 80, -12, 27, 57),
            kf(1, 78, -16, 26, 58),
          ],
        },
        blockHold: { left: { x: 33.6, y: -14.4 }, right: { x: 33.6, y: 14.4 } },
      };

    case 'ranged':
      return {
        strategy: 'follow-left',
        // Hands reach forward (high +X) so the bow/crossbow reads as held out
        // in front of the player, not tucked at the head. (Body radius is 48;
        // pre-juice x≈42-52 sat the hands at the body edge.)
        idle: { left: { x: 82, y: -16 }, right: { x: 72, y: 16 } },
        idleSpring: { stiffness: 160, damping: 0.85 },
        walkAmplitude: 0.35,
        walkSwing: { left: 0.35, right: 0.35 },
        windup: {
          easing: 'easeInOutSine',
          spring: { stiffness: 900, damping: 0.8 },
          keyframes: [
            kf(0, 82, -16, 72, 16),
            kf(0.35, 90, -16, 56, 16),
            kf(0.7, 98, -15, 40, 15),
            kf(1, 102, -14, 30, 14),
          ],
        },
        strike: {
          easing: 'easeOutExpo',
          spring: { stiffness: 5000, damping: 0.4 },
          keyframes: [
            kf(0, 102, -14, 30, 14),
            kf(0.1, 114, -20, 56, 78),
            kf(0.3, 108, -18, 58, 84),
            kf(0.6, 94, -16, 66, 54),
            kf(1, 84, -16, 74, 22),
          ],
        },
        recover: {
          easing: 'easeOutElastic',
          spring: { stiffness: 140, damping: 0.85 },
          keyframes: [kf(0, 84, -16, 74, 22), kf(0.4, 82, -16, 72, 18), kf(1, 82, -16, 72, 16)],
        },
        blockHold: { left: { x: 33.6, y: -14.4 }, right: { x: 33.6, y: 14.4 } },
      };

    case 'shield':
      return {
        strategy: 'follow-both-hands',
        idle: { left: { x: 60, y: -26 }, right: { x: 60, y: 26 } },
        idleSpring: { stiffness: 200, damping: 0.9 },
        walkAmplitude: 0.25,
        walkSwing: { left: 0.25, right: 0.25 },
        windup: {
          easing: 'easeInCubic',
          spring: { stiffness: 1500, damping: 0.7 },
          keyframes: [kf(0, 60, -26, 60, 26), kf(0.5, 36, -22, 36, 22), kf(1, 18, -20, 18, 20)],
        },
        strike: {
          easing: 'easeOutBack',
          spring: { stiffness: 3200, damping: 0.5 },
          keyframes: [
            kf(0, 18, -20, 18, 20),
            kf(0.15, 92, -32, 92, 32),
            kf(0.45, 86, -30, 86, 30),
            kf(0.75, 70, -28, 70, 28),
            kf(1, 60, -26, 60, 26),
          ],
        },
        recover: {
          easing: 'easeOutBounce',
          spring: { stiffness: 160, damping: 0.85 },
          keyframes: [
            kf(0, 60, -26, 60, 26),
            kf(0.35, 57, -25, 57, 25),
            kf(0.7, 61, -26, 61, 26),
            kf(1, 60, -26, 60, 26),
          ],
        },
        blockHold: { left: { x: 66, y: -26 }, right: { x: 66, y: 26 } },
      };

    case 'thrown':
      return {
        strategy: 'radial-right',
        idle: { left: { x: 36, y: -62 }, right: { x: 38, y: 60 } },
        idleSpring: { stiffness: 160, damping: 0.8 },
        walkAmplitude: 0.8,
        walkSwing: { left: 1, right: 0.4 },
        windup: {
          easing: 'easeInCubic',
          spring: { stiffness: 1400, damping: 0.65 },
          keyframes: [
            kf(0, 36, -62, 38, 60),
            kf(0.3, 42, -58, 20, 72),
            kf(0.65, 48, -68, -18, 80),
            kf(1, 52, -72, -46, 74),
          ],
        },
        strike: {
          easing: 'easeOutExpo',
          spring: { stiffness: 4200, damping: 0.4 },
          keyframes: [
            kf(0, 52, -72, -46, 74),
            kf(0.18, 38, -76, 40, 84),
            kf(0.4, 16, -84, 88, 54),
            kf(0.7, 2, -88, 94, 56),
            kf(1, 8, -86, 90, 54),
          ],
        },
        recover: {
          easing: 'easeOutElastic',
          spring: { stiffness: 140, damping: 0.85 },
          keyframes: [
            kf(0, 8, -86, 90, 54),
            kf(0.3, 24, -74, 60, 58),
            kf(0.65, 34, -64, 44, 60),
            kf(1, 36, -62, 38, 60),
          ],
        },
        blockHold: { left: { x: 33.6, y: -14.4 }, right: { x: 33.6, y: 14.4 } },
      };
  }
}

export interface SpecParams {
  category: AttackCategory;
  weightClass: 0 | 1 | 2 | 3;
  /** Strike duration in 60Hz ticks. */
  strikeTicks: number;
  /** Hitbox live window within the strike (0..1). */
  activeFrom: number;
  activeTo: number;
  /** Melee reach (px) the tip apex must hit; 0 → use fixedBladeLength. */
  meleeRange: number;
  /** Weapon sprite grip offset from the hand (weaponDef.visual.handOffset). */
  handOffset: number;
  /** Used when meleeRange = 0 (ranged/shield — hitbox not range-driven). */
  fixedBladeLength?: number;
  /**
   * Weapon with sprite art: the bladeLength is pinned to the rendered sprite
   * blade (never scaled dynamically) and the STRIKE hand extension is solved
   * so the apex tip still reaches meleeRange — the motion carries the reach.
   */
  weaponType?: WeaponType;
}

/** Per-weapon motion overrides — the unique animation identity. Applied to
 *  the category template BEFORE the blade length is solved, so range parity
 *  holds for any authored strike path. */
export interface SpecOverrides {
  idle?: HandTargets;
  idleSpring?: SpringProfile;
  walkAmplitude?: number;
  walkSwing?: { left: number; right: number };
  windup?: Partial<Pick<CategoryTemplate['windup'], 'keyframes' | 'easing' | 'spring'>>;
  strike?: Partial<Pick<CategoryTemplate['strike'], 'keyframes' | 'easing' | 'spring'>>;
  recover?: Partial<Pick<CategoryTemplate['recover'], 'keyframes' | 'easing' | 'spring'>>;
  blockHold?: HandTargets;
}

/** Guard stance per weight class (non-shield weapons). */
function weightClassBlockHold(weightClass: number): HandTargets {
  switch (weightClass) {
    case 0: // quick high one-hand guard
      return { left: { x: 38, y: -12 }, right: { x: 40, y: 16 } };
    case 1: // angled brace
      return { left: { x: 34, y: -18 }, right: { x: 38, y: 14 } };
    default: // heavy two-hand brace, pulled close
      return { left: { x: 30, y: -10 }, right: { x: 32, y: 12 } };
  }
}

// Blade radius = half the weapon's physical width perpendicular to travel.
// Fists: hand sprite art is 34×34px at HAND_SCALE=1.0 → radius=17.
const CATEGORY_BLADE_RADIUS: Record<AttackCategory, number> = {
  fists: 17,
  arc: 16,
  line: 10,
  ranged: 0,
  shield: 28,
  thrown: 16,
};

/** Build a weapon spec from its category template + parameters + overrides. */
export function buildSpec(params: SpecParams, overrides: SpecOverrides = {}): WeaponMotionSpec {
  const t = getCategoryTemplate(params.category);
  const wt = params.weightClass;

  const windup = { ...t.windup, ...overrides.windup };
  const strike = { ...t.strike, ...overrides.strike };
  const recover = { ...t.recover, ...overrides.recover };

  const spriteBlade =
    params.weaponType != null ? getSpriteBladeLength(params.weaponType) : undefined;

  let bladeLength: number;
  if (params.meleeRange > 0 && spriteBlade != null) {
    // Sprite-true blade: never scale the art — solve the hand extension so
    // the strike apex tip equals the gameplay range.
    bladeLength = spriteBlade;
    const k = solveStrikeExtension(
      strike.keyframes,
      strike.easing,
      t.strategy,
      params.handOffset,
      bladeLength,
      params.meleeRange,
    );
    strike.keyframes = scaleStrikeKeyframes(strike.keyframes, k);
  } else if (params.meleeRange > 0) {
    bladeLength = solveBladeLength(
      strike.keyframes,
      strike.easing,
      t.strategy,
      params.handOffset,
      params.meleeRange,
    );
  } else {
    bladeLength = params.fixedBladeLength ?? 0;
  }

  const blockHold =
    overrides.blockHold ?? (params.category === 'shield' ? t.blockHold : weightClassBlockHold(wt));

  return {
    weightClass: wt,
    strategy: t.strategy,
    bladeLength,
    bladeRadius:
      params.weaponType != null
        ? (getSpriteBladeRadius(params.weaponType) ?? CATEGORY_BLADE_RADIUS[params.category]!)
        : CATEGORY_BLADE_RADIUS[params.category]!,
    idle: overrides.idle ?? t.idle,
    idleSpring: overrides.idleSpring ?? t.idleSpring,
    walkAmplitude: overrides.walkAmplitude ?? t.walkAmplitude,
    walkSwing: overrides.walkSwing ?? t.walkSwing,
    windup,
    strike: {
      ...strike,
      ticks: params.strikeTicks,
      activeFrom: params.activeFrom,
      activeTo: params.activeTo,
    },
    recover,
    block: { hold: blockHold, spring: { stiffness: 320, damping: 0.85 } },
    reactions: {
      flinchScale: 1 + wt * 0.5,
      clashScale: 0.8 + wt * 0.4,
      wallScale: 0.8 + wt * 0.4,
      recoilScale: 0.6 + wt * 0.3,
    },
  };
}

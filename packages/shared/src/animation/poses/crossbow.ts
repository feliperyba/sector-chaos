/**
 * Crossbow — braced hunched aim with both hands tight on the stock, a
 * mechanical recoil jolt on release, then a slow two-hand recock pull.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.CROSSBOW);

export const CROSSBOW_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'ranged',
    weaponType: WeaponType.CROSSBOW,
    weightClass: 3,
    strikeTicks: 4,
    activeFrom: 0.05,
    activeTo: 0.3,
    meleeRange: 0, // projectile resolution — segment not used for damage
    handOffset: def.visual.handOffset,
    fixedBladeLength: 36,
  },
  {
    // Both hands ride the stock — much tighter than the bow's spread grip.
    // Hands reach forward (+X) so the crossbow reads as held out in front of
    // the player, matching the bow's forward reach (see ranged template).
    idle: { left: { x: 86, y: -6 }, right: { x: 60, y: 8 } },
    walkAmplitude: 0.2,
    walkSwing: { left: 0.2, right: 0.2 },
    windup: {
      // Hunch into the brace — barely moves, all tension
      easing: 'easeInOutSine',
      spring: { stiffness: 1100, damping: 0.85 },
      keyframes: [kf(0, 86, -6, 60, 8), kf(1, 90, -4, 56, 6, { lean: -0.03 })],
    },
    strike: {
      // Mechanical recoil jolt: the whole frame kicks straight back
      easing: 'easeOutExpo',
      spring: { stiffness: 6500, damping: 0.5 },
      keyframes: [kf(0, 90, -4, 56, 6), kf(0.3, 76, -8, 44, 4), kf(1, 82, -6, 52, 6)],
    },
    recover: {
      // Slow recock: the string hand drags back along the stock and returns
      easing: 'easeInOutSine',
      spring: { stiffness: 150, damping: 0.85 },
      keyframes: [kf(0, 82, -6, 52, 6), kf(0.45, 84, -6, 32, 12), kf(1, 86, -6, 60, 8)],
    },
  },
);

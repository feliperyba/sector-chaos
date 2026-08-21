/**
 * Large Shield — full-body coil, lumbering two-hand wall-slam with an
 * overshoot wobble and a braced press before the recover.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.LARGE_SHIELD);

export const LARGE_SHIELD_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'shield',
    weaponType: WeaponType.LARGE_SHIELD,
    weightClass: 1,
    strikeTicks: 9,
    activeFrom: 0.1,
    activeTo: 0.7,
    meleeRange: 0, // shield bash resolution unchanged; face used for clashes
    handOffset: def.visual.handOffset,
    fixedBladeLength: 96, // shield face width
  },
  {
    windup: {
      // Full-body coil: the wall comes all the way back to the chest
      easing: 'easeInCubic',
      spring: { stiffness: 1200, damping: 0.75 },
      keyframes: [
        kf(0, 60, -26, 60, 26),
        kf(0.5, 38, -22, 38, 22),
        kf(1, 16, -20, 16, 20, { lean: -0.05 }),
      ],
    },
    strike: {
      // Lumbering slam with overshoot wobble, then a braced press
      easing: 'easeOutBack',
      spring: { stiffness: 2600, damping: 0.42 },
      keyframes: [
        kf(0, 16, -20, 16, 20),
        kf(0.2, 96, -34, 96, 34, { lean: 0.1 }),
        kf(0.4, 88, -30, 88, 30),
        kf(0.6, 92, -32, 92, 32, { lean: 0.06 }),
        kf(1, 66, -27, 66, 27),
      ],
    },
    recover: {
      // Heavy settle back into the braced stance
      easing: 'easeOutBounce',
      spring: { stiffness: 140, damping: 0.85 },
      keyframes: [kf(0, 66, -27, 66, 27), kf(0.5, 58, -25, 58, 25), kf(1, 60, -26, 60, 26)],
    },
  },
);

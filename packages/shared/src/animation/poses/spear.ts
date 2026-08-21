/**
 * Spear — side coil, step-in straight thrust with a held extension, quick
 * withdraw. The cleanest read of the line weapons: one beat in, one beat out.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.SPEAR);

export const SPEAR_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'line',
    weightClass: 1,
    strikeTicks: 7,
    activeFrom: 0.1,
    activeTo: 0.7,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.SPEAR,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Reference frame 1: shaft vertical (forward) beside the body — butt
      // hand at the hip, lead hand mid-shaft, slight rear coil
      easing: 'easeInCubic',
      spring: { stiffness: 1500, damping: 0.7 },
      keyframes: [
        kf(0, 78, -16, 26, 58),
        kf(0.45, 64, 30, 2, 54),
        kf(1, 56, 46, -10, 50, { lean: -0.04 }),
      ],
    },
    strike: {
      // Reference last frame: hands punch forward TOGETHER to the butt — the
      // full spear projects ahead of the arms; held extension, quick withdraw
      easing: 'easeOutExpo',
      spring: { stiffness: 5200, damping: 0.45 },
      keyframes: [
        kf(0, 56, 46, -10, 50),
        kf(0.2, 190, 17, 164, 22, { lean: 0.14 }),
        kf(0.6, 184, 18, 158, 23, { lean: 0.1 }),
        kf(1, 96, 36, 40, 44, { lean: 0.03 }),
      ],
    },
    recover: {
      // Draw the shaft back through the hands into the resting diagonal
      easing: 'easeOutElastic',
      spring: { stiffness: 180, damping: 0.8 },
      keyframes: [kf(0, 96, 36, 40, 44), kf(0.4, 86, 10, 30, 52), kf(1, 78, -16, 26, 58)],
    },
  },
);

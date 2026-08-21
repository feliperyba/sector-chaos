/**
 * Polearm — two-hand DEEP lunge thrust with heavy body lean, then a slow
 * haft-pivot withdraw. The longest reach in the game, paid for in recovery.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.POLEARM);

export const POLEARM_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'line',
    weightClass: 2,
    strikeTicks: 10,
    activeFrom: 0.1,
    activeTo: 0.7,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.POLEARM,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Deep coil: shaft drawn vertical beside the body, butt hand pulled
      // behind the hip — the longest weapon loads the deepest
      easing: 'easeInCubic',
      spring: { stiffness: 1100, damping: 0.72 },
      keyframes: [
        kf(0, 78, -16, 26, 58),
        kf(0.4, 62, 32, -2, 54),
        kf(0.75, 54, 44, -16, 50),
        kf(1, 50, 48, -24, 48, { lean: -0.06 }),
      ],
    },
    strike: {
      // Reference thrust at full commitment: hands ram forward to the butt,
      // whole haft ahead of the arms, heavy lean, long held extension
      easing: 'easeOutExpo',
      spring: { stiffness: 4600, damping: 0.45 },
      keyframes: [
        kf(0, 50, 48, -24, 48),
        kf(0.25, 210, 18, 182, 24, { lean: 0.18 }),
        kf(0.65, 202, 19, 174, 25, { lean: 0.14 }),
        kf(1, 100, 36, 42, 44, { lean: 0.05 }),
      ],
    },
    recover: {
      // Slow haft-pivot back across the front to the resting diagonal
      easing: 'easeInOutSine',
      spring: { stiffness: 130, damping: 0.85 },
      keyframes: [kf(0, 100, 36, 42, 44), kf(0.4, 86, 12, 30, 52), kf(1, 78, -16, 26, 58)],
    },
  },
);

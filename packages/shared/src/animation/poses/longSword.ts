/**
 * Long Sword — wide ~110° horizontal cleave left → right with body lean and
 * a long follow-through past the hip. The defining "knight" swing.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.LONG_SWORD);

export const LONG_SWORD_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 2,
    strikeTicks: 12,
    activeFrom: 0.05,
    activeTo: 0.85,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.LONG_SWORD,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Cross the blade far over the left shoulder
      easing: 'easeInCubic',
      spring: { stiffness: 1500, damping: 0.7 },
      keyframes: [
        kf(0, 36, -62, 38, 60),
        kf(0.4, 28, -58, 28, -12),
        kf(0.7, 24, -64, 12, -50),
        kf(1, 20, -70, 4, -68, { lean: -0.06 }),
      ],
    },
    strike: {
      // Wide horizontal cleave through the front, long follow-through right
      easing: 'easeOutCubic',
      spring: { stiffness: 3500, damping: 0.5 },
      keyframes: [
        kf(0, 20, -70, 4, -68),
        kf(0.25, 28, -66, 60, -56, { lean: 0.05 }),
        kf(0.5, 34, -62, 88, 0, { lean: 0.09 }),
        kf(0.75, 36, -60, 58, 58, { lean: 0.05 }),
        kf(1, 36, -62, 16, 92),
      ],
    },
    recover: {
      // Carry the follow-through back up to rest
      easing: 'easeOutElastic',
      spring: { stiffness: 150, damping: 0.85 },
      keyframes: [kf(0, 36, -62, 16, 92), kf(0.35, 36, -62, 32, 72), kf(1, 36, -62, 38, 60)],
    },
  },
);

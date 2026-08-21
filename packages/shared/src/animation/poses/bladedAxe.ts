/**
 * Bladed Axe — edge-led RISING reverse arc: low-right → front → high-left.
 * The mirror of the Large Axe's descending chop, and snappier, with a whip
 * recover.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.BLADED_AXE);

export const BLADED_AXE_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 2,
    strikeTicks: 10,
    activeFrom: 0.05,
    activeTo: 0.85,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.BLADED_AXE,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Drop the edge to the low-right rear
      easing: 'easeInCubic',
      spring: { stiffness: 1600, damping: 0.68 },
      keyframes: [
        kf(0, 36, -62, 38, 60),
        kf(0.45, 34, -58, 8, 74),
        kf(1, 32, -56, -12, 78, { lean: 0.04 }),
      ],
    },
    strike: {
      // Rising reverse arc: low-right → front → high-left
      easing: 'easeOutCubic',
      spring: { stiffness: 3900, damping: 0.5 },
      keyframes: [
        kf(0, 32, -56, -12, 78),
        kf(0.3, 34, -58, 60, 58, { lean: -0.04 }),
        kf(0.6, 36, -60, 90, -4, { lean: -0.07 }),
        kf(1, 36, -62, 36, -70),
      ],
    },
    recover: {
      // Whip the edge back down to carry — livelier than its big sibling
      easing: 'easeOutElastic',
      spring: { stiffness: 190, damping: 0.75 },
      keyframes: [kf(0, 36, -62, 36, -70), kf(0.35, 36, -62, 40, -8), kf(1, 36, -62, 38, 60)],
    },
  },
);

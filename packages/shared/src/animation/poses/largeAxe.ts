/**
 * Large Axe — shoulder-loaded high-left, ~100° DESCENDING diagonal chop
 * across the front to low-right, weight-carried settle.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.LARGE_AXE);

export const LARGE_AXE_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 2,
    strikeTicks: 11,
    activeFrom: 0.05,
    activeTo: 0.85,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.LARGE_AXE,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Load the axe over the lead shoulder (high-left)
      easing: 'easeInCubic',
      spring: { stiffness: 1400, damping: 0.7 },
      keyframes: [
        kf(0, 36, -62, 38, 60),
        kf(0.4, 30, -58, 24, -10),
        kf(0.75, 26, -62, 4, -56),
        kf(1, 24, -66, -6, -70, { lean: -0.05 }),
      ],
    },
    strike: {
      // Descending diagonal: high-left → front → low-right
      easing: 'easeOutCubic',
      spring: { stiffness: 3600, damping: 0.5 },
      keyframes: [
        kf(0, 24, -66, -6, -70),
        kf(0.3, 30, -62, 58, -50, { lean: 0.06 }),
        kf(0.6, 34, -60, 88, 10, { lean: 0.08 }),
        kf(1, 36, -60, 40, 78),
      ],
    },
    recover: {
      // The edge buries low-right; carry the weight back up to rest
      easing: 'easeOutElastic',
      spring: { stiffness: 140, damping: 0.85 },
      keyframes: [kf(0, 36, -60, 40, 78), kf(0.4, 36, -61, 38, 68), kf(1, 36, -62, 38, 60)],
    },
  },
);

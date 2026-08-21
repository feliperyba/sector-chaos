/**
 * Small Shield — tight pull-to-chest coil, quick punch-bash, snap back to a
 * high guard. Half the wind, twice the snap of the Large Shield.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.SMALL_SHIELD);

export const SMALL_SHIELD_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'shield',
    weaponType: WeaponType.SMALL_SHIELD,
    weightClass: 0,
    strikeTicks: 6,
    activeFrom: 0.1,
    activeTo: 0.6,
    meleeRange: 0, // shield bash resolution unchanged; face used for clashes
    handOffset: def.visual.handOffset,
    fixedBladeLength: 64, // shield face width
  },
  {
    windup: {
      // Quick pull to the chest
      easing: 'easeInQuad',
      spring: { stiffness: 2000, damping: 0.7 },
      keyframes: [kf(0, 60, -26, 60, 26), kf(1, 26, -20, 26, 20)],
    },
    strike: {
      // Punch-bash: fast out, fast back — no wall-press hold
      easing: 'easeOutExpo',
      spring: { stiffness: 4200, damping: 0.55 },
      keyframes: [
        kf(0, 26, -20, 26, 20),
        kf(0.2, 84, -30, 84, 30),
        kf(0.55, 78, -28, 78, 28),
        kf(1, 60, -26, 60, 26),
      ],
    },
    recover: {
      // Snap straight back to the high guard
      easing: 'easeOutCubic',
      spring: { stiffness: 300, damping: 0.8 },
      keyframes: [kf(0, 60, -26, 60, 26), kf(1, 60, -26, 60, 26)],
    },
  },
);

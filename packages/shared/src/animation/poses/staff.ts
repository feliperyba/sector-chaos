/**
 * Staff — rapid poke-thrust with a bouncy elastic recoil into ready.
 * Shortest commitment of the line weapons; the spring does the talking.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.STAFF);

export const STAFF_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'line',
    weightClass: 0,
    strikeTicks: 5,
    activeFrom: 0.1,
    activeTo: 0.7,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.STAFF,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Snap the staff level beside the body — barely a coil
      easing: 'easeInQuad',
      spring: { stiffness: 2400, damping: 0.7 },
      keyframes: [kf(0, 78, -16, 26, 58), kf(0.5, 66, 28, 4, 54), kf(1, 58, 44, -6, 50)],
    },
    strike: {
      // Rapid poke: hands snap forward to the butt end and rebound — the
      // staff length does the reaching, in and out in one elastic breath
      easing: 'easeOutExpo',
      spring: { stiffness: 6000, damping: 0.5 },
      keyframes: [
        kf(0, 58, 44, -6, 50),
        kf(0.3, 172, 16, 148, 20, { lean: 0.1 }),
        kf(0.6, 166, 17, 142, 21, { lean: 0.07 }),
        kf(1, 92, 36, 36, 44),
      ],
    },
    recover: {
      // Bouncy reset into the ready diagonal
      easing: 'easeOutElastic',
      spring: { stiffness: 280, damping: 0.6 },
      keyframes: [kf(0, 92, 36, 36, 44), kf(0.5, 84, 10, 28, 52), kf(1, 78, -16, 26, 58)],
    },
  },
);

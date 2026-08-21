/**
 * Dagger — low coil, lightning STAB with an upward wrist-flick exit.
 * Unlike the swords' sweeps, the dagger thrusts: tight azimuth, instant in,
 * instant out. Precise but unforgiving.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.DAGGER);

export const DAGGER_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 0,
    strikeTicks: 5,
    activeFrom: 0.05,
    activeTo: 0.8,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.DAGGER,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Coil the knife hand back-low beside the hip; guard hand rises
      easing: 'easeInQuad',
      spring: { stiffness: 2600, damping: 0.7 },
      keyframes: [kf(0, 36, -62, 38, 60), kf(0.45, 40, -56, 12, 50), kf(1, 44, -52, -14, 42)],
    },
    strike: {
      // Lightning thrust forward-right, brief hold, wrist-flick up and out
      easing: 'easeOutExpo',
      spring: { stiffness: 9000, damping: 0.55 },
      keyframes: [
        kf(0, 44, -52, -14, 42),
        kf(0.3, 42, -56, 96, 30),
        kf(0.6, 40, -58, 100, 26),
        kf(1, 38, -60, 86, 10),
      ],
    },
    recover: {
      // Double-blink reset to guard
      easing: 'easeOutCubic',
      spring: { stiffness: 320, damping: 0.7 },
      keyframes: [kf(0, 38, -60, 86, 10), kf(0.5, 37, -61, 52, 44), kf(1, 36, -62, 38, 60)],
    },
  },
);

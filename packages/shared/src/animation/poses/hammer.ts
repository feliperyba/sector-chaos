/**
 * Hammer — towering raise pulled far behind the body, crushing smash that
 * DEAD-STOPS at the apex, laborious lift back to carry. Almost no lateral
 * sweep: this is a commitment weapon — you point it, you own it.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.HAMMER);

export const HAMMER_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 3,
    strikeTicks: 9,
    activeFrom: 0.1,
    activeTo: 0.8,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.HAMMER,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Slow towering raise: hammer hand draws straight back behind the body
      easing: 'easeInOutSine',
      spring: { stiffness: 900, damping: 0.8 },
      keyframes: [
        kf(0, 36, -62, 38, 60),
        kf(0.35, 32, -54, 0, 54),
        kf(0.7, 30, -50, -34, 30),
        kf(1, 28, -48, -46, 8, { lean: -0.06 }),
      ],
    },
    strike: {
      // Crushing smash straight forward — dead-stop and HOLD at the apex
      easing: 'easeOutExpo',
      spring: { stiffness: 5200, damping: 0.45 },
      keyframes: [
        kf(0, 28, -48, -46, 8),
        kf(0.45, 34, -56, 98, 18, { lean: 0.1 }),
        kf(1, 36, -58, 96, 16, { lean: 0.08 }),
      ],
    },
    recover: {
      // Laborious lift back to carry — the weight fights you the whole way
      easing: 'easeInOutSine',
      spring: { stiffness: 110, damping: 0.9 },
      keyframes: [
        kf(0, 36, -58, 96, 16),
        kf(0.45, 36, -60, 70, 38),
        kf(0.8, 36, -62, 48, 54),
        kf(1, 36, -62, 38, 60),
      ],
    },
  },
);

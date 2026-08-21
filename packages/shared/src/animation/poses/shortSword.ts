/**
 * Short Sword — compact diagonal slash low-right → high-left, crisp
 * wrist-led recover. Tighter and quicker than the Long Sword's full cleave.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.SHORT_SWORD);

export const SHORT_SWORD_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 1,
    strikeTicks: 8,
    activeFrom: 0.05,
    activeTo: 0.8,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.SHORT_SWORD,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Chamber to the low-right rear
      easing: 'easeInCubic',
      spring: { stiffness: 1800, damping: 0.7 },
      keyframes: [kf(0, 36, -62, 38, 60), kf(0.4, 34, -58, 4, 76), kf(1, 32, -56, -18, 70)],
    },
    strike: {
      // Diagonal slash: low-right sweeps up across the front to high-left
      easing: 'easeOutCubic',
      spring: { stiffness: 4200, damping: 0.5 },
      keyframes: [
        kf(0, 32, -56, -18, 70),
        kf(0.3, 34, -58, 56, 62),
        kf(0.55, 36, -60, 86, 6),
        kf(0.8, 36, -62, 58, -48),
        kf(1, 36, -62, 34, -66),
      ],
    },
    recover: {
      // Crisp wrist-led return from high-left to carry
      easing: 'easeOutElastic',
      spring: { stiffness: 220, damping: 0.8 },
      keyframes: [kf(0, 36, -62, 34, -66), kf(0.4, 36, -62, 38, -10), kf(1, 36, -62, 38, 60)],
    },
  },
);

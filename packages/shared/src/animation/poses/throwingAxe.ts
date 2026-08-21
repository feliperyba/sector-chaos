/**
 * Throwing Axe (melee mode) — quick, compact chop: short shoulder load,
 * tight descending arc, fast reset. Built to flow into a throw at any moment
 * (throws use THROWN_MOTION).
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.THROWING_AXE);

export const THROWING_AXE_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 0,
    strikeTicks: 8,
    activeFrom: 0.05,
    activeTo: 0.8,
    // Melee mode reach (thrown mode is a projectile, not swept)
    meleeRange: def.meleeStats?.range ?? def.baseStats.range,
    weaponType: WeaponType.THROWING_AXE,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Short shoulder load — half the Large Axe's wind, twice the urgency
      easing: 'easeInQuad',
      spring: { stiffness: 2200, damping: 0.68 },
      keyframes: [kf(0, 36, -62, 38, 60), kf(0.5, 32, -58, 12, -24), kf(1, 30, -58, -2, -46)],
    },
    strike: {
      // Tight descending chop across the front
      easing: 'easeOutCubic',
      spring: { stiffness: 5000, damping: 0.5 },
      keyframes: [
        kf(0, 30, -58, -2, -46),
        kf(0.4, 34, -60, 70, -28),
        kf(0.7, 36, -60, 84, 24),
        kf(1, 36, -61, 52, 64),
      ],
    },
    recover: {
      easing: 'easeOutCubic',
      spring: { stiffness: 260, damping: 0.75 },
      keyframes: [kf(0, 36, -61, 52, 64), kf(1, 36, -62, 38, 60)],
    },
  },
);

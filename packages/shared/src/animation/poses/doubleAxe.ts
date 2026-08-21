/**
 * Double Axe — full ~140° sweep left → right, then a partial RETURN sweep
 * back across the front. The return re-arms the hit set (clearsHitSet), so
 * one swing can hit the same target twice. Longest strike in the game.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { buildSpec, kf } from './categoryTemplates.js';
import type { WeaponMotionSpec } from './types.js';

const def = weaponRegistry.getDefinition(WeaponType.DOUBLE_AXE);

export const DOUBLE_AXE_MOTION: WeaponMotionSpec = buildSpec(
  {
    category: 'arc',
    weightClass: 3,
    strikeTicks: 16,
    activeFrom: 0.05,
    activeTo: 0.95,
    meleeRange: def.baseStats.range,
    weaponType: WeaponType.DOUBLE_AXE,
    handOffset: def.visual.handOffset,
  },
  {
    windup: {
      // Deep cross-body coil to the far left
      easing: 'easeInCubic',
      spring: { stiffness: 1300, damping: 0.7 },
      keyframes: [
        kf(0, 36, -62, 38, 60),
        kf(0.45, 28, -56, 20, -30),
        kf(1, 22, -60, -2, -74, { lean: -0.07 }),
      ],
    },
    strike: {
      // Full sweep left → right, then partial return sweep (second hit)
      easing: 'easeOutCubic',
      spring: { stiffness: 3300, damping: 0.5 },
      keyframes: [
        kf(0, 22, -60, -2, -74),
        kf(0.2, 28, -62, 60, -54, { lean: 0.05 }),
        kf(0.38, 32, -62, 92, 0, { lean: 0.09 }),
        kf(0.55, 34, -62, 60, 58),
        kf(0.68, 36, -62, 18, 86),
        // Return sweep — re-arms multi-hit from here
        kf(0.7, 36, -62, 20, 84, { clearsHitSet: true, easing: 'easeInOutSine' }),
        kf(0.85, 36, -62, 58, 52, { lean: -0.04 }),
        kf(1, 36, -62, 80, 8),
      ],
    },
    recover: {
      // Staggering settle — the momentum nearly takes you with it
      easing: 'easeOutElastic',
      spring: { stiffness: 100, damping: 0.8 },
      keyframes: [kf(0, 36, -62, 80, 8), kf(0.45, 36, -62, 52, 44), kf(1, 36, -62, 38, 60)],
    },
  },
);

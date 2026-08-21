import { weaponRegistry, WEAPON_RENDER_SCALE } from '@sector-battle/shared';
import type { WeaponType } from '@sector-battle/shared';

export const TIER_COLORS = [0xffffff, 0x37d98c, 0x5b7fff, 0xffd700] as const;

// Re-export so existing client imports (`./WeaponVisuals.js`) keep resolving.
// The canonical home is now `@sector-battle/shared` so the swept-blade hitbox
// math (getSpriteBladeLength/Radius) sees the same value the renderer does.
export { WEAPON_RENDER_SCALE };

export function getTierColor(tier: number): number {
  return TIER_COLORS[tier] ?? TIER_COLORS[0];
}

export function getWeaponDisplayScale(weaponType: number): number {
  try {
    return weaponRegistry.getDefinition(weaponType as WeaponType).visual.scale * WEAPON_RENDER_SCALE;
  } catch {
    return WEAPON_RENDER_SCALE;
  }
}

export interface WeaponVisualConfig {
  scale: number;
  originX: number;
  originY: number;
  flipX: boolean;
}

export function getWeaponVisualConfig(
  weaponType: number,
  defaults: WeaponVisualConfig = { scale: 1.0, originX: 0.5, originY: 0.5, flipX: false },
): WeaponVisualConfig {
  try {
    const v = weaponRegistry.getDefinition(weaponType as WeaponType).visual;
    return { scale: v.scale, originX: v.originX, originY: v.originY, flipX: v.flipX };
  } catch {
    return defaults;
  }
}

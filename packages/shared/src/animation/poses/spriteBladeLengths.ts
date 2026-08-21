/**
 * spriteBladeLengths.ts — measured weapon art lengths, in ART pixels, from the
 * sprite origin (the handle, weaponDef.visual.originY) to the last opaque
 * pixel along the blade axis (art points up: origin row − opaque top row,
 * 128×128 frames). The hitbox bladeLength is this × visual.scale ×
 * WEAPON_RENDER_SCALE, so the swept segment tip is EXACTLY the drawn weapon
 * tip — sprites never scale dynamically beyond the shared render-scale
 * constant; reach beyond the blade comes from the authored hand motion.
 *
 * Values below were re-measured from the v2 character-art spritesheet
 * (game.png) — the heavy weapons (hammer/axes) grew larger heads, the
 * throwing axe became a thin side-profile. See docs/wayfinder/player-art-and-skins.md.
 */
import { WeaponType } from '../../enums/WeaponType.js';
import { weaponRegistry } from '../../weapons/WeaponRegistry.js';
import { WEAPON_RENDER_SCALE } from '../../constants/weapon-sprites.js';

const ART_BLADE_PX: Partial<Record<WeaponType, number>> = {
  [WeaponType.DAGGER]: 82,
  [WeaponType.SHORT_SWORD]: 87,
  [WeaponType.LONG_SWORD]: 97,
  [WeaponType.HAMMER]: 100,
  [WeaponType.LARGE_AXE]: 97,
  [WeaponType.BLADED_AXE]: 96,
  [WeaponType.DOUBLE_AXE]: 95,
  [WeaponType.SPEAR]: 104,
  [WeaponType.POLEARM]: 104,
  [WeaponType.STAFF]: 99,
  [WeaponType.THROWING_AXE]: 85,
};

/** Rendered blade length (px) at the weapon's static registry scale × render scale. */
export function getSpriteBladeLength(weaponType: WeaponType): number | undefined {
  const art = ART_BLADE_PX[weaponType];
  if (art == null) return undefined;
  return art * weaponRegistry.getDefinition(weaponType).visual.scale * WEAPON_RENDER_SCALE;
}

/**
 * Measured weapon art WIDTHS (perpendicular to blade axis, i.e. the widest
 * part of the blade/head/shaft), in art px from 128×128 alpha bbox.
 * Re-measured from the v2 spritesheet.
 */
const ART_BLADE_WIDTH_PX: Partial<Record<WeaponType, number>> = {
  [WeaponType.FISTS]: 34, // hand sprite art content
  [WeaponType.DAGGER]: 30,
  [WeaponType.SHORT_SWORD]: 40,
  [WeaponType.LONG_SWORD]: 40,
  [WeaponType.HAMMER]: 65,
  [WeaponType.LARGE_AXE]: 79,
  [WeaponType.BLADED_AXE]: 63,
  [WeaponType.DOUBLE_AXE]: 74,
  [WeaponType.THROWING_AXE]: 14,
  [WeaponType.SPEAR]: 26,
  [WeaponType.POLEARM]: 19,
  [WeaponType.STAFF]: 40,
  [WeaponType.SHORT_BOW]: 116, // bow.png 116×32px
  [WeaponType.CROSSBOW]: 140, // estimated (crossbow typically wider than bow)
  [WeaponType.SMALL_SHIELD]: 106,
  [WeaponType.LARGE_SHIELD]: 105,
};

/** Rendered blade radius (half the visual width) at the weapon's static registry scale × render scale. */
export function getSpriteBladeRadius(weaponType: WeaponType): number | undefined {
  const art = ART_BLADE_WIDTH_PX[weaponType];
  if (art == null) return undefined;
  return Math.round((art * weaponRegistry.getDefinition(weaponType).visual.scale * WEAPON_RENDER_SCALE) / 2);
}

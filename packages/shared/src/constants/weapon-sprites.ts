import { WeaponType } from '../enums/WeaponType.js';

export const WEAPON_SPRITE_KEYS: Record<WeaponType, string> = {
  [WeaponType.FISTS]: '',
  [WeaponType.DAGGER]: 'weapon_dagger',
  [WeaponType.SHORT_SWORD]: 'weapon_sword',
  [WeaponType.LONG_SWORD]: 'weapon_longsword',
  [WeaponType.HAMMER]: 'weapon_hammer',
  [WeaponType.LARGE_AXE]: 'weapon_axe_large',
  [WeaponType.BLADED_AXE]: 'weapon_axe_blades',
  [WeaponType.DOUBLE_AXE]: 'weapon_axe_double',
  [WeaponType.SPEAR]: 'weapon_spear',
  [WeaponType.POLEARM]: 'weapon_pole',
  [WeaponType.STAFF]: 'weapon_staff',
  [WeaponType.THROWING_AXE]: 'weapon_axe',
  [WeaponType.SHORT_BOW]: 'weapon_bow',
  [WeaponType.CROSSBOW]: 'weapon_bow_arrow',
  [WeaponType.SMALL_SHIELD]: 'shield_curved',
  [WeaponType.LARGE_SHIELD]: 'shield_straight',
};

export const PLAYER_SPRITE_KEYS = [
  'red_character',
  'green_character',
  'yellow_character',
  'purple_character',
  'blue_character',
  'pink_character',
  'orange_character',
  'cyan_character',
] as const;

export const PLAYER_HAND_SPRITE_KEYS = [
  'red_hand',
  'green_hand',
  'yellow_hand',
  'purple_hand',
  'blue_hand',
  'pink_hand',
  'orange_hand',
  'cyan_hand',
] as const;

/**
 * Color indices (into {@linkcode PLAYER_SPRITE_KEYS}) that may be assigned to
 * players at spawn. `blue` (index 4) is excluded until its hand art is
 * re-exported — the shipped `blue_hand` frame is malformed (fills the whole
 * 128×128 cell vs ~1300px for the other seven). Round-robin assignment over
 * this list distributes the 7 usable skins across all joiners. Re-add index 4
 * once the art is fixed. See docs/wayfinder/player-art-and-skins.md.
 */
export const ASSIGNABLE_COLOR_INDICES = [0, 1, 2, 3, 5, 6, 7] as const;

/**
 * Global render multiplier applied on top of each weapon's authored
 * `visual.scale`. The new character art has larger hands, so weapons read as
 * too small relative to them; this bumps every weapon uniformly without
 * touching hand size or the per-weapon scale ratios.
 *
 * Lives in `shared` (not client-only) because the swept-blade hitbox model
 * treats the rendered weapon as the hitbox: {@linkcode getSpriteBladeLength}
 * and {@linkcode getSpriteBladeRadius} multiply by this so the damage volume
 * tracks the drawn size exactly. The client applies it at its `setScale`
 * call sites. Tune by eye: 1.0 = authored scale, 1.3 ≈ +30%.
 */
export const WEAPON_RENDER_SCALE = 1.3;

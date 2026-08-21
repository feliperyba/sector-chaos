/**
 * Weapon rarity tiers.
 * Fists are treated as tier NONE (below Common).
 * Use null/undefined check for 'no tier' — not a formal enum value.
 */
export enum WeaponTier {
  COMMON = 'common',
  UNCOMMON = 'uncommon',
  RARE = 'rare',
  LEGENDARY = 'legendary',
}

export default WeaponTier;

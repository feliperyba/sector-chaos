/**
 * Chest rarity determines loot quality distribution.
 * Independent from WeaponTier — ChestRarity.EPIC ≠ WeaponTier.RARE.
 */
export enum ChestRarity {
  COMMON = 0,
  RARE = 1,
  EPIC = 2,
  LEGENDARY = 3,
}

export default ChestRarity;

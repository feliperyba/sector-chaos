import { ChestRarity } from '../enums/ChestRarity.js';
import { WeaponTier } from '../enums/WeaponTier.js';
import { PowerUpType } from '../enums/PowerUpType.js';
import { WEAPON_LOOT_CHANCE } from './loot-weights.js';

export const CHEST_TIER_COLORS: Record<ChestRarity, number> = {
  [ChestRarity.COMMON]: 0x8b4513,
  [ChestRarity.RARE]: 0x4169e1,
  [ChestRarity.EPIC]: 0x9932cc,
  [ChestRarity.LEGENDARY]: 0xffd700,
};

export const CHEST_LOOT_TABLES: Record<ChestRarity, { item: WeaponTier; weight: number }[]> = {
  [ChestRarity.COMMON]: [
    { item: WeaponTier.COMMON, weight: 80 },
    { item: WeaponTier.UNCOMMON, weight: 15 },
    { item: WeaponTier.RARE, weight: 4 },
    { item: WeaponTier.LEGENDARY, weight: 1 },
  ],
  [ChestRarity.RARE]: [
    { item: WeaponTier.COMMON, weight: 50 },
    { item: WeaponTier.UNCOMMON, weight: 30 },
    { item: WeaponTier.RARE, weight: 15 },
    { item: WeaponTier.LEGENDARY, weight: 5 },
  ],
  [ChestRarity.EPIC]: [
    { item: WeaponTier.COMMON, weight: 25 },
    { item: WeaponTier.UNCOMMON, weight: 30 },
    { item: WeaponTier.RARE, weight: 30 },
    { item: WeaponTier.LEGENDARY, weight: 15 },
  ],
  [ChestRarity.LEGENDARY]: [
    { item: WeaponTier.COMMON, weight: 10 },
    { item: WeaponTier.UNCOMMON, weight: 20 },
    { item: WeaponTier.RARE, weight: 35 },
    { item: WeaponTier.LEGENDARY, weight: 35 },
  ],
};

export const CHEST_WEAPON_CHANCE = WEAPON_LOOT_CHANCE;
export const CHEST_POWERUP_WEIGHTS: { item: PowerUpType; weight: number }[] = [
  { item: PowerUpType.HEALTH_PACK, weight: 50 },
  { item: PowerUpType.BARRIER, weight: 25 },
  { item: PowerUpType.SPEED_BOOST, weight: 25 },
];

export const CHEST = {
  OPEN_DURATION: 0.5,
  INTERACTION_RANGE: 192,
} as const;

import { WeaponTier } from '../enums/WeaponTier.js';
import { ChestRarity } from '../enums/ChestRarity.js';
import { SectorLootTier } from '../map/types.js';

export const LOOT_TIER_WEIGHTS: readonly { item: ChestRarity; weight: number }[] = [
  { item: ChestRarity.COMMON, weight: 70 },
  { item: ChestRarity.RARE, weight: 20 },
  { item: ChestRarity.EPIC, weight: 8 },
  { item: ChestRarity.LEGENDARY, weight: 2 },
] as const;

export const RING_TIER_WEIGHTS: Readonly<
  Record<'outer' | 'center', readonly { item: WeaponTier; weight: number }[]>
> = {
  outer: [{ item: WeaponTier.COMMON, weight: 100 }] as const,
  center: [
    { item: WeaponTier.COMMON, weight: 60 },
    { item: WeaponTier.UNCOMMON, weight: 25 },
    { item: WeaponTier.RARE, weight: 12 },
    { item: WeaponTier.LEGENDARY, weight: 3 },
  ] as const,
};

/**
 * Per-tier chest-rarity tables (map-redesign ticket 02 / DEC-003). The tier
 * of the sector a chest spawns in selects the table. WARM keeps the classic
 * map-wide table (`LOOT_TIER_WEIGHTS`); HOT shifts the whole distribution
 * up; COLD drops legendaries entirely (zero-weight entries are omitted —
 * `weightedPick` must never reach a 0-weight fallthrough).
 */
export const SECTOR_TIER_CHEST_WEIGHTS: Readonly<
  Record<SectorLootTier, readonly { item: ChestRarity; weight: number }[]>
> = {
  [SectorLootTier.HOT]: [
    { item: ChestRarity.COMMON, weight: 45 },
    { item: ChestRarity.RARE, weight: 30 },
    { item: ChestRarity.EPIC, weight: 18 },
    { item: ChestRarity.LEGENDARY, weight: 7 },
  ],
  [SectorLootTier.WARM]: [
    { item: ChestRarity.COMMON, weight: 70 },
    { item: ChestRarity.RARE, weight: 20 },
    { item: ChestRarity.EPIC, weight: 8 },
    { item: ChestRarity.LEGENDARY, weight: 2 },
  ],
  [SectorLootTier.COLD]: [
    { item: ChestRarity.COMMON, weight: 85 },
    { item: ChestRarity.RARE, weight: 12 },
    { item: ChestRarity.EPIC, weight: 3 },
  ],
};

/**
 * Per-tier ground-weapon tables (map-redesign ticket 02 / DEC-003). These
 * replace the per-ring tables as the generation source (`RING_TIER_WEIGHTS`
 * remains for the demo-map fallback path): HOT = the GDD §5.6.1 center split
 * (60/25/12/3), COLD = the outer Common-only band, WARM sits between with no
 * legendaries — legendaries only spawn in HOT districts, keeping the risk
 * story readable (gold districts vs cool edges).
 */
export const SECTOR_TIER_WEAPON_WEIGHTS: Readonly<
  Record<SectorLootTier, readonly { item: WeaponTier; weight: number }[]>
> = {
  [SectorLootTier.HOT]: [
    { item: WeaponTier.COMMON, weight: 60 },
    { item: WeaponTier.UNCOMMON, weight: 25 },
    { item: WeaponTier.RARE, weight: 12 },
    { item: WeaponTier.LEGENDARY, weight: 3 },
  ],
  [SectorLootTier.WARM]: [
    { item: WeaponTier.COMMON, weight: 85 },
    { item: WeaponTier.UNCOMMON, weight: 12 },
    { item: WeaponTier.RARE, weight: 3 },
  ],
  [SectorLootTier.COLD]: [{ item: WeaponTier.COMMON, weight: 100 }],
};

export const CRATE_TIER_WEIGHTS: readonly { item: WeaponTier; weight: number }[] = [
  { item: WeaponTier.COMMON, weight: 80 },
  { item: WeaponTier.UNCOMMON, weight: 15 },
  { item: WeaponTier.RARE, weight: 4 },
  { item: WeaponTier.LEGENDARY, weight: 1 },
] as const;

export const CENTER_RESOURCE_RICH_WEIGHTS: readonly { item: ChestRarity; weight: number }[] = [
  { item: ChestRarity.RARE, weight: 60 },
  { item: ChestRarity.LEGENDARY, weight: 40 },
] as const;

export const WEAPON_LOOT_CHANCE = 0.7;
export const WEAPON_DROP_CHANCE = 0.6;

export const CRATE_LOOT = {
  DROP_CHANCE: WEAPON_DROP_CHANCE,
  WEAPON_SPLIT: WEAPON_LOOT_CHANCE,
  WEAPON_TIER_WEIGHTS: CRATE_TIER_WEIGHTS.map((w) => ({ item: w.item, weight: w.weight })),
  POWERUP_WEIGHTS: [
    { item: 'health_pack' as const, weight: 50 },
    { item: 'barrier' as const, weight: 50 },
    { item: 'speed_boost' as const, weight: 50 },
  ],
} as const;

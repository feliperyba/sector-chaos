import { WeaponTier, PowerUpType, ChestRarity } from '@sector-battle/shared';
import {
  SeededRNG,
  CRATE_LOOT,
  CHEST_LOOT_TABLES,
  CHEST_WEAPON_CHANCE,
  CHEST_POWERUP_WEIGHTS,
} from '@sector-battle/shared';
import type { GamePowerUpType } from '../entities/PowerUp.ts';

export type CrateLootResult =
  | { kind: 'weapon'; tier: WeaponTier }
  | { kind: 'powerup'; powerUpType: GamePowerUpType }
  | null;

export type ChestLootResult =
  | { kind: 'weapon'; tier: WeaponTier }
  | { kind: 'powerup'; powerUpType: PowerUpType };

const MAX_LEGENDARY = 10;

export class LootService {
  rollCrateLoot(rng: SeededRNG): CrateLootResult {
    if (rng.nextFloat() > CRATE_LOOT.DROP_CHANCE) return null;
    if (rng.nextFloat() < CRATE_LOOT.WEAPON_SPLIT) {
      const tier = rng.weightedPick([...CRATE_LOOT.WEAPON_TIER_WEIGHTS]);
      return { kind: 'weapon', tier };
    }
    const powerUpType = rng.weightedPick([...CRATE_LOOT.POWERUP_WEIGHTS]);
    return { kind: 'powerup', powerUpType };
  }

  rollChestLoot(chestTier: ChestRarity, rng: SeededRNG): ChestLootResult {
    if (rng.nextFloat() < CHEST_WEAPON_CHANCE) {
      const table = CHEST_LOOT_TABLES[chestTier];
      const hasValidWeight = table.some((e: { weight: number }) => e.weight > 0);
      if (!hasValidWeight) {
        return { kind: 'weapon', tier: WeaponTier.COMMON };
      }
      const tier = rng.weightedPick(table) as WeaponTier;
      return { kind: 'weapon', tier };
    }
    const powerUpType = rng.weightedPick([...CHEST_POWERUP_WEIGHTS]);
    return { kind: 'powerup', powerUpType };
  }

  static readonly MAX_LEGENDARY = MAX_LEGENDARY;
}

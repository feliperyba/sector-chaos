import { WeaponTier } from '../enums/WeaponTier.js';
import { ChestRarity } from '../enums/ChestRarity.js';
import { RING_TIER_WEIGHTS, LOOT_TIER_WEIGHTS } from '../constants/loot-weights.js';
import type { SeededRNG } from '../map/rng/SeededRNG.js';

export const WEAPON_TIER_WEIGHTS: readonly { tier: WeaponTier; weight: number }[] =
  RING_TIER_WEIGHTS.center.map((w) => ({ tier: w.item, weight: w.weight }));

export const CHEST_TIER_WEIGHTS: readonly { tier: ChestRarity; weight: number }[] =
  LOOT_TIER_WEIGHTS.map((w) => ({ tier: w.item, weight: w.weight }));

/**
 * Roll a weapon tier from the center ring weight table using a deterministic
 * {@link SeededRNG}. Delegates to `rng.weightedPick`, which consumes a single
 * `nextFloat()` and applies the same weighted-subtraction as the legacy
 * `Math.random()` form — so the distribution (weight tables) is identical, only
 * the RNG source is now deterministic-from-seed.
 */
export function rollWeaponTier(rng: SeededRNG): WeaponTier {
  return rng.weightedPick(RING_TIER_WEIGHTS.center);
}

/**
 * Roll a chest rarity from the loot tier weight table using a deterministic
 * {@link SeededRNG}. Uses `rng.weightedPick` over the same source table as the
 * legacy form and as `EntityPlacer.rollChestTier`, so all three paths now share
 * one implementation and consume the RNG identically.
 */
export function rollChestTier(rng: SeededRNG): ChestRarity {
  return rng.weightedPick(LOOT_TIER_WEIGHTS);
}

import { ChestRarity } from '../enums/ChestRarity.js';
import { TrapType } from '../enums/TrapType.js';
import { SeededRNG } from './rng/SeededRNG.js';
import { avalanche } from './lootTiers.js';
import type { LegendaryBudget, TierLookup } from './lootTiers.js';
import {
  BEACON_INTENSITY_MAX,
  BEACON_RADIUS,
  BEACON_THEME_LIGHT,
  BEACON_TIER_LIGHT,
  CITADEL_BEACON_RADIUS,
} from './landmarks.js';
import { SECTOR_TIER_CHEST_WEIGHTS } from '../constants/loot-weights.js';
import { TILE_PIXEL_SIZE, SECTOR_TILE_SIZE } from './constants.js';
import type { CompoundInfo, FortressInfo } from './macro/MacroTypes.js';
import type { LootPlacement, TrapPlacement, SectorType } from './types.js';

/**
 * Compound loot + beacon finalization (map-redesign ticket 06 / DEC-004).
 *
 * The compound templates author their chests/traps as ANCHORS during the
 * macro pass; this module converts them into real placement data at the END
 * of the pipeline so:
 *
 *   - the tile/entity RNG streams keep their exact draw order (the appended
 *     placements draw ZERO main-pipeline RNG — only the isolated CMLT
 *     stream below);
 *   - the shared map-wide {@link LegendaryBudget} sees the compound rolls
 *     AFTER every sector/spawner roll, so pre-ticket-06 legendary outcomes
 *     are unchanged and the compound can only spend leftover headroom
 *     (legendary density stays capped, DEC-003/004);
 *   - compound chests hydrate + open like every other chest (tier authored
 *     by generation — single source of truth, DEC-003.1).
 *
 * Value framing (DEC-004.4): position + guaranteed epic, NOT volume — the
 * standard compound carries its 2 (loot-arm: 4) authored chests at tier-table
 * odds, the Citadel adds ONE vault chest guaranteed EPIC-or-better.
 */

/**
 * Isolated RNG stream seed XOR constant for compound loot rolls ('CMLT' in
 * ASCII hex — same convention/salt documentation as the other identity
 * streams). Avalanche-mixed like TIER/HOTS/NAME/DESG/CITD.
 */
const COMPOUND_LOOT_SEED_XOR = 0x434d4c54;

/**
 * Chance the guaranteed vault chest upgrades EPIC → LEGENDARY, gated by the
 * map-wide LegendaryBudget (a denied roll stays EPIC — "epic-or-better"
 * holds unconditionally; the cap holds because the budget is consumed only
 * on a successful roll).
 */
const VAULT_LEGENDARY_CHANCE = 0.35;

/** Guardian trap type weights (mirrors EntityPlacer's table). */
const TRAP_TYPE_WEIGHTS: ReadonlyArray<{ item: TrapType; weight: number }> = [
  { item: TrapType.SPIKE, weight: 1 },
  { item: TrapType.FIRE, weight: 1 },
  { item: TrapType.TELEPORT, weight: 1 },
];

function sectorCoordOf(row: number, col: number): { row: number; col: number } {
  return { row: Math.floor(row / SECTOR_TILE_SIZE), col: Math.floor(col / SECTOR_TILE_SIZE) };
}

function posOf(row: number, col: number): { x: number; y: number } {
  return { x: col * TILE_PIXEL_SIZE, y: row * TILE_PIXEL_SIZE };
}

/**
 * Convert the compound's authored anchors into loot/trap placements. The
 * vault chest (Citadel) is the LAST roll so it only sees leftover legendary
 * headroom. Zero main-pipeline RNG.
 */
export function appendCompoundLoot(
  compound: CompoundInfo,
  tierOf: TierLookup,
  legendary: LegendaryBudget,
  seed: number,
): { chestPlacements: LootPlacement[]; trapPlacements: TrapPlacement[] } {
  const rng = new SeededRNG(avalanche((seed ^ COMPOUND_LOOT_SEED_XOR) >>> 0));
  const isCitadel = compound.variant === 'CITADEL';

  const chestPlacements: LootPlacement[] = [];
  for (const cell of compound.chests) {
    const sectorCoord = sectorCoordOf(cell.row, cell.col);
    let tier: ChestRarity;
    if (isCitadel) {
      // Citadel vault chest (the Citadel authors exactly ONE chest — the
      // vault chamber's GUARANTEED epic-or-better chest, DEC-004.1). The
      // legendary attempt draws on the isolated stream and consumes budget
      // only on success (a denied roll stays EPIC — "epic-or-better" holds
      // unconditionally, and the map-wide legendary cap holds because the
      // budget is consumed only on a successful roll).
      tier =
        rng.nextFloat() < VAULT_LEGENDARY_CHANCE && legendary.tryConsume()
          ? ChestRarity.LEGENDARY
          : ChestRarity.EPIC;
    } else {
      // Standard compound chest: the tier table of its containing sector's
      // EFFECTIVE tier (base pyramid + hot upgrade) — tier integration.
      tier = rng.weightedPick(SECTOR_TIER_CHEST_WEIGHTS[tierOf(sectorCoord.row, sectorCoord.col)]);
      if (tier === ChestRarity.LEGENDARY && !legendary.tryConsume()) {
        tier = ChestRarity.EPIC;
      }
    }
    chestPlacements.push({
      type: 'CHEST',
      tier,
      position: posOf(cell.row, cell.col),
      sectorCoord,
    });
  }

  const trapPlacements: TrapPlacement[] = compound.traps.map((cell) => ({
    trapType: rng.weightedPick([...TRAP_TYPE_WEIGHTS]),
    position: posOf(cell.row, cell.col),
    sectorCoord: sectorCoordOf(cell.row, cell.col),
  }));

  return { chestPlacements, trapPlacements };
}

/**
 * Sector-TYPE lookup injection (same injection pattern as {@link TierLookup}):
 * resolves a sector coordinate to its `SectorType` — the standard compound
 * beacon keys its hue on the beacon anchor sector's theme color.
 */
export type SectorTypeLookup = (row: number, col: number) => SectorType;

/**
 * Project the placed compound onto the MapData-facing {@link FortressInfo}.
 *
 * Beacon spec (DEC-004.1/2 + DEC-005 value band, map-polish ticket 03):
 *   - CITADEL: the vault beacon — RARE violet (the one sanctioned tier-hue
 *     exception), intensity AT the `BEACON_INTENSITY_MAX` ceiling (2.6) and
 *     radius 576 (beyond every hero beacon's 512) → unambiguously the
 *     strongest static light on the map by radius dominance, still inside
 *     the static value band.
 *   - Standard templates: theme-colored by the beacon anchor sector's TYPE
 *     (`BEACON_THEME_LIGHT`) with the tier's intensity — same hue=theme,
 *     value=tier contract as the hero beacons.
 *
 * Pure projection — zero RNG.
 */
export function buildFortressInfo(
  compound: CompoundInfo | null,
  tierOf: TierLookup,
  typeOf: SectorTypeLookup,
): FortressInfo | null {
  if (!compound) return null;
  const beaconSector = sectorCoordOf(compound.beaconAnchor.row, compound.beaconAnchor.col);
  if (compound.variant === 'CITADEL') {
    const light = BEACON_TIER_LIGHT.RARE;
    return {
      variant: compound.variant,
      originRow: compound.originRow,
      originCol: compound.originCol,
      size: compound.size,
      vault: compound.vault ? { tileX: compound.vault.col, tileY: compound.vault.row } : null,
      beacon: {
        tileX: compound.beaconAnchor.col,
        tileY: compound.beaconAnchor.row,
        color: light.color,
        intensity: BEACON_INTENSITY_MAX,
        radius: CITADEL_BEACON_RADIUS,
      },
    };
  }
  const tier = tierOf(beaconSector.row, beaconSector.col);
  const light = BEACON_TIER_LIGHT[tier];
  const themeColor = BEACON_THEME_LIGHT[typeOf(beaconSector.row, beaconSector.col)].color;
  return {
    variant: compound.variant,
    originRow: compound.originRow,
    originCol: compound.originCol,
    size: compound.size,
    vault: null,
    beacon: {
      tileX: compound.beaconAnchor.col,
      tileY: compound.beaconAnchor.row,
      color: themeColor,
      intensity: light.intensity,
      radius: BEACON_RADIUS,
    },
  };
}

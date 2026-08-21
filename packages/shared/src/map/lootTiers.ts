import { SeededRNG } from './rng/SeededRNG.js';
import { SECTOR_GRID_SIZE } from './constants.js';
import { getSectorRing } from './gridUtils.js';
import { SectorLootTier } from './types.js';

/**
 * Effective loot-tier lookup for a sector (base pyramid + per-match hot
 * upgrade). Built by `MapGenerator.runPipeline` from the
 * `SectorTierAssignment`; consumed by EntityPlacer + LootSpacer to select
 * per-tier weight tables.
 */
export type TierLookup = (row: number, col: number) => SectorLootTier;

/**
 * Isolated RNG stream seed XOR constant for the sector loot-tier pyramid
 * ('TIER' in ASCII hex — same convention as MacroFeaturePass's 'HIGW'/
 * 'COMP'/'FLAV' salts). The tier pass draws ONLY from this stream so it can
 * never perturb the tile/entity generation streams (ADR 0035 determinism
 * contract: every new stream is XOR-salted + documented).
 */
const TIER_SEED_XOR = 0x54494552;

/**
 * Isolated RNG stream seed XOR constant for the per-match hot-sector roll
 * ('HOTS' in ASCII hex). Separate from TIER_SEED_XOR so the hot-sector roll
 * is independently reproducible from the match seed without replaying the
 * pyramid draws.
 */
const HOT_SECTOR_SEED_XOR = 0x484f5453;

/**
 * 32-bit avalanche (murmur3 finalizer) applied to the salted seed before it
 * enters `SeededRNG`.
 *
 * WHY: `SeededRNG` seeds only `stateX`; `stateY/Z/W` are constants. For two
 * seeds that differ only in LOW bits (e.g. consecutive match seeds), the
 * first outputs differ only in the low/mid bits the xorshift chain spreads
 * them to — while `weightedPick`/`shuffle` decide outcomes from the HIGH
 * bits (`floor(nextFloat() * N)`). Nearby seeds therefore produced identical
 * draws: measured, the per-match hot sector rotated on only ~3% of
 * consecutive seed pairs (DEC-009 gate is >=60%). The avalanche spreads the
 * seed across all 32 bits first, restoring the expected ~5/6 rotation. The
 * mapping stays a pure function of the seed (determinism contract intact).
 *
 * Exported for the other isolated identity streams (poi names, designation —
 * map-redesign ticket 03) so every salted stream gets the same
 * step-adjacent-seed decorrelation.
 */
export function avalanche(seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Pyramid targets (map-redesign DEC-003): HOT 2–3, WARM ~8, COLD ~5. */
export const TIER_TARGETS = {
  hotMin: 2,
  hotMax: 3,
  warm: 8,
  cold: 5,
} as const;

/**
 * Seed-authored loot-tier pyramid + per-match hot sector (map-redesign
 * ticket 02 / DEC-003). Pure function of the map seed.
 */
export interface SectorTierAssignment {
  /** Base pyramid tiers (4x4). The hot sector is still WARM here. */
  tiers: SectorLootTier[][];
  /**
   * The per-match hot sector: one non-central WARM sector upgraded to HOT
   * for the match only. Always present for a generated map.
   */
  hotSector: { row: number; col: number };
}

/** The 4 center 2x2 sector coordinates (row-major order). */
const CENTER_SECTORS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, 2],
  [2, 1],
  [2, 2],
];

/**
 * Assign every sector a loot tier — the seed-authored pyramid:
 *
 * - HOT: 2–3 sectors. The center 2x2 ALWAYS holds >=1 HOT ("center cluster
 *   guaranteed"); the remaining HOT sectors extend the cluster outward into
 *   an outer sector that shares an edge with a center-HOT sector, so the
 *   HOT sectors are always contiguous around the map center.
 * - COLD: exactly 5 sectors, all on the outer ring (the cool edges).
 * - WARM: everything else (8–9 sectors).
 *
 * Determinism: ALL draws come from an isolated XOR-salted stream —
 * `avalanche(seed ^ TIER_SEED_XOR)` (salt + avalanche documented above) —
 * so the tier pass can never perturb the tile/entity generation streams. The
 * per-match hot sector is rolled from a SECOND isolated stream
 * (`avalanche(seed ^ HOT_SECTOR_SEED_XOR)`) — one non-central (outer-ring)
 * WARM sector upgrades to HOT for the match only (Apex-style hot zone).
 * Same seed ⇒ identical assignment.
 */
export function assignSectorTiers(seed: number): SectorTierAssignment {
  const rng = new SeededRNG(avalanche((seed ^ TIER_SEED_XOR) >>> 0));

  // Start every sector at WARM; HOT/COLD are carved out below.
  const tiers: SectorLootTier[][] = [];
  const allSectors: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
    tiers[row] = [];
    for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
      tiers[row]![col] = SectorLootTier.WARM;
      allSectors.push({ row, col });
    }
  }

  // 1. HOT count for this map: 2 or 3 (50/50 single draw).
  const hotCount = rng.nextFloat() < 0.5 ? TIER_TARGETS.hotMin : TIER_TARGETS.hotMax;

  // 2. Center cluster: 1 center HOT (2 maps) or 2 center HOT (3 maps). When
  //    two center sectors go HOT, the second is drawn from the two center
  //    sectors EDGE-adjacent to the first, so the center pair is always
  //    contiguous (a diagonal-only pair would strand an isolated HOT corner).
  const centerHotCount = hotCount === TIER_TARGETS.hotMax ? 2 : 1;
  const centerSectorList = CENTER_SECTORS.map(([row, col]) => ({ row, col }));
  const firstCenterHot = rng.shuffle(centerSectorList)[0]!;
  tiers[firstCenterHot.row]![firstCenterHot.col] = SectorLootTier.HOT;
  if (centerHotCount === 2) {
    const centerNeighbors = centerSectorList.filter(
      ({ row, col }) =>
        Math.abs(row - firstCenterHot.row) + Math.abs(col - firstCenterHot.col) === 1,
    );
    const secondCenterHot = rng.shuffle(centerNeighbors)[0]!;
    tiers[secondCenterHot.row]![secondCenterHot.col] = SectorLootTier.HOT;
  }

  // 3. Extend the cluster: one outer sector edge-adjacent to a center HOT
  //    becomes the remaining HOT. Edge-adjacency keeps the HOT sectors a
  //    single contiguous cluster (corners touch the center only diagonally
  //    and are excluded).
  const isCenterHot = (row: number, col: number): boolean =>
    CENTER_SECTORS.some(([r, c]) => r === row && c === col && tiers[r]![c] === SectorLootTier.HOT);
  const adjacentOuter: Array<{ row: number; col: number }> = [];
  for (const { row, col } of allSectors) {
    if (getSectorRing(row, col, SECTOR_GRID_SIZE) !== 'outer') continue;
    const touchesCenterHot =
      isCenterHot(row - 1, col) ||
      isCenterHot(row + 1, col) ||
      isCenterHot(row, col - 1) ||
      isCenterHot(row, col + 1);
    if (touchesCenterHot) adjacentOuter.push({ row, col });
  }
  const outerHot = rng.shuffle(adjacentOuter)[0]!;
  tiers[outerHot.row]![outerHot.col] = SectorLootTier.HOT;

  // 4. COLD: exactly 5 sectors from the remaining outer ring.
  const remainingOuter = allSectors.filter(
    ({ row, col }) =>
      getSectorRing(row, col, SECTOR_GRID_SIZE) === 'outer' &&
      tiers[row]![col] === SectorLootTier.WARM,
  );
  for (const { row, col } of rng.shuffle(remainingOuter).slice(0, TIER_TARGETS.cold)) {
    tiers[row]![col] = SectorLootTier.COLD;
  }

  // 5. Per-match hot sector: one outer WARM sector upgrades to HOT for this
  //    match only, rolled from the match seed on its own isolated stream.
  const hotRng = new SeededRNG(avalanche((seed ^ HOT_SECTOR_SEED_XOR) >>> 0));
  const warmOuter = allSectors.filter(
    ({ row, col }) =>
      getSectorRing(row, col, SECTOR_GRID_SIZE) === 'outer' &&
      tiers[row]![col] === SectorLootTier.WARM,
  );
  const hotSector = hotRng.shuffle(warmOuter)[0]!;

  return { tiers, hotSector };
}

/**
 * The tier that drives loot tables / minimap tint for a sector: the base
 * pyramid tier, upgraded to HOT when the sector is this match's hot sector.
 */
export function effectiveSectorTier(
  assignment: SectorTierAssignment,
  row: number,
  col: number,
): SectorLootTier {
  const hot = assignment.hotSector;
  if (hot.row === row && hot.col === col) return SectorLootTier.HOT;
  return assignment.tiers[row]![col]!;
}

/** Count sectors per base tier (diagnostics / benchmark manifest). */
export function countTiers(tiers: SectorLootTier[][]): { hot: number; warm: number; cold: number } {
  const counts = { hot: 0, warm: 0, cold: 0 };
  for (const row of tiers) {
    for (const tier of row) {
      if (tier === SectorLootTier.HOT) counts.hot++;
      else if (tier === SectorLootTier.WARM) counts.warm++;
      else counts.cold++;
    }
  }
  return counts;
}

/**
 * Map-wide legendary budget (map-redesign ticket 02): the total count of
 * LEGENDARY-tier placements (chest rarity LEGENDARY + weapon tier LEGENDARY,
 * combined) is capped at ~10 per map. Shared by EntityPlacer (chests +
 * ground weapons) and LootSpawner so the cap is enforced across ALL
 * generation-time legendary sources. Consumption is RNG-free — a denied
 * legendary deterministically downgrades one step instead of re-rolling.
 */
export class LegendaryBudget {
  used = 0;

  constructor(readonly max: number) {}

  /** True while at least one legendary slot remains (no consumption). */
  hasHeadroom(): boolean {
    return this.used < this.max;
  }

  /** Consume one legendary slot; false (no consumption) when exhausted. */
  tryConsume(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}

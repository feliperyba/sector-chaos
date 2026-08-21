import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import { SECTOR_TILE_SIZE, MIN_SPAWNS_PER_SECTOR } from '../constants.js';
import { measureSectorGates } from './sectorGates.js';
import { GRID_ARENA_SUB_BLOCKS } from './probBlocksGridArena.js';
import { OPEN_ARENA_SUB_BLOCKS } from './probBlocksOpenArena.js';
import { MAZE_SUB_BLOCKS } from './probBlocksMaze.js';
import { RESOURCE_RICH_SUB_BLOCKS } from './probBlocksResourceRich.js';
import type { SectorSubVariant } from './subVariants.js';

/**
 * Probabilistic sub-block pass (map-redesign ticket 08 / DEC-007.1 — the
 * Spelunky probabilistic-tiles pattern: authored optional sub-blocks at
 * 25/33/50% presence dice multiply layout variety without new skeletons).
 *
 * RNG CONTRACT (Wei's dissent, encoded as the ticket criterion): the presence
 * dice consume the sector's FORKED RNG stream strictly AFTER the base skeleton
 * draw — appended, never interleaved. `MapGenerator.generateSectorLayouts`
 * hands each generator the forked `subRng`; the builder consumes its own draws
 * first (unchanged count/order from before this ticket), and only THEN does
 * this pass draw EXACTLY ONE `nextFloat()` per authored sub-block, in authored
 * array order. The appended position keeps the base skeleton output for a
 * given subSeed identical to pre-ticket output, so golden-fixture
 * regeneration is the single planned v3-continuity bump (layout geometry +
 * downstream cascade only). Draw counts per variant are fixed
 * (`SUB_BLOCKS_BY_VARIANT[v].length`) and documented per data module.
 *
 * SAFETY (deterministic guards, zero RNG): every PRESENT block applies to a
 * snapshot of the gate measures and is fully reverted when it would
 * - split the walkable region (`emptyComponents` grows) — a crate pair across
 *   a 1-wide maze corridor must not seal a pocket;
 * - starve spawns below `MIN_SPAWNS_PER_SECTOR`;
 * - orphan an indestructible wall into a lone stub (`loneWalls` grows — only
 *   `clear` operations can do this).
 * `fill` cells only land on EMPTY tiles and never on the sector's authored
 * `lootSpots` / `landmarkAnchor` (loot must not be buried by its own cover).
 * `clear` cells never touch the border ring (rows/cols 0/19) — they are
 * "gap-phase variants": smash-open shortcuts through the authored structure.
 * All guards are pure functions of the tile grid, so the whole pass stays a
 * pure function of `(subVariant, subRng)`.
 */

/** The 20×20 sector side length these sub-blocks assume. */
const SIZE = SECTOR_TILE_SIZE;

/**
 * One authored optional sub-block. `cells` are `[row, col]` pairs in the
 * UNMIRRORED authored frame of the skeleton (the mirror transform, when it
 * fires, flips the whole grid including placed blocks).
 */
export interface SkeletonSubBlock {
  /** Stable id (audit/debug + test reporting). */
  readonly id: string;
  /** `fill` places breakable cover; `clear` carves an extra opening. */
  readonly op: 'fill' | 'clear';
  /** The cover tile placed by `fill` (ignored by `clear`). */
  readonly tile: TileType.DESTRUCTIBLE_WALL | TileType.DESTRUCTIBLE_CRATE;
  /** Presence die: 0.25, 0.33 or 0.5 (DEC-007 dice set). */
  readonly chance: number;
  /** Authored cells in `[row, col]` form (interior 1..18 only). */
  readonly cells: ReadonlyArray<readonly [number, number]>;
}

/** The authored sub-block tables, keyed by sub-variant id (3–6 entries each). */
export const SUB_BLOCKS_BY_VARIANT: Readonly<
  Record<SectorSubVariant, readonly SkeletonSubBlock[]>
> = {
  ...GRID_ARENA_SUB_BLOCKS,
  ...OPEN_ARENA_SUB_BLOCKS,
  ...MAZE_SUB_BLOCKS,
  ...RESOURCE_RICH_SUB_BLOCKS,
};

/**
 * Apply this sector's probabilistic sub-blocks on the forked per-sector RNG
 * stream. Draws exactly `SUB_BLOCKS_BY_VARIANT[sector.subVariant].length`
 * floats (one presence die per block, appended after the base draw) and
 * records which blocks ended up PRESENT (and survived the guards) as a bitmask
 * on `sector.subBlockMask` — bit `i` is the `i`-th authored block. Pure
 * function of `(sector.tiles, sector.subVariant, rng)`.
 *
 * @param sector - the generated sector (mutated in place; `subBlockMask` set)
 * @param rng - the sector's forked RNG stream, positioned AFTER the base draw
 */
export function applyProbabilisticSubBlocks(sector: SectorData, rng: SeededRNG): void {
  const blocks = SUB_BLOCKS_BY_VARIANT[sector.subVariant] ?? [];
  let mask = 0;
  for (let i = 0; i < blocks.length; i++) {
    const present = rng.nextFloat() < blocks[i]!.chance;
    if (!present) continue;
    if (applyBlock(sector, blocks[i]!)) mask |= 1 << i;
  }
  sector.subBlockMask = mask;
}

/**
 * Apply one block with the deterministic safety guards. Returns whether the
 * block ended up changing the grid (false = dice won but every cell no-op'd
 * or the guards reverted it — the block then does not count as present).
 */
function applyBlock(sector: SectorData, block: SkeletonSubBlock): boolean {
  const tiles = sector.tiles;
  const protectedCells = new Set<string>();
  for (const spot of sector.lootSpots) protectedCells.add(`${spot.y},${spot.x}`);
  protectedCells.add(`${sector.landmarkAnchor.y},${sector.landmarkAnchor.x}`);

  const pre = measureSectorGates(sector);
  const changes: Array<{ r: number; c: number; previous: number }> = [];
  for (const cell of block.cells) {
    const [r, c] = cell;
    if (r < 1 || r > SIZE - 2 || c < 1 || c > SIZE - 2) continue;
    if (block.op === 'fill') {
      if (tiles[r]![c]! !== TileType.EMPTY) continue;
      if (protectedCells.has(`${r},${c}`)) continue;
      changes.push({ r, c, previous: tiles[r]![c]! });
      tiles[r]![c] = block.tile;
    } else {
      if (tiles[r]![c]! === TileType.EMPTY) continue;
      changes.push({ r, c, previous: tiles[r]![c]! });
      tiles[r]![c] = TileType.EMPTY;
    }
  }
  if (changes.length === 0) return false;

  const post = measureSectorGates(sector);
  if (blockDegradedGates(pre, post, block.op)) {
    // Deterministic revert to the exact previous tiles: the block would split
    // the walkable region, starve spawns or orphan a wall — skip it entirely.
    for (const change of changes) {
      tiles[change.r]![change.c] = change.previous;
    }
    return false;
  }
  return true;
}

/**
 * Guard predicate: did this op make any local gate worse? `fill` can only
 * reduce the spawn pool and split regions; `clear` can only orphan walls.
 * (A `clear` revert restores INDESTRUCTIBLE_WALL — `clear` cells are authored
 * against skeleton walls; see the data modules.)
 */
function blockDegradedGates(
  pre: ReturnType<typeof measureSectorGates>,
  post: ReturnType<typeof measureSectorGates>,
  op: 'fill' | 'clear',
): boolean {
  if (post.emptyComponents > pre.emptyComponents) return true;
  if (post.spawnEligible < MIN_SPAWNS_PER_SECTOR) return true;
  if (op === 'clear' && post.loneWalls > pre.loneWalls) return true;
  return false;
}

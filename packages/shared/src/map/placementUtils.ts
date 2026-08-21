import { TileType } from '../enums/TileType.js';
import type { SeededRNG } from './rng/SeededRNG.js';
import type { SectorData } from './types.js';
import { SECTOR_TILE_SIZE } from './constants.js';

/**
 * A tile-grid position inside a sector (local row/col).
 */
export interface CellPos {
  row: number;
  col: number;
}

const CARDINAL_DIRS: readonly (readonly [number, number])[] = [
  [-1, 0] as const,
  [1, 0] as const,
  [0, -1] as const,
  [0, 1] as const,
];

/**
 * Shared empty preferred-cell set for placements that never use loot-framing
 * (barrels, traps). It is never mutated — `pickPlacement` only touches the set
 * when `size > 0` — so sharing one instance is safe. Passing it keeps
 * `placeWithSpacing`'s preferred-first branch inert, so barrel/trap placement
 * and RNG draw order stay unchanged (T7).
 */
export const NO_PREFERRED: Set<string> = new Set<string>();

/**
 * Whether a tile has at least one cardinal neighbour that is an indestructible wall.
 *
 * @param tiles - the sector tile grid
 * @param row - the tile row
 * @param col - the tile column
 * @returns `true` when at least one cardinal neighbour is INDESTRUCTIBLE_WALL
 */
function isAdjacentToIndestructibleWall(tiles: Uint8Array[], row: number, col: number): boolean {
  for (const [dr, dc] of CARDINAL_DIRS) {
    const nr = row + dr;
    const nc = col + dc;
    if (nr >= 0 && nr < tiles.length && nc >= 0 && nc < tiles[0]!.length) {
      if (tiles[nr]![nc] === TileType.INDESTRUCTIBLE_WALL) return true;
    }
  }
  return false;
}

/**
 * Collect the valid placement positions for a sector: interior EMPTY tiles that
 * are not corridor tiles, not macro-feature tiles, and not cardinally adjacent
 * to an indestructible wall. Mirrors `countLootEligible` in validatorGates so
 * the feasibility gate and the placer agree on the eligible pool.
 *
 * @param sector - the sector being populated
 * @param sRow - the sector's grid row (for corridor keys and global coords)
 * @param sCol - the sector's grid column (for corridor keys and global coords)
 * @param corridorTiles - the set of corridor tile keys to exclude (`"sRow,sCol,r,c"`)
 * @param macroTiles - the set of macro-feature tile keys to exclude (`"globalR,globalC"`)
 * @returns the eligible placement positions
 */
export function collectValidPositions(
  sector: SectorData,
  sRow: number,
  sCol: number,
  corridorTiles: Set<string>,
  macroTiles: Set<string>,
): CellPos[] {
  const positions: CellPos[] = [];
  const tiles = sector.tiles;
  const last = SECTOR_TILE_SIZE - 1;

  for (let r = 1; r < last; r++) {
    for (let c = 1; c < last; c++) {
      if (tiles[r]![c] !== TileType.EMPTY) continue;
      if (corridorTiles.has(`${sRow},${sCol},${r},${c}`)) continue;
      const globalR = sRow * SECTOR_TILE_SIZE + r;
      const globalC = sCol * SECTOR_TILE_SIZE + c;
      if (macroTiles.has(`${globalR},${globalC}`)) continue;
      if (isAdjacentToIndestructibleWall(tiles, r, c)) continue;
      positions.push({ row: r, col: c });
    }
  }

  return positions;
}

/**
 * Build the loot-framing preferred-cell set (T7): the skeleton's `lootSpots`
 * cache cells (tile coords) that are still valid placement positions per the
 * `collectValidPositions` rules. Cells outside that pool are dropped so a
 * stale/ineligible hint can never force a bad placement — placement simply falls
 * back to the existing random pick. Returns an empty set for every sector type
 * with no `lootSpots` (all non-ResourceRich types), which keeps placement and
 * the RNG draw order byte-identical to before this hook.
 *
 * @param sector - the sector being populated
 * @param positions - the valid positions collected for this sector
 * @returns the set of `"row,col"` keys loot should prefer
 */
export function buildPreferredKeys(sector: SectorData, positions: CellPos[]): Set<string> {
  const preferred = new Set<string>();
  if (sector.lootSpots.length === 0) return preferred;
  const valid = new Set(positions.map((p) => `${p.row},${p.col}`));
  for (const spot of sector.lootSpots) {
    const key = `${spot.y},${spot.x}`;
    if (valid.has(key)) preferred.add(key);
  }
  return preferred;
}

/**
 * Score a position by how many non-EMPTY tiles surround it in the 8-neighbourhood.
 * Higher = more enclosed / closer to cover. Used to bias barrel placement toward
 * cover (chain-reaction adjacency) and trap placement toward chokepoints.
 *
 * @param tiles - the sector tile grid
 * @param r - candidate row
 * @param c - candidate column
 * @returns count of non-EMPTY 8-neighbours (0–8)
 */
function coverProximityScore(tiles: Uint8Array[], r: number, c: number): number {
  let score = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const t = tiles[r + dr]?.[c + dc];
      if (t !== undefined && t !== TileType.EMPTY) score++;
    }
  }
  return score;
}

/**
 * Build a preferred-cell set biased toward positions near cover (walls, chests,
 * other placed entities). Returns the keys of positions with a cover-proximity
 * score ≥ 2 — tiles that sit in enclosed pockets or adjacent to walls/cover
 * rather than in the open floor. Used for barrel placement (chain-reaction
 * adjacency) and trap placement (chokepoint bias).
 *
 * The set is consumed (mutated) by `pickPlacement`, so callers that share one
 * instance (e.g. barrels then traps) get sequential priority — barrels get
 * first pick of near-cover cells, traps get the remainder.
 *
 * @param positions - the valid placement positions for this sector
 * @param tiles - the sector tile grid (reflects current placement state)
 * @returns the set of `"row,col"` keys with score ≥ 2
 */
export function buildCoverProximityPreferred(
  positions: CellPos[],
  tiles: Uint8Array[],
): Set<string> {
  const preferred = new Set<string>();
  for (const p of positions) {
    if (coverProximityScore(tiles, p.row, p.col) >= 2) {
      preferred.add(`${p.row},${p.col}`);
    }
  }
  return preferred;
}

/**
 * Build the structure-backed preferred-cell set (map-polish round 7): cells
 * with at least one cardinal DESTRUCTIBLE_WALL neighbour — the nesting cells
 * where smashable structure forms a pocket. Chests prefer these so a chest
 * reads as vaulted INTO the breachable composition (smash the wall to open the
 * vault, loot guarding a breach bay) instead of floating on the open floor.
 *
 * @param positions - the valid placement positions for this sector
 * @param tiles - the sector tile grid (I-wall-adjacent cells are already
 *   excluded from `positions` by `collectValidPositions`, so this set is the
 *   D-wall-backed share of the eligible pool)
 * @returns the set of `"row,col"` keys with a cardinal D-wall neighbour
 */
export function buildStructureBackedPreferred(
  positions: CellPos[],
  tiles: Uint8Array[],
): Set<string> {
  const preferred = new Set<string>();
  for (const p of positions) {
    for (const [dr, dc] of CARDINAL_DIRS) {
      if (tiles[p.row + dr]?.[p.col + dc] === TileType.DESTRUCTIBLE_WALL) {
        preferred.add(`${p.row},${p.col}`);
        break;
      }
    }
  }
  return preferred;
}

/**
 * Choose a placement from `valid`, preferring a still-available preferred cell
 * (loot-framing T7 / round-7 structure nesting) before falling back to the
 * uniform random pick. The preferred branch picks a UNIFORM RANDOM member of
 * `preferred ∩ valid` (round 7: the former first-match-in-row-major return
 * swept every preferred placement toward the sector's NW corner — a programmatic
 * but arbitrary clustering that read as clutter). Both branches consume exactly
 * one `rng.nextInt` draw, so the per-placement RNG cost is unchanged (draw
 * counts shift only where the old preferred branch hit — sanctioned by the
 * round-7 PIPELINE_VERSION bump).
 *
 * @param valid - the spacing-filtered candidate positions
 * @param preferred - the preferred cache-cell keys (consumed as cells are used)
 * @param rng - the per-sector RNG stream
 * @returns the chosen position
 */
export function pickPlacement(valid: CellPos[], preferred: Set<string>, rng: SeededRNG): CellPos {
  if (preferred.size > 0) {
    const hits: number[] = [];
    for (let i = 0; i < valid.length; i++) {
      const p = valid[i]!;
      if (preferred.has(`${p.row},${p.col}`)) hits.push(i);
    }
    if (hits.length > 0) {
      const chosen = valid[hits[rng.nextInt(0, hits.length - 1)]!]!;
      preferred.delete(`${chosen.row},${chosen.col}`);
      return chosen;
    }
  }
  return valid[rng.nextInt(0, valid.length - 1)]!;
}

/**
 * Whether a cell keeps the minimum Manhattan spacing (>= 2) from every already
 * placed cell.
 *
 * @param row - the candidate row
 * @param col - the candidate column
 * @param placed - the set of placed `"row,col"` keys
 * @returns `true` when the cell is far enough from all placed cells
 */
export function hasMinSpacing(row: number, col: number, placed: Set<string>): boolean {
  for (const key of placed) {
    const comma = key.indexOf(',');
    const pr = parseInt(key.substring(0, comma), 10);
    const pc = parseInt(key.substring(comma + 1), 10);
    if (Math.abs(row - pr) + Math.abs(col - pc) < 2) return false;
  }
  return true;
}

/**
 * The shared spacing-aware placement loop: place up to `count` entities, each on
 * a spacing-filtered cell chosen via `pickPlacement`, removing the chosen cell
 * from `positions` and recording it in `placed`. Calls `onPlaced` per placement.
 *
 * @param positions - the candidate positions (mutated: chosen cells spliced out)
 * @param count - the maximum number of placements
 * @param placed - the placed-cell key set (mutated)
 * @param preferred - the loot-framing preferred-cell keys (consumed)
 * @param rng - the per-sector RNG stream
 * @param onPlaced - callback invoked with each chosen cell and its index
 * @returns nothing
 */
export function placeWithSpacing(
  positions: CellPos[],
  count: number,
  placed: Set<string>,
  preferred: Set<string>,
  rng: SeededRNG,
  onPlaced: (chosen: CellPos, index: number) => void,
): void {
  for (let i = 0; i < count; i++) {
    const valid = positions.filter((p) => hasMinSpacing(p.row, p.col, placed));
    if (valid.length === 0) break;

    const chosen = pickPlacement(valid, preferred, rng);
    const posIdx = positions.indexOf(chosen);

    placed.add(`${chosen.row},${chosen.col}`);
    positions.splice(posIdx, 1);

    onPlaced(chosen, i);
  }
}

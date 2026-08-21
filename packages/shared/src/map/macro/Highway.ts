import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import { SECTOR_GRID_SIZE, SECTOR_TILE_SIZE } from '../constants.js';
import type { HighwayDirection, HighwayInfo } from './MacroTypes.js';

/** Fixed 3-tile highway width: 1 center tile (fast lane) + 2 shoulder tiles. */
const HIGHWAY_WIDTH = 3;

/** Map edge index that must never be touched (outer perimeter wall). */
const PERIMETER_LAST = SECTOR_GRID_SIZE * SECTOR_TILE_SIZE - 1; // 79

/** Center band: the highway's base centerline is drawn from [33, 47]. */
const CENTER_MIN = 33;
const CENTER_MAX = 47;

/** Probability of placing a DESTRUCTIBLE_CRATE on each shoulder tile. */
const SHOULDER_CRATE_CHANCE = 0.3;

/**
 * Per-sector jog range. Each sector's centerline shifts by
 * `prevJog + nextInt(-2, 2)` relative to the previous sector.
 */
const JOG_STEP_MIN = -2;
const JOG_STEP_MAX = 2;

/**
 * Carve a 5-tile-wide highway strip through the center band of the map.
 *
 * The highway spans ALL sectors along its length axis (full width for H, full
 * height for V) and dead-ends at the outer perimeter wall. It clears EVERYTHING
 * in its 5-tile path — sector walls, border rings, crates, pillars, maze
 * corridors, and any entities already placed.
 *
 * Center 1 tile (offset 0) becomes EMPTY (fast lane). Shoulder tiles
 * (|offset| == 1) become EMPTY with a {@link SHOULDER_CRATE_CHANCE} chance of
 * a DESTRUCTIBLE_CRATE for cover.
 *
 * The per-sector jog creates a slight zig-zag at sector boundaries, preventing
 * a dead-straight sniper lane.
 *
 * @param sectors - the 2D sector grid (mutated in place)
 * @param rng - an isolated RNG stream (caller must XOR the seed)
 * @returns highway metadata including carved tile coordinates
 */
export function carveHighway(sectors: SectorData[][], rng: SeededRNG): HighwayInfo {
  const direction: HighwayDirection = rng.nextInt(0, 1) === 0 ? 'H' : 'V';
  const width = HIGHWAY_WIDTH;
  const half = Math.floor(width / 2); // 2
  const baseCenter = rng.nextInt(CENTER_MIN, CENTER_MAX);

  // Per-sector jog amounts along the cross-axis.
  const jogs: number[] = [0];
  for (let i = 1; i < SECTOR_GRID_SIZE; i++) {
    jogs.push(jogs[i - 1]! + rng.nextInt(JOG_STEP_MIN, JOG_STEP_MAX));
  }

  // Clamp each centerline so the highway stays inside [1, PERIMETER_LAST-1].
  const minCenter = half + 1;
  const maxCenter = PERIMETER_LAST - half - 1;
  const centerlines = jogs.map((j) => {
    const c = baseCenter + j;
    return Math.max(minCenter, Math.min(maxCenter, c));
  });

  const carvedTiles = new Set<string>();

  if (direction === 'H') {
    carveHorizontal(sectors, centerlines, half, rng, carvedTiles);
  } else {
    carveVertical(sectors, centerlines, half, rng, carvedTiles);
  }

  return { direction, width, centerlines, carvedTiles };
}

/**
 * Carve a horizontal highway: the strip runs left-to-right across all 4 sector
 * columns, with per-column row centerlines.
 */
function carveHorizontal(
  sectors: SectorData[][],
  centerlines: number[],
  half: number,
  rng: SeededRNG,
  carvedTiles: Set<string>,
): void {
  for (let sc = 0; sc < SECTOR_GRID_SIZE; sc++) {
    const center = centerlines[sc]!;
    const colStart = sc * SECTOR_TILE_SIZE;
    const colEnd = colStart + SECTOR_TILE_SIZE - 1;

    for (let gc = colStart; gc <= colEnd; gc++) {
      if (gc === 0 || gc === PERIMETER_LAST) continue;

      for (let dr = -half; dr <= half; dr++) {
        const gr = center + dr;
        if (gr <= 0 || gr >= PERIMETER_LAST) continue;

        setHighwayTile(sectors, gr, gc, dr, half, rng, carvedTiles);
      }
    }
  }
}

/**
 * Carve a vertical highway: the strip runs top-to-bottom across all 4 sector
 * rows, with per-row column centerlines.
 */
function carveVertical(
  sectors: SectorData[][],
  centerlines: number[],
  half: number,
  rng: SeededRNG,
  carvedTiles: Set<string>,
): void {
  for (let sr = 0; sr < SECTOR_GRID_SIZE; sr++) {
    const center = centerlines[sr]!;
    const rowStart = sr * SECTOR_TILE_SIZE;
    const rowEnd = rowStart + SECTOR_TILE_SIZE - 1;

    for (let gr = rowStart; gr <= rowEnd; gr++) {
      if (gr === 0 || gr === PERIMETER_LAST) continue;

      for (let dc = -half; dc <= half; dc++) {
        const gc = center + dc;
        if (gc <= 0 || gc >= PERIMETER_LAST) continue;

        setHighwayTile(sectors, gr, gc, dc, half, rng, carvedTiles);
      }
    }
  }
}

/**
 * Set a single highway tile: EMPTY for center tiles, EMPTY-or-CRATE for
 * shoulders. Records every cleared tile in `carvedTiles`.
 */
function setHighwayTile(
  sectors: SectorData[][],
  gr: number,
  gc: number,
  offset: number,
  half: number,
  rng: SeededRNG,
  carvedTiles: Set<string>,
): void {
  const sr = Math.floor(gr / SECTOR_TILE_SIZE);
  const sc = Math.floor(gc / SECTOR_TILE_SIZE);
  const lr = gr % SECTOR_TILE_SIZE;
  const lc = gc % SECTOR_TILE_SIZE;

  const sector = sectors[sr]?.[sc];
  if (!sector?.tiles?.[lr]) return;

  sector.tiles[lr]![lc] = TileType.EMPTY;

  // Shoulder tiles (|offset| == half) may get a destructible crate for cover.
  if (Math.abs(offset) === half && rng.nextFloat() < SHOULDER_CRATE_CHANCE) {
    sector.tiles[lr]![lc] = TileType.DESTRUCTIBLE_CRATE;
  }

  carvedTiles.add(`${gr},${gc}`);
}

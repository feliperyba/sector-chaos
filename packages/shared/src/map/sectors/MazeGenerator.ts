import { SectorType } from '../types.js';
import { TileType } from '../../enums/TileType.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import type { SectorConfig } from './ISectorGenerator.js';
import type { ISectorGenerator } from './ISectorGenerator.js';
import {
  MAZE_SUB_VARIANTS,
  resolveSubVariant,
  type MazeSubVariant,
  type SectorSubVariant,
} from './subVariants.js';
import { MAZE_SKELETON_BUILDERS } from './mazeSkeletons.js';

/**
 * Maze (labyrinth ambush / cat-and-mouse) generator. Dispatches on the chosen
 * sub-variant to one of four DISTINCT skeletons (T6): asymmetric, mixed-width
 * (2-wide arteries + 1-wide branches), looped, with seeded breakable
 * `wall_secret` (DESTRUCTIBLE_WALL) shortcuts (ADR 0027 / GDD §5.2.3). This
 * replaces the old 4-fold mirrored, all-width-1, all-indestructible carve —
 * repetitive, unfair for the 96px melee hitbox, and the worst case for 63-bot
 * LOS / pathfinding (ADR 0024). EntityPlacer later tops up crate density (5%) and
 * places loot in the open junction pockets each skeleton leaves clear of
 * indestructible walls.
 */
export class MazeGenerator implements ISectorGenerator {
  readonly subVariants = MAZE_SUB_VARIANTS;

  /**
   * Whether this generator supports the given sub-variant id.
   *
   * @param id - the sub-variant id to test
   * @returns `true` if `id` is a Maze sub-variant
   */
  supports(id: SectorSubVariant): boolean {
    return (this.subVariants as readonly SectorSubVariant[]).includes(id);
  }

  /**
   * Build a Maze sector, dispatching on its sub-variant to the matching skeleton
   * builder. The builder consumes `rng`, so two Maze instances differ and the
   * same seed reproduces them exactly.
   *
   * @param rng - the per-sector seeded RNG stream
   * @param config - the sector generation config (type, coord, sub-variant)
   * @returns the generated sector data
   */
  generate(rng: SeededRNG, config: SectorConfig): SectorData {
    const subVariant = resolveSubVariant(SectorType.MAZE, config.subVariant) as MazeSubVariant;

    const { tiles, landmarkAnchor } = MAZE_SKELETON_BUILDERS[subVariant](rng);
    const lootSpots = findMazeLootSpots(tiles);

    return {
      type: config.type,
      subVariant,
      tiles,
      elevation: null,
      lootSpots,
      landmarkAnchor,
      mirrored: false,
      subBlockMask: 0,
      bounds: {
        x: config.sectorCoord.col * config.width * config.tileSize,
        y: config.sectorCoord.row * config.height * config.tileSize,
        width: config.width * config.tileSize,
        height: config.height * config.tileSize,
      },
      theme: config.theme,
    };
  }
}

/**
 * Scan a maze tile grid for structural loot-pocket positions: junctions (≥3
 * open cardinals — wide intersections where corridors meet) and dead-ends
 * (1 open cardinal — terminal pockets). Junctions are returned first (more
 * strategic), dead-ends second. Capped at 8 so EntityPlacer isn't flooded.
 *
 * Many of these will be filtered by `collectValidPositions` (tiles cardinally
 * adjacent to INDESTRUCTIBLE_WALL are excluded) — only the ones in wide-enough
 * openings survive, which is exactly where maze loot should land.
 */
function findMazeLootSpots(tiles: Uint8Array[]): { x: number; y: number }[] {
  const junctions: { x: number; y: number }[] = [];
  const deadEnds: { x: number; y: number }[] = [];
  const size = tiles.length;

  for (let r = 1; r < size - 1; r++) {
    for (let c = 1; c < size - 1; c++) {
      if (tiles[r]![c] !== TileType.EMPTY) continue;

      const openCount =
        (tiles[r - 1]?.[c] === TileType.EMPTY ? 1 : 0) +
        (tiles[r + 1]?.[c] === TileType.EMPTY ? 1 : 0) +
        (tiles[r]![c - 1] === TileType.EMPTY ? 1 : 0) +
        (tiles[r]![c + 1] === TileType.EMPTY ? 1 : 0);

      if (openCount >= 3) junctions.push({ x: c, y: r });
      else if (openCount === 1) deadEnds.push({ x: c, y: r });
    }
  }

  return [...junctions, ...deadEnds].slice(0, 8);
}

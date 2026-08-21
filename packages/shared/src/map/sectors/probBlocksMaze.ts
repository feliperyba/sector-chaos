import { TileType } from '../../enums/TileType.js';
import type { SkeletonSubBlock } from './probabilisticBlocks.js';
import type { MazeSubVariant } from './subVariants.js';

/**
 * Authored probabilistic sub-blocks for the MAZE skeletons (map-redesign
 * ticket 08 / DEC-007.1).
 *
 * Maze corridors are 1–2 tiles wide, so a `fill` in the wrong cell would seal
 * a lane; the runtime connectivity guard reverts those. The signature maze
 * sub-blocks are therefore `clear` "gap-phase variants": they smash an extra
 * opening through separator walls at authored positions (a present block
 * converts the wall cells to EMPTY — an alternate route that did not exist in
 * the base carve). `clear` can only ADD walkable tiles, so the only guard
 * that can fire is the lone-wall one (clearing must not orphan an
 * indestructible wall into an isolated stub).
 *
 * Fills use DESTRUCTIBLE_WALL only — the maze family places smashable wall
 * cover, never crates (existing family convention; findMazeLootSpots and the
 * family tests rely on it).
 *
 * Presence dice: exactly 4–5 draws per variant.
 */

/** Gap-phase + hub-cover blocks for the Loose Labyrinth. */
const LOOSE_LABYRINTH_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'labyrinth-north-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [5, 9],
      [5, 10],
    ],
  },
  {
    id: 'labyrinth-south-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [14, 9],
      [14, 10],
    ],
  },
  {
    id: 'labyrinth-west-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 5],
      [10, 5],
    ],
  },
  {
    id: 'labyrinth-east-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 14],
      [10, 14],
    ],
  },
  {
    id: 'labyrinth-hub-cover',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.25,
    cells: [
      [9, 9],
      [9, 10],
    ],
  },
];

/** Gap-phase + chamber-cover blocks for Chambers & Halls. */
const CHAMBERS_AND_HALLS_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'chambers-nw-interior-cover',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [5, 5],
      [6, 5],
    ],
  },
  {
    id: 'chambers-se-interior-cover',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [13, 13],
      [13, 14],
    ],
  },
  {
    id: 'chambers-west-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 4],
      [10, 4],
    ],
  },
  {
    id: 'chambers-east-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 15],
      [10, 15],
    ],
  },
];

/** Gap-phase blocks for the Breakable Warren. */
const BREAKABLE_WARREN_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'warren-north-smash-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [5, 9],
      [5, 10],
    ],
  },
  {
    id: 'warren-south-smash-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [14, 10],
      [14, 11],
    ],
  },
  {
    id: 'warren-west-smash-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 5],
      [10, 5],
    ],
  },
  {
    id: 'warren-east-smash-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [10, 14],
      [11, 14],
    ],
  },
  {
    id: 'warren-hub-cover',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.25,
    cells: [
      [9, 9],
      [10, 9],
    ],
  },
];

/** Gap-phase + pocket-cover blocks for the Concentric Spiral. */
const CONCENTRIC_SPIRAL_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'spiral-nw-ring-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [7, 7],
      [7, 8],
    ],
  },
  {
    id: 'spiral-se-ring-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [12, 11],
      [12, 12],
    ],
  },
  {
    id: 'spiral-outer-west-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [4, 4],
      [4, 5],
    ],
  },
  {
    id: 'spiral-outer-east-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [15, 14],
      [15, 15],
    ],
  },
  {
    id: 'spiral-pocket-cover',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.25,
    cells: [
      [9, 16],
      [10, 16],
    ],
  },
];

/** Gap-phase + junction-cover blocks for the Sewer Grid (ticket 08 skeleton). */
const SEWER_GRID_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'sewer-north-lattice-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [5, 9],
      [5, 10],
    ],
  },
  {
    id: 'sewer-south-lattice-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.5,
    cells: [
      [14, 9],
      [14, 10],
    ],
  },
  {
    id: 'sewer-west-lattice-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 5],
      [10, 5],
    ],
  },
  {
    id: 'sewer-east-lattice-gap',
    op: 'clear',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 14],
      [10, 14],
    ],
  },
];

/** MAZE sub-block table (one entry per skeleton; 4–5 dice each). */
export const MAZE_SUB_BLOCKS: Readonly<Record<MazeSubVariant, readonly SkeletonSubBlock[]>> = {
  'Loose Labyrinth': LOOSE_LABYRINTH_BLOCKS,
  'Chambers & Halls': CHAMBERS_AND_HALLS_BLOCKS,
  'Breakable Warren': BREAKABLE_WARREN_BLOCKS,
  'Concentric Spiral': CONCENTRIC_SPIRAL_BLOCKS,
  'Sewer Grid': SEWER_GRID_BLOCKS,
};

import { TileType } from '../../enums/TileType.js';
import type { SkeletonSubBlock } from './probabilisticBlocks.js';
import type { OpenArenaSubVariant } from './subVariants.js';

/**
 * Authored probabilistic sub-blocks for the OPEN_ARENA skeletons
 * (map-redesign ticket 08 / DEC-007.1). Cells sit in the wide-open margins
 * these skeletons keep clear (the field is rows/cols 2..17, structures hug
 * corners/center), so the presence dice mostly land. Presence dice: exactly
 * 4–5 draws per variant.
 */

/** Cover blocks for the Corner Bastions midfield. */
const CORNER_BASTIONS_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'bastions-west-midfield-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 5],
      [10, 5],
    ],
  },
  {
    id: 'bastions-east-midfield-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 14],
      [10, 14],
    ],
  },
  {
    id: 'bastions-north-crossbar',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [4, 9],
      [4, 10],
    ],
  },
  {
    id: 'bastions-south-crossbar',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [15, 9],
      [15, 10],
    ],
  },
];

/** Cover blocks for the Central Monument approach ring. */
const CENTRAL_MONUMENT_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'monument-nw-approach-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [4, 4],
      [4, 5],
    ],
  },
  {
    id: 'monument-se-approach-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [15, 14],
      [15, 15],
    ],
  },
  {
    id: 'monument-ne-approach-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [4, 14],
      [5, 14],
    ],
  },
  {
    id: 'monument-sw-approach-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [14, 4],
      [15, 4],
    ],
  },
  {
    id: 'monument-far-west-single',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.25,
    cells: [
      [9, 2],
      [10, 2],
    ],
  },
];

/** Cover blocks for the Scatter Cover quadrants. */
const SCATTER_COVER_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'scatter-north-quad-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [6, 12],
      [6, 13],
    ],
  },
  {
    id: 'scatter-south-quad-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [13, 6],
      [12, 6],
    ],
  },
  {
    id: 'scatter-nw-quad-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [5, 5],
      [5, 6],
    ],
  },
  {
    id: 'scatter-se-quad-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [14, 14],
      [14, 13],
    ],
  },
];

/** Cover blocks for the Diagonal Spurs aisles. */
const DIAGONAL_SPURS_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'spurs-west-aisle-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 5],
      [9, 6],
    ],
  },
  {
    id: 'spurs-east-aisle-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [10, 14],
      [10, 15],
    ],
  },
  {
    id: 'spurs-north-aisle-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [4, 10],
      [5, 10],
    ],
  },
  {
    id: 'spurs-south-aisle-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [15, 9],
      [14, 9],
    ],
  },
];

/** Cover blocks for the Airstrip lane shoulders (ticket 08 skeleton). */
const AIRSTRIP_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'airstrip-lane-west-end',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 2],
      [10, 2],
    ],
  },
  {
    id: 'airstrip-lane-east-end',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 17],
      [10, 17],
    ],
  },
  {
    id: 'airstrip-north-mouth-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [6, 9],
      [6, 10],
    ],
  },
  {
    id: 'airstrip-south-mouth-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [13, 9],
      [13, 10],
    ],
  },
];

/** OPEN_ARENA sub-block table (one entry per skeleton; 4–5 dice each). */
export const OPEN_ARENA_SUB_BLOCKS: Readonly<
  Record<OpenArenaSubVariant, readonly SkeletonSubBlock[]>
> = {
  'Corner Bastions': CORNER_BASTIONS_BLOCKS,
  'Central Monument': CENTRAL_MONUMENT_BLOCKS,
  'Scatter Cover': SCATTER_COVER_BLOCKS,
  'Diagonal Spurs': DIAGONAL_SPURS_BLOCKS,
  Airstrip: AIRSTRIP_BLOCKS,
};

import { TileType } from '../../enums/TileType.js';
import type { SkeletonSubBlock } from './probabilisticBlocks.js';
import type { GridArenaSubVariant } from './subVariants.js';

/**
 * Authored probabilistic sub-blocks for the GRID_ARENA skeletons
 * (map-redesign ticket 08 / DEC-007.1). Cells are authored in the unmirrored
 * frame at the skeletons' known-open pocket zones (lattice gap axes, ring
 * annuli, lane midpoints); the runtime guards (see probabilisticBlocks.ts)
 * deterministically skip or revert any placement that would split lanes,
 * starve spawns or orphan walls. Presence dice: exactly 4 draws per variant.
 */

/** Crate-cluster cover blocks for the Classic Lattice gaps and mid-lanes. */
const CLASSIC_LATTICE_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'lattice-nw-gap-crates',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [4, 5],
      [5, 5],
    ],
  },
  {
    id: 'lattice-se-gap-crates',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [13, 16],
      [13, 17],
    ],
  },
  {
    id: 'lattice-north-mid-wall-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [6, 8],
      [6, 9],
    ],
  },
  {
    id: 'lattice-south-mid-wall-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [13, 11],
      [13, 12],
    ],
  },
];

/** Cover blocks for the Ring Fortress annular corridors and outer margin. */
const RING_FORTRESS_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'ring-north-annulus-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [5, 9],
      [5, 10],
    ],
  },
  {
    id: 'ring-south-annulus-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [14, 9],
      [14, 10],
    ],
  },
  {
    id: 'ring-west-annulus-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 5],
      [10, 5],
    ],
  },
  {
    id: 'ring-east-annulus-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 14],
      [10, 14],
    ],
  },
  {
    id: 'ring-outer-margin-cluster',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.25,
    cells: [
      [2, 2],
      [2, 3],
      [3, 2],
    ],
  },
];

/** Cover blocks for the Broken Grid irregular lanes. */
const BROKEN_GRID_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'broken-west-lane-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [5, 5],
      [5, 6],
    ],
  },
  {
    id: 'broken-east-lane-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [13, 13],
      [13, 14],
    ],
  },
  {
    id: 'broken-north-spur-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [2, 9],
      [2, 10],
    ],
  },
  {
    id: 'broken-south-spur-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [16, 9],
      [16, 10],
    ],
  },
  {
    id: 'broken-corner-pocket',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.25,
    cells: [
      [16, 16],
      [16, 15],
    ],
  },
];

/** Cover blocks for the Lane Corridors bays (lane count/positions vary per instance). */
const LANE_CORRIDORS_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'lanes-nw-bay-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [3, 3],
      [3, 4],
    ],
  },
  {
    id: 'lanes-se-bay-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [16, 15],
      [16, 16],
    ],
  },
  {
    id: 'lanes-ne-bay-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [3, 15],
      [3, 16],
    ],
  },
  {
    id: 'lanes-sw-bay-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [15, 3],
      [16, 3],
    ],
  },
];

/** Cover blocks for the Plaza Crossroads lanes and room mouths (ticket 08 skeleton). */
const PLAZA_CROSSROADS_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'plaza-lane-west-mouth',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 5],
      [10, 5],
    ],
  },
  {
    id: 'plaza-lane-east-mouth',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [9, 14],
      [10, 14],
    ],
  },
  {
    id: 'plaza-north-shoulder',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [6, 9],
      [6, 10],
    ],
  },
  {
    id: 'plaza-south-shoulder',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [13, 9],
      [13, 10],
    ],
  },
  {
    id: 'plaza-ring-corner-cluster',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.25,
    cells: [
      [1, 1],
      [1, 2],
    ],
  },
];

/** GRID_ARENA sub-block table (one entry per skeleton; 4–5 dice each). */
export const GRID_ARENA_SUB_BLOCKS: Readonly<
  Record<GridArenaSubVariant, readonly SkeletonSubBlock[]>
> = {
  'Classic Lattice': CLASSIC_LATTICE_BLOCKS,
  'Ring Fortress': RING_FORTRESS_BLOCKS,
  'Broken Grid': BROKEN_GRID_BLOCKS,
  'Lane Corridors': LANE_CORRIDORS_BLOCKS,
  'Plaza Crossroads': PLAZA_CROSSROADS_BLOCKS,
};

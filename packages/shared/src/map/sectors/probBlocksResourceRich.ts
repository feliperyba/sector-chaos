import { TileType } from '../../enums/TileType.js';
import type { SkeletonSubBlock } from './probabilisticBlocks.js';
import type { ResourceRichSubVariant } from './subVariants.js';

/**
 * Authored probabilistic sub-blocks for the RESOURCE_RICH skeletons
 * (map-redesign ticket 08 / DEC-007.1). Cells sit in the open field around
 * each skeleton's framed caches (never ON the cache interiors — the runtime
 * guard also skips authored lootSpots/anchors). Presence dice: exactly 4–5
 * draws per variant.
 */

/** Exterior cover blocks around the Treasure Vault. */
const TREASURE_VAULT_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'vault-north-exterior-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [4, 9],
      [4, 10],
    ],
  },
  {
    id: 'vault-south-exterior-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [15, 9],
      [15, 10],
    ],
  },
  {
    id: 'vault-west-exterior-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 4],
      [10, 4],
    ],
  },
  {
    id: 'vault-east-exterior-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 15],
      [10, 15],
    ],
  },
];

/** Aisle cover blocks between the Loot Bazaar stalls. */
const LOOT_BAZAAR_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'bazaar-north-aisle-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [6, 9],
      [7, 9],
    ],
  },
  {
    id: 'bazaar-south-aisle-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [12, 9],
      [13, 9],
    ],
  },
  {
    id: 'bazaar-west-aisle-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 6],
      [9, 7],
    ],
  },
  {
    id: 'bazaar-east-aisle-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [9, 12],
      [9, 13],
    ],
  },
];

/** Token-cover blocks near the Exposed Cache spots. */
const EXPOSED_CACHE_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'exposed-nw-field-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [6, 6],
      [6, 7],
    ],
  },
  {
    id: 'exposed-se-field-pair',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [13, 13],
      [13, 12],
    ],
  },
  {
    id: 'exposed-ne-field-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [6, 13],
      [6, 12],
    ],
  },
  {
    id: 'exposed-sw-field-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [13, 6],
      [13, 7],
    ],
  },
  {
    id: 'exposed-center-sliver',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.25,
    cells: [
      [16, 16],
      [16, 15],
    ],
  },
];

/** Lane cover blocks between the Supply Depot shelves. */
const SUPPLY_DEPOT_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'depot-nw-corner-cluster',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [2, 2],
      [3, 2],
    ],
  },
  {
    id: 'depot-se-corner-cluster',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [17, 16],
      [17, 17],
    ],
  },
  {
    id: 'depot-ne-lane-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [2, 16],
      [2, 17],
    ],
  },
  {
    id: 'depot-sw-lane-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [16, 2],
      [17, 2],
    ],
  },
];

/** Street-mouth cover blocks for the Bank Row (ticket 08 skeleton). */
const BANK_ROW_BLOCKS: readonly SkeletonSubBlock[] = [
  {
    id: 'bank-street-west-mouth',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [10, 1],
      [11, 1],
    ],
  },
  {
    id: 'bank-street-east-mouth',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_CRATE,
    chance: 0.5,
    cells: [
      [10, 17],
      [11, 17],
    ],
  },
  {
    id: 'bank-street-mid-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [10, 6],
      [11, 6],
    ],
  },
  {
    id: 'bank-street-far-wall',
    op: 'fill',
    tile: TileType.DESTRUCTIBLE_WALL,
    chance: 0.33,
    cells: [
      [10, 11],
      [11, 11],
    ],
  },
];

/** RESOURCE_RICH sub-block table (one entry per skeleton; 4–5 dice each). */
export const RESOURCE_RICH_SUB_BLOCKS: Readonly<
  Record<ResourceRichSubVariant, readonly SkeletonSubBlock[]>
> = {
  'Treasure Vault': TREASURE_VAULT_BLOCKS,
  'Loot Bazaar': LOOT_BAZAAR_BLOCKS,
  'Exposed Cache': EXPOSED_CACHE_BLOCKS,
  'Supply Depot': SUPPLY_DEPOT_BLOCKS,
  'Bank Row': BANK_ROW_BLOCKS,
};

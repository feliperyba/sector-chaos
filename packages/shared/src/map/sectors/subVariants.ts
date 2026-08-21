import { SectorType } from '../types.js';

/**
 * Canonical per-type sub-variant (Skeleton) ids. Each sector type is realized by
 * one of these procedural skeletons, chosen per sector instance from the map
 * seed. All sub-variants of a type deliver the same Gameplay Purpose and balance
 * budget; they differ only in structural shape (see CONTEXT.md → Sub-variant).
 *
 * Map-redesign ticket 08 (DEC-007.3): the library grew to 5 ids per type —
 * each type's fifth id is its purpose-typed new skeleton (Plaza Crossroads /
 * Airstrip / Sewer Grid / Bank Row). Selection stays uniform over the
 * dedup-filtered pool (the "selection weights extend" clause = the same
 * uniform-draw mechanism now covers 5 candidates per type).
 */
export const GRID_ARENA_SUB_VARIANTS = [
  'Classic Lattice',
  'Ring Fortress',
  'Broken Grid',
  'Lane Corridors',
  'Plaza Crossroads',
] as const;

export const OPEN_ARENA_SUB_VARIANTS = [
  'Corner Bastions',
  'Central Monument',
  'Scatter Cover',
  'Diagonal Spurs',
  'Airstrip',
] as const;

export const MAZE_SUB_VARIANTS = [
  'Loose Labyrinth',
  'Chambers & Halls',
  'Breakable Warren',
  'Concentric Spiral',
  'Sewer Grid',
] as const;

export const RESOURCE_RICH_SUB_VARIANTS = [
  'Treasure Vault',
  'Loot Bazaar',
  'Exposed Cache',
  'Supply Depot',
  'Bank Row',
] as const;

/** Sub-variant id union for {@link SectorType.GRID_ARENA}. */
export type GridArenaSubVariant = (typeof GRID_ARENA_SUB_VARIANTS)[number];
/** Sub-variant id union for {@link SectorType.OPEN_ARENA}. */
export type OpenArenaSubVariant = (typeof OPEN_ARENA_SUB_VARIANTS)[number];
/** Sub-variant id union for {@link SectorType.MAZE}. */
export type MazeSubVariant = (typeof MAZE_SUB_VARIANTS)[number];
/** Sub-variant id union for {@link SectorType.RESOURCE_RICH}. */
export type ResourceRichSubVariant = (typeof RESOURCE_RICH_SUB_VARIANTS)[number];

/** Any sector sub-variant id, across all sector types. */
export type SectorSubVariant =
  | GridArenaSubVariant
  | OpenArenaSubVariant
  | MazeSubVariant
  | ResourceRichSubVariant;

/**
 * The supported sub-variant id set for each sector type. The single source of
 * truth for selection (`MapGenerator`) and per-generator `supports` checks.
 */
export const SUB_VARIANTS_BY_TYPE: Record<SectorType, readonly SectorSubVariant[]> = {
  [SectorType.GRID_ARENA]: GRID_ARENA_SUB_VARIANTS,
  [SectorType.OPEN_ARENA]: OPEN_ARENA_SUB_VARIANTS,
  [SectorType.MAZE]: MAZE_SUB_VARIANTS,
  [SectorType.RESOURCE_RICH]: RESOURCE_RICH_SUB_VARIANTS,
};

/**
 * Resolve the effective sub-variant for a generator. Returns `requested` when it
 * is a supported id for `type`, otherwise the type's first (default) id — so a
 * generator always records a valid sub-variant even when called directly (tests)
 * or with an unknown id.
 *
 * @param type - the sector type being generated
 * @param requested - the sub-variant id requested via config, if any
 * @returns a sub-variant id guaranteed to be supported by `type`
 */
export function resolveSubVariant(
  type: SectorType,
  requested: SectorSubVariant | undefined,
): SectorSubVariant {
  const supported = SUB_VARIANTS_BY_TYPE[type];
  if (requested !== undefined && supported.includes(requested)) return requested;
  return supported[0]!;
}

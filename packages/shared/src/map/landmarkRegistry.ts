import type { SectorSubVariant } from './sectors/subVariants.js';
import { SectorType } from './types.js';
import {
  GRID_ARENA_COMPOSITIONS,
  OPEN_ARENA_COMPOSITIONS,
  MAZE_COMPOSITIONS,
  RESOURCE_RICH_COMPOSITIONS,
} from './landmarkRegistryData.js';

/**
 * Landmark composition registry (map-redesign ticket 04 / DEC-002; stripped of
 * all bake-time visual fields by map-polish ticket 29).
 *
 * Per sector type, 3–5 authored hero-landmark compositions. A composition is
 * now PURELY the landmark's placement/naming identity — the ticket-04 client
 * composite dressing (loose `game`-atlas frames + per-type tint + scale baked
 * client-side on top of the floor grid) was REMOVED by the owner's ruling:
 * "the beacon plaza composition is still baking random tiles on top of the
 * floor grid, I told you to remove it and create real map composition over
 * the grid layers". The visible landmark is the SERVER-composed structure —
 * the beacon keep (`landmarkPlaza.ts`) + the beacon-anchored court floor
 * (`FloorSpriteSelector`) + the beacon light + motes. Each entry retains:
 *
 * - `rarity` — `'common'` or `'rare'`. Exactly one entry per type is RARE and
 *   is deliberately under-rolled (weight 0.35 vs 1.0) so its appearance is an
 *   event (NMS rarity-as-emotion). The per-map "signature" variant is not
 *   authored here — it is ROTATED by seed band at assignment time
 *   (`landmarks.ts`), so consecutive seed bands rarely repeat it.
 * - `nounHints` — the POI-name nouns this landmark family aligns with, per
 *   sub-variant of the type (Elena's structure-alignment dissent: the
 *   landmark's identity links into the sector's name). The naming pass
 *   (`poiNames.ts`) restricts the sector's noun draw to
 *   `NOUNS_BY_SUB_VARIANT[subVariant] ∩ nounHints[subVariant]`. DATA CONTRACT:
 *   every intersection is guaranteed non-empty (asserted by the landmark test
 *   suite), so alignment always holds with zero fallback.
 * - `exclusionRadius` — the decor-free exclusion zone radius (2–3 tiles,
 *   Chebyshev) around the placed anchor: decorative accents + sconce/crystal
 *   light placements avoid it; entity/loot/spawn placement is untouched (the
 *   GDD §5.3.1 entity rules and §5.6 loot minimums are preserved verbatim).
 *
 * This module is PURE DATA + pure lookups (no RNG, no Phaser) so the naming
 * pass, the server light/decor exclusion zones and the test suite consume it.
 */

/**
 * Noun-alignment hints keyed by the sub-variants of the composition's type.
 * Values MUST be members of the corresponding `NOUNS_BY_SUB_VARIANT` pool and
 * non-empty (the landmark test suite asserts both).
 */
export type NounHints = Partial<Record<SectorSubVariant, readonly string[]>>;

/** One authored hero-landmark composition (placement + naming identity). */
export interface LandmarkComposition {
  /** Stable id (unique map-wide across types). */
  id: string;
  /** Display family name (diagnostics / manifest). */
  family: string;
  /** Authored rarity class. The signature class is assigned per seed band. */
  rarity: 'common' | 'rare';
  /** Decor-free exclusion zone radius (Chebyshev tiles, 2–3). */
  exclusionRadius: 2 | 3;
  /** POI-noun alignment hints per sub-variant. */
  nounHints: NounHints;
}

/**
 * The hero-landmark registry: per sector type, 3–5 authored compositions.
 * Data-driven — tuning never touches algorithms (DEC-002 / SPEC user story 44).
 */
export const LANDMARK_REGISTRY: Readonly<Record<SectorType, readonly LandmarkComposition[]>> = {
  [SectorType.GRID_ARENA]: GRID_ARENA_COMPOSITIONS,
  [SectorType.OPEN_ARENA]: OPEN_ARENA_COMPOSITIONS,
  [SectorType.MAZE]: MAZE_COMPOSITIONS,
  [SectorType.RESOURCE_RICH]: RESOURCE_RICH_COMPOSITIONS,
};

/** Stable type iteration order used by the signature-rotation offset. */
export const LANDMARK_TYPE_ORDER: readonly SectorType[] = [
  SectorType.GRID_ARENA,
  SectorType.OPEN_ARENA,
  SectorType.MAZE,
  SectorType.RESOURCE_RICH,
];

/** Flat id → composition lookup (ids are unique map-wide). */
const COMPOSITION_BY_ID = new Map<string, LandmarkComposition>(
  Object.values(LANDMARK_REGISTRY)
    .flat()
    .map((c) => [c.id, c]),
);

/** Resolve a composition by id (undefined for unknown ids). */
export function landmarkCompositionById(id: string): LandmarkComposition | undefined {
  return COMPOSITION_BY_ID.get(id);
}

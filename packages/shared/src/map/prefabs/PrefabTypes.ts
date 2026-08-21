/**
 * Prefab library types (map-polish ticket 25).
 *
 * A PREFAB is one authored composition — straight wall RUNS (rendered by the
 * autotiler as top-down face bars + L-corners, per the ticket-24 beacon-keep
 * encoding discipline) plus an optional symmetric PROP list (DESTRUCTIBLE_CRATE
 * object tiles that hydrate to live entities through the existing
 * `InteractiveLayerBuilder` grid-scan path). Prefabs are selected + stamped by
 * the deterministic smart-reuse placement pass
 * (`prefabs/PrefabPlacementPass.ts`) instead of per-cell probability scatter.
 *
 * ART-AWARE ENCODING RULES (binding, ticket 25 + ticket 24 precedent):
 * - Walls are RUN cells, never filled squares: every wall tile must keep ≥1
 *   CARDINAL wall neighbour inside its own run after any conflict-clip, so the
 *   autotiler renders continuous face bars and never a floating half-strip.
 * - NO 2×2 wall-like clump: authored shapes are exactly ONE tile thick and the
 *   placement pass additionally refuses any single write that would complete a
 *   2×2 wall-like block with pre-existing geometry.
 * - NO sealed region: partial enclosures only (U/L/pier shapes with wide
 *   mouths), and the pass reverts any stamp whose walls locally seal walkable
 *   tiles (windowed reachability check).
 * - L-corners are owned by exactly ONE run (the joining run starts beside the
 *   corner tile, never on it) so the autotiler stamps one clean `wall_corner`.
 * - Props are DESTRUCTIBLE_CRATE tiles only — grid DESTRUCTIBLE_BARREL tiles
 *   have no hydration path (see `landmarkPlaza.ts` precedent).
 */

import type { TileType } from '../../enums/TileType.js';
import type { SectorType } from '../types.js';

/** A straight wall run: ≥2 colinear `[col, row]` offsets from the stamp anchor. */
export interface PrefabWallRun {
  tiles: ReadonlyArray<readonly [number, number]>;
  /** The run's material (persisting structure vs smashable barricade). */
  tile: TileType.INDESTRUCTIBLE_WALL | TileType.DESTRUCTIBLE_WALL;
}

/** How a prefab may be transformed when reused (orientation variation). */
export type PrefabOrientations =
  | /** All four 90° rotations. */ 'rot4'
  | /** Four rotations + horizontal mirror (8 transforms). */ 'full';

/** One authored prefab composition (see {@link PREFAB_LIBRARY}). */
export interface PrefabDef {
  /** Stable id (telemetry + report vocabulary). */
  id: string;
  /** Fictional read, one line (what the composition "is"). */
  fiction: string;
  /** Sector types allowed to stamp this prefab (biome family allowlist). */
  allowedSectorTypes: readonly SectorType[];
  /** Selection weight inside a sector's allowed pool. */
  weight: number;
  /** Orientation variants the placement pass may draw. */
  orientations: PrefabOrientations;
  /** Wall runs (may be empty for a props-only composition). */
  walls: ReadonlyArray<PrefabWallRun>;
  /** Prop tiles (DESTRUCTIBLE_CRATE object placements). */
  props: ReadonlyArray<readonly [number, number]>;
}

/** The number of distinct orientation transforms a prefab offers. */
export function orientationCount(def: PrefabDef): number {
  return def.orientations === 'full' ? 8 : 4;
}

/**
 * Apply orientation variant `i` (canonical order: rot0, rot90, rot180, rot270,
 * then the same four mirrored) to a `[col, row]` offset. Pure arithmetic —
 * rotate90([c, r]) = [-r, c] (clockwise on the screen grid), mirror flips col.
 */
export function transformOffset(c: number, r: number, variant: number): readonly [number, number] {
  let col = c;
  let row = r;
  const rot = variant % 4;
  for (let i = 0; i < rot; i++) {
    const nc = -row;
    const nr = col;
    col = nc;
    row = nr;
  }
  if (variant >= 4) col = -col;
  return [col, row];
}

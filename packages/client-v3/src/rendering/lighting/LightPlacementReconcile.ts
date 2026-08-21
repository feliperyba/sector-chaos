/**
 * LightPlacementReconcile — reconciles the one-shot `mapData` light-placement
 * list against the LIVE destructibles schema state (map-polish ticket 08).
 *
 * Two pure seams, both server-authoritative by construction:
 *
 *   1. {@link cullDestroyedLightPlacements} — the LATE-JOIN/SPECTATOR fix.
 *      `mapData` carries the FULL placement list for the whole match; a client
 *      joining after lights were destroyed receives placements whose backing
 *      entities are already gone, and without this cull those lights would
 *      render as lit forever (the pre-existing ghost-campfire-light bug —
 *      now fixed for EVERY destructible-backed light). Ordering is safe by
 *      Colyseus protocol construction: the full schema snapshot
 *      (`Room.sendFullState`) is flushed BEFORE any room message, and the
 *      client only receives `mapData` in response to its own post-join
 *      `requestMapData` — so `stateSync.destructibles` already mirrors the
 *      live server state when the cull runs at map load. Pure function of
 *      (placement list, live schema state) — never local history, zero
 *      randomness (ADR-0035).
 *
 *   2. {@link wireLightPlacementRemoval} — the runtime destroy→light-off hook
 *      installed by `bootLightingPipeline`. Extracted here (type-only deps)
 *      so the BOTH-removal invocation is unit-testable without a WebGL
 *      pipeline. The client NEVER calls this on its own — it fires only from
 *      the schema `onDestructibleRemove` callback
 *      (`DestructibleStateHandlers`).
 *
 * PERF PARITY (the live-pipeline fact, ticket 08): the deferred lighting
 * pipeline re-packs statics into pre-allocated `Float32Array` uniforms EVERY
 * frame (`LightingPipeline.update` → `packLightsAndHandoff`; buffers from
 * `createLightBuffers`, zero per-frame allocations). Nothing is baked into a
 * texture, so light-off needs NO re-bake — removing a placement takes effect
 * the NEXT frame by construction. The cull runs ONCE at map load; the removal
 * hook runs only on rare destruction events (O(placements) per event).
 */
import type { LightAnchor, LightPlacementTiled } from '@sector-battle/shared';
import { LIGHT_PROP_ENTITY_ANCHORS } from '@sector-battle/shared';
import type { DestructibleState } from '../../types.js';

/**
 * Anchors whose light placements are backed by a LIVE destructible entity and
 * therefore culled at map load when that entity is gone: the ticket-07
 * conversion set (`LIGHT_PROP_ENTITY_ANCHORS`: route/fill/poi-pool/crystal
 * → `'light'` entities) PLUS `'campfire'` (backed 1:1 by its crate entity
 * since before this campaign — including it here is what fixes the
 * ghost-campfire-light bug for late joiners). Exempt by exclusion: beacons
 * (kind-identified, never carry an anchor) and `'doorway'` sconces (the
 * corridor-passage carve-out) — baked statics with NO backing entity, never
 * culled.
 */
export const LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS: ReadonlySet<LightAnchor> = new Set<LightAnchor>(
  [...LIGHT_PROP_ENTITY_ANCHORS, 'campfire'],
);

/** Whether a placement is backed by a destructible entity (cull candidate). */
export function isEntityBackedLightPlacement(placement: LightPlacementTiled): boolean {
  return (
    placement.anchor !== undefined && LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS.has(placement.anchor)
  );
}

/** Tile key in the same `col,row` order the removal hook computes. */
function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

/**
 * Cull placements whose backing destructible was destroyed before this client
 * joined. A placement is dropped iff it is entity-backed (see {@link
 * LIGHT_PLACEMENT_ENTITY_BACKED_ANCHORS}) and NO live destructible sits at its
 * tile in the schema state. "Live" = present in the map and not flagged
 * destroyed (the server deletes destroyed entities, but the flag is honored
 * defensively). Exempt placements (beacons, doorway sconces) and entity-backed
 * placements with live entities pass through UNTOUCHED (same references, same
 * order). Runs once at map load — zero per-frame cost.
 *
 * @param placements    the full `mapData.lightPlacements` list.
 * @param destructibles the live schema-state destructibles map
 *                      (`stateSync.destructibles`, populated before mapData
 *                      arrives per Colyseus join ordering).
 * @param tileSize      world-px per tile (destructible x/y are tile centers).
 */
export function cullDestroyedLightPlacements(
  placements: ReadonlyArray<LightPlacementTiled>,
  destructibles: ReadonlyMap<string, DestructibleState>,
  tileSize: number,
): ReadonlyArray<LightPlacementTiled> {
  if (placements.length === 0 || tileSize <= 0) return placements;
  // Build the live-tile index once (O(destructibles)); lookups are O(1).
  // Rare defensive skip: a destructible without finite coords can't be
  // matched to a tile and must not accidentally vouch for a placement.
  const liveTiles = new Set<string>();
  for (const d of destructibles.values()) {
    if (d.isDestroyed) continue;
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    liveTiles.add(tileKey(Math.floor(d.x / tileSize), Math.floor(d.y / tileSize)));
  }
  let culled = 0;
  const kept: LightPlacementTiled[] = [];
  for (const p of placements) {
    if (isEntityBackedLightPlacement(p) && !liveTiles.has(tileKey(p.gridX, p.gridY))) {
      culled++;
      continue;
    }
    kept.push(p);
  }
  // No entity-backed placement missing → hand back the ORIGINAL array
  // (identity preserved for the pipeline's placement reference).
  return culled === 0 ? placements : kept;
}

/**
 * Install the destroy→light-off hook on the game state (ticket 08; previously
 * an inline closure in `bootLightingPipeline`). Invoking the hook tears down
 * BOTH halves of a destructible-backed light's footprint at the destroyed
 * tile: the light disk (`LightingPipeline.removePlacementAt`) AND the visible
 * fixture sprite (`LightPropRenderer.removeAt`). Fired ONLY from the schema
 * `onDestructibleRemove` callback — never client-side prediction.
 */
export function wireLightPlacementRemoval(
  gameState: GameStateLike,
  lighting: Pick<LightingPipelineLike, 'removePlacementAt'>,
  lightPropRenderer: Pick<LightPropRendererLike, 'removeAt'> | null,
): void {
  gameState.onLightPlacementRemoved = (gridX: number, gridY: number) => {
    lighting.removePlacementAt(gridX, gridY);
    lightPropRenderer?.removeAt(gridX, gridY);
  };
}

/** Structural deps for {@link wireLightPlacementRemoval} (type-only). */
interface GameStateLike {
  onLightPlacementRemoved?: (gridX: number, gridY: number) => void;
}

interface LightingPipelineLike {
  removePlacementAt(gridX: number, gridY: number): void;
}

interface LightPropRendererLike {
  removeAt(gridX: number, gridY: number): void;
}

/**
 * Spatial-index partial for {@linkcode GameMatch} (ticket 17,
 * server-domain-spatial-hash). Mechanical action extraction so GameMatch.ts
 * stays under the max-lines lint budget — same convention as the other
 * GameMatch* partials (GameMatchPlayers.ts, GameMatchGrid.ts, ...).
 */

import { DomainSpatialIndex } from './DomainSpatialIndex.ts';
import type { GameMatch } from './GameMatch.ts';

/**
 * (Re)build the domain broadphase index from the match's live maps. Called
 * once per tick by GameSimulation at the END of step2 (movement resolution) —
 * after movement, before the combat steps — the same placement pattern as the
 * power-up grid rebuild. The index is a post-step2 snapshot; consumers
 * re-verify liveness + live positions per candidate (see
 * {@linkcode DomainSpatialIndex} for the full contract).
 */
export function rebuildSpatialIndexAction(match: GameMatch): DomainSpatialIndex {
  let index = match.spatialIndex;
  if (!index) {
    index = new DomainSpatialIndex(
      match.mapWidth * match.config.map.tileWidth,
      match.mapHeight * match.config.map.tileHeight,
    );
    match.spatialIndex = index;
  }
  index.rebuildFrom(match);
  return index;
}

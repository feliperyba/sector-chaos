import type { StateSync } from '../network/StateSync.js';
import type { MapRenderer } from './MapRenderer.js';
import type { ZoneRenderer } from './ZoneRenderer.js';

/**
 * Next-circle telegraph updater (GDD §8.1.4 "dashed circle showing next zone
 * size" / map-redesign ticket 09 / DEC-008.3): the per-frame hand-off from
 * the authoritative zone state (`StateSync.getZoneState`, fed by the
 * `ZoneSchema` sync) to `ZoneRenderer`, which draws the current ring, the
 * target ring and the warning border.
 *
 * The server publishes each phase's target center + radius at the
 * phase-advance tick, so the target ring has data to render for the ENTIRE
 * phase — ≥1 phase of warning before the circle arrives (user story 40).
 * Extracted from GameSceneHelpers (ticket 09) so the render path is unit-
 * testable without the heavy scene import chain (this module imports types
 * only — the function is pure over its arguments; the production call site
 * is GameScene.update).
 */
export function updateZoneRenderer(
  zoneRenderer: ZoneRenderer,
  stateSync: StateSync,
  mapRenderer: MapRenderer,
  localPos: { x: number; y: number },
): void {
  const zoneState = stateSync.getZoneState();
  if (zoneState.currentRadius > 0) {
    const dx = localPos.x - zoneState.centerX;
    const dy = localPos.y - zoneState.centerY;
    const isOutside = Math.sqrt(dx * dx + dy * dy) > zoneState.currentRadius;
    const timeUntilTransitionMs = zoneState.phaseEndTime - Date.now();
    const shrinking =
      zoneState.currentRadius > zoneState.targetRadius && zoneState.targetRadius > 0;
    const aboutToShrink = timeUntilTransitionMs > 0 && timeUntilTransitionMs < 10000 && shrinking;
    const warningActive = isOutside || aboutToShrink;
    zoneRenderer.setWorldBounds(
      mapRenderer.getMapWidth?.() ?? 6400,
      mapRenderer.getMapHeight?.() ?? 6400,
    );
    zoneRenderer.update(
      zoneState.centerX,
      zoneState.centerY,
      zoneState.currentRadius,
      zoneState.targetCenterX,
      zoneState.targetCenterY,
      zoneState.targetRadius,
      isOutside,
      warningActive,
    );
  }

  const siegedSectors = stateSync.getSiegedSectors();
  if (siegedSectors.length > 0) {
    let maxIdx = 0;
    for (const s of siegedSectors) {
      if (s.row > maxIdx) maxIdx = s.row;
      if (s.col > maxIdx) maxIdx = s.col;
    }
    const sectorGridSize = maxIdx + 1;
    const grid = mapRenderer.getGrid();
    const mapTileWidth = grid[0]?.length ?? 0;
    const sectorTileCount = Math.max(1, Math.round(mapTileWidth / Math.max(1, sectorGridSize)));
    zoneRenderer.renderSiegedSectors(
      siegedSectors,
      sectorTileCount,
      mapRenderer.getTileSize(),
      zoneState.centerX,
      zoneState.centerY,
      zoneState.currentRadius,
    );
  } else {
    zoneRenderer.renderSiegedSectors([], 1, mapRenderer.getTileSize());
  }
}

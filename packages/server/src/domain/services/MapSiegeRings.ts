import { ZONE, TileType } from '@sector-battle/shared';
import type { MapSiegeService, SectorSiege, RingBatch } from './MapSiegeService.ts';

/**
 * Ring-computation helpers for MapSiegeService. Mechanical extraction from the
 * original class (F8 file-length retirement of the over-cap file) — bodies
 * verbatim, `this.→service.` only (the MapSiegeCascade.ts precedent).
 *
 * NOTE: MapSiegeService exposes `wallManager` + `tilePixelSize` as public so
 * these helpers can read them.
 */

// ─── Ring computation ────────────────────────────────────────────

/**
 * Compute distance-sorted ring batches for a rectangular tile region. Tiles
 * furthest from the zone center go into ring 0 (dropped first), tiles closest
 * go last. Already-walled tiles are excluded so re-snapshots after zone center
 * shifts produce clean remaining-tile lists.
 */
export function computeRings(
  service: MapSiegeService,
  startX: number,
  startY: number,
  width: number,
  height: number,
  zoneCenter: { x: number; y: number },
  grid: TileType[][],
): RingBatch[] {
  const ringWidth = ZONE.SIEGE_RING_WIDTH_TILES * service.tilePixelSize;
  const tilesByRing = new Map<number, Array<{ gridX: number; gridY: number }>>();

  for (let y = startY; y < startY + height; y++) {
    if (y < 0 || y >= grid.length) continue;
    for (let x = startX; x < startX + width; x++) {
      if (x < 0 || x >= (grid[0]?.length ?? 0)) continue;
      if (service.wallManager.hasSiegeWall(x, y)) continue;

      const px = (x + 0.5) * service.tilePixelSize;
      const py = (y + 0.5) * service.tilePixelSize;
      const dx = px - zoneCenter.x;
      const dy = py - zoneCenter.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ringIdx = Math.round(dist / ringWidth);

      let batch = tilesByRing.get(ringIdx);
      if (!batch) {
        batch = [];
        tilesByRing.set(ringIdx, batch);
      }
      batch.push({ gridX: x, gridY: y });
    }
  }

  const sortedKeys = [...tilesByRing.keys()].sort((a, b) => b - a);
  return sortedKeys.map((k) => ({ tiles: tilesByRing.get(k)! }));
}

/**
 * Re-snapshot ring order when the zone center moves more than one tile-width.
 * Already-walled tiles are excluded by computeRings, so the new ring 0
 * represents the outermost remaining tiles relative to the new center.
 */
export function maybeRecomputeRings(
  service: MapSiegeService,
  sector: SectorSiege,
  zoneCenter: { x: number; y: number },
  grid: TileType[][],
): void {
  if (sector.cascade) return;
  const dx = zoneCenter.x - sector.ringCenter.x;
  const dy = zoneCenter.y - sector.ringCenter.y;
  const moved = Math.sqrt(dx * dx + dy * dy);
  if (moved <= service.tilePixelSize) return;

  sector.rings = computeRings(
    service,
    sector.startX,
    sector.startY,
    sector.width,
    sector.height,
    zoneCenter,
    grid,
  );
  sector.ringCenter = { x: zoneCenter.x, y: zoneCenter.y };
  sector.currentRing = 0;
  sector.warningIssued = false;
}

export function isSectorComplete(service: MapSiegeService, sector: SectorSiege): boolean {
  if (sector.currentRing < sector.rings.length) return false;
  for (const ring of sector.rings) {
    for (const tile of ring.tiles) {
      if (!service.wallManager.hasSiegeWall(tile.gridX, tile.gridY)) return false;
    }
  }
  return true;
}

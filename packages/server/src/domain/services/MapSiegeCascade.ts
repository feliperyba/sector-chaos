import { ZONE, TileType } from '@sector-battle/shared';
import type { MapSiegeService, SectorSiege, CascadeState } from './MapSiegeService.ts';

/**
 * Cascade wall-drop helpers for MapSiegeService. Mechanical extraction from
 * the original class — bodies verbatim, `this.→service.` only.
 *
 * NOTE: MapSiegeService exposes `wallManager`, `eventCollector`, `entityContext`
 * as public so these helpers can read them.
 */

export function continueCascade(
  service: MapSiegeService,
  sector: SectorSiege,
  grid: TileType[][],
  currentTime: number,
): boolean {
  const cascade: CascadeState = sector.cascade!;
  const tileDelayMs = ZONE.SIEGE_CASCADE_TILE_DELAY * 1000;

  while (cascade.tileIndex < cascade.coords.length) {
    const elapsed = currentTime - cascade.lastTileTime;
    if (elapsed < tileDelayMs) return false;
    dropCascadeTile(service, sector, grid, currentTime);
    if (cascade.tileIndex >= cascade.coords.length) return true;
  }
  return true;
}

export function dropCascadeTile(
  service: MapSiegeService,
  sector: SectorSiege,
  grid: TileType[][],
  currentTime: number,
): void {
  const cascade = sector.cascade!;
  const c = cascade.coords[cascade.tileIndex]!;

  service.destroyEntitiesOnTile(c.gridX, c.gridY);
  service.handlePlayersOnTile(c.gridX, c.gridY);
  grid[c.gridY]![c.gridX] = TileType.INDESTRUCTIBLE_WALL;
  service.wallManager.addWall(c.gridX, c.gridY);
  service.entityContext?.setSiegeWallCollider(c.gridX, c.gridY);

  const audioInterval = ZONE.SIEGE_CASCADE_AUDIO_INTERVAL;
  const isLast = cascade.tileIndex === cascade.coords.length - 1;
  const audible = cascade.tileIndex % audioInterval === 0 || isLast;

  service.eventCollector.emit({
    type: 'SiegeWallDropped',
    tick: 0,
    timestamp: currentTime,
    gridX: c.gridX,
    gridY: c.gridY,
    sectorRow: sector.row,
    sectorCol: sector.col,
    ring: sector.currentRing,
    tileIndex: cascade.tileIndex,
    audible,
  });

  cascade.tileIndex++;
  cascade.lastTileTime = currentTime;

  if (cascade.tileIndex >= cascade.coords.length) {
    sector.currentRing++;
  }
}

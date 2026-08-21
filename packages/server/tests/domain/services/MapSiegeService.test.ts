import { describe, it, expect, beforeEach } from 'vitest';
import { MapSiegeService } from '../../../src/domain/services/MapSiegeService.ts';
import { SiegeWallManager } from '../../../src/domain/aggregates/SiegeWallManager.ts';
import type { SiegeEntityContext } from '../../../src/domain/services/MapSiegeService.ts';
import { ZONE, TileType } from '@sector-battle/shared';
import type { GameEvent } from '../../../src/domain/events/index.ts';

const MAP_SIZE = 10;
const INTERVAL = 3;
const TILE = 64;
const CASCADE_MS = ZONE.SIEGE_CASCADE_TILE_DELAY * 1000;
const NO_ZONE_CENTER = { x: 99999, y: 99999 };
const NO_ZONE_RADIUS = 0;

function makeGrid(
  rows: number,
  cols: number,
  fill: TileType,
  overrides?: Array<{ x: number; y: number; tile: TileType }>,
): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  if (overrides) for (const o of overrides) grid[o.y]![o.x] = o.tile;
  return grid;
}

function createMockEntityContext(overrides?: Partial<SiegeEntityContext>): SiegeEntityContext {
  return {
    getDestructibleAtTile: () => null,
    getChestAtTile: () => null,
    getWeaponPickupAtTile: () => null,
    getPowerUpAtTile: () => null,
    getTrapAtTile: () => null,
    destroyDestructible: () => {},
    removeChest: () => {},
    removeWeaponPickup: () => {},
    removePowerUp: () => {},
    removeTrap: () => {},
    crushPlayersOnTile: () => {},
    setSiegeWallCollider: () => {},
    ...overrides,
  };
}

/**
 * Drive the service forward until one ring cascade completes (or no more drops).
 */
function completeRing(
  svc: MapSiegeService,
  startTime: number,
  interval: number,
  grid: TileType[][],
  zoneCenter = NO_ZONE_CENTER,
  zoneRadius = NO_ZONE_RADIUS,
  isOvertime = false,
): { events: GameEvent[]; endTime: number } {
  const allEvents: GameEvent[] = [];
  let t = startTime;
  let hadDrops = false;

  for (let i = 0; i < MAP_SIZE * MAP_SIZE + 10; i++) {
    const events = svc.update(t, interval, grid, zoneCenter, zoneRadius, isOvertime);
    allEvents.push(...events);
    const drops = events.filter((e) => e.type === 'SiegeWallDropped');
    if (drops.length > 0) hadDrops = true;
    else if (hadDrops) break;
    t += CASCADE_MS;
  }

  return { events: allEvents, endTime: t };
}

/**
 * Compute Euclidean distance from a tile center to a pixel point.
 */
function tileDist(x: number, y: number, cx: number, cy: number): number {
  const px = (x + 0.5) * TILE;
  const py = (y + 0.5) * TILE;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

describe('MapSiegeService', () => {
  let wallManager: SiegeWallManager;
  let service: MapSiegeService;
  let grid: TileType[][];

  beforeEach(() => {
    wallManager = new SiegeWallManager(MAP_SIZE, MAP_SIZE);
    service = new MapSiegeService(wallManager, MAP_SIZE, MAP_SIZE, TILE);
    grid = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY);
  });

  describe('ring ordering — furthest tiles first', () => {
    it('drops tiles furthest from zone center first', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      service.update(0, INTERVAL, grid, zc, 0, false);

      const { events } = completeRing(service, 3000, INTERVAL, grid, zc, 0);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');

      expect(drops.length).toBeGreaterThan(0);

      const maxDistInGrid = tileDist(0, 0, zc.x, zc.y);
      for (const d of drops) {
        const dist = tileDist(d.gridX, d.gridY, zc.x, zc.y);
        expect(dist).toBeGreaterThan(maxDistInGrid * 0.85);
      }
    });

    it('rings progress inward — later rings are closer to zone center', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      service.update(0, INTERVAL, grid, zc, 0, false);

      const r1 = completeRing(service, 3000, INTERVAL, grid, zc, 0);
      const drops1 = r1.events.filter((e) => e.type === 'SiegeWallDropped');
      const avgDist1 =
        drops1.reduce((s, d) => s + tileDist(d.gridX, d.gridY, zc.x, zc.y), 0) / drops1.length;

      const r2 = completeRing(service, r1.endTime + INTERVAL * 1000, INTERVAL, grid, zc, 0);
      const drops2 = r2.events.filter((e) => e.type === 'SiegeWallDropped');
      if (drops2.length > 0) {
        const avgDist2 =
          drops2.reduce((s, d) => s + tileDist(d.gridX, d.gridY, zc.x, zc.y), 0) / drops2.length;
        expect(avgDist2).toBeLessThan(avgDist1);
      }
    });
  });

  describe('tile replacement', () => {
    it('replaces EMPTY tiles with INDESTRUCTIBLE_WALL', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops.length).toBeGreaterThan(0);
      for (const d of drops) {
        expect(grid[d.gridY]![d.gridX]).toBe(TileType.INDESTRUCTIBLE_WALL);
        expect(wallManager.hasSiegeWall(d.gridX, d.gridY)).toBe(true);
      }
    });

    it('replaces DESTRUCTIBLE_CRATE tiles', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY, [
        { x: 0, y: 0, tile: TileType.DESTRUCTIBLE_CRATE },
      ]);
      service.update(0, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, g);
      expect(g[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(wallManager.hasSiegeWall(0, 0)).toBe(true);
    });

    it('replaces DESTRUCTIBLE_BARREL tiles', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY, [
        { x: 0, y: 0, tile: TileType.DESTRUCTIBLE_BARREL },
      ]);
      service.update(0, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, g);
      expect(g[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
    });

    it('replaces CHEST tiles', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY, [
        { x: 0, y: 0, tile: TileType.CHEST },
      ]);
      service.update(0, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, g);
      expect(g[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
    });

    it('replaces INDESTRUCTIBLE_WALL tiles', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY, [
        { x: 0, y: 0, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      service.update(0, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, g);
      expect(g[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(wallManager.hasSiegeWall(0, 0)).toBe(true);
    });
  });

  describe('warnings', () => {
    it('issues warnings 0.5s before solidification', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const events = service.update(2500, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const warnings = events.filter((e) => e.type === 'SiegeWallWarning');
      expect(warnings.length).toBeGreaterThan(0);
      for (const w of warnings) {
        expect(w.solidifyAt).toBe(3000);
      }
    });

    it('does not re-issue warnings for the same ring', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const first = service.update(2500, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      expect(first.filter((e) => e.type === 'SiegeWallWarning').length).toBeGreaterThan(0);

      service.update(2600, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const again = service.update(2800, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      expect(again.filter((e) => e.type === 'SiegeWallWarning')).toHaveLength(0);
    });
  });

  describe('entity destruction', () => {
    it('destroys entities on dropped tiles', () => {
      const destroyedIds: string[] = [];
      const ctx = createMockEntityContext({
        getDestructibleAtTile: (x, y) => (x === 0 && y === 0 ? 'dest-1' : null),
        getChestAtTile: (x, y) => (x === 0 && y === 0 ? 'chest-1' : null),
        destroyDestructible: (id) => destroyedIds.push(id),
        removeChest: (id) => destroyedIds.push(id),
      });
      service.setEntityContext(ctx);
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, grid);
      expect(destroyedIds).toContain('dest-1');
      expect(destroyedIds).toContain('chest-1');
    });

    it('works without entity context', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });
  });

  describe('player crushing', () => {
    it('calls crushPlayersOnTile for each dropped tile', () => {
      const crushedTiles: Array<{ x: number; y: number }> = [];
      const ctx = createMockEntityContext({
        crushPlayersOnTile: (x, y) => crushedTiles.push({ x, y }),
      });
      service.setEntityContext(ctx);
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const numDrops = events.filter((e) => e.type === 'SiegeWallDropped').length;
      expect(crushedTiles).toHaveLength(numDrops);
    });
  });

  describe('completion', () => {
    it('detects when all tiles are walled', () => {
      const smallGrid = makeGrid(4, 4, TileType.EMPTY);
      const wm = new SiegeWallManager(4, 4);
      const svc = new MapSiegeService(wm, 4, 4, TILE);
      expect(svc.isComplete()).toBe(false);

      svc.update(0, INTERVAL, smallGrid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);

      let t = 3000;
      for (let ring = 0; ring < 4 * 4 + 5; ring++) {
        const r = completeRing(svc, t, INTERVAL, smallGrid);
        t = r.endTime + INTERVAL * 1000;
      }
      expect(svc.isComplete()).toBe(true);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          expect(smallGrid[y]![x]).toBe(TileType.INDESTRUCTIBLE_WALL);
        }
      }
    });

    it('is not complete during progress', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, grid);
      expect(service.isComplete()).toBe(false);
    });
  });

  describe('stop', () => {
    it('halts all processing', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      service.stop();
      const events = service.update(3000, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      expect(events).toHaveLength(0);
    });
  });

  describe('initialization', () => {
    it('first update initializes without dropping', () => {
      const events = service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      expect(events).toHaveLength(0);
    });

    it('drops on second update after interval', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });
  });

  describe('no drop before interval', () => {
    it('does not drop before interval elapses', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const events = service.update(2000, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      expect(events.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);
    });
  });

  describe('cascade behavior', () => {
    it('drops tiles one-by-one with cascade delay', () => {
      const zc = { x: 0, y: 0 };
      service.update(0, INTERVAL, grid, zc, 0, false);

      const e1 = service.update(3000, INTERVAL, grid, zc, 0, false);
      const drops1 = e1.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops1).toHaveLength(1);
      expect(drops1[0]!.tileIndex).toBe(0);

      const e2 = service.update(3000 + CASCADE_MS, INTERVAL, grid, zc, 0, false);
      const drops2 = e2.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops2).toHaveLength(1);
      expect(drops2[0]!.tileIndex).toBe(1);
    });
  });

  describe('audible flag', () => {
    it('marks tile 0 as audible', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops.find((d) => d.tileIndex === 0)!.audible).toBe(true);
    });

    it('marks last tile as audible', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops[drops.length - 1]!.audible).toBe(true);
    });

    it('marks every 8th tile as audible', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      for (const d of drops) {
        const isEvery8th = d.tileIndex % ZONE.SIEGE_CASCADE_AUDIO_INTERVAL === 0;
        const isLast = d.tileIndex === drops.length - 1;
        expect(d.audible).toBe(isEvery8th || isLast);
      }
    });
  });

  describe('event properties', () => {
    it('SiegeWallDropped events have ring and tileIndex', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      for (const d of drops) {
        expect(typeof d.ring).toBe('number');
        expect(typeof d.tileIndex).toBe('number');
        expect(typeof d.audible).toBe('boolean');
        expect(d.sectorRow).toBe(0);
        expect(d.sectorCol).toBe(0);
      }
    });
  });

  describe('empty-ring fast-forward', () => {
    it('skips tiles that already have siege walls', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY);
      for (let x = 0; x < MAP_SIZE; x++) {
        for (let y = 0; y < MAP_SIZE; y++) {
          if (x === 0 && y === 0) continue;
          wallManager.addWall(x, y);
          g[y]![x] = TileType.INDESTRUCTIBLE_WALL;
        }
      }
      service.update(0, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, g);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
      expect(wallManager.hasSiegeWall(0, 0)).toBe(true);
    });

    it('completes when all tiles are already walled', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY);
      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          wallManager.addWall(x, y);
          g[y]![x] = TileType.INDESTRUCTIBLE_WALL;
        }
      }
      service.update(0, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      const events = service.update(3000, INTERVAL, g, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      expect(events.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);
      expect(service.isComplete()).toBe(true);
    });
  });

  describe('zone center re-snapshot', () => {
    it('recomputes ring order when zone center moves > 1 tile', () => {
      const zc1 = { x: 0, y: 0 };
      const zc2 = { x: 5 * TILE, y: 5 * TILE };

      service.update(0, INTERVAL, grid, zc1, 0, false);
      const r1 = completeRing(service, 3000, INTERVAL, grid, zc1, 0);
      const drops1 = r1.events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops1.length).toBeGreaterThan(0);

      const dists1 = drops1.map((d) => tileDist(d.gridX, d.gridY, zc1.x, zc1.y));
      const maxDist1 = Math.max(...dists1);

      const r2 = completeRing(service, r1.endTime + INTERVAL * 1000, INTERVAL, grid, zc2, 0);
      const drops2 = r2.events.filter((e) => e.type === 'SiegeWallDropped');
      if (drops2.length > 0) {
        const dists2FromOld = drops2.map((d) => tileDist(d.gridX, d.gridY, zc1.x, zc1.y));
        const maxDist2FromOld = Math.max(...dists2FromOld);
        expect(maxDist2FromOld).toBeLessThanOrEqual(maxDist1);
      }
    });
  });

  describe('multi-sector', () => {
    it('tags drops with originating sector', () => {
      const SIZE = 4;
      const SECTOR = 2;
      const g = makeGrid(SIZE, SIZE, TileType.EMPTY);
      const wm = new SiegeWallManager(SIZE, SIZE);
      const svc = new MapSiegeService(wm, SIZE, SIZE, TILE, SECTOR);

      const zc = { x: 999999, y: 999999 };
      svc.update(0, INTERVAL, g, zc, 0, false);
      const { events } = completeRing(svc, 3000, INTERVAL, g, zc, 0);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops.length).toBeGreaterThan(0);

      for (const d of drops) {
        expect(d.sectorRow).toBeGreaterThanOrEqual(0);
        expect(d.sectorCol).toBeGreaterThanOrEqual(0);
        expect(Math.floor(d.gridX / SECTOR)).toBe(d.sectorCol);
        expect(Math.floor(d.gridY / SECTOR)).toBe(d.sectorRow);
      }
    });

    it('does not siege sector whose center is inside the circle', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 3 * TILE;

      service.update(0, INTERVAL, grid, zc, zoneRadius, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid, zc, zoneRadius);
      expect(events.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);
    });
  });

  describe('overtime', () => {
    it('all sectors siege in overtime regardless of zone position', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 5 * TILE;

      service.update(0, INTERVAL, grid, zc, zoneRadius, true);
      const { events } = completeRing(service, 3000, INTERVAL, grid, zc, zoneRadius, true);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });

    it('uses overtime interval (1.5s)', () => {
      const OT = ZONE.SIEGE_WALL_DROP_INTERVAL_OT;
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 5 * TILE;

      service.update(0, OT, grid, zc, zoneRadius, true);
      const events = service.update(OT * 1000, OT, grid, zc, zoneRadius, true);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });
  });

  describe('getWallManager', () => {
    it('returns the SiegeWallManager', () => {
      expect(service.getWallManager()).toBeInstanceOf(SiegeWallManager);
    });
  });

  describe('drainEvents', () => {
    it('returns empty after draining', () => {
      service.update(0, INTERVAL, grid, NO_ZONE_CENTER, NO_ZONE_RADIUS, false);
      completeRing(service, 3000, INTERVAL, grid);
      expect(service.drainEvents()).toHaveLength(0);
    });
  });
});

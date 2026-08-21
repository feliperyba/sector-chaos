import { describe, it, expect, beforeEach } from 'vitest';
import { MapSiegeService } from '../../src/domain/services/MapSiegeService.ts';
import { SiegeWallManager } from '../../src/domain/aggregates/SiegeWallManager.ts';
import type { SiegeEntityContext } from '../../src/domain/services/MapSiegeService.ts';
import type { GameEvent } from '../../src/domain/events/index.ts';
import { ZONE, TileType } from '@sector-battle/shared';

const MAP_SIZE = 10;
const INTERVAL = ZONE.SIEGE_WALL_DROP_INTERVAL;
const OT_INTERVAL = ZONE.SIEGE_WALL_DROP_INTERVAL_OT;
const TILE = 64;
const CASCADE_MS = ZONE.SIEGE_CASCADE_TILE_DELAY * 1000;
const NO_ZONE = { x: 99999, y: 99999 };
const NO_RADIUS = 0;

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

function completeRing(
  svc: MapSiegeService,
  startTime: number,
  interval: number,
  grid: TileType[][],
  zoneCenter = NO_ZONE,
  zoneRadius = NO_RADIUS,
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

function runToCompletion(
  svc: MapSiegeService,
  startTime: number,
  interval: number,
  grid: TileType[][],
  zoneCenter = NO_ZONE,
  zoneRadius = NO_RADIUS,
  isOvertime = false,
): GameEvent[] {
  const allEvents: GameEvent[] = [];
  let t = startTime;
  for (let ring = 0; ring < MAP_SIZE * MAP_SIZE + 5; ring++) {
    const r = completeRing(svc, t, interval, grid, zoneCenter, zoneRadius, isOvertime);
    allEvents.push(...r.events);
    t = r.endTime + interval * 1000;
    if (svc.isComplete()) break;
  }
  return allEvents;
}

function tileDist(x: number, y: number, cx: number, cy: number): number {
  const px = (x + 0.5) * TILE;
  const py = (y + 0.5) * TILE;
  return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
}

describe('Map-Level Siege Integration Tests', () => {
  let wallManager: SiegeWallManager;
  let service: MapSiegeService;
  let grid: TileType[][];

  beforeEach(() => {
    wallManager = new SiegeWallManager(MAP_SIZE, MAP_SIZE);
    service = new MapSiegeService(wallManager, MAP_SIZE, MAP_SIZE, TILE);
    grid = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY);
  });

  describe('Basic Siege Flow', () => {
    it('issues SiegeWallWarning 0.5s before solidification', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);

      const events = service.update(2500, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      const warnings = events.filter((e) => e.type === 'SiegeWallWarning');

      expect(warnings.length).toBeGreaterThan(0);
      for (const w of warnings) {
        expect(w.solidifyAt).toBe(3000);
        expect(w.timestamp).toBe(2500);
      }
      expect(wallManager.getWarnings().length).toBeGreaterThan(0);
    });

    it('drops walls and mutates grid after interval via cascade', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);

      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');

      expect(drops.length).toBeGreaterThan(0);
      for (const d of drops) {
        expect(grid[d.gridY]![d.gridX]).toBe(TileType.INDESTRUCTIBLE_WALL);
        expect(wallManager.hasSiegeWall(d.gridX, d.gridY)).toBe(true);
      }
    });

    it('calls entity context methods on drop', () => {
      const destroyed: string[] = [];
      const crushed: Array<{ x: number; y: number }> = [];
      const ctx = createMockEntityContext({
        getDestructibleAtTile: (x, y) =>
          tileDist(x, y, 99999, 99999) > 0 && x === 9 && y === 9 ? 'crate-1' : null,
        destroyDestructible: (id) => destroyed.push(id),
        crushPlayersOnTile: (x, y) => crushed.push({ x, y }),
      });
      service.setEntityContext(ctx);

      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      completeRing(service, 3000, INTERVAL, grid);

      expect(crushed.length).toBeGreaterThan(0);
    });

    it('tile remains walkable during warning phase', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      service.update(2500, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);

      const events = service.update(2500, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      const warnings = events.filter((e) => e.type === 'SiegeWallWarning');
      for (const w of warnings) {
        expect(grid[w.gridY]![w.gridX]).toBe(TileType.EMPTY);
      }
    });

    it('full flow: init → warn → drop → crush across multiple rings', () => {
      const crushed: Array<{ x: number; y: number }> = [];
      const ctx = createMockEntityContext({
        crushPlayersOnTile: (x, y) => crushed.push({ x, y }),
      });
      service.setEntityContext(ctx);

      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);

      const warnEvents = service.update(2500, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      expect(warnEvents.filter((e) => e.type === 'SiegeWallWarning').length).toBeGreaterThan(0);
      expect(warnEvents.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);

      const r1 = completeRing(service, 3000, INTERVAL, grid);
      const drops1 = r1.events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops1.length).toBeGreaterThan(0);

      const r2 = completeRing(service, r1.endTime + INTERVAL * 1000, INTERVAL, grid);
      const drops2 = r2.events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops2.length).toBeGreaterThan(0);

      expect(crushed.length).toBeGreaterThan(0);
    });
  });

  describe('Flood-Fill Ring Ordering', () => {
    it('first ring contains the furthest tiles from zone center', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      service.update(0, INTERVAL, grid, zc, 0, false);

      const r1 = completeRing(service, 3000, INTERVAL, grid, zc, 0);
      const drops1 = r1.events.filter((e) => e.type === 'SiegeWallDropped');

      const cornerDist = tileDist(0, 0, zc.x, zc.y);
      for (const d of drops1) {
        const dist = tileDist(d.gridX, d.gridY, zc.x, zc.y);
        expect(dist).toBeGreaterThan(cornerDist * 0.85);
      }
    });

    it('second ring is closer than first ring', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      service.update(0, INTERVAL, grid, zc, 0, false);

      const r1 = completeRing(service, 3000, INTERVAL, grid, zc, 0);
      const r2 = completeRing(service, r1.endTime + INTERVAL * 1000, INTERVAL, grid, zc, 0);
      const drops1 = r1.events.filter((e) => e.type === 'SiegeWallDropped');
      const drops2 = r2.events.filter((e) => e.type === 'SiegeWallDropped');

      if (drops2.length > 0) {
        const minDist1 = Math.min(...drops1.map((d) => tileDist(d.gridX, d.gridY, zc.x, zc.y)));
        const maxDist2 = Math.max(...drops2.map((d) => tileDist(d.gridX, d.gridY, zc.x, zc.y)));
        expect(maxDist2).toBeLessThanOrEqual(minDist1);
      }
    });

    it('eventually walls the entire sector', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      runToCompletion(service, 3000, INTERVAL, grid);

      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          expect(grid[y]![x]).toBe(TileType.INDESTRUCTIBLE_WALL);
        }
      }
    });
  });

  describe('Zone Overlap Detection', () => {
    it('sieges a sector whose center is outside the circle', () => {
      const zc = { x: 0, y: 0 };
      const zoneRadius = 2 * TILE;

      service.update(0, INTERVAL, grid, zc, zoneRadius, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid, zc, zoneRadius);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });

    it('does not siege a sector whose center is inside the circle', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 3 * TILE;

      service.update(0, INTERVAL, grid, zc, zoneRadius, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid, zc, zoneRadius);
      expect(events.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);
    });

    it('zone shrinks → previously-safe sector begins sieging', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const largeRadius = 5 * TILE;

      service.update(0, INTERVAL, grid, zc, largeRadius, false);
      const r1 = completeRing(service, 3000, INTERVAL, grid, zc, largeRadius);
      expect(r1.events.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);

      const smallRadius = 0.5 * TILE;
      const r2 = completeRing(
        service,
        r1.endTime + INTERVAL * 1000,
        INTERVAL,
        grid,
        zc,
        smallRadius,
      );
      expect(r2.events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });

    it('overtime bypasses zone overlap — siege active', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 5 * TILE;

      service.update(0, INTERVAL, grid, zc, zoneRadius, true);
      const { events } = completeRing(
        service,
        INTERVAL * 1000,
        INTERVAL,
        grid,
        zc,
        zoneRadius,
        true,
      );
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });

    it('all sides overlapping → siege paused (zero events)', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 6 * TILE;

      service.update(0, INTERVAL, grid, zc, zoneRadius, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid, zc, zoneRadius);
      expect(events.filter((e) => e.type === 'SiegeWallDropped')).toHaveLength(0);
    });
  });

  describe('Overtime Acceleration', () => {
    it('uses overtime interval (1.5s) for faster drops', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 5 * TILE;

      service.update(0, OT_INTERVAL, grid, zc, zoneRadius, true);
      const events = service.update(OT_INTERVAL * 1000, OT_INTERVAL, grid, zc, zoneRadius, true);
      expect(events.filter((e) => e.type === 'SiegeWallDropped').length).toBeGreaterThan(0);
    });

    it('walls close into the safe zone during overtime', () => {
      const zc = { x: 4.5 * TILE, y: 4.5 * TILE };
      const zoneRadius = 2 * TILE;

      service.update(0, OT_INTERVAL, grid, zc, zoneRadius, true);
      runToCompletion(service, OT_INTERVAL * 1000, OT_INTERVAL, grid, zc, zoneRadius, true);

      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          expect(grid[y]![x]).toBe(TileType.INDESTRUCTIBLE_WALL);
        }
      }
    });
  });

  describe('Barrel Chain Reactions', () => {
    it('siege wall drops on DESTRUCTIBLE_BARREL tile and destroys barrel', () => {
      const destroyedIds: string[] = [];
      const ctx = createMockEntityContext({
        getDestructibleAtTile: (x, y) => (x === 0 && y === 0 ? 'barrel-1' : null),
        destroyDestructible: (id) => destroyedIds.push(id),
      });
      service.setEntityContext(ctx);

      grid[0]![0] = TileType.DESTRUCTIBLE_BARREL;

      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      completeRing(service, 3000, INTERVAL, grid);

      expect(destroyedIds).toContain('barrel-1');
      expect(grid[0]![0]).toBe(TileType.INDESTRUCTIBLE_WALL);
    });
  });

  describe('Empty-Ring Fast-Forward', () => {
    it('skips tiles that already have siege walls', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY);
      wallManager.addWall(9, 9);
      g[9]![9] = TileType.INDESTRUCTIBLE_WALL;

      service.update(0, INTERVAL, g, NO_ZONE, NO_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, g);

      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops.length).toBeGreaterThan(0);
      expect(drops.every((d) => !(d.gridX === 9 && d.gridY === 9))).toBe(true);
    });

    it('issues warnings for droppable tiles, not siege-wall tiles', () => {
      const g = makeGrid(MAP_SIZE, MAP_SIZE, TileType.EMPTY);
      wallManager.addWall(9, 9);
      g[9]![9] = TileType.INDESTRUCTIBLE_WALL;

      service.update(0, INTERVAL, g, NO_ZONE, NO_RADIUS, false);
      const events = service.update(2500, INTERVAL, g, NO_ZONE, NO_RADIUS, false);

      const warnings = events.filter((e) => e.type === 'SiegeWallWarning');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.every((w) => !(w.gridX === 9 && w.gridY === 9))).toBe(true);
    });
  });

  describe('Audible Flag', () => {
    it('tile 0 is audible', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops.find((d) => d.tileIndex === 0)!.audible).toBe(true);
    });

    it('every 8th tile is audible', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      for (const d of drops) {
        const isEvery8th = d.tileIndex % ZONE.SIEGE_CASCADE_AUDIO_INTERVAL === 0;
        const isLast = d.tileIndex === drops.length - 1;
        expect(d.audible).toBe(isEvery8th || isLast);
      }
    });

    it('last tile is always audible', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');
      expect(drops[drops.length - 1]!.audible).toBe(true);
    });
  });

  describe('Multi-Tick Progression', () => {
    it('siege eventually completes when all tiles are walled', () => {
      const smallMap = 4;
      const smallGrid = makeGrid(smallMap, smallMap, TileType.EMPTY);
      const wm = new SiegeWallManager(smallMap, smallMap);
      const svc = new MapSiegeService(wm, smallMap, smallMap, TILE);

      expect(svc.isComplete()).toBe(false);
      svc.update(0, INTERVAL, smallGrid, NO_ZONE, NO_RADIUS, false);
      runToCompletion(svc, INTERVAL * 1000, INTERVAL, smallGrid);

      expect(svc.isComplete()).toBe(true);
      for (let y = 0; y < smallMap; y++) {
        for (let x = 0; x < smallMap; x++) {
          expect(smallGrid[y]![x]).toBe(TileType.INDESTRUCTIBLE_WALL);
        }
      }
    });

    it('stop() halts all siege progression', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      completeRing(service, 3000, INTERVAL, grid);

      service.stop();

      const events = service.update(6000, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      expect(events).toHaveLength(0);

      const events2 = service.update(9000, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      expect(events2).toHaveLength(0);
    });
  });

  describe('Event Properties', () => {
    it('SiegeWallDropped events have ring and tileIndex fields', () => {
      service.update(0, INTERVAL, grid, NO_ZONE, NO_RADIUS, false);
      const { events } = completeRing(service, 3000, INTERVAL, grid);
      const drops = events.filter((e) => e.type === 'SiegeWallDropped');

      for (const d of drops) {
        expect(typeof d.tileIndex).toBe('number');
        expect(typeof d.audible).toBe('boolean');
        expect(typeof d.ring).toBe('number');
      }
    });
  });

  describe('Per-Sector Siege', () => {
    it('sieges sectors individually based on each sector center', () => {
      const SIZE = 4;
      const SECTOR = 2;
      const g = makeGrid(SIZE, SIZE, TileType.EMPTY);
      const wm = new SiegeWallManager(SIZE, SIZE);
      const svc = new MapSiegeService(wm, SIZE, SIZE, TILE, SECTOR);

      const sectorPixel = SECTOR * TILE;
      const zc = { x: 1.5 * sectorPixel, y: 1.5 * sectorPixel };
      const zoneRadius = 0.4 * sectorPixel;

      svc.update(0, INTERVAL, g, zc, zoneRadius, false);
      for (let i = 0; i < SIZE * SIZE + 10; i++) {
        svc.update(3000 + i * CASCADE_MS, INTERVAL, g, zc, zoneRadius, false);
      }

      expect(wm.hasSiegeWall(2, 2)).toBe(false);
      expect(wm.hasSiegeWall(3, 3)).toBe(false);
      expect(wm.hasSiegeWall(0, 0)).toBe(true);
      expect(wm.hasSiegeWall(3, 0)).toBe(true);
      expect(wm.hasSiegeWall(0, 3)).toBe(true);
    });
  });
});

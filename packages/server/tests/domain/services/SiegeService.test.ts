import { describe, it, expect, beforeEach } from 'vitest';
import { SiegeService, type SiegedSector } from '../../../src/domain/services/SiegeService.ts';

const SECTOR_PIXEL_SIZE = 20 * 128;
const MAP_CENTER = { x: (4 * SECTOR_PIXEL_SIZE) / 2, y: (4 * SECTOR_PIXEL_SIZE) / 2 };

describe('SiegeService', () => {
  let service: SiegeService;

  beforeEach(() => {
    service = new SiegeService({ sectorGridSize: 4, sectorTileSize: 20, tilePixelSize: 128 });
  });

  describe('checkSiegeStatus', () => {
    it('no sectors sieged initially when zone covers entire map', () => {
      const events = service.checkSiegeStatus(MAP_CENTER, 10000);

      expect(service.getSiegedSectors()).toEqual([]);
      expect(events).toEqual([]);
    });

    it('corner sector sieged when zone is small', () => {
      service.checkSiegeStatus(MAP_CENTER, 100);

      expect(service.isSectorSieged(0, 0)).toBe(true);
    });

    it('multiple sectors sieged with small zone radius', () => {
      service.checkSiegeStatus(MAP_CENTER, 100);

      expect(service.getSiegedSectors().length).toBeGreaterThanOrEqual(2);
    });

    it('sector inside zone is not sieged', () => {
      const row = 2;
      const col = 2;
      const sectorCenter = {
        x: (col + 0.5) * SECTOR_PIXEL_SIZE,
        y: (row + 0.5) * SECTOR_PIXEL_SIZE,
      };

      service.checkSiegeStatus(sectorCenter, SECTOR_PIXEL_SIZE);

      expect(service.isSectorSieged(row, col)).toBe(false);
    });

    it('is idempotent — already sieged sectors stay sieged without duplicate events', () => {
      service.checkSiegeStatus(MAP_CENTER, 100);

      service.checkSiegeStatus(MAP_CENTER, 100);

      expect(service.drainEvents()).toEqual([]);
    });

    it('emits SectorSiegeStarted events for newly sieged sectors', () => {
      const events = service.checkSiegeStatus(MAP_CENTER, 100);

      expect(events.length).toBeGreaterThanOrEqual(1);

      for (const event of events) {
        expect(event.type).toBe('SectorSiegeStarted');
        expect(event).toHaveProperty('sectorRow');
        expect(event).toHaveProperty('sectorCol');
        expect(event).toHaveProperty('tick');
        expect(event).toHaveProperty('timestamp');
        expect(typeof event.sectorRow).toBe('number');
        expect(typeof event.sectorCol).toBe('number');
        expect(typeof event.tick).toBe('number');
        expect(typeof event.timestamp).toBe('number');
      }

      const uniqueKeys = new Set(events.map((e) => `${e.sectorRow},${e.sectorCol}`));
      expect(uniqueKeys.size).toBe(events.length);
    });

    it('correctly calculates sector center for distance check', () => {
      const row = 1;
      const col = 2;
      const sectorCenterX = (col + 0.5) * SECTOR_PIXEL_SIZE;
      const sectorCenterY = (row + 0.5) * SECTOR_PIXEL_SIZE;

      expect(sectorCenterX).toBe(6400);
      expect(sectorCenterY).toBe(3840);

      const zoneCenter = { x: sectorCenterX, y: sectorCenterY };
      service.checkSiegeStatus(zoneCenter, 0);

      expect(service.isSectorSieged(row, col)).toBe(false);

      const allSieged = service.getSiegedSectors();
      const otherSectorsSieged = allSieged.filter((s) => s.row !== row || s.col !== col);
      expect(otherSectorsSieged.length).toBeGreaterThan(0);
    });
  });

  describe('non-standard map sizes', () => {
    it('22x22 single sector — center inside zone radius', () => {
      const service = new SiegeService({
        sectorGridSize: 1,
        sectorTileSize: 22,
        tilePixelSize: 128,
      });
      const mapCenter = { x: (22 * 128) / 2, y: (22 * 128) / 2 };
      const events = service.checkSiegeStatus(mapCenter, (22 * 128) / 2);
      expect(service.getSiegedSectors()).toEqual([]);
      expect(events).toEqual([]);
    });

    it('22x22 single sector — center outside zone radius triggers siege', () => {
      const service = new SiegeService({
        sectorGridSize: 1,
        sectorTileSize: 22,
        tilePixelSize: 128,
      });
      const events = service.checkSiegeStatus({ x: 0, y: 0 }, 100);
      expect(service.isSectorSieged(0, 0)).toBe(true);
      expect(events.length).toBe(1);
    });
  });
});

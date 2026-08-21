import { describe, it, expect, beforeEach } from 'vitest';
import { SpawnService } from '../../../src/domain/services/SpawnService.ts';
import type { SpawnPoint } from '@sector-battle/shared';

function sp(
  x: number,
  y: number,
  priority: number = 0,
  row: number = 0,
  col: number = 0,
): SpawnPoint {
  return { x, y, sectorCoord: { row, col }, priority };
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

describe('SpawnService', () => {
  let service: SpawnService;

  beforeEach(() => {
    service = new SpawnService();
  });

  describe('initialize', () => {
    it('sorts spawn points by priority ascending', () => {
      const points = [sp(100, 100, 2, 0, 0), sp(200, 200, 0, 0, 1), sp(300, 300, 1, 1, 0)];
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1']);
      expect(assignments.get('p1')).toEqual({ x: 200, y: 200 });
    });

    it('clears previous assignments', () => {
      const points = [sp(100, 100, 0), sp(200, 200, 1), sp(300, 300, 2), sp(400, 400, 3)];
      service.initialize(points);
      service.assignSpawnPoints(['p1', 'p2']);

      service.initialize(points);

      const internal = service as unknown as {
        assignments: Map<string, { x: number; y: number }>;
      };
      expect(internal.assignments.size).toBe(0);
    });
  });

  describe('assignSpawnPoints', () => {
    it('assigns single player to highest priority spawn', () => {
      const points = [sp(100, 100, 3), sp(200, 200, 0), sp(300, 300, 1), sp(400, 400, 2)];
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1']);
      expect(assignments.size).toBe(1);
      expect(assignments.get('p1')).toEqual({ x: 200, y: 200 });
    });

    it('distributes multiple players using farthest-point sampling', () => {
      // 8 spawn points in a grid, 300px apart
      const points = [
        sp(0, 0, 0),
        sp(300, 0, 1),
        sp(600, 0, 2),
        sp(0, 300, 3),
        sp(300, 300, 4),
        sp(600, 300, 5),
        sp(0, 600, 6),
        sp(300, 600, 7),
      ];
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1', 'p2', 'p3']);
      expect(assignments.size).toBe(3);

      // p1 gets the first (highest priority = closest to center)
      expect(assignments.get('p1')).toEqual({ x: 0, y: 0 });

      // All three should be far apart
      const positions = Array.from(assignments.values());
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          expect(
            dist(positions[i]!.x, positions[i]!.y, positions[j]!.x, positions[j]!.y),
          ).toBeGreaterThanOrEqual(400);
        }
      }
    });

    it('does not stack players when spawns run out — uses jitter', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1), sp(600, 0, 2), sp(900, 0, 3)];
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1', 'p2', 'p3', 'p4', 'p5']);
      expect(assignments.size).toBe(5);

      // p5 should NOT have the exact same position as p1
      const pos1 = assignments.get('p1')!;
      const pos5 = assignments.get('p5')!;
      expect(pos5).not.toEqual(pos1);
      // Jitter should give at least some separation
      expect(dist(pos1.x, pos1.y, pos5.x, pos5.y)).toBeGreaterThan(0);
    });

    it('enforces spacing — players never spawn on top of each other', () => {
      const points = [
        sp(100, 100, 0),
        sp(110, 100, 1),
        sp(500, 500, 2),
        sp(800, 800, 3),
        sp(1200, 1200, 4),
      ];
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1', 'p2']);
      const pos1 = assignments.get('p1')!;
      const pos2 = assignments.get('p2')!;
      // Farthest-point should pick well-separated spawns
      expect(dist(pos1.x, pos1.y, pos2.x, pos2.y)).toBeGreaterThanOrEqual(256);
    });

    it('keeps all players spaced apart with enough spawns', () => {
      const points: SpawnPoint[] = [];
      for (let i = 0; i < 10; i++) {
        points.push(sp(i * 300, 0, i));
      }
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1', 'p2', 'p3', 'p4']);
      expect(assignments.size).toBe(4);

      const positions = Array.from(assignments.values());
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          expect(
            dist(positions[i]!.x, positions[i]!.y, positions[j]!.x, positions[j]!.y),
          ).toBeGreaterThanOrEqual(256);
        }
      }
    });

    it('handles identical player IDs by overwriting', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1), sp(600, 0, 2)];
      service.initialize(points);

      const assignments = service.assignSpawnPoints(['p1', 'p1']);
      expect(assignments.size).toBe(1);
    });

    it('returns a new map each call', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1)];
      service.initialize(points);

      const first = service.assignSpawnPoints(['p1']);
      const second = service.assignSpawnPoints(['p1']);
      expect(first).not.toBe(second);
    });

    it('distributes 24 players across 40 spawn points without stacking', () => {
      const points: SpawnPoint[] = [];
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 8; x++) {
          points.push(sp(x * 300, y * 300, y * 8 + x));
        }
      }
      service.initialize(points);

      const playerIds = Array.from({ length: 24 }, (_, i) => `p${i}`);
      const assignments = service.assignSpawnPoints(playerIds);
      expect(assignments.size).toBe(24);

      // No two players at the exact same position
      const positions = Array.from(assignments.values());
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          expect(positions[i]).not.toEqual(positions[j]);
        }
      }
    });
  });

  describe('releaseAssignment (lifecycle)', () => {
    it('removes assignment so released spawn point becomes reusable', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1), sp(600, 0, 2)];
      service.initialize(points);

      service.assignSpawnPoints(['p1', 'p2']);
      expect(service.assignSpawnPoints(['p1', 'p2']).size).toBe(2);

      service.releaseAssignment('p1');

      const assignments = service.assignSpawnPoints(['p3']);
      const pos2 = assignments.get('p2')!;
      const pos3 = assignments.get('p3')!;
      expect(pos3).not.toEqual(pos2);
    });

    it('survives join/leave/rejoin churn without stacking', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1), sp(600, 0, 2), sp(900, 0, 3)];
      service.initialize(points);

      service.assignSpawnPoints(['p1', 'p2', 'p3', 'p4']);

      service.releaseAssignment('p1');
      service.releaseAssignment('p2');
      service.releaseAssignment('p3');
      service.releaseAssignment('p4');

      const assignments = service.assignSpawnPoints(['p5', 'p6', 'p7', 'p8']);
      expect(assignments.size).toBe(4);

      const positions = Array.from(assignments.values());
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          expect(positions[i]).not.toEqual(positions[j]);
        }
      }
    });

    it('survives 10 join/leave cycles without exhausting spawn points', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1), sp(600, 0, 2), sp(900, 0, 3)];
      service.initialize(points);

      for (let cycle = 0; cycle < 10; cycle++) {
        const ids = [`b${cycle}_1`, `b${cycle}_2`, `b${cycle}_3`, `b${cycle}_4`];
        service.assignSpawnPoints(ids);

        for (const id of ids) {
          service.releaseAssignment(id);
        }
      }

      const assignments = service.assignSpawnPoints(['final1', 'final2', 'final3', 'final4']);
      expect(assignments.size).toBe(4);

      const positions = Array.from(assignments.values());
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          expect(positions[i]).not.toEqual(positions[j]);
        }
      }
    });

    it('is a no-op for unknown playerId', () => {
      const points = [sp(0, 0, 0), sp(300, 0, 1)];
      service.initialize(points);
      service.assignSpawnPoints(['p1']);

      service.releaseAssignment('nonexistent');

      expect(service.assignSpawnPoints(['p1']).get('p1')).toBeDefined();
    });
  });
});

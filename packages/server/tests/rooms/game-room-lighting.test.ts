import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup, createRoom } from '../helpers/test-server';
import type { GameRoom } from '../../src/room/GameRoom.ts';
import type { LightingReport } from '../../src/infrastructure/map/LightingReportBuilder.js';

/**
 * Map-redesign ticket 05 (DEC-005) — the room-level lighting-discipline
 * wiring: the lighting report is computed ONCE at map build (post hue
 * enforcement, from the final placement list + grid) and stashed for the
 * benchmark generation manifest, where the ≤3-hue-family and value-band
 * violations are LOGGED per the ticket criterion. Procedural rooms carry
 * it; demo-TMX rooms have no shared-generation placements (null).
 */
describe('GameRoom — lighting-discipline report (ticket 05)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  function reportOf(room: Room): LightingReport | undefined {
    return (room as unknown as GameRoom).getMapIdentityManifest().lightingReport;
  }

  async function createGameRoom(seed: number, mapType: 'procedural' | 'demo', matchId: string) {
    return createRoom(server, { seed, mapType, botFillTo: 0, matchId });
  }

  it('procedural room carries a clean lighting report (0 violations, pools, beacons)', async () => {
    const room = await createGameRoom(42, 'procedural', 'lighting-probe');
    const report = reportOf(room);
    expect(report).toBeDefined();
    // Discipline gates hold on the shipped pipeline.
    expect(report!.hueViolations).toHaveLength(0);
    expect(report!.valueBandViolations).toHaveLength(0);
    // The hierarchy layers are present.
    expect(report!.byKind['beacon']).toBeGreaterThanOrEqual(18);
    expect(report!.poiGlowPools).toBeGreaterThan(0);
    expect(report!.total).toBeGreaterThan(0);
    // Dark pockets exist and every COLD sector holds at least one.
    expect(report!.darkPockets.count).toBeGreaterThan(0);
    expect(report!.darkPockets.coldSectorPockets).toBeGreaterThanOrEqual(4);
    // The on-screen budget sample stays far below the ≤80 client target.
    expect(report!.maxViewportStatics).toBeLessThanOrEqual(20);
    expect(report!.viewportSamples).toBeGreaterThan(0);
  });

  it('same seed → identical report (deterministic)', async () => {
    const roomA = await createGameRoom(777, 'procedural', 'lighting-det-a');
    const roomB = await createGameRoom(777, 'procedural', 'lighting-det-b');
    expect(JSON.stringify(reportOf(roomA))).toBe(JSON.stringify(reportOf(roomB)));
  });

  it('different seed → different report (placement varies per map)', async () => {
    const roomA = await createGameRoom(777, 'procedural', 'lighting-var-a');
    const roomB = await createGameRoom(778, 'procedural', 'lighting-var-b');
    expect(JSON.stringify(reportOf(roomA))).not.toBe(JSON.stringify(reportOf(roomB)));
  });

  it('demo room report has no tier split but still reports the TMX placements', async () => {
    const room = await createGameRoom(42, 'demo', 'demo-lighting-probe');
    const report = reportOf(room);
    // Demo TMX maps have no shared-generation tiers → coldSectorPockets is 0
    // (no tier split), but the placement-derived stats are still reported.
    expect(report).toBeDefined();
    expect(report!.darkPockets.coldSectorPockets).toBe(0);
    expect(report!.hueViolations).toHaveLength(0);
    expect(report!.valueBandViolations).toHaveLength(0);
  });
});

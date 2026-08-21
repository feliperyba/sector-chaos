import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { NETWORK, deriveZoneSeed } from '@sector-battle/shared';
import { createTestServer, createRoom, cleanup } from '../helpers/test-server';
import { createTestConfig } from '../helpers/test-utils';
import { GameRoom } from '../../src/room/GameRoom';

/**
 * Zone same-seed replay — the FULL production chain (map generation →
 * GameRoomLifecycle → createGameOrchestrator → deriveZoneSeed → ZoneService),
 * map-redesign ticket 09 / DEC-008.1 (GDD §5.4: "Zone center randomization
 * uses the same seed").
 *
 * Two rooms created with the same map seed, driven synchronously through
 * every center-selecting phase, must report an identical zone center
 * sequence — a map seed now means a full reproducible match story. The
 * zone seed is also asserted to equal `deriveZoneSeed(mapSeed)` exactly
 * (the room stashes it for the benchmark manifest).
 *
 * Drive pattern matches zone-system.test.ts's `syncAdvanceTicks` (direct
 * `orchestrator.update()` — blocking the event loop so the room's real
 * interval cannot interleave; the phase table is accelerated so the whole
 * zone story runs in a few hundred ticks).
 */

/** Accelerated phase table: same radii as production, 2s/1s durations. */
const ACCELERATED_PHASES = [
  { index: 1, radiusRatio: 1.0, duration: 2, name: 'Drop' },
  { index: 2, radiusRatio: 0.6, duration: 2, name: 'First Closure' },
  { index: 3, radiusRatio: 0.25, duration: 2, name: 'Edge Closure' },
  { index: 4, radiusRatio: 0.15, duration: 2, name: 'Final Ring' },
  { index: 5, radiusRatio: 0.1, duration: 1, name: 'Last Sector' },
  { index: 6, radiusRatio: 0.08, duration: 1, name: 'Final Closure' },
  { index: 7, radiusRatio: 0.08, duration: 9999, name: 'Sudden Death' },
];

interface ZoneTrace {
  seed: number;
  centers: Array<{ phase: number; x: number; y: number; radius: number }>;
}

/** Create the room and drive it synchronously through every zone phase. */
async function runRoomAsync(server: ColyseusTestServer, mapSeed: number): Promise<ZoneTrace> {
  const room = await createRoom(server, {
    matchId: `zone-seed-${mapSeed}-${Math.random().toString(36).slice(2, 6)}`,
    seed: mapSeed,
    botFillTo: 0,
    config: createTestConfig({
      zone: {
        phases: ACCELERATED_PHASES,
        totalDuration: 12,
        transitionDuration: 1,
        tickInterval: 0.5,
        warningTime: 1,
      },
    }),
  });
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator();
  const centers: ZoneTrace['centers'] = [];
  // Enough ticks to pass phase 6 (phases 1..6 = 2+2+2+2+1+1 = 10s game-time)
  // plus slack for the countdown phase machine to reach ACTIVE first.
  const ticks = 12 * NETWORK.TICK_RATE + 8 * NETWORK.TICK_RATE;
  let lastPhase = -1;
  for (let i = 0; i < ticks; i++) {
    orch.update(NETWORK.TICK_INTERVAL);
    const zone = orch.getMatchState().zone;
    if (zone.currentPhase !== lastPhase) {
      lastPhase = zone.currentPhase;
      if (zone.currentPhase >= 2) {
        centers.push({
          phase: zone.currentPhase,
          x: zone.targetCenterX,
          y: zone.targetCenterY,
          radius: zone.targetRadius,
        });
      }
    }
  }
  const stashed = gameRoom.getMapIdentityManifest().zoneSeed;
  return { seed: stashed ?? -1, centers };
}

describe('zone same-seed replay (room-level, ticket 09 / DEC-008.1)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('two rooms with the same map seed produce an identical zone center sequence', async () => {
    const runA = await runRoomAsync(server, 4242);
    const runB = await runRoomAsync(server, 4242);
    // The room stashes the derived zone seed for the benchmark manifest.
    expect(runA.seed).toBe(deriveZoneSeed(4242));
    expect(runB.seed).toBe(runA.seed);
    // Full zone story identical: every phase target center + radius.
    expect(runB.centers).toEqual(runA.centers);
    // Sanity: the trace covers phases 2..7 (5 center selections + OT entry).
    expect(runA.centers.map((c) => c.phase)).toEqual([2, 3, 4, 5, 6, 7]);
    for (const c of runA.centers) {
      expect(c.radius).toBeGreaterThan(0);
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Number.isFinite(c.y)).toBe(true);
    }
    // GDD §8.1.1: overtime does NOT shift the zone center — the phase 7
    // trace entry must repeat the phase 6 target exactly.
    const phase6 = runA.centers.find((c) => c.phase === 6)!;
    const phase7 = runA.centers.find((c) => c.phase === 7)!;
    expect(phase7.x).toBe(phase6.x);
    expect(phase7.y).toBe(phase6.y);
  }, 60_000);

  it('a different map seed produces a different zone story', async () => {
    const runA = await runRoomAsync(server, 4242);
    const runC = await runRoomAsync(server, 4243);
    expect(runC.seed).not.toBe(runA.seed);
    expect(runC.centers).not.toEqual(runA.centers);
  }, 60_000);
});

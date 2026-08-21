import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import { getActiveSimulations } from '../../src/infrastructure/SimulationRegistry';

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await cleanup(server);
});

describe('Room State Isolation', () => {
  it('second room does not inherit state from first room', async () => {
    // Room 1
    const { room: room1, helper: helper1 } = await createGameRoom(server, {
      botFillTo: 5,
      seed: 42,
      matchId: 'room-isolation-1',
    });

    await new Promise((r) => setTimeout(r, 3000));

    const orch1 = (room1 as unknown as GameRoom).getOrchestrator();
    const tick1 = orch1.currentTick;
    const playerCount1 = orch1.getMatch().getPlayers().length;
    expect(playerCount1).toBeGreaterThan(0);

    // Verify simulation is registered
    expect(getActiveSimulations().size).toBeGreaterThanOrEqual(1);

    // Disconnect room 1
    room1.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    // Room 2 — should start fresh with no inherited state
    const { room: room2, helper: helper2 } = await createGameRoom(server, {
      botFillTo: 5,
      seed: 99,
      matchId: 'room-isolation-2',
    });

    await new Promise((r) => setTimeout(r, 3000));

    const orch2 = (room2 as unknown as GameRoom).getOrchestrator();
    const tick2 = orch2.currentTick;
    const playerCount2 = orch2.getMatch().getPlayers().length;

    // Room 2 should have its own fresh tick counter (near 0, not continuing from room 1)
    expect(tick2).toBeLessThan(tick1 + 100);

    // Room 2 should have its own players (different IDs)
    const room1PlayerIds = new Set(
      orch1
        .getMatch()
        .getPlayers()
        .map((p) => p.id),
    );
    const room2Players = orch2.getMatch().getPlayers();
    for (const p of room2Players) {
      expect(room1PlayerIds.has(p.id)).toBe(false);
    }

    // Room 2 spawn assignments should be independent
    const spawnService2 = (orch2 as any).spawnService;
    expect(spawnService2.assignments.size).toBeGreaterThan(0);
    expect(spawnService2.spawnPoints.length).toBe(64);

    room2.disconnect();
  }, 30_000);

  it('simulation registry cleans up on room dispose', async () => {
    const beforeCount = getActiveSimulations().size;

    const { room } = await createGameRoom(server, {
      botFillTo: 2,
      seed: 77,
      matchId: 'registry-test',
    });

    expect(getActiveSimulations().size).toBe(beforeCount + 1);

    room.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    expect(getActiveSimulations().size).toBe(beforeCount);
  }, 15_000);
});

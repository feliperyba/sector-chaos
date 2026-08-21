import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { GRID, MatchPhase } from '@sector-battle/shared';
import { createTestServer } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { freezeServerWallClock } from '../helpers/test-utils';

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server?.cleanup();
});

describe('Room Creation with Default Options', () => {
  it('creates room with default options', async () => {
    const { room } = await createGameRoom(server);
    expect(room).toBeDefined();
    expect(room.state).toBeDefined();
    expect(room.state.players.size).toBe(0);
  });

  it('creates room with custom matchId', async () => {
    const { room } = await createGameRoom(server, { matchId: 'custom-match-001' });
    expect(room.state.matchId).toBe('custom-match-001');
  });

  it('creates room with seed option (deterministic map)', async () => {
    const { room: roomA } = await createGameRoom(server, { seed: 42 });
    const { room: roomB } = await createGameRoom(server, { seed: 42 });
    expect(roomA.state.mapWidth).toBe(roomB.state.mapWidth);
    expect(roomA.state.mapHeight).toBe(roomB.state.mapHeight);

    const { room: roomC } = await createGameRoom(server, { seed: 99 });
    expect(roomC.state.mapSeed).not.toBe(roomA.state.mapSeed);
  });

  it('creates room with botFillTo: 0', async () => {
    const { room } = await createGameRoom(server, { botFillTo: 0 });
    expect(room.state.players.size).toBe(0);
  });
});

describe('Initial State Values', () => {
  // [STALE] Room starts in COUNTDOWN, not WAITING — GameRoomLifecycle.handleOnCreate
  // calls ctx.botManager.spawnBots() then syncState() while the GameRoom's first
  // simulation tick (handleSimulationTick) calls orchestrator.start() which
  // transitions WAITING→COUNTDOWN. By the time waitForNextSimulationTick()
  // returns, phase is already COUNTDOWN.
  it('phase is COUNTDOWN on creation', async () => {
    const { room } = await createGameRoom(server);
    expect(room.state.phase).toBe(MatchPhase.COUNTDOWN);
  });

  // tick starts near 0. GameMatch.tick is initialized to 0 and increments via
  // advanceTick() at the END of each simulation step. createRoom waits
  // `syncEveryN` ticks before returning (so at least one syncState() has
  // projected the post-start phase), so by the time we read state, tick has
  // advanced to syncEveryN-1 (0 with PATCH_RATE=60, 1 with PATCH_RATE=30).
  // The room's real simulation interval keeps firing during those awaited
  // timers and passes its REAL deltaTime into the sim, so under parallel-worker
  // load the tick drifts past 1 (observed 5). Freezing the server wall-clock
  // (virtual-clock pattern) makes every real fire pass deltaTime=0: the tick
  // stays at its creation value deterministically.
  it('tick starts near 0', async () => {
    const unfreeze = freezeServerWallClock();
    try {
      const { room } = await createGameRoom(server);
      expect(room.state.tick).toBeLessThanOrEqual(1);
    } finally {
      unfreeze();
    }
  });

  it('players map is empty', async () => {
    const { room } = await createGameRoom(server);
    expect(room.state.players.size).toBe(0);
  });

  it('playersAlive is 0', async () => {
    const { room } = await createGameRoom(server);
    expect(room.state.playersAlive).toBe(0);
  });

  it('map dimensions are set', async () => {
    const { room } = await createGameRoom(server);
    expect(room.state.mapWidth).toBeGreaterThan(0);
    expect(room.state.mapHeight).toBeGreaterThan(0);
    expect(room.state.mapWidth).toBeLessThanOrEqual(GRID.WORLD_WIDTH);
    expect(room.state.mapHeight).toBeLessThanOrEqual(GRID.WORLD_HEIGHT);
  });

  it('mapSeed matches seed option', async () => {
    const { room } = await createGameRoom(server, { seed: 42 });
    expect(room.state.mapSeed).toBe(42);
  });

  it('matchTimer is 0 or initial value', async () => {
    const { room } = await createGameRoom(server);
    expect(typeof room.state.matchTimer).toBe('number');
    expect(room.state.matchTimer).toBeGreaterThanOrEqual(0);
  });

  it('lastProcessedInput is 0', async () => {
    const { room } = await createGameRoom(server);
    expect(room.state.lastProcessedInput).toBe(0);
  });
});

describe('Room Metadata', () => {
  it('room has correct roomId', async () => {
    const { room } = await createGameRoom(server);
    expect(room.roomId).toBeDefined();
    expect(typeof room.roomId).toBe('string');
    expect(room.roomId.length).toBeGreaterThan(0);
  });

  it('room has correct room type', async () => {
    const { room } = await createGameRoom(server);
    expect(room).toBeDefined();
  });

  it('room maxClients is 64', async () => {
    const { room } = await createGameRoom(server);
    expect(room.maxClients).toBe(64);
  });

  // PATCH_RATE is 30Hz (decoupled from the 60Hz TICK_RATE to keep the live
  // server inside its 16ms tick budget — see NETWORK.PATCH_RATE doc). So
  // GameRoom.patchRate = 1000/NETWORK.PATCH_RATE ≈ 33.33ms.
  it('room patchRate is 1000/30 (~33.33ms)', async () => {
    const { room } = await createGameRoom(server);
    expect(room.patchRate).toBeCloseTo(1000 / 30, 5);
  });
});

describe('Multiple Rooms Coexistence', () => {
  it('multiple rooms can coexist independently', async () => {
    const { room: room1, helper: h1 } = await createGameRoom(server, { matchId: 'multi-1' });
    const { room: room2 } = await createGameRoom(server, { matchId: 'multi-2' });
    const { room: room3 } = await createGameRoom(server, { matchId: 'multi-3' });

    const matchIds = [room1.state.matchId, room2.state.matchId, room3.state.matchId];
    const uniqueMatchIds = new Set(matchIds);
    expect(uniqueMatchIds.size).toBe(3);

    expect(room1.state.players.size).toBe(0);
    expect(room2.state.players.size).toBe(0);
    expect(room3.state.players.size).toBe(0);

    await h1.addPlayer('P1');
    expect(room1.state.players.size).toBe(1);
    expect(room2.state.players.size).toBe(0);
    expect(room3.state.players.size).toBe(0);
  });

  it('rooms have independent state', async () => {
    const { room: r1, helper: h1 } = await createGameRoom(server, { matchId: 'indep-1' });
    const { room: r2 } = await createGameRoom(server, { matchId: 'indep-2' });

    await h1.addPlayer('P1');
    expect(r1.state.players.size).toBe(1);
    expect(r2.state.players.size).toBe(0);
  });

  it('rooms have independent tick counters', async () => {
    const { room: r1, helper: h1 } = await createGameRoom(server, { matchId: 'tick-1' });
    const { room: r2 } = await createGameRoom(server, { matchId: 'tick-2' });

    await h1.addPlayer('P1');
    await h1.advanceTicks(30);
    expect(r1.state.tick).toBeGreaterThan(r2.state.tick);
  });
});

describe('Edge Cases', () => {
  it('creating room with very large seed', async () => {
    const { room } = await createGameRoom(server, { seed: 2147483647 });
    expect(room).toBeDefined();
    expect(room.state).toBeDefined();
  });

  it('creating room with seed 0', async () => {
    const { room } = await createGameRoom(server, { seed: 0 });
    expect(room).toBeDefined();
    expect(room.state).toBeDefined();
  });

  it('creating room with negative seed', async () => {
    const { room } = await createGameRoom(server, { seed: -1 });
    expect(room).toBeDefined();
    expect(room.state).toBeDefined();
  });
});

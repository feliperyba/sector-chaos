import { describe, it, expect, afterAll } from 'vitest';
import { PLAYER } from '@sector-battle/shared';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, createRoom, connectClient, cleanup } from './test-server.ts';

describe('test-server harness', () => {
  let server: ColyseusTestServer;

  afterAll(async () => {
    await cleanup(server);
  });

  it('boots a test server', async () => {
    server = await createTestServer();
    expect(server).toBeDefined();
  });

  it('creates a room with deterministic seed and no bots', async () => {
    const room = await createRoom(server, { matchId: 'smoke-room' });
    expect(room.state.matchId).toBe('smoke-room');
    expect(room.state.players.size).toBe(0);
  });

  it('connects a client with proper auth', async () => {
    const room = await createRoom(server, { matchId: 'smoke-connect' });
    const client = await connectClient(server, room, { name: 'Alice' });
    const player = room.state.players.get(client.sessionId);
    expect(player).toBeDefined();
    expect(player!.name).toBe('Alice');
    expect(player!.health).toBe(PLAYER.BASE_HEALTH);
  });

  it('connects multiple clients', async () => {
    const room = await createRoom(server, { matchId: 'smoke-multi' });
    const c1 = await connectClient(server, room);
    const c2 = await connectClient(server, room);
    const c3 = await connectClient(server, room);
    expect(room.state.players.size).toBe(3);
    expect(room.state.players.get(c1.sessionId)).toBeDefined();
    expect(room.state.players.get(c2.sessionId)).toBeDefined();
    expect(room.state.players.get(c3.sessionId)).toBeDefined();
  });
});

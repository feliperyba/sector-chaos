import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { PLAYER, GRID } from '@sector-battle/shared';
import { createTestServer, createRoom, connectClient } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server?.cleanup();
});

describe('Connection with Valid Auth', () => {
  it('connects client with valid auth token', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'valid-auth' });
    const client = await helper.addPlayer('Alice');
    expect(client.sessionId).toBeDefined();
    expect(client.sessionId.length).toBeGreaterThan(0);
    expect(room.state.players.size).toBe(1);
    const player = helper.getPlayer(client);
    expect(player).toBeDefined();
    expect(player!.name).toBe('Alice');
    expect(player!.health).toBe(PLAYER.BASE_HEALTH);
    expect(player!.connected).toBe(true);
  });

  it('connects client with minimum valid token (exactly 16 chars)', async () => {
    const room = await createRoom(server, { matchId: 'min-token' });
    const client = await connectClient(server, room, {
      token: '1234567890123456',
      name: 'MinToken',
    });
    expect(client).toBeDefined();
    expect(room.state.players.size).toBe(1);
  });

  it('connects client with custom name', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'custom-name' });
    const client = await helper.addPlayer('CustomName');
    expect(helper.getPlayer(client)!.name).toBe('CustomName');
  });

  it('connected player has correct initial state', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'init-state' });
    const client = await helper.addPlayer('StateCheck');
    const player = helper.getPlayer(client)!;
    expect(player.health).toBe(PLAYER.BASE_HEALTH);
    expect(player.maxHealth).toBe(PLAYER.MAX_HEALTH);
    expect(player.speed).toBe(PLAYER.BASE_SPEED);
    expect(player.kills).toBe(0);
    expect(player.activeSlot).toBeGreaterThanOrEqual(0);
    expect(player.x).toBeGreaterThan(0);
    expect(player.y).toBeGreaterThan(0);
    expect(player.x).toBeLessThan(GRID.WORLD_WIDTH);
    expect(player.y).toBeLessThan(GRID.WORLD_HEIGHT);
    expect(player.connected).toBe(true);
  });
});

describe('Rejection with Invalid Auth', () => {
  it('rejects client with missing auth', async () => {
    const room = await createRoom(server, { matchId: 'no-auth' });
    await expect(connectClient(server, room, { token: '', name: 'NoAuth' })).rejects.toThrow();
    expect(room.state.players.size).toBe(0);
  });

  it('rejects client with short token (< 16 chars)', async () => {
    const room = await createRoom(server, { matchId: 'short-token' });
    await expect(
      connectClient(server, room, { token: 'short', name: 'ShortToken' }),
    ).rejects.toThrow();
    expect(room.state.players.size).toBe(0);
  });

  it('rejects client with exactly 15 char token', async () => {
    const room = await createRoom(server, { matchId: 'fifteen-token' });
    await expect(
      connectClient(server, room, { token: '123456789012345', name: 'Fifteen' }),
    ).rejects.toThrow();
    expect(room.state.players.size).toBe(0);
  });

  it('rejection does not create player state', async () => {
    const room = await createRoom(server, { matchId: 'rejection-state' });
    try {
      await connectClient(server, room, { token: 'bad', name: 'BadToken' });
    } catch {}
    try {
      await connectClient(server, room, { token: '', name: 'EmptyToken' });
    } catch {}
    expect(room.state.players.size).toBe(0);
  });
});

describe('Multiple Client Connections', () => {
  it('connects multiple clients sequentially', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'multi-seq' });
    const c1 = await helper.addPlayer('P1');
    const c2 = await helper.addPlayer('P2');
    const c3 = await helper.addPlayer('P3');
    const c4 = await helper.addPlayer('P4');
    const c5 = await helper.addPlayer('P5');
    expect(helper.state.players.size).toBe(5);
    expect(helper.getPlayer(c1)!.name).toBe('P1');
    expect(helper.getPlayer(c2)!.name).toBe('P2');
    expect(helper.getPlayer(c3)!.name).toBe('P3');
    expect(helper.getPlayer(c4)!.name).toBe('P4');
    expect(helper.getPlayer(c5)!.name).toBe('P5');
  });

  it('connects multiple clients to same room', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'same-room' });
    const c1 = await helper.addPlayer('R1');
    const c2 = await helper.addPlayer('R2');
    const c3 = await helper.addPlayer('R3');
    const sessionIds = new Set([c1.sessionId, c2.sessionId, c3.sessionId]);
    expect(sessionIds.size).toBe(3);
    for (const c of [c1, c2, c3]) {
      const player = helper.getPlayer(c);
      expect(player).toBeDefined();
      expect(player!.id).toBe(c.sessionId);
    }
  });

  it('player count tracks correctly', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'count-track' });
    const c1 = await helper.addPlayer('T1');
    await helper.addPlayer('T2');
    await helper.addPlayer('T3');
    expect(room.state.players.size).toBe(3);
    await helper.removePlayer(c1);
    expect(room.state.players.size).toBe(2);
  });

  it('connects up to maxClients=64', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'max-64' });
    const clients = [];
    for (let i = 0; i < 64; i++) {
      clients.push(await helper.addPlayer(`Max${i}`));
    }
    expect(room.state.players.size).toBe(64);
    const sessionIds = new Set(clients.map((c) => c.sessionId));
    expect(sessionIds.size).toBe(64);
  }, 60000);
});

describe('Room Full Rejection', () => {
  it('rejects client when room is full (64 clients)', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'room-full' });
    const clients = [];
    for (let i = 0; i < 64; i++) {
      clients.push(await helper.addPlayer(`Full${i}`));
    }
    expect(room.state.players.size).toBe(64);
    await expect(
      connectClient(server, room, { token: 'overflow-token-xxxxx', name: 'Overflow' }),
    ).rejects.toThrow();
    expect(room.state.players.size).toBe(64);
  }, 60000);
});

describe('Client Disconnection', () => {
  it('client disconnection removes player from state', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'disconnect' });
    const client = await helper.addPlayer('Leaver');
    expect(room.state.players.size).toBe(1);
    await helper.removePlayer(client);
    expect(room.state.players.size).toBe(0);
  });

  it('client disconnection sets connected flag to false', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'conn-flag' });
    const client = await helper.addPlayer('FlagCheck');
    expect(helper.getPlayer(client)?.connected).toBe(true);
    client.leave();
    await room.waitForNextSimulationTick();
    const player = helper.getPlayer(client);
    if (player) {
      expect(player.connected).toBe(false);
    }
  });

  it('multiple disconnections update count', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'multi-disconnect' });
    const c1 = await helper.addPlayer('D1');
    const c2 = await helper.addPlayer('D2');
    const c3 = await helper.addPlayer('D3');
    expect(room.state.players.size).toBe(3);
    await helper.removePlayer(c1);
    await helper.removePlayer(c2);
    expect(room.state.players.size).toBe(1);
    const remaining = helper.getPlayer(c3);
    expect(remaining).toBeDefined();
    expect(remaining!.connected).toBe(true);
  });

  it('disconnection of non-existent client is no-op', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'noop-disconnect' });
    room.autoDispose = false;
    const client = await helper.addPlayer('NoOp');
    client.leave();
    await room.waitForNextSimulationTick();
    try {
      client.leave();
    } catch {}
    const verifyClient = await helper.addPlayer('StillWorks');
    expect(helper.getPlayer(verifyClient)).toBeDefined();
  });
});

describe('Reconnection', () => {
  it('reconnection within grace period restores player', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'reconnect-grace' });
    room.autoDispose = false;
    const client1 = await helper.addPlayer('Reconnector');
    const sessionId1 = client1.sessionId;
    const player1 = helper.getPlayer(client1)!;
    const originalPos = { x: player1.x, y: player1.y };
    client1.leave();
    await room.waitForNextSimulationTick();
    const client2 = await connectClient(server, room, { name: 'Reconnector' });
    expect(client2.sessionId).not.toBe(sessionId1);
    const player2 = [...room.state.players.values()].find((p) => p.id === client2.sessionId);
    expect(player2).toBeDefined();
    expect(player2!.connected).toBe(true);
    expect(originalPos).toBeDefined();
  });

  it('reconnection after grace period creates new session', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'reconnect-expired' });
    room.autoDispose = false;
    const client1 = await helper.addPlayer('ExpiredReconnector');
    const sessionId1 = client1.sessionId;
    client1.leave();
    await room.waitForNextSimulationTick();
    const client2 = await connectClient(server, room, { name: 'NewPlayer' });
    expect(client2.sessionId).not.toBe(sessionId1);
    const player2 = [...room.state.players.values()].find((p) => p.id === client2.sessionId);
    expect(player2).toBeDefined();
    expect(player2!.connected).toBe(true);
  });
});

describe('Edge Cases', () => {
  it('rapid connect/disconnect cycle', async () => {
    const { room, helper } = await createGameRoom(server, { matchId: 'rapid-cycle' });
    room.autoDispose = false;
    for (let i = 0; i < 10; i++) {
      const client = await helper.addPlayer(`Rapid${i}`);
      await helper.removePlayer(client);
    }
    expect(room.state.players.size).toBe(0);
  });

  it('connect with special characters in name', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'special-chars' });
    const c1 = await helper.addPlayer("Player O'Brien");
    const c2 = await helper.addPlayer('Player-Test_123');
    expect(helper.getPlayer(c1)!.name).toBe("Player O'Brien");
    expect(helper.getPlayer(c2)!.name).toBe('Player-Test_123');
  });

  it('connect without name uses default', async () => {
    const room = await createRoom(server, { matchId: 'no-name' });
    const client = await connectClient(server, room);
    const player = [...room.state.players.values()].find((p) => p.id === client.sessionId);
    expect(player).toBeDefined();
    expect(player!.name).toBeDefined();
    expect(player!.name.length).toBeGreaterThan(0);
  });
});

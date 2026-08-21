import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server } from 'colyseus';
import type { ColyseusTestServer } from '@colyseus/testing';
import { setupServer } from '../../src/app.config.ts';
import { LobbyRoom } from '../../src/room/LobbyRoom.ts';
import type { SDKRoom } from '@colyseus/sdk';
import { bootTestServer, cleanup } from '../helpers/test-server.ts';

describe('LobbyRoom', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    const server = new Server();
    setupServer(server);
    colyseus = await bootTestServer(server);
  }, 30000);

  afterAll(async () => {
    await cleanup(colyseus);
  });

  async function createLobbyAndConnect(
    clientCount: number,
    options: Record<string, string> = {},
  ): Promise<{
    room: LobbyRoom;
    clients: SDKRoom<LobbyRoom>[];
  }> {
    const room = await colyseus.createRoom<LobbyRoom>('lobby', {
      mapId: options.mapId ?? 'test_map',
      mode: options.mode ?? 'battle_royale',
      botFill: false,
    });

    const clients: SDKRoom<LobbyRoom>[] = [];
    for (let i = 0; i < clientCount; i++) {
      const client = await colyseus.connectTo(room, { mmr: 1000 + i * 100 });
      clients.push(client);
    }

    await room.waitForNextPatch();

    return { room, clients };
  }

  it('player joins lobby and state reflects join', async () => {
    const { room } = await createLobbyAndConnect(1);

    expect(room.state.players.size).toBe(1);
    expect(room.state.hostId).toBeDefined();
    expect(room.state.players.get(room.state.hostId)).toBeDefined();
  });

  it('first player becomes host', async () => {
    const { room, clients } = await createLobbyAndConnect(1);
    const sessionId = clients[0].sessionId;

    expect(room.state.players.get(sessionId)!.isHost).toBe(true);
    expect(room.state.hostId).toBe(sessionId);
  });

  it('player sets valid name', async () => {
    const { room, clients } = await createLobbyAndConnect(1);
    clients[0].send('selectName', { name: 'CoolPlayer' });

    await room.waitForNextPatch();

    const player = room.state.players.get(clients[0].sessionId);
    expect(player?.name).toBe('CoolPlayer');
  });

  it('player sets invalid name - too short', async () => {
    const { clients } = await createLobbyAndConnect(1);
    clients[0].send('selectName', { name: 'ab' });

    const msg = await clients[0].waitForMessage('error', 3000);
    expect(msg).toBeDefined();
    expect((msg as { message: string }).message).toContain('3');
  });

  it('player sets invalid name - special characters', async () => {
    const { clients } = await createLobbyAndConnect(1);
    clients[0].send('selectName', { name: 'bad!name' });

    const msg = await clients[0].waitForMessage('error', 3000);
    expect(msg).toBeDefined();
    expect((msg as { message: string }).message).toContain('alphanumeric');
  });

  it('player selects available color', async () => {
    const { room, clients } = await createLobbyAndConnect(1);
    clients[0].send('selectColor', { colorIndex: 5 });

    await room.waitForNextPatch();

    const player = room.state.players.get(clients[0].sessionId);
    expect(player?.color).toBe(5);
  });

  it('player selects taken color - rejected', async () => {
    const { clients } = await createLobbyAndConnect(2);

    clients[0].send('selectColor', { colorIndex: 3 });
    await new Promise((r) => setTimeout(r, 200));
    clients[1].send('selectColor', { colorIndex: 3 });

    const msg = await clients[1].waitForMessage('error', 3000);
    expect(msg).toBeDefined();
    expect((msg as { message: string }).message).toContain('already taken');
  });

  it('player toggles ready with name and color set', async () => {
    const { room, clients } = await createLobbyAndConnect(1);

    clients[0].send('selectName', { name: 'ReadyPlayer' });
    await new Promise((r) => setTimeout(r, 200));
    clients[0].send('selectColor', { colorIndex: 2 });
    await new Promise((r) => setTimeout(r, 200));
    clients[0].send('ready', {});

    await room.waitForNextPatch();

    const player = room.state.players.get(clients[0].sessionId);
    expect(player?.ready).toBe(true);
  });

  it('ready blocked without name', async () => {
    const { room, clients } = await createLobbyAndConnect(1);
    clients[0].send('selectColor', { colorIndex: 1 });
    await new Promise((r) => setTimeout(r, 200));
    clients[0].send('ready', {});

    await room.waitForNextPatch();

    const player = room.state.players.get(clients[0].sessionId);
    expect(player?.ready).toBe(false);
  });

  it('ready blocked without color', async () => {
    const { room, clients } = await createLobbyAndConnect(1);
    clients[0].send('selectName', { name: 'NoColor' });
    await new Promise((r) => setTimeout(r, 200));

    const player = room.state.players.get(clients[0].sessionId);
    if (player) {
      player.color = 255;
    }

    clients[0].send('ready', {});

    await room.waitForNextPatch();

    const updated = room.state.players.get(clients[0].sessionId);
    expect(updated?.ready).toBe(false);
  });

  it('host transfer on host leave', async () => {
    const { room, clients } = await createLobbyAndConnect(2);

    const hostId = room.state.hostId;
    const nonHostId = clients[1].sessionId;

    expect(hostId).toBe(clients[0].sessionId);

    await clients[0].leave();
    await room.waitForNextPatch();

    expect(room.state.players.get(hostId)).toBeUndefined();
    expect(room.state.hostId).toBe(nonHostId);
    expect(room.state.players.get(nonHostId)?.isHost).toBe(true);
  });

  it('chat message is added to state', async () => {
    const { room, clients } = await createLobbyAndConnect(1);
    clients[0].send('selectName', { name: 'Chatter' });
    await new Promise((r) => setTimeout(r, 200));

    const chatLen = room.state.chatMessages.length;
    clients[0].send('chat', { text: 'Hello!' });

    await room.waitForNextPatch();

    expect(room.state.chatMessages.length).toBe(chatLen + 1);
  });

  it('chat rate limiting rejects rapid messages', async () => {
    const { clients } = await createLobbyAndConnect(1);
    clients[0].send('selectName', { name: 'Spammer' });
    await new Promise((r) => setTimeout(r, 200));

    clients[0].send('chat', { text: 'msg1' });
    await new Promise((r) => setTimeout(r, 100));
    clients[0].send('chat', { text: 'msg2' });

    const msg = await clients[0].waitForMessage('error', 3000);
    expect(msg).toBeDefined();
    expect((msg as { message: string }).message).toContain('too quickly');
  });

  it('countdown flow creates game room and sends matchStarting', async () => {
    const { room, clients } = await createLobbyAndConnect(2);

    clients[0].send('selectName', { name: 'PlayerOne' });
    await new Promise((r) => setTimeout(r, 200));
    clients[1].send('selectName', { name: 'PlayerTwo' });
    await new Promise((r) => setTimeout(r, 200));

    clients[0].send('selectColor', { colorIndex: 0 });
    await new Promise((r) => setTimeout(r, 200));
    clients[1].send('selectColor', { colorIndex: 1 });
    await new Promise((r) => setTimeout(r, 200));

    clients[0].send('ready', {});
    await new Promise((r) => setTimeout(r, 200));
    clients[1].send('ready', {});
    await new Promise((r) => setTimeout(r, 200));

    await room.waitForNextPatch();

    expect(room.state.status).toBe('waiting');

    clients[0].send('startGame', {});
    await room.waitForNextPatch();

    expect(room.state.status).toBe('countdown');
    expect(room.state.countdownSeconds).toBeGreaterThanOrEqual(4);
    expect(room.state.countdownSeconds).toBeLessThanOrEqual(5);

    const matchMsg = await clients[0].waitForMessage('matchStarting', 10000);

    expect(matchMsg).toBeDefined();
    const data = matchMsg as {
      roomId: string;
      seatToken: string;
    };
    expect(data.roomId).toBeDefined();
    expect(data.seatToken).toBeDefined();

    expect(room.state.status).toBe('starting');
  }, 15000);

  it('onDrop triggers reconnection grace period and player is marked disconnected', async () => {
    const { room, clients } = await createLobbyAndConnect(2);

    const droppedSessionId = clients[0].sessionId;
    expect(room.state.players.get(droppedSessionId)?.connected).toBe(true);

    (clients[0] as unknown as { connection: { close: () => void } }).connection.close();

    await room.waitForNextPatch();

    const player = room.state.players.get(droppedSessionId);
    expect(player?.connected).toBe(false);
  });
});

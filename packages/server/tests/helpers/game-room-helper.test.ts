import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PLAYER, MatchPhase } from '@sector-battle/shared';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from './test-server';
import { createGameRoom, GameRoomHelper } from './game-room-helper';

describe('GameRoomHelper', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('creates a room and helper via createGameRoom', async () => {
    const { room, helper } = await createGameRoom(server, {
      matchId: 'wrapper-create',
      forceActivePhase: false,
    });
    expect(room).toBeDefined();
    expect(helper).toBeInstanceOf(GameRoomHelper);
    expect(helper.state.matchId).toBe('wrapper-create');
    expect(helper.phase).toBe(MatchPhase.COUNTDOWN);
  });

  it('addPlayer connects a client and state reflects the join', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-join' });
    const client = await helper.addPlayer('Alice');
    const player = helper.getPlayer(client);
    expect(player).toBeDefined();
    expect(player!.name).toBe('Alice');
    expect(player!.health).toBe(PLAYER.BASE_HEALTH);
    expect(helper.state.players.size).toBe(1);
  });

  it('addPlayer increments player count for multiple joins', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-multi' });
    await helper.addPlayer('P1');
    await helper.addPlayer('P2');
    await helper.addPlayer('P3');
    expect(helper.getAllPlayers().length).toBe(3);
    expect(helper.state.players.size).toBe(3);
  });

  it('sendInput sends movement and state advances', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-input' });
    const client = await helper.addPlayer('Mover');
    helper.forceActive();
    const xBefore = helper.getPlayer(client)!.x;
    await helper.sendInput(client, { movementX: 1, movementY: 0 });
    // Advance a tick so the simulation processes the movement input.
    await helper.advanceTicks(1);
    const player = helper.getPlayer(client);
    expect(player).toBeDefined();
    expect(player!.x).not.toBe(xBefore);
  });

  it('sendInput sends attack action', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-attack' });
    const client = await helper.addPlayer('Attacker');
    await helper.sendInput(client, { actions: ['ATTACK'] });
    expect(helper.tick).toBeGreaterThan(0);
  });

  it('sendInput sends weapon switch action', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-switch' });
    const client = await helper.addPlayer('Switcher');
    await helper.sendInput(client, { actions: ['WEAPON_SLOT_1'] });
    expect(helper.tick).toBeGreaterThan(0);
  });

  it('advanceTicks advances simulation', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-ticks' });
    await helper.addPlayer('Ticker');
    const tickBefore = helper.tick;
    await helper.advanceTicks(60);
    expect(helper.tick).toBeGreaterThanOrEqual(tickBefore + 59);
  });

  it('advanceSeconds converts and advances', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-seconds' });
    await helper.addPlayer('Seconder');
    const tickBefore = helper.tick;
    await helper.advanceSeconds(1);
    expect(helper.tick).toBeGreaterThanOrEqual(tickBefore + 59);
  });

  it('removePlayer disconnects and state reflects the leave', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-leave' });
    const client = await helper.addPlayer('Leaver');
    expect(helper.state.players.size).toBe(1);
    await helper.removePlayer(client);
    expect(helper.state.players.size).toBe(0);
  });

  it('getAllPlayers returns all connected players', async () => {
    const { helper } = await createGameRoom(server, { matchId: 'wrapper-all' });
    const c1 = await helper.addPlayer('A');
    const c2 = await helper.addPlayer('B');
    const players = helper.getAllPlayers();
    expect(players.length).toBe(2);
    const names = players.map((p) => p.name);
    expect(names).toContain('A');
    expect(names).toContain('B');
  });
});

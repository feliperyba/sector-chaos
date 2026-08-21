import { describe, it, expect, afterAll } from 'vitest';
import { PLAYER, NETWORK, GRID, MATCH, MatchPhase } from '@sector-battle/shared';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, createRoom, connectClient, cleanup } from './test-server.ts';
import { advanceTicks, advanceSeconds, createTestConfig, getPlayerState } from './test-utils.ts';

describe('test-utils', () => {
  let server: ColyseusTestServer;

  afterAll(async () => {
    await cleanup(server);
  });

  it('advanceTicks advances room state by N ticks', async () => {
    server = await createTestServer();
    const room = await createRoom(server, { matchId: 'tick-test' });
    await connectClient(server, room);
    const tickBefore = room.state.tick;
    await advanceTicks(room, NETWORK.TICK_RATE);
    expect(room.state.tick).toBeGreaterThanOrEqual(tickBefore + NETWORK.TICK_RATE - 1);
  });

  it('advanceSeconds converts seconds to ticks correctly', async () => {
    const room = await createRoom(server, { matchId: 'seconds-test' });
    await connectClient(server, room);
    const tickBefore = room.state.tick;
    await advanceSeconds(room, 0.5);
    expect(room.state.tick).toBeGreaterThanOrEqual(tickBefore + 29);
  });

  it('createTestConfig returns a complete GameConfig with defaults', () => {
    const config = createTestConfig();
    expect(config.player.baseHealth).toBe(PLAYER.BASE_HEALTH);
    expect(config.player.maxHealth).toBe(PLAYER.MAX_HEALTH);
    expect(config.player.baseSpeed).toBe(PLAYER.BASE_SPEED);
    expect(config.network.tickRate).toBe(NETWORK.TICK_RATE);
    expect(config.map.arenaWidth).toBe(GRID.ARENA_WIDTH);
    expect(config.map.arenaHeight).toBe(GRID.ARENA_HEIGHT);
    expect(config.match.maxPlayers).toBe(MATCH.MAX_PLAYERS);
  });

  it('createTestConfig applies overrides to nested fields', () => {
    const config = createTestConfig({ player: { baseHealth: 50 }, match: { maxPlayers: 10 } });
    expect(config.player.baseHealth).toBe(50);
    expect(config.player.maxHealth).toBe(PLAYER.MAX_HEALTH);
    expect(config.match.maxPlayers).toBe(10);
    expect(config.match.minPlayers).toBe(MATCH.MIN_PLAYERS);
  });

  it('getPlayerState finds a player by sessionId', async () => {
    const room = await createRoom(server, { matchId: 'get-player-test' });
    const client = await connectClient(server, room, { name: 'Finder' });
    const player = getPlayerState(room, client.sessionId);
    expect(player).toBeDefined();
    expect(player!.name).toBe('Finder');
  });

  it('getPlayerState returns undefined for unknown sessionId', async () => {
    const room = await createRoom(server, { matchId: 'unknown-player' });
    const player = getPlayerState(room, 'nonexistent-id');
    expect(player).toBeUndefined();
  });
});

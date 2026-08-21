
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../../helpers/test-server';
import { createGameRoom } from '../../helpers/game-room-helper';
import type { GameStateSchema } from '../../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../../src/room/GameRoom';

let server: ColyseusTestServer;
beforeAll(async () => { server = await createTestServer(); });
afterAll(async () => { await cleanup(server); });

describe('Bot Spawn Debug', () => {
  it('checks if bots spawn at all', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 3,
      matchId: `debug-${Date.now()}`,
    });

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;

    // Check domain model directly
    console.log('=== Tick 0 ===');
    console.log('room.state.players.size:', room.state.players.size);
    console.log('domain match players:', [...orch.match.getState().players.entries()].map(([k, v]: any) => ({ id: k, name: v.name, isBot: v.isBot })));
    console.log('botManager.botIds:', gameRoom.botManager?.botIds?.size);
    console.log('botSystem bots size:', orch.simulation.botSystem?.bots?.size);

    await helper.advanceTicks(100);
    console.log('\n=== After 100 ticks ===');
    console.log('room.state.players.size:', room.state.players.size);
    console.log('domain match players:', [...orch.match.getState().players.entries()].map(([k, v]: any) => ({ id: k, name: v.name, isBot: v.isBot })));
    console.log('botManager.botIds:', gameRoom.botManager?.botIds?.size);
    console.log('botSystem bots size:', orch.simulation.botSystem?.bots?.size);

    await helper.advanceTicks(200);
    console.log('\n=== After 300 ticks ===');
    console.log('room.state.players.size:', room.state.players.size);
    console.log('domain match players:', [...orch.match.getState().players.entries()].map(([k, v]: any) => ({ id: k, name: v.name, isBot: v.isBot })));
    console.log('botManager.botIds:', gameRoom.botManager?.botIds?.size);
    console.log('botSystem bots size:', orch.simulation.botSystem?.bots?.size);

    await helper.advanceTicks(200);
    console.log('\n=== After 500 ticks ===');
    console.log('room.state.players.size:', room.state.players.size);
    console.log('domain match players count:', [...orch.match.getState().players.entries()].length);
    console.log('botManager.botIds:', gameRoom.botManager?.botIds?.size);
    console.log('botSystem bots size:', orch.simulation.botSystem?.bots?.size);

    expect(true).toBe(true);
  }, 60_000);
});


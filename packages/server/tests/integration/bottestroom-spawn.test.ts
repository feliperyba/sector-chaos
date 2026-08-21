import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Server } from 'colyseus';
import { ColyseusTestServer } from '@colyseus/testing';
import { Encoder } from '@colyseus/schema';
import { BotTestRoom } from '../../src/room/BotTestRoom';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';

Encoder.BUFFER_SIZE = 128 * 1024;

let server: ColyseusTestServer;

beforeAll(async () => {
  const app = new Server();
  app.define('bot-e2e', BotTestRoom);
  await app.listen(0);
  const transport = (app as unknown as { transport?: { server?: { address(): { port: number } } } })
    .transport;
  const address = transport?.server?.address();
  if (address) {
    (app as unknown as { port: number }).port = address.port;
  }
  server = new ColyseusTestServer(app);
});

afterAll(async () => {
  await server.cleanup();
  await server.shutdown();
});

describe('BotTestRoom Spawn Distribution', () => {
  it('bots spawn at unique, spread positions', async () => {
    const room = await server.createRoom<{ state: GameStateSchema }>('bot-e2e', {
      botCount: 20,
      difficulty: 'normal',
      mapId: 'test',
      debug: false,
    });

    // Wait for all bots to spawn
    await new Promise((r) => setTimeout(r, 6000));

    const orch = (room as any).orchestrator;
    const match = orch.match;

    const positions: { id: string; x: number; y: number }[] = [];
    match.forEachAlivePlayer((p: any) => {
      positions.push({
        id: p.id,
        x: Math.round(p.movement.position.x),
        y: Math.round(p.movement.position.y),
      });
    });

    console.log(`BotTestRoom: ${positions.length} players`);
    for (const p of positions.slice(0, 10)) {
      console.log(`  ${p.id}: (${p.x}, ${p.y})`);
    }

    expect(positions.length).toBeGreaterThan(1);

    // No duplicates
    const posKeys = new Set<string>();
    for (const p of positions) {
      const key = `${p.x},${p.y}`;
      if (posKeys.has(key)) {
        console.error(`DUPLICATE POSITION: ${key} (${p.id})`);
      }
      expect(posKeys.has(key)).toBe(false);
      posKeys.add(key);
    }

    room.disconnect();
  }, 30_000);
});

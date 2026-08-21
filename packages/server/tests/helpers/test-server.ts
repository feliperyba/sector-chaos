import { Server, type Room } from 'colyseus';
import { ColyseusTestServer } from '@colyseus/testing';
import { Encoder } from '@colyseus/schema';
import { NETWORK } from '@sector-battle/shared';
import { GameRoom } from '../../src/room/GameRoom.ts';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema.ts';
import type { DifficultyLevel } from '../../src/ai/BotManager.ts';

Encoder.BUFFER_SIZE = 128 * 1024;

export type TestClient = Awaited<ReturnType<ColyseusTestServer['connectTo']>>;

interface CreateRoomOptions {
  matchId?: string;
  seed?: number;
  botFillTo?: number;
  botDifficulty?: DifficultyLevel;
  mapType?: 'procedural' | 'demo';
  config?: unknown;
}

interface ConnectClientOptions {
  token?: string;
  name?: string;
}

let globalClientCounter = 1;

interface AddressInfoLike {
  port: number;
}

/**
 * Boot a Colyseus {@link Server} on an OS-assigned ephemeral port.
 *
 * `@colyseus/testing`'s `boot()` hardcodes port 2568 for `Server` instances, so
 * every test file that boots its own server collides on that port (EADDRINUSE).
 * We listen manually on port 0, read back the assigned port, and patch it onto
 * the server so {@link ColyseusTestServer} (which reads `server.port`) targets
 * the right endpoint.
 */
export async function bootTestServer(app: Server): Promise<ColyseusTestServer> {
  await app.listen(0);
  const transport = (
    app as unknown as {
      transport?: { server?: { address(): AddressInfoLike | null } };
    }
  ).transport;
  const address = transport?.server?.address();
  if (address) {
    (app as unknown as { port: number }).port = address.port;
  }
  return new ColyseusTestServer(app);
}

export async function createTestServer(): Promise<ColyseusTestServer> {
  const app = new Server();
  app.define('game', GameRoom);
  return bootTestServer(app);
}

export async function createRoom(
  server: ColyseusTestServer,
  options: CreateRoomOptions = {},
): Promise<Room<{ state: GameStateSchema }>> {
  const room = await server.createRoom<{ state: GameStateSchema }>('game', {
    matchId: options.matchId ?? `test-${Date.now()}`,
    seed: options.seed ?? 42,
    botFillTo: options.botFillTo ?? 0,
    botDifficulty: options.botDifficulty,
    mapType: options.mapType,
    config: options.config,
  });
  // Wait for enough simulation ticks that at least one `syncState()` has run
  // via the snapshot sink. The sink batches: it only projects domain→schema
  // every `syncEveryN = ceil(TICK_RATE / PATCH_RATE)` ticks. With PATCH_RATE
  // decoupled from TICK_RATE (30 vs 60), syncEveryN is 2, so a single tick is
  // no longer enough to guarantee the schema reflects the post-start phase
  // transition. Waiting `syncEveryN` ticks ensures at least one projection
  // (the first tick starts the orchestrator + runs the snapshot sink counter
  // to 1; the second trips the sync).
  const syncEveryN = Math.max(1, Math.round(NETWORK.TICK_RATE / NETWORK.PATCH_RATE));
  for (let i = 0; i < syncEveryN; i++) {
    await room.waitForNextSimulationTick();
  }
  return room;
}

export async function connectClient(
  server: ColyseusTestServer,
  room: Room,
  options: ConnectClientOptions = {},
): Promise<TestClient> {
  const index = globalClientCounter++;
  const client = await server.connectTo(room, {
    token: options.token ?? `test-token-${String(index).padStart(5, '0')}`,
    name: options.name ?? `Player${index}`,
  });
  await room.waitForNextPatch();
  return client;
}

interface HttpServerLike {
  listening: boolean;
  close(callback: () => void): void;
}

function getUnderlyingHttpServer(server: ColyseusTestServer): HttpServerLike | undefined {
  const colyseusServer = (server as unknown as { server?: unknown }).server;
  if (!colyseusServer) return undefined;
  const transport = (colyseusServer as { transport?: unknown }).transport;
  if (!transport) return undefined;
  const http = (transport as { server?: unknown }).server;
  if (
    http &&
    typeof http === 'object' &&
    'listening' in (http as object) &&
    'close' in (http as object)
  ) {
    return http as HttpServerLike;
  }
  return undefined;
}

export async function cleanup(server?: ColyseusTestServer): Promise<void> {
  if (!server) return;
  await server.cleanup();
  const http = getUnderlyingHttpServer(server);
  await server.shutdown();
  if (http?.listening) {
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
    });
  }
}

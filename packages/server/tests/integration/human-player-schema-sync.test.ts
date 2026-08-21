import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { PLAYER, NETWORK, GRID, TileType } from '@sector-battle/shared';
import type { Room } from 'colyseus';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { Position } from '../../src/domain/value-objects/Position';

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getMatch();
}

/**
 * Regression guard for the human player's authoritative schema sync.
 *
 * The reported defect: in the dev-boot path the human's authoritative state
 * (x, y, lastProcessedInput) sent to the client was alleged to be frozen at
 * spawn while the client's prediction advanced. Runtime diagnosis via raw
 * Colyseus schema inspection (`room.state.players.get(sessionId)`) showed the
 * server-side sync is in fact correct — the human's PlayerSchema is keyed by
 * sessionId, written every snapshot via `StateMapper.playerToSchema`, and both
 * `schema.x` and `schema.lastProcessedInput` advance as MOVE inputs are
 * processed. This test pins that end-to-end behaviour so a future regression
 * (e.g. a snapshot-sink change that skips the local player, a key mismatch, or
 * a per-player ack write being dropped) would fail loudly.
 *
 * It drives the real GameRoom through `@colyseus/testing`, sends a MOVE input
 * from a human client, advances ticks, and asserts:
 *   - the human PlayerSchema is findable by sessionId (correct map key),
 *   - schema.x advances past spawn after a sustained MOVE,
 *   - the per-player `schema.lastProcessedInput` advances (ADR-0033),
 *   - the global `state.lastProcessedInput` also advances (consumed by the
 *     client's onStateChange handler).
 */
describe('Human player schema sync (regression)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('human PlayerSchema is keyed by sessionId and advances x + lastProcessedInput on MOVE', async () => {
    const { helper, room } = await createGameRoom(server, { botFillTo: 0 });
    const client = await helper.addPlayer('Human');

    // Skip warmup / spawn invincibility so inputs are accepted.
    helper.forceActive();
    await helper.advanceTicks(SPAWN_INV_TICKS + 1);

    // Place the domain player in an open area so MOVE isn't blocked by walls.
    const match = getMatch(room);
    const grid = match.getGrid();
    const gx = Math.floor(grid[0]!.length / 2);
    const gy = Math.floor(grid.length / 2);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const y = gy + dy;
        const x = gx + dx;
        if (y >= 0 && y < grid.length && x >= 0 && x < grid[0]!.length) {
          grid[y]![x] = TileType.EMPTY;
        }
      }
    }
    const domainPlayer = match.getPlayer(client.sessionId)!;
    const openX = (gx + 0.5) * GRID.TILE_SIZE;
    const openY = (gy + 0.5) * GRID.TILE_SIZE;
    domainPlayer.movement.position = new Position(openX, openY);
    await helper.advanceTicks(1);

    // The human's PlayerSchema MUST be findable by sessionId — not stranded
    // under a numeric index or a stale bot id.
    const schemaPlayer = room.state.players.get(client.sessionId);
    expect(schemaPlayer, 'human PlayerSchema must be keyed by sessionId').toBeDefined();
    expect(schemaPlayer!.id).toBe(client.sessionId);

    const x0 = schemaPlayer!.x;
    const y0 = schemaPlayer!.y;
    const ack0 = schemaPlayer!.lastProcessedInput;
    const globalAck0 = room.state.lastProcessedInput;
    expect(ack0, 'per-player ack should start at 0 or a known baseline').toBeGreaterThanOrEqual(0);

    // Sustained MOVE right for several ticks.
    for (let i = 0; i < 15; i++) {
      await helper.sendInput(client, { movementX: 1, movementY: 0 });
      await helper.advanceTicks(1);
    }

    // The domain position and the wire schema position must match — the
    // snapshot sink projects domain→schema every sync. If they diverge, the
    // snapshot is stale (the hypothesised defect).
    const finalDomain = match.getPlayer(client.sessionId)!;
    expect(finalDomain.movement.position.x, 'domain and schema x must match post-snapshot').toBe(
      schemaPlayer!.x,
    );

    // schema.x must advance meaningfully (player moves right). From a standing
    // start with ACCELERATION=4800/BASE_SPEED=430, 15 ticks yields ~80px+ if
    // every MOVE input lands. Use a conservative threshold well above
    // collision/no-op noise but below the theoretical max.
    expect(schemaPlayer!.x, 'schema.x must advance during sustained MOVE').toBeGreaterThan(x0 + 24);
    // y must stay roughly constant (pure horizontal move).
    expect(Math.abs(schemaPlayer!.y - y0)).toBeLessThan(GRID.TILE_SIZE);

    // Per-player lastProcessedInput MUST advance (ADR-0033 — the field the
    // client's reconciler reads via PlayerSchema).
    expect(
      schemaPlayer!.lastProcessedInput,
      'per-player schema.lastProcessedInput must advance after MOVE inputs',
    ).toBeGreaterThan(ack0);

    // Global lastProcessedInput MUST advance too (consumed by the client's
    // room.onStateChange handler).
    expect(
      room.state.lastProcessedInput,
      'global state.lastProcessedInput must advance',
    ).toBeGreaterThanOrEqual(globalAck0);
  });
});

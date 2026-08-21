import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { PLAYER, NETWORK, GRID, TileType, MATCH, MatchPhase } from '@sector-battle/shared';
import type { Room } from 'colyseus';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom, GameRoomHelper } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch';
import { Position } from '../../src/domain/value-objects/Position';

const SPAWN_INV_TICKS = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * NETWORK.TICK_RATE);
const COUNTDOWN_TICKS = Math.ceil(MATCH.COUNTDOWN_DURATION * NETWORK.TICK_RATE);

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getMatch();
}

function getDomainPlayer(room: Room<{ state: GameStateSchema }>, sessionId: string) {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getPlayer(sessionId)!;
}

/**
 * Regression tests for the human-specific movement defect ("ghost/floaty
 * movement").
 *
 * ROOT CAUSE: `step1_ProcessInputs` returned early during non-input-allowed
 * phases (WAITING/COUNTDOWN) WITHOUT dequeuing the current tick's input
 * bucket. Every MOVE input a human client sent during countdown piled up in a
 * per-tick bucket that was never drained (dequeueTick only returns the
 * current tick, and step1 had already returned), so the inputs were silently
 * lost. The client's unacked input buffer saturated at its cap (120), its
 * continuously-running prediction raced ahead of a server that had never
 * seen the inputs, and each server snapshot yanked the player back to spawn
 * — the ghost/floaty feel. Bots were unaffected (BotSystem only emits inputs
 * while the match is ACTIVE).
 *
 * FIX: step1 now ALWAYS drains the current tick's bucket. During a
 * non-input-allowed phase it advances `lastProcessedInput` (so the client
 * learns its inputs were consumed and drops them from its reconciliation
 * buffer) but does NOT apply movement/attacks (game rule: frozen during
 * countdown).
 *
 * These tests drive the REAL `'input'` message path (`client.send('input')`
 * delivered by @colyseus/testing to the room's onMessage('input') handler) +
 * the room's real simulation interval (`room.waitForNextSimulationTick`).
 * They do NOT call `orchestrator.handleInput` directly — the prior
 * regression guard (`human-player-schema-sync.test.ts`) did and so missed
 * the defect.
 */
describe('Human movement via real input message path (regression)', () => {
  let server: ColyseusTestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('MOVE inputs sent during COUNTDOWN are acked (lpi advances) but do not move the player', async () => {
    const { helper, room } = await createGameRoom(server, { botFillTo: 0 });
    const client = await helper.addPlayer('Human');

    // Do NOT call forceActive — let the room transition WAITING→COUNTDOWN
    // naturally so we exercise the countdown input-drain path. Run a few real
    // ticks so onCreate→onJoin→start() has fired and the room is in COUNTDOWN.
    for (let i = 0; i < 4; i++) {
      await room.waitForNextSimulationTick();
    }

    const phaseNow = room.state.phase;
    // The room should be in (or just past) COUNTDOWN. If the human joined
    // slowly and ACTIVE already began, this test is a no-op pass; in practice
    // the 5s countdown is far longer than the join time.
    const inCountdown = phaseNow === MatchPhase.COUNTDOWN || phaseNow === MatchPhase.WAITING;

    const domainPlayer = getDomainPlayer(room, client.sessionId);
    const x0 = domainPlayer.movement.position.x;
    const ack0 = domainPlayer.lastProcessedInput;

    // Send several MOVE inputs via the REAL 'input' message path during the
    // non-input-allowed phase. Before the fix these were silently dropped
    // (lpi stayed flat and inputs piled up in the queue).
    let seq = 1;
    for (let i = 0; i < 8; i++) {
      client.send('input', {
        movementX: 1,
        movementY: 0,
        aimAngle: 0,
        sequence: seq++,
        actions: [],
      });
      await room.waitForNextSimulationTick();
    }

    const ackAfter = domainPlayer.lastProcessedInput;

    if (inCountdown) {
      // The fix: even though the phase forbids movement, the inputs must be
      // consumed + acked (lpi advances) so the client's reconciliation buffer
      // doesn't retain them. Before the fix this stayed at ack0.
      expect(
        ackAfter,
        'lastProcessedInput must advance during countdown (inputs drained+acked)',
      ).toBeGreaterThan(ack0);

      // But the player must NOT have moved — movement is correctly forbidden
      // during countdown (server-authoritative game rule).
      expect(
        Math.abs(domainPlayer.movement.position.x - x0),
        'player must not move during countdown',
      ).toBeLessThan(1);
    }
  }, 30000);

  it('human domain position accumulates during ACTIVE MOVE sent via client.send("input")', async () => {
    const { helper, room } = await createGameRoom(server, { botFillTo: 0 });
    const client = await helper.addPlayer('Human');

    // Skip warmup / spawn invincibility so MOVE inputs are accepted.
    helper.forceActive();
    for (let i = 0; i < SPAWN_INV_TICKS + 1; i++) {
      await room.waitForNextSimulationTick();
    }

    // Place the domain player in an open corridor so MOVE isn't blocked.
    const match = getMatch(room);
    const grid = match.getGrid();
    const gx = Math.floor(grid[0]!.length / 2);
    const gy = Math.floor(grid.length / 2);
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx < 40; dx++) {
        const y = gy + dy;
        const x = gx + dx;
        if (y >= 0 && y < grid.length && x >= 0 && x < grid[0]!.length) {
          grid[y]![x] = TileType.EMPTY;
        }
      }
    }
    // Clear entities so explosions/knockback can't inflate displacement.
    const ents = match.getState();
    ents.destructibles.clear();
    ents.traps.clear();
    ents.chests.clear();
    ents.weaponPickups.clear();
    ents.powerUps.clear();
    ents.explosions.clear();
    ents.projectiles.clear();

    const domainPlayer = getDomainPlayer(room, client.sessionId);
    const openX = (gx + 0.5) * GRID.TILE_SIZE;
    const openY = (gy + 0.5) * GRID.TILE_SIZE;
    domainPlayer.movement.position = new Position(openX, openY);
    await room.waitForNextSimulationTick();
    await room.waitForNextSimulationTick();

    const x0 = domainPlayer.movement.position.x;

    // Sustained MOVE right via the REAL 'input' message path.
    let seq = 1;
    for (let i = 0; i < 30; i++) {
      client.send('input', {
        movementX: 1,
        movementY: 0,
        aimAngle: 0,
        sequence: seq++,
        actions: [],
      });
      await room.waitForNextSimulationTick();
    }
    await room.waitForNextSimulationTick();

    const finalDomain = getDomainPlayer(room, client.sessionId);
    const deltaX = finalDomain.movement.position.x - x0;

    // BASE_SPEED=430, ACCELERATION=4800, 30 ticks from standing → ~200px.
    expect(deltaX, 'human domain x must accumulate during sustained MOVE').toBeGreaterThan(150);
    expect(deltaX, 'displacement bounded — no knockback inflation').toBeLessThan(400);

    // Schema (wire) must track domain. The room projects domain → schema every
    // syncEveryN(=2) sim steps on its real interval, and waitForNextSimulationTick
    // is a bare setTimeout that can resolve BETWEEN projections — under
    // parallel-worker load the last awaited "tick" then leaves the schema one
    // 7.17px step stale (observed flake). Force a projection before reading
    // (same pattern as GameRoomHelper.advanceTicks' trailing syncState): the
    // assertion verifies the PROJECTION is faithful, which is the behavior
    // under test — not the batching cadence.
    ;(room as unknown as GameRoom).syncState();
    const schemaPlayer = room.state.players.get(client.sessionId);
    expect(schemaPlayer, 'human schema must be keyed by sessionId').toBeDefined();
    expect(schemaPlayer!.x, 'schema.x must track domain x').toBe(finalDomain.movement.position.x);

    // lastProcessedInput advanced.
    expect(
      schemaPlayer!.lastProcessedInput,
      'per-player lastProcessedInput must advance',
    ).toBeGreaterThan(0);
  }, 30000);
});

// Exported for any future test that needs the countdown tick count.
export { COUNTDOWN_TICKS };

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import { MatchPhase } from '@sector-battle/shared';

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await cleanup(server);
});

function forceActivePhase(room: any) {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  orch.setLastStandingThreshold(-1);
  orch.matchEndedEmitted = false;
  const cur = orch.matchFlow.getCurrentState().phase;
  if (cur === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  if (orch.matchFlow.getCurrentState().phase !== MatchPhase.ACTIVE) {
    orch.matchFlow.phase = MatchPhase.ACTIVE;
    orch.matchFlow.phaseElapsedMs = 0;
  }
  orch.match.forEachAlivePlayer((p: { id: string }) => {
    if (!orch.matchFlow.alivePlayerIds.has(p.id)) orch.matchFlow.alivePlayerIds.add(p.id);
    if (!orch.matchFlow.playerIds.includes(p.id)) orch.matchFlow.playerIds.push(p.id);
  });
  orch.phase = MatchPhase.ACTIVE;
  orch.match.phase = MatchPhase.ACTIVE;
  gameRoom.syncState();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TILE = 128;

describe('Spawn Diagnostics', () => {
  it('checks walkability at every bot spawn position', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 64,
      mapType: 'procedural',
      seed: 1337,
    });

    await helper.addPlayer('Diag');
    forceActivePhase(room);
    await sleep(7000);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.getMatch();
    const botSystem = orch.simulation.botSystem;
    const pathfinder = (gameRoom as any).pathfinder;
    const grid = match.getGrid();
    const mapW = grid[0]?.length ?? 0;
    const mapH = grid.length ?? 0;

    const bots = match.getPlayers().filter((p: any) => p.isBot);
    let walkable = 0,
      blocked = 0,
      edgeSpawn = 0;

    console.log(`\n=== ${bots.length} bots, Map ${mapW}×${mapH} ===`);

    for (const bot of bots) {
      const pos = bot.movement?.position;
      if (!pos) continue;
      const gx = Math.floor(pos.x / TILE);
      const gy = Math.floor(pos.y / TILE);

      // Check grid walkability at spawn
      const tile = grid[gy]?.[gx];
      const isWalkableGrid = tile === 0 || tile === 2; // EMPTY or EXIT

      // Check pathfinder walkability
      const isWalkablePF = pathfinder?.isWalkable?.(gx, gy) ?? 'N/A';

      // Check if spawn is at map edge (within 2 tiles of border)
      const isEdge = gx < 2 || gy < 2 || gx >= mapW - 2 || gy >= mapH - 2;
      if (isEdge) edgeSpawn++;

      // Count walkable neighbors (8-directional)
      let walkableNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nt = grid[gy + dy]?.[gx + dx];
          if (nt === 0 || nt === 2) walkableNeighbors++;
        }
      }

      if (!isWalkableGrid || walkableNeighbors === 0) {
        blocked++;
        console.log(
          `  BLOCKED: ${bot.id.slice(-6)} pos:(${pos.x.toFixed(0)},${pos.y.toFixed(0)}) grid:(${gx},${gy}) tile:${tile} pfWalkable:${isWalkablePF} neighbors:${walkableNeighbors} edge:${isEdge}`,
        );
      } else {
        walkable++;
      }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`  Total: ${bots.length}`);
    console.log(`  Walkable spawn: ${walkable}`);
    console.log(`  Blocked spawn: ${blocked}`);
    console.log(`  Edge spawns: ${edgeSpawn}`);
    console.log(`  BotSystem registered: ${(botSystem as any).bots?.size ?? 'N/A'}`);

    expect(bots.length).toBeGreaterThan(0);
  }, 20_000);
});

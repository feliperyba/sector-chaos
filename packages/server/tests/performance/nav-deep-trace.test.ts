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

describe('Navigation Deep Trace', () => {
  it('traces A* pathfinding for stuck bots', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 8,
      mapType: 'procedural',
      seed: 1337,
    });

    await helper.addPlayer('Nav');
    forceActivePhase(room);
    await sleep(6000);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.getMatch();
    const botSystem = orch.simulation.botSystem;
    const pathfinder = (gameRoom as any).pathfinder;
    const grid = match.getGrid();
    const mapW = grid[0]?.length ?? 0;
    const mapH = grid.length ?? 0;

    const bots = match.getPlayers().filter((p: any) => p.isBot);
    console.log(`\n${bots.length} bots, map ${mapW}×${mapH}`);

    // For each bot, test pathfinding to map center
    const centerX = Math.floor(mapW / 2) * TILE;
    const centerY = Math.floor(mapH / 2) * TILE;

    for (const bot of bots) {
      const pos = bot.movement.position;
      const botGridX = Math.floor(pos.x / TILE);
      const botGridY = Math.floor(pos.y / TILE);
      const targetGridX = Math.floor(centerX / TILE);
      const targetGridY = Math.floor(centerY / TILE);

      const botWalkable = pathfinder.isWalkable(botGridX, botGridY);
      const targetWalkable = pathfinder.isWalkable(targetGridX, targetGridY);

      // Try A* from bot to center
      const path = pathfinder.findPath({ x: pos.x, y: pos.y }, { x: centerX, y: centerY });

      const entry = botSystem.bots.get(bot.id);
      const goal = entry?.context?.movementGoal;
      const pathToTarget = entry?.context?.pathToTarget;

      console.log(
        `\nBot ${bot.id.slice(-6)}: pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)}) grid=(${botGridX},${botGridY})`,
      );
      console.log(`  botWalkable: ${botWalkable}, targetWalkable: ${targetWalkable}`);
      console.log(
        `  goal: ${goal?.type} → (${goal?.target?.x?.toFixed(0)},${goal?.target?.y?.toFixed(0)})`,
      );
      console.log(`  A* path to center: ${path ? `${path.length} waypoints` : 'NULL'}`);
      if (path && path.length >= 2) {
        console.log(
          `    wp[0]: (${path[0].x.toFixed(0)},${path[0].y.toFixed(0)}) wp[1]: (${path[1].x.toFixed(0)},${path[1].y.toFixed(0)})`,
        );
      }
      console.log(`  pathToTarget: ${pathToTarget?.length ?? 0} waypoints`);

      // Check 8 neighbors for walls
      const neighbors: string[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const w = pathfinder.isWalkable(botGridX + dx, botGridY + dy);
          neighbors.push(`(${dx},${dy}):${w ? 'W' : '#'} `);
        }
      }
      console.log(`  neighbors: ${neighbors.join('')}`);
    }

    expect(bots.length).toBeGreaterThan(0);
  }, 20_000);
});

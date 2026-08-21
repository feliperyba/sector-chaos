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

describe('Bot Movement Trace', () => {
  it('checks if bots produce ANY movement inputs', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 4,
      mapType: 'demo',
      seed: 42,
    });

    // Connect human FIRST, before bots spawn, to prevent match auto-ending
    await helper.addPlayer('Trace');
    forceActivePhase(room);

    // NOW wait for bot spawn timers to fire
    await sleep(5500);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.getMatch();
    const sim = orch.getSimulation();
    const botSystem = orch.simulation.botSystem;
    console.log(`\nsim.botSystem type: ${botSystem?.constructor?.name}`);
    console.log(`sim.botSystem.bots.size: ${(botSystem as any)?.bots?.size ?? 'undefined'}`);
    const botMgr = (gameRoom as any).botManager;
    console.log(
      `gameRoom.botManager.botIds.size: ${botMgr?.botIds?.size ?? 'N/A'}, getBotCount: ${botMgr?.getBotCount?.() ?? 'N/A'}`,
    );

    const bots = match.getPlayers().filter((p: any) => p.isBot);
    console.log(`\n${bots.length} bots registered`);

    // Check grid walkability at spawn positions
    const grid = match.getGrid();
    const TILE = 128;
    for (const bot of bots) {
      const pos = bot.movement.position;
      const gx = Math.floor(pos.x / TILE);
      const gy = Math.floor(pos.y / TILE);
      const tile = grid[gy]?.[gx];
      const tileType =
        tile === 0 ? 'EMPTY' : tile === 1 ? 'WALL' : tile === 2 ? 'EXIT' : `TILE_${tile}`;

      // Check 8 neighbors
      const neighbors: string[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nt = grid[gy + dy]?.[gx + dx];
          neighbors.push(`(${dx},${dy}):${nt === 0 ? 'E' : nt === 1 ? 'W' : nt === 2 ? 'X' : nt}`);
        }
      }

      console.log(
        `Bot ${bot.id.slice(-6)} spawn: (${pos.x.toFixed(0)},${pos.y.toFixed(0)}) grid:(${gx},${gy}) tile:${tileType}`,
      );
      console.log(`  Neighbors: ${neighbors.join(' ')}`);

      // Check if bot entry exists in botSystem
      const entry = (botSystem as any).bots?.get(bot.id);
      console.log(`  botSystem.bots.size = ${(botSystem as any).bots?.size ?? 'undefined'}`);
      if (entry) {
        console.log(
          `  BotEntry: tickInterval=${entry.tickInterval} perceptionPhase=${entry.perceptionPhase}`,
        );
        console.log(
          `  Context: goal=${entry.context?.movementGoal?.type} pos=(${entry.context?.position?.x?.toFixed(0)},${entry.context?.position?.y?.toFixed(0)})`,
        );
        console.log(`  nearbyDestructibles: ${entry.context?.nearbyDestructibles?.length ?? 0}`);
        console.log(`  nearbyPlayers: ${entry.context?.nearbyPlayers?.length ?? 0}`);
        console.log(`  globalWeapons: ${entry.context?.globalWeapons?.length ?? 0}`);
      } else {
        console.log(`  BotEntry: NOT FOUND in botSystem.bots`);
      }
    }

    // Advance 120 ticks and trace
    let inputCount = 0;
    const positionsBefore = new Map<string, { x: number; y: number }>();
    for (const bot of bots) {
      positionsBefore.set(bot.id, { x: bot.movement.position.x, y: bot.movement.position.y });
    }

    await helper.advanceTicks(120);
    gameRoom.syncState();

    for (const bot of bots) {
      const p = match.getPlayer(bot.id);
      if (!p) continue;
      const before = positionsBefore.get(bot.id)!;
      const after = p.movement.position;
      const dist = Math.hypot(after.x - before.x, after.y - before.y);
      const entry = (botSystem as any).bots?.get(bot.id);
      const ctx = entry?.context;
      console.log(`\nBot ${bot.id.slice(-6)} after 120 ticks:`);
      console.log(`  Distance moved: ${dist.toFixed(1)}px`);
      console.log(`  Position: (${after.x.toFixed(0)},${after.y.toFixed(0)})`);
      console.log(`  Goal: ${ctx?.movementGoal?.type}`);
      console.log(
        `  VelX: ${p.movement.velocityX?.toFixed(1)} VelY: ${p.movement.velocityY?.toFixed(1)}`,
      );
      console.log(`  Status: alive=${p.isAlive()} health=${p.health?.current}`);
    }

    expect(bots.length).toBeGreaterThan(0);
  }, 15_000);
});

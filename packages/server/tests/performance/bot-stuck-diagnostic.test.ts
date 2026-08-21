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

describe('Bot Stuck Diagnostic', () => {
  it('traces why bots get stuck at spawn', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 4,
      mapType: 'demo',
      seed: 42,
    });

    await sleep(3500); // wait for 4 bots to spawn
    await helper.addPlayer('DiagHuman');
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.getMatch();
    const botSystem = orch.simulation.botSystem;

    // Get bots via domain match
    const bots = match.getPlayers().filter((p: any) => p.isBot);
    console.log(`\n=== ${bots.length} bots ===`);

    // Trace positions every 30 ticks for 300 ticks
    for (let phase = 0; phase <= 10; phase++) {
      await helper.advanceTicks(30);
      gameRoom.syncState();

      console.log(`\n--- Tick ${(phase + 1) * 30} ---`);
      for (const bot of bots) {
        const p = match.getPlayer(bot.id);
        if (!p) {
          console.log(`  ${bot.id.slice(-6)}: GONE`);
          continue;
        }
        const pos = p.movement?.position;
        const goal = (botSystem as any).bots?.get(bot.id);
        const ctx = goal?.context;
        const moveGoal = ctx?.movementGoal;
        const stuck = ctx?.getBlackboard?.('_seekStuckCount') ?? 'N/A';
        const behavior = ctx?.lastBehaviorName ?? 'N/A';
        console.log(
          `  ${bot.id.slice(-6)}: pos:(${pos?.x?.toFixed(0)},${pos?.y?.toFixed(0)}) ` +
            `HP:${p.health?.current} alive:${p.isAlive()} ` +
            `goal:${moveGoal?.type ?? '?'} ` +
            `stuck:${stuck} behavior:${behavior}`,
        );
      }
    }
    expect(bots.length).toBeGreaterThan(0);
  }, 20_000);
});

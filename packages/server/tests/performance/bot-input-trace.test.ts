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

describe('Bot Input Pipeline Trace', () => {
  it('traces bot inputs from BotSystem through to PlayerMovement', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 8,
      mapType: 'procedural',
      seed: 1337,
    });

    await helper.addPlayer('Trace');
    forceActivePhase(room);
    await sleep(6000);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.getMatch();
    const sim = orch.getSimulation();
    const botSystem = sim.botSystem;

    const bots = match.getPlayers().filter((p: any) => p.isBot);
    console.log(`\n${bots.length} bots, botSystem.bots.size = ${botSystem.bots.size}`);

    if (bots.length === 0) {
      expect(true).toBe(true);
      return;
    }

    // Pick 2 bots: one that will likely move and one that might be stuck
    const bot0 = bots[0];
    const bot1 = bots[Math.min(1, bots.length - 1)];

    for (const testBot of [bot0, bot1]) {
      const id = testBot.id;
      const pos0 = { x: testBot.movement.position.x, y: testBot.movement.position.y };

      // Check bot entry
      const entry = botSystem.bots.get(id);
      if (!entry) {
        console.log(`\nBot ${id.slice(-6)}: NOT IN botSystem — skipping`);
        continue;
      }

      // Check player state
      const player = match.getPlayer(id);
      console.log(`\nBot ${id.slice(-6)}:`);
      console.log(`  pos: (${pos0.x.toFixed(0)}, ${pos0.y.toFixed(0)})`);
      console.log(`  connectionState: ${player?.connectionState}`);
      console.log(`  inputSuppressed: ${player?.inputSuppressed}`);
      console.log(`  isActive: ${player?.isActive}`);
      console.log(`  isAlive: ${player?.isAlive()}`);
      console.log(`  status: ${player?.statusEffects?.status}`);
      // BotContext is the entry itself (no nested .context). Current navigation
      // goal is captured by ctx.state (BotState) + path/wander target coords.
      console.log(
        `  botState: ${entry.state} pathTarget=(${entry.pathTargetX.toFixed(0)},${entry.pathTargetY.toFixed(0)})`,
      );
      console.log(`  facingAngle: ${player?.movement?.facingAngle?.toFixed(2)}`);

      // Advance 30 ticks and check
      await helper.advanceTicks(30);
      gameRoom.syncState();

      const after = match.getPlayer(id);
      if (!after) {
        console.log(`  GONE after 30 ticks`);
        continue;
      }
      const pos30 = after.movement.position;
      const dist = Math.hypot(pos30.x - pos0.x, pos30.y - pos0.y);
      console.log(
        `  After 30 ticks: pos=(${pos30.x.toFixed(0)},${pos30.y.toFixed(0)}) dist=${dist.toFixed(1)}px`,
      );
      console.log(
        `  velocity: (${after.movement.velocityX.toFixed(1)}, ${after.movement.velocityY.toFixed(1)})`,
      );
      console.log(`  isAlive: ${after.isAlive()}`);
      console.log(`  status: ${after.statusEffects?.status}`);
    }

    // Now check: does botSystem.tick() actually produce inputs?
    const tickBefore = match.currentTick;
    const inputs = botSystem.tick(tickBefore + 1);
    console.log(`\nBotSystem.tick(${tickBefore + 1}) produced ${inputs.length} inputs`);
    for (const input of inputs.slice(0, 5)) {
      const p = match.getPlayer(input.playerId);
      console.log(
        `  Input: player=${input.playerId.slice(-6)} action=${input.action} dx=${(input.data as any)?.dx?.toFixed(2)} dy=${(input.data as any)?.dy?.toFixed(2)} serverTick=${input.serverTick}`,
      );
    }

    // Check input queue
    const queue = sim.inputQueue;
    const queueSize = queue.size?.() ?? (queue as any)._queue?.length ?? 'unknown';
    console.log(`\nInputQueue size: ${queueSize}`);

    expect(bots.length).toBeGreaterThan(0);
  }, 20_000);
});

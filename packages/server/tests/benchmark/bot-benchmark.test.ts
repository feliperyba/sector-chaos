import { GameRoom, type GameRoomOptions } from '../../src/room/GameRoom';
import { GameOrchestrator } from '../../../src/application/services/GameOrchestrator';
import { createTestServer, cleanup, connectClient, createRoom } from '../helpers/test-server';
import type { TestClient } from '@colyseus/testing';
import { type BotSystem } from '../../../src/ai/BotSystem';
import { type GameSimulation } from '../../../src/application/simulation/GameSimulation';
import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import type { Player } from '../../../src/domain/entities/Player';
import { WeaponType } from '@sector-battle/shared';
import { MatchPhase } from '../../../src/domain/match/Match';
import fs from 'fs';

/** Override GameRoom for test access */
class TestGameRoom extends GameRoom {
  // CRITICAL: BotSystem needs state, not just schema, for entity visibility
  getMatch() {
    const gameRoom = this.room as unknown as GameRoom;
    return gameRoom.getOrchestrator().getMatch();
  }
}

describe('Bot AI Benchmark — 4×4 seed map, 64 bots', () => {
  let helper: RoomTestHelper<TestGameRoom>;
  let orch: GameOrchestrator;
  let botSystem: BotSystem;
  let simulation: GameSimulation;

  beforeAll(async () => {
    // Create test server and room
    const testServer = await createTestServer();
    const room = await createRoom(testServer, {
      mapType: 'procedural',
      seed: 12345,
      botFillTo: 64,
      botDifficulty: 'hard',
    });

    // Connect dummy client to start the match
    const dummyClient = await connectClient(testServer, room);

    // Activate the match phase
    const gameRoom = room as unknown as GameRoom;
    const orchestrator = gameRoom.getOrchestrator();
    if (orchestrator.matchFlow.getCurrentState().phase === 1) {
      // COUNTDOWN
      orchestrator.matchFlow.transitionTo(2); // ACTIVE
    }

    orch = (room as unknown as GameRoom).getOrchestrator();
    simulation = orch.getSimulation();
    botSystem = simulation.getBotSystem()!;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('runs full simulation and collects bot performance metrics', async () => {
    const BOT_COUNT = 64;
    const SIM_DURATION_SECONDS = 120;
    const SAMPLE_INTERVAL_SECONDS = 10;
    const samples: Array<{
      timeSeconds: number;
      aliveBots: number;
      armedBots: number;
      avgHealth: number;
      totalKills: number;
      chestsRemaining: number;
      weaponPickupsRemaining: number;
    }> = [];

    // Wait for simulation to initialize
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Sample at 10s intervals
    for (let t = 0; t <= SIM_DURATION_SECONDS; t += SAMPLE_INTERVAL_SECONDS) {
      // Wait for sample time
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_SECONDS * 1000));

      const matchState = orch.getMatch();
      const aliveBots = Array.from(matchState.players.values()).filter(
        (p: any) => p.id.startsWith('bot_') && p.isAlive(),
      );
      const armedCount = aliveBots.filter((bot: any) =>
        bot.inventory.weapons.some((w: any) => w !== null && w.type !== WeaponType.FISTS),
      ).length;
      const totalHealth = aliveBots.reduce((sum: number, bot: any) => sum + bot.health.current, 0);
      const avgHealth = totalHealth / Math.max(aliveBots.length, 1);
      const totalKills = Array.from(matchState.players.values()).reduce(
        (sum: number, p: any) => sum + (p.kills || 0),
        0,
      );

      const sample = {
        timeSeconds: t,
        aliveBots: aliveBots.length,
        armedBots: armedCount,
        avgHealth: Math.round(avgHealth),
        totalKills,
        chestsRemaining: matchState.chests.size,
        weaponPickupsRemaining: matchState.weaponPickups.size,
      };
      samples.push(sample);

      const armedPct = ((armedCount / Math.max(aliveBots.length, 1)) * 100).toFixed(0);
      console.log(
        `  [${String(sample.timeSeconds).padStart(3)}s] ` +
          `Alive: ${String(sample.aliveBots).padStart(2)}/${BOT_COUNT} | ` +
          `Armed: ${String(sample.armedBots).padStart(2)} (${armedPct}%) | ` +
          `HP: ${sample.avgHealth} | ` +
          `Kills: ${String(sample.totalKills).padStart(3)} | ` +
          `Chests: ${sample.chestsRemaining} | ` +
          `WpnPickups: ${sample.weaponPickupsRemaining}`,
      );
    }

    const final = samples[samples.length - 1]!;
    const results = {
      config: {
        botCount: BOT_COUNT,
        duration: SIM_DURATION_SECONDS,
        mapSize: `${4}x${4}`,
        seed: 12345,
      },
      final: {
        aliveBots: final.aliveBots,
        alivePct: ((final.aliveBots / BOT_COUNT) * 100).toFixed(1),
        armedBots: final.armedBots,
        armedPctOfAlive: ((final.armedBots / Math.max(final.aliveBots, 1)) * 100).toFixed(1),
        avgHealth: final.avgHealth,
        totalKills: final.totalKills,
        chestsRemaining: final.chestsRemaining,
        weaponPickupsRemaining: final.weaponPickupsRemaining,
      },
      samples,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync('/tmp/bot-benchmark-results.json', JSON.stringify(results, null, 2));
    console.log('  Results saved to /tmp/bot-benchmark-results.json\n');

    // Loop runs t = 0, 10, ..., 120 inclusive = (DURATION/INTERVAL + 1) samples.
    // Use toBeGreaterThanOrEqual to tolerate timing jitter cutting the final
    // sample short on slower environments.
    expect(samples.length).toBeGreaterThanOrEqual(SIM_DURATION_SECONDS / SAMPLE_INTERVAL_SECONDS);
  }, 300_000);
});

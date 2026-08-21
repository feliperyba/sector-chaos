import { describe, it, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';
import { BotSystem } from '../../src/ai/BotSystem';

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await cleanup(server);
});

describe('Bot AI Sub-Phase Profiling', () => {
  it('profiles bot AI subsystem timings at 64 bots', async () => {
    const { room } = await createGameRoom(server, {
      botFillTo: 64,
      seed: 12345,
      matchId: 'profile-64',
    });

    // Wait for game to start and bots to populate
    await new Promise((r) => setTimeout(r, 3000));

    const orch = (room as unknown as GameRoom).getOrchestrator();
    const sim = orch.getSimulation();
    const botSystem = (sim as unknown as { botSystem: BotSystem }).botSystem;

    // Collect tick durations for 5 seconds
    const TICK_SAMPLES = 300;
    const samples: Array<{
      total: number;
      botAI: number;
      inputs: number;
      snapshot: number;
      animSim: number;
      melee: number;
      phaseTimings?: typeof botSystem.phaseTimings;
    }> = [];

    for (let i = 0; i < TICK_SAMPLES; i++) {
      await new Promise((r) => setTimeout(r, 16));
      const phaseTimings = { ...botSystem.phaseTimings };

      samples.push({
        total: 0,
        botAI: 0,
        inputs: 0,
        snapshot: 0,
        animSim: 0,
        melee: 0,
        phaseTimings,
      });
    }

    // Calculate phase timing deltas (cumulative counters)
    const first = samples[0]!.phaseTimings!;
    const last = samples[samples.length - 1]!.phaseTimings!;

    console.log('\n=== Bot AI Sub-Phase Profiling (64 bots, 300 ticks) ===\n');
    console.log('Phase timings (cumulative ms across all bots over 300 ticks):');
    console.log(`  updateContext:   ${(last.updateContext - first.updateContext).toFixed(1)}ms`);
    console.log(`  combatState:    ${(last.combatState - first.combatState).toFixed(1)}ms`);
    console.log(`  demolitionState:${(last.demolitionState - first.demolitionState).toFixed(1)}ms`);
    console.log(`  movementGoal:   ${(last.movementGoal - first.movementGoal).toFixed(1)}ms`);
    console.log(`  btEval:          ${(last.btEval - first.btEval).toFixed(1)}ms`);
    console.log(`  btEvalCount:    ${last.btEvalCount - first.btEvalCount} evaluations`);
    console.log(
      `  totalBots:       ${last.totalBots} bots processed (cumulative across all ticks)`,
    );

    const totalBotPhaseMs =
      last.updateContext -
      first.updateContext +
      (last.combatState - first.combatState) +
      (last.demolitionState - first.demolitionState) +
      (last.movementGoal - first.movementGoal) +
      (last.btEval - first.btEval);
    console.log(`\nTotal measured bot phases: ${totalBotPhaseMs.toFixed(1)}ms over 300 ticks`);
    console.log(`Average per tick: ${(totalBotPhaseMs / 300).toFixed(2)}ms`);

    const btEvalCount = last.btEvalCount - first.btEvalCount;
    if (btEvalCount > 0) {
      console.log(
        `Average btEval per evaluation: ${((last.btEval - first.btEval) / btEvalCount).toFixed(3)}ms`,
      );
    }

    // Also dump TICK-OVERRUN style info via metrics
    const metrics = (sim as unknown as { metrics: Record<string, number> }).metrics;
    if (metrics) {
      console.log('\n=== Simulation Metrics ===');
      console.log(`  totalTicks: ${metrics.totalTicks}`);
      console.log(`  avgTickMs: ${(metrics.totalDurationMs / metrics.totalTicks).toFixed(2)}ms`);
      console.log(`  maxTickMs: ${metrics.maxTickMs.toFixed(2)}ms`);
      console.log(`  lastTickMs: ${metrics.lastTickMs.toFixed(2)}ms`);
      if (metrics.systemAverages) {
        console.log('  System averages (ms/tick):');
        for (const [k, v] of Object.entries(metrics.systemAverages)) {
          console.log(`    ${k}: ${(v as number).toFixed(3)}`);
        }
      }
    }

    room.disconnect();
  }, 20_000);
});

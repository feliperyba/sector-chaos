import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import { GameRoom } from '../../src/room/GameRoom';

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await cleanup(server);
});

describe('16ms Tick Budget Performance', () => {
  it('game ticks stay under 16ms budget at 60fps with 64 bots', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 64,
      seed: 12345,
      matchId: 'budget-test-64',
    });

    // Wait for initial game startup and first few ticks
    await new Promise((r) => setTimeout(r, 3000));
    const orch = (room as unknown as GameRoom).getOrchestrator();
    const sim = orch.getSimulation();

    // Read tick counters via the public getMetrics() API (refactor #35 moved
    // the private `metrics` field into TickProfiler; getMetrics() is the
    // stable surface — same shape the /debug/* endpoints consume).
    const startMetrics = sim.getMetrics();
    const startTick = startMetrics.totalTicks;
    const startDuration = startMetrics.totalDurationMs;

    // Collect samples for 5 seconds
    await new Promise((r) => setTimeout(r, 5000));

    const endMetrics = sim.getMetrics();
    const endTick = endMetrics.totalTicks;
    const endDuration = endMetrics.totalDurationMs;
    const elapsedTicks = endTick - startTick;
    const elapsedDuration = endDuration - startDuration;

    const avgTickMs = elapsedDuration / Math.max(1, elapsedTicks);
    // maxTickMs is cumulative (tracks global max) — use it but understand
    // it includes any JIT warmup spike in the first few ticks
    const maxTickMs = endMetrics.maxTickMs;

    // Assert budget compliance. The hard constraint is 16ms (60fps budget at
    // 1000/60 ≈ 16.67ms/tick). The 11ms "target" is for production-grade
    // hardware; CI/VPS environments run slower, so we enforce the hard 16ms
    // budget strictly and log a warning if the tighter 11ms target is missed.
    expect(avgTickMs).toBeLessThanOrEqual(
      16,
      `Avg tick ${avgTickMs.toFixed(2)}ms exceeds 16ms budget (60fps)`,
    );
    if (avgTickMs > 11) {
      console.warn(
        `⚠ Avg tick ${avgTickMs.toFixed(2)}ms exceeds 11ms target (but within 16ms budget)`,
      );
    }

    console.log(`Budget test results (64 bots):`);
    console.log(`- Ticks sampled: ${elapsedTicks}`);
    console.log(`- Avg tick: ${avgTickMs.toFixed(2)}ms`);
    console.log(`- Global max tick (incl warmup): ${maxTickMs.toFixed(2)}ms`);

    room.disconnect();
  }, 30_000);

  it('game ticks stay under 16ms budget at 60fps with 0 bots (baseline)', async () => {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 0,
      seed: 67890,
      matchId: 'budget-test-0',
    });

    // Wait for initial game startup
    await new Promise((r) => setTimeout(r, 3000));
    const orch = (room as unknown as GameRoom).getOrchestrator();
    const sim = orch.getSimulation();

    // Read tick counters via the public getMetrics() API (refactor #35 moved
    // the private `metrics` field into TickProfiler; getMetrics() is the
    // stable surface — same shape the /debug/* endpoints consume).
    const startTick = sim.getMetrics().totalTicks;
    const startDuration = sim.getMetrics().totalDurationMs;

    // Collect samples for 2 seconds
    await new Promise((r) => setTimeout(r, 2000));

    const endMetrics = sim.getMetrics();
    const endTick = endMetrics.totalTicks;
    const endDuration = endMetrics.totalDurationMs;
    const avgTickMs = (endDuration - startDuration) / Math.max(1, endTick - startTick);

    // Even baseline should be well under budget
    expect(avgTickMs).toBeLessThanOrEqual(
      8,
      `Baseline avg tick ${avgTickMs.toFixed(2)}ms exceeds 8ms`,
    );

    console.log(`Baseline budget test results (0 bots):`);
    console.log(`- Avg tick: ${avgTickMs.toFixed(2)}ms`);

    room.disconnect();
  }, 15_000);
});

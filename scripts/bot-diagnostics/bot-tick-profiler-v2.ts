/**
 * Bot AI tick profiler v2 — captures per-subsystem timings from GameSimulation
 *
 * Usage: npx tsx bot-tick-profiler-v2.ts [botCount] [warmupTicks] [measureTicks]
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { GameSimulation } from '../../packages/server/src/application/simulation/GameSimulation';
import type { ColyseusTestServer } from '@colyseus/testing';

const BOT_COUNT = parseInt(process.argv[2] || '63');
const WARMUP_TICKS = parseInt(process.argv[3] || '460');
const MEASURE_TICKS = parseInt(process.argv[4] || '300');

process.stderr.write(
  `\n=== Bot Tick Profiler v2: ${BOT_COUNT} bots, ${WARMUP_TICKS} warmup, ${MEASURE_TICKS} measure ===\n`,
);

const server: ColyseusTestServer = await createTestServer();

try {
  const { room, helper } = await createGameRoom(server, {
    botFillTo: BOT_COUNT,
    mapType: undefined,
    seed: 42,
  });
  const client = await connectClient(server, room, { name: 'Profiler' });
  await room.waitForNextPatch();

  process.stderr.write('Warming up...\n');
  await helper.advanceTicks(WARMUP_TICKS);

  // Force active phase
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    simulation: {
      botSystem: { bots: Map<string, unknown> };
      match: { forEachAlivePlayer: (cb: () => void) => void };
    };
    matchFlow: { phase: number };
    lastStandingThreshold: number;
    matchEndedEmitted: boolean;
  };
  orch.matchFlow.phase = 2;
  orch.lastStandingThreshold = -1;
  orch.matchEndedEmitted = false;

  // Collect per-subsystem timings
  const subsystemTimings: Record<string, number[]> = {};
  const totalTickTimes: number[] = [];

  process.stderr.write('Measuring...\n');
  for (let i = 0; i < MEASURE_TICKS; i++) {
    const start = performance.now();
    await helper.advanceTicks(1);
    const elapsed = performance.now() - start;
    totalTickTimes.push(elapsed);

    // Capture per-subsystem timings from the simulation
    const timings = GameSimulation.metrics.lastTickSystemTimings;
    for (const key in timings) {
      if (!subsystemTimings[key]) subsystemTimings[key] = [];
      subsystemTimings[key]!.push(timings[key]!);
    }
  }

  // Report
  process.stderr.write('\n=== PER-SUBSYSTEM TIMINGS ===\n');
  process.stderr.write(
    `${'Subsystem'.padEnd(20)} ${'avg'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)} ${'% total'.padStart(8)}\n`,
  );
  process.stderr.write(`${'─'.repeat(60)}\n`);

  const avgTotal = totalTickTimes.reduce((a, b) => a + b, 0) / totalTickTimes.length;

  // Sort subsystems by avg time descending
  const sortedSubsystems = Object.entries(subsystemTimings).sort(
    ([, a], [, b]) =>
      b.reduce((s, v) => s + v, 0) / b.length - a.reduce((s, v) => s + v, 0) / a.length,
  );

  for (const [name, times] of sortedSubsystems) {
    const sorted = [...times].sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const max = sorted[sorted.length - 1]!;
    process.stderr.write(
      `${name.padEnd(20)} ${avg.toFixed(2).padStart(8)} ${p50.toFixed(2).padStart(8)} ${p95.toFixed(2).padStart(8)} ${max.toFixed(2).padStart(8)} ${((avg / avgTotal) * 100).toFixed(1).padStart(7)}%\n`,
    );
  }

  // Overall stats
  const sorted = [...totalTickTimes].sort((a, b) => a - b);
  const avg = totalTickTimes.reduce((a, b) => a + b, 0) / totalTickTimes.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
  const max = sorted[sorted.length - 1]!;
  const overruns = totalTickTimes.filter((t) => t > 16.67).length;

  process.stderr.write('\n=== OVERALL ===\n');
  process.stderr.write(`avg:   ${avg.toFixed(2)} ms (budget: 16.67 ms)\n`);
  process.stderr.write(`p50:   ${p50.toFixed(2)} ms\n`);
  process.stderr.write(`p95:   ${p95.toFixed(2)} ms\n`);
  process.stderr.write(`p99:   ${p99.toFixed(2)} ms\n`);
  process.stderr.write(`max:   ${max.toFixed(2)} ms\n`);
  process.stderr.write(
    `overruns: ${overruns}/${MEASURE_TICKS} (${((overruns / MEASURE_TICKS) * 100).toFixed(1)}%)\n`,
  );

  let aliveCount = 0;
  orch.simulation.match.forEachAlivePlayer(() => aliveCount++);
  process.stderr.write(`\nBots: ${orch.simulation.botSystem.bots.size}, alive: ${aliveCount}\n`);

  void client;
} finally {
  await cleanup();
}

/**
 * Bot AI tick profiler — measures per-tick timing breakdown
 * with N bots over a fixed number of ticks.
 *
 * Usage: npx tsx bot-tick-profiler.ts [botCount] [warmupTicks] [measureTicks]
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import type { ColyseusTestServer } from '@colyseus/testing';

const BOT_COUNT = parseInt(process.argv[2] || '63');
const WARMUP_TICKS = parseInt(process.argv[3] || '500');
const MEASURE_TICKS = parseInt(process.argv[4] || '300');

process.stderr.write(
  `\n=== Bot Tick Profiler: ${BOT_COUNT} bots, ${WARMUP_TICKS} warmup, ${MEASURE_TICKS} measure ===\n`,
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

  // Warmup
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

  process.stderr.write('Measuring...\n');
  const tickTimings: number[] = [];
  for (let i = 0; i < MEASURE_TICKS; i++) {
    const start = performance.now();
    await helper.advanceTicks(1);
    tickTimings.push(performance.now() - start);
  }

  const sorted = [...tickTimings].sort((a, b) => a - b);
  const avg = tickTimings.reduce((a, b) => a + b, 0) / tickTimings.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
  const max = sorted[sorted.length - 1]!;
  const min = sorted[0]!;
  const overruns = tickTimings.filter((t) => t > 16.67).length;

  process.stderr.write('\n=== RESULTS ===\n');
  process.stderr.write(`min:    ${min.toFixed(2)} ms\n`);
  process.stderr.write(`avg:    ${avg.toFixed(2)} ms\n`);
  process.stderr.write(`p50:    ${p50.toFixed(2)} ms\n`);
  process.stderr.write(`p95:    ${p95.toFixed(2)} ms\n`);
  process.stderr.write(`p99:    ${p99.toFixed(2)} ms\n`);
  process.stderr.write(`max:    ${max.toFixed(2)} ms\n`);
  process.stderr.write(
    `overruns (>16.67ms): ${overruns}/${MEASURE_TICKS} (${((overruns / MEASURE_TICKS) * 100).toFixed(1)}%)\n`,
  );

  const worst = [...tickTimings.map((t, i) => ({ tick: i, ms: t }))]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  process.stderr.write('\n=== 10 WORST TICKS ===\n');
  for (const w of worst) {
    process.stderr.write(`  tick ${WARMUP_TICKS + w.tick}: ${w.ms.toFixed(2)} ms\n`);
  }

  let aliveCount = 0;
  orch.simulation.match.forEachAlivePlayer(() => aliveCount++);
  process.stderr.write(`\nBots: ${orch.simulation.botSystem.bots.size}, alive: ${aliveCount}\n`);

  void client;
} finally {
  await cleanup();
}

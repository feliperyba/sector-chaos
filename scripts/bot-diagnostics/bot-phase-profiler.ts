/**
 * Bot AI phase profiler — measures per-function costs inside tickBot
 *
 * Usage: npx tsx bot-phase-profiler.ts [botCount] [warmupTicks] [measureTicks]
 */
import {
  cleanup,
  connectClient,
  createTestServer,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { GameRoom } from '../../packages/server/src/room/GameRoom';
import type { GameSimulation } from '../../packages/server/src/application/simulation/GameSimulation';

const BOT_COUNT = parseInt(process.argv[2] || '63');
const WARMUP_TICKS = parseInt(process.argv[3] || '460');
const MEASURE_TICKS = parseInt(process.argv[4] || '200');

process.stderr.write(
  `\n=== Phase Profiler: ${BOT_COUNT} bots, ${WARMUP_TICKS} warmup, ${MEASURE_TICKS} measure ===\n`,
);

const server = await createTestServer();

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
      botSystem: {
        bots: Map<string, unknown>;
        phaseTimings: {
          updateContext: number;
          combatState: number;
          demolitionState: number;
          movementGoal: number;
          btEval: number;
          btEvalCount: number;
          totalBots: number;
        };
      };
      match: { forEachAlivePlayer: (cb: () => void) => void };
    };
    matchFlow: { phase: number };
    lastStandingThreshold: number;
    matchEndedEmitted: boolean;
  };
  orch.matchFlow.phase = 2;
  orch.lastStandingThreshold = -1;
  orch.matchEndedEmitted = false;

  // Reset phase timings
  const pt = orch.simulation.botSystem.phaseTimings;
  pt.updateContext = 0;
  pt.combatState = 0;
  pt.demolitionState = 0;
  pt.movementGoal = 0;
  pt.btEval = 0;
  pt.btEvalCount = 0;
  pt.totalBots = 0;

  // Measure
  process.stderr.write('Measuring...\n');
  const tickTimes: number[] = [];
  for (let i = 0; i < MEASURE_TICKS; i++) {
    const t0 = performance.now();
    await helper.advanceTicks(1);
    tickTimes.push(performance.now() - t0);
  }

  // Report
  process.stderr.write('\n=== PER-PHASE BREAKDOWN ===\n');
  process.stderr.write(`Total ticks: ${MEASURE_TICKS}\n`);
  process.stderr.write(
    `Total bot-ticks: ${pt.totalBots} (${(pt.totalBots / MEASURE_TICKS).toFixed(1)} bots/tick avg)\n`,
  );
  process.stderr.write(
    `BT evaluations: ${pt.btEvalCount} (${(pt.btEvalCount / MEASURE_TICKS).toFixed(1)}/tick avg)\n\n`,
  );

  const phases: [string, number][] = [
    ['updateContext  ', pt.updateContext],
    ['combatState    ', pt.combatState],
    ['demolitionState', pt.demolitionState],
    ['movementGoal   ', pt.movementGoal],
    ['btEval         ', pt.btEval],
  ];

  const totalPhase = phases.reduce((s, [, v]) => s + v, 0);
  process.stderr.write('Phase                  total(ms)  avg/bot(µs)  avg/tick(ms)  % botAI\n');
  process.stderr.write('────────────────────────────────────────────────────────────────────\n');
  for (const [name, val] of phases) {
    const avgBot = pt.totalBots > 0 ? ((val / pt.totalBots) * 1000).toFixed(1) : '0.0';
    const avgTick = (val / MEASURE_TICKS).toFixed(2);
    const pct = totalPhase > 0 ? ((val / totalPhase) * 100).toFixed(1) : '0.0';
    process.stderr.write(
      `${name}        ${val.toFixed(0).padStart(8)}    ${avgBot.padStart(8)}      ${avgTick.padStart(6)}     ${pct.padStart(5)}%\n`,
    );
  }
  process.stderr.write('────────────────────────────────────────────────────────────────────\n');
  const avgBotTotal = pt.totalBots > 0 ? ((totalPhase / pt.totalBots) * 1000).toFixed(1) : '0.0';
  process.stderr.write(
    `${'TOTAL botAI'.padEnd(22)}${totalPhase.toFixed(0).padStart(8)}    ${avgBotTotal.padStart(8)}      ${(totalPhase / MEASURE_TICKS).toFixed(2).padStart(6)}     100.0%\n`,
  );

  // Tick time stats
  tickTimes.sort((a, b) => a - b);
  const avg = tickTimes.reduce((s, v) => s + v, 0) / tickTimes.length;
  const p50 = tickTimes[Math.floor(tickTimes.length * 0.5)]!;
  const p95 = tickTimes[Math.floor(tickTimes.length * 0.95)]!;
  const p99 = tickTimes[Math.floor(tickTimes.length * 0.99)]!;
  const maxT = tickTimes[tickTimes.length - 1]!;
  const overruns = tickTimes.filter((t) => t > 16.67).length;
  process.stderr.write(`\n=== TICK TIME STATS ===\n`);
  process.stderr.write(
    `avg: ${avg.toFixed(2)}ms  p50: ${p50.toFixed(2)}ms  p95: ${p95.toFixed(2)}ms  p99: ${p99.toFixed(2)}ms  max: ${maxT.toFixed(2)}ms\n`,
  );
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

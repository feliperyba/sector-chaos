/**
 * Profiling harness: capture per-system timings for EVERY tick, then report
 * which system dominates the over-budget (>16ms) ticks. This pinpoints the
 * real burst source instead of guessing between botAI / GC / melee / snapshot.
 *
 * Reads the simulation's per-system timing breakdown directly via the
 * orchestrator's metrics, accumulating a histogram per system.
 */
import { ColyseusTestServer } from '@colyseus/testing';
import { MatchPhase, NETWORK } from '@sector-battle/shared';
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';
import type { GameRoom } from '../src/room/GameRoom.ts';

interface MetricsLike {
  lastTickSystemTimings: Record<string, number>;
}
interface SimLike {
  getMetrics(): MetricsLike;
}
interface OrchLike {
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(d: number): unknown;
  getPhase(): MatchPhase;
  getSimulation(): SimLike;
  getMatch(): { players: Map<string, unknown> } | undefined;
}
function asGameRoom(room: unknown): { getOrchestrator(): OrchLike } {
  return room as { getOrchestrator(): OrchLike };
}

const TICK_BUDGET_MS = 16;
const realNow = () => {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
};

async function main() {
  const bots = Number(process.env.BENCH_BOTS ?? 63);
  const seed = Number(process.env.BENCH_SEED ?? 12345);
  const duration = Number(process.env.BENCH_DURATION ?? 300);

  const server = await createTestServer();
  try {
    const room = await createRoom(server, {
      botFillTo: bots,
      botDifficulty: 'hard',
      mapType: 'procedural',
      seed,
    });
    room.autoDispose = false;
    const orch = asGameRoom(room).getOrchestrator();
    orch.setLastStandingThreshold(-1);

    const start = Date.now();
    while ((orch.getMatch()?.players.size ?? 0) < bots && Date.now() - start < 30000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    orch.setLastStandingThreshold(1);
    orch.start();

    const totalTicks = Math.ceil(duration * NETWORK.TICK_RATE);
    const sim = orch.getSimulation();

    // Per-system: sum of time spent, and count of ticks where that system was
    // the dominant (>50% of tick) contributor to an over-budget tick.
    const systemTotals: Record<string, number> = {};
    const overBudgetSystemDominance: Record<string, number> = {};
    let overBudgetTicks = 0;

    // Also track wall-clock tick times (the real production constraint).
    const tickTimes: number[] = [];

    // We can't read per-system wall-clock (the sim tracks them via performance.now
    // which we don't virtualize here), so measure whole-tick wall-clock and read
    // the sim's lastTickSystemTimings (which are the sim's own accounting).
    for (let i = 0; i < totalTicks; i++) {
      const t0 = realNow();
      orch.update(NETWORK.TICK_INTERVAL);
      const tickMs = realNow() - t0;
      tickTimes.push(tickMs);

      const timings = sim.getMetrics().lastTickSystemTimings;
      if (tickMs > TICK_BUDGET_MS) {
        overBudgetTicks++;
        // find dominant system
        let dom: string | null = null;
        let domVal = 0;
        let sum = 0;
        for (const [k, v] of Object.entries(timings)) {
          systemTotals[k] = (systemTotals[k] ?? 0) + v;
          sum += v;
          if (v > domVal) {
            domVal = v;
            dom = k;
          }
        }
        if (dom) overBudgetSystemDominance[dom] = (overBudgetSystemDominance[dom] ?? 0) + 1;
        void sum;
      } else {
        for (const [k, v] of Object.entries(timings)) {
          systemTotals[k] = (systemTotals[k] ?? 0) + v;
        }
      }

      if (orch.getPhase() === MatchPhase.FINISHED) break;
    }

    // Compute P50/P95/P99 from wall-clock tick times.
    const sorted = [...tickTimes].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    console.log(`\n=== TICK BUDGET (wall-clock, ${bots} bots, ${duration}s, seed ${seed}) ===`);
    console.log(
      `P50=${pct(0.5).toFixed(2)}ms P95=${pct(0.95).toFixed(2)}ms ` +
        `P99=${pct(0.99).toFixed(2)}ms max=${sorted[sorted.length - 1]!.toFixed(2)}ms ` +
        `(>16ms: ${overBudgetTicks}/${tickTimes.length} ticks)`,
    );

    console.log(`\n=== DOMINANT SYSTEM ON OVER-BUDGET TICKS ===`);
    const domEntries = Object.entries(overBudgetSystemDominance).sort((a, b) => b[1] - a[1]);
    for (const [k, c] of domEntries) {
      console.log(
        `  ${k}: dominant on ${c} over-budget ticks (${((c / Math.max(1, overBudgetTicks)) * 100).toFixed(1)}%)`,
      );
    }

    console.log(`\n=== TOTAL SYSTEM TIME (sim accounting, all ticks) ===`);
    const totEntries = Object.entries(systemTotals).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of totEntries) {
      console.log(
        `  ${k}: ${v.toFixed(1)}ms total (${(v / tickTimes.length).toFixed(4)}ms/tick avg)`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

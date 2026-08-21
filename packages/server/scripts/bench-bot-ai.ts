/**
 * Standalone bot AI benchmark runner.
 *
 * Boots an in-process Colyseus test server and fast-forwards a complete bot
 * match (no browser, no real-time wait for the game itself). Prints a summary
 * table and writes a JSON report under packages/server/bench-results/.
 *
 * Usage (from repo root):
 *   pnpm --filter @sector-battle/server exec tsx scripts/bench-bot-ai.ts
 *   pnpm --filter @sector-battle/server run bench:bot-ai
 *
 * Configuration via env vars (all optional):
 *   BENCH_BOTS=63            number of bots
 *   BENCH_DURATION=600       game-time seconds to simulate
 *   BENCH_SAMPLE=10          sample resolution (game-time seconds)
 *   BENCH_SEED=12345         map seed
 *   BENCH_DIFFICULTY=hard    easy | normal | hard
 *   BENCH_MAP=procedural     demo | procedural (procedural = real 80x80 game map)
 *   BENCH_LAST_STANDING=1    lastStandingThreshold (1 = last man standing)
 *   BENCH_ASSERT_ALIVE_COUNT=1  per-tick alive-counter vs full-scan drift check
 *                               (dev/test-only; adds an O(n) scan per tick)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, cleanup } from '../tests/helpers/test-server.ts';
import {
  runBotBenchmark,
  formatSummary,
  type BenchmarkConfig,
} from '../tests/helpers/bot-benchmark-harness.ts';

const env = process.env;

function envInt(key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config: BenchmarkConfig = {
  botFillTo: envInt('BENCH_BOTS', 63),
  durationSeconds: envInt('BENCH_DURATION', 600),
  sampleEverySeconds: envInt('BENCH_SAMPLE', 10),
  seed: envInt('BENCH_SEED', 12345),
  botDifficulty: (env['BENCH_DIFFICULTY'] as BenchmarkConfig['botDifficulty']) ?? 'hard',
  // Default to 'procedural' — the real 80x80 game map. The 'demo' (22x22 TMX)
  // map spawns all weapons inside a room enclosed by destructible walls, which
  // only bots with working destructible-pathing can reach; it's a poor default
  // for general AI-quality regression. Use BENCH_MAP=demo to stress that path.
  mapType: (env['BENCH_MAP'] as BenchmarkConfig['mapType']) ?? 'procedural',
  lastStandingThreshold: envInt('BENCH_LAST_STANDING', 1),
};

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log(`Booting in-process test server (bots=${config.botFillTo}, seed=${config.seed}) ...`);
  const server = await createTestServer();

  let result;
  try {
    result = await runBotBenchmark(server, config);
  } finally {
    await cleanup(server);
  }

  console.log(formatSummary(result));

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'bench-results');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(outDir, `bot-ai-${stamp}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`\nReport written to ${outFile}`);
  console.log(`Total wall-clock: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});

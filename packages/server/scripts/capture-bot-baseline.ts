/**
 * Believability baseline capture (bot-ai-v2 DEC-013, ticket 01; versioned
 * fixtures added by ticket 02 per the DEC-006 dissent).
 *
 * Runs the fast-forward benchmark over the STANDARD SEED SET (12345 + three
 * others) with the standard benchmark configuration and commits the aggregate
 * as the fixture-style reference every later bot-ai-v2 behavior ticket diffs
 * against (directional gates, per the decision log — absolute thresholds are
 * avoided because changing behavior is the point).
 *
 * Outputs (the bench-results paths that are committed — see the root
 * .gitignore carve-out):
 *   default:                    .../baseline/bot-ai-v2-pre-baseline.json (ticket 01)
 *   --v2 / bench:baseline-v2:   .../baseline/bot-ai-v2-baseline-v2.json
 *     Records the post-DEC-006-bug-pack state as "baseline v2", the NEW
 *     recorded baseline per the DEC-006 dissent: fix 2 intentionally changes
 *     the behavior distribution, so later tickets diff against v2, not pre-v2.
 *
 * Usage (from repo root):
 *   pnpm --filter @sector-battle/server run bench:baseline        # pre-v2 fixture
 *   pnpm --filter @sector-battle/server run bench:baseline-v2     # baseline v2 fixture
 *
 * Env overrides (all optional — defaults are the standard set):
 *   BENCH_SEEDS=12345,777,20260817,31337   comma-separated seed list
 *   BENCH_BOTS / BENCH_DURATION / BENCH_SAMPLE / BENCH_DIFFICULTY /
 *   BENCH_MAP / BENCH_LAST_STANDING        same meaning as bench-bot-ai.ts
 *   BENCH_BASELINE_FILE=<name>.json        output filename inside
 *                                          bench-results/baseline/ (extension
 *                                          optional) — default the pre-v2 file
 *   BENCH_BASELINE_PURPOSE=<text>          overrides meta.purpose
 *
 * DETERMINISM CONTRACT (load-bearing): every believability field in each run
 * is pure observation of the deterministic tick stream, so two captures at
 * the same seed are byte-identical EXCEPT the wall-clock fields listed in
 * `meta.maskOnDiff` — mask those before using JSON equality as a gate:
 *   timestamp, realDurationMs, speedup, tickBudget, aiTime, aiBudget (per-run
 *   fields; aiBudget is the enforced-AI-budget block, bot-ai-v2 ticket 11)
 *   meta.capturedAt (fixture-level wall-clock stamp of the capture itself)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, cleanup } from '../tests/helpers/test-server.ts';
import {
  runBotBenchmark,
  type BenchmarkConfig,
  type BenchmarkResult,
} from '../tests/helpers/bot-benchmark-harness.ts';

const STANDARD_SEEDS = [12345, 777, 20260817, 31337];

const BASELINE_V2_PURPOSE =
  'Baseline v2 (bot-ai-v2 ticket 02, recorded per the DEC-006 dissent). ' +
  'Post-verified-bug-pack behavior: fix 1 restored siege-warning proximity ' +
  '(TILE_PIXEL_SIZE), fix 2 restored symmetric personality jitter (behavior ' +
  'distribution INTENTIONALLY shifted — that is why this is a NEW baseline), ' +
  'fix 3 corrected the health-pack blacklist to 3s, fix 4 routed barrel-trap ' +
  'aim through the SAT-centroid map, fix 5 unified the hazard scan range. ' +
  'Later behavior tickets diff against THIS fixture, not the pre-v2 one.';

const PRE_BASELINE_PURPOSE =
  'Pre-v2 believability baseline (bot-ai-v2 DEC-013 ticket 01). Every later ' +
  'behavior ticket diffs its bench run against these numbers with DIRECTIONAL ' +
  'gates (stall metrics down, latency spread up, per-archetype cuts distinct). ' +
  'Re-capture (and note the change) whenever a ticket intentionally shifts the ' +
  'behavior distribution — e.g. the DEC-006 bug pack. Superseded as the diff ' +
  'reference by baseline v2 (bot-ai-v2-baseline-v2.json) after ticket 02.';

interface BaselineVariant {
  /** File name inside bench-results/baseline/. */
  file: string;
  /** meta.purpose text. */
  purpose: string;
  /** captureCommand recorded in meta (must reproduce this exact fixture). */
  command: string;
}

/**
 * Fixture variant to capture. `--v2` (the bench:baseline-v2 npm alias) records
 * the post-DEC-006 state as baseline v2 per the DEC-006 dissent; the default
 * reproduces ticket 01's pre-v2 fixture. BENCH_BASELINE_FILE /
 * BENCH_BASELINE_PURPOSE override the file name / purpose text for ad-hoc
 * future variants (a file override disables the v2 command label).
 */
function resolveVariant(): BaselineVariant {
  const v2Flag = process.argv.includes('--v2');
  const fileOverride = process.env.BENCH_BASELINE_FILE;
  const purposeOverride = process.env.BENCH_BASELINE_PURPOSE;
  const file =
    fileOverride !== undefined && fileOverride !== ''
      ? fileOverride.endsWith('.json')
        ? fileOverride
        : `${fileOverride}.json`
      : v2Flag
        ? 'bot-ai-v2-baseline-v2.json'
        : 'bot-ai-v2-pre-baseline.json';
  const v2 = file === 'bot-ai-v2-baseline-v2.json';
  const purpose =
    purposeOverride !== undefined && purposeOverride !== ''
      ? purposeOverride
      : v2
        ? BASELINE_V2_PURPOSE
        : PRE_BASELINE_PURPOSE;
  const command = fileOverride
    ? `BENCH_BASELINE_FILE=${file} pnpm --filter @sector-battle/server run bench:baseline`
    : v2
      ? 'pnpm --filter @sector-battle/server run bench:baseline-v2'
      : 'pnpm --filter @sector-battle/server run bench:baseline';
  return { file, purpose, command };
}

const variant = resolveVariant();

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const seeds = (process.env.BENCH_SEEDS ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((s) => Number.isFinite(s) && s > 0);

const config: Omit<BenchmarkConfig, 'seed'> = {
  botFillTo: envInt('BENCH_BOTS', 63),
  durationSeconds: envInt('BENCH_DURATION', 600),
  sampleEverySeconds: envInt('BENCH_SAMPLE', 10),
  botDifficulty: (process.env.BENCH_DIFFICULTY as BenchmarkConfig['botDifficulty']) ?? 'hard',
  mapType: (process.env.BENCH_MAP as BenchmarkConfig['mapType']) ?? 'procedural',
  lastStandingThreshold: envInt('BENCH_LAST_STANDING', 1),
};

interface BaselineFixture {
  meta: {
    purpose: string;
    capturedAt: string;
    captureCommand: string;
    config: Omit<BenchmarkConfig, 'seed'>;
    seeds: number[];
    /** Wall-clock result fields — mask before diffing two captures. */
    maskOnDiff: string[];
    determinismNote: string;
  };
  runs: Record<string, BenchmarkResult>;
}

async function main(): Promise<void> {
  const seedList = seeds.length > 0 ? seeds : STANDARD_SEEDS;
  console.log(
    `Capturing baseline fixture ${variant.file}: ${seedList.length} seeds x ` +
      `${config.botFillTo} bots (${config.botDifficulty}), map=${config.mapType}, ` +
      `${config.durationSeconds}s@${config.sampleEverySeconds}s, lastStanding=${config.lastStandingThreshold}`,
  );
  const runs: Record<string, BenchmarkResult> = {};
  for (const seed of seedList) {
    console.log(`\n=== seed ${seed} ===`);
    // Fresh server per seed: complete room isolation between runs (no
    // lingering autoDispose=false rooms from the previous seed).
    const server = await createTestServer();
    let result: BenchmarkResult;
    try {
      result = await runBotBenchmark(server, { ...config, seed });
    } finally {
      await cleanup(server);
    }
    if (!result.finished) {
      // Not fatal: some seeds' endgames don't resolve to last-standing within
      // the standard duration (survivors hold positions). The run is still a
      // valid full-population reference — flag it so the fixture reader knows.
      console.warn(
        `WARNING: seed ${seed}: match did not reach FINISHED within ${config.durationSeconds}s ` +
          `(ended in phase ${result.finalPhase}, ${result.finalSnapshot.aliveBots} alive) — ` +
          'kept as a full-duration reference run',
      );
    }
    runs[String(seed)] = result;
  }

  const fixture: BaselineFixture = {
    meta: {
      purpose: variant.purpose,
      capturedAt: new Date().toISOString(),
      captureCommand: variant.command,
      config,
      seeds: seedList,
      maskOnDiff: [
        'timestamp',
        'realDurationMs',
        'speedup',
        'tickBudget',
        'aiTime',
        // bot-ai-v2 ticket 11 (DEC-012): the enforced-budget block is wall-
        // clock (metric-clock percentiles + overrun counters); the LOD
        // block is deterministic and stays un-masked.
        'aiBudget',
        'meta.capturedAt',
      ],
      determinismNote:
        'Same-seed captures are byte-identical modulo meta.maskOnDiff (wall-clock ' +
        'fields). Believability fields are pure observation of the deterministic ' +
        'tick stream (no RNG, no clock reads). See the harness header for the ' +
        'virtual-clock + AI-time measurement contract.',
    },
    runs,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'bench-results', 'baseline');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, variant.file);
  writeFileSync(outFile, JSON.stringify(fixture, null, 2));
  console.log(`\nBaseline written to ${outFile} (${seedList.length} runs)`);
}

main().catch((err: unknown) => {
  console.error('Baseline capture failed:', err);
  process.exit(1);
});

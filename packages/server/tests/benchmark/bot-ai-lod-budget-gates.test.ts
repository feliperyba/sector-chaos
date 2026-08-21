import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, cleanup } from '../helpers/test-server.ts';
import {
  runBotBenchmark,
  formatSummary,
  type BenchmarkConfig,
} from '../helpers/bot-benchmark-harness.ts';
import { AI_BUDGET_TARGET_MS, AI_SUSTAINED_OVERRUN_TICKS } from '../../src/ai/lod/AiBudgetGuard.ts';

/**
 * AI LOD + ENFORCED BUDGET bench gates (bot-ai-v2 ticket 11, DEC-012).
 *
 * The DEC-012 validation gates, env-tunable like the CI health-check so the
 * same file covers the quick form (defaults; part of `pnpm test`) and the
 * full sweep the orchestrator runs at end of effort:
 *
 *   BENCH_BOTS=63 BENCH_DURATION=600 BENCH_LAST_STANDING=1 \
 *     pnpm --filter @sector-battle/server exec vitest run \
 *     tests/benchmark/bot-ai-lod-budget-gates.test.ts
 *   (and the same with BENCH_LAST_STANDING=-1 for the full-duration config)
 *
 * Gates (ticket criteria):
 *  - AI-budget P95 ≤ 4 ms (GDD §15.3.1b) — the 63-bot form is the binding
 *    one; the quick default form asserts the gate machinery itself.
 *  - Sustained overrun is a FAIL: `sustainedOverrun` must be false.
 *  - Tick-budget P95 stays within the existing 16 ms bound (no unbounded
 *    growth from the LOD pass itself).
 *  - LOD is actually engaging: T1/T2 share > 0 on a spread lobby, think
 *    skips happen (cadence), and fights upgrade bots immediately.
 *  - Determinism: same-seed byte-identity is covered by the harness contract
 *    (tier assignment is a pure function of positions — see the unit suites;
 *    the guard clock is the virtualized performance.now, so relief is
 *    deterministic-inert here and every relief tick is level 0).
 */
describe('Bot AI LOD + enforced budget gates', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('holds the AI budget and engages LOD across the run', { timeout: 600_000 }, async () => {
    const config: BenchmarkConfig = {
      botFillTo: Number(process.env.BENCH_BOTS ?? 24),
      durationSeconds: Number(process.env.BENCH_DURATION ?? 120),
      sampleEverySeconds: Number(process.env.BENCH_SAMPLE ?? 15),
      seed: Number(process.env.BENCH_SEED ?? 4211),
      botDifficulty: 'hard',
      mapType: (process.env.BENCH_MAP as BenchmarkConfig['mapType']) ?? 'procedural',
      lastStandingThreshold: Number(process.env.BENCH_LAST_STANDING ?? 1),
    };
    const result = await runBotBenchmark(server, config);

    // ── Gate 1: AI-budget percentiles vs the GDD §15.3.1b target ──────────
    // P95 ≤ 4 ms across ALL bots (the budget is global, never per-bot). The
    // 63-bot sweep is the binding validation; smaller quick runs assert the
    // same gate on their own scale.
    const ab = result.aiBudget;
    expect(ab.targetMs).toBe(AI_BUDGET_TARGET_MS);
    expect(ab.p95Ms).toBeLessThanOrEqual(AI_BUDGET_TARGET_MS);
    expect(ab.p50Ms).toBeLessThanOrEqual(ab.p95Ms);
    expect(ab.p99Ms).toBeGreaterThanOrEqual(ab.p95Ms);

    // ── Gate 2: sustained overrun = FAIL, not silent ──────────────────────
    // Sustained pressure (≥ AI_SUSTAINED_OVERRUN_TICKS consecutive over-
    // target ticks) must trip the flag — the bench reads it as a gate.
    expect(ab.sustainedOverrunTicks).toBe(AI_SUSTAINED_OVERRUN_TICKS);
    expect(ab.sustainedOverrun).toBe(false);
    expect(ab.maxConsecutiveOverrunTicks).toBeLessThan(AI_SUSTAINED_OVERRUN_TICKS);

    // ── Gate 3: relief NEVER fired (virtual-clock contract) ───────────────
    // The guard reads performance.now — virtualized by this harness — so
    // within-tick deltas are 0 and relief cannot trip. Any non-zero relief
    // row here means the guard read a non-virtualized clock (a determinism
    // break, not just a budget one).
    expect(ab.reliefTicksByLevel.reduce((a, b) => a + b, 0)).toBe(ab.samples);
    expect(ab.reliefTicksByLevel[1]).toBe(0);
    expect(ab.reliefTicksByLevel[2]).toBe(0);
    expect(ab.reliefTicksByLevel[3]).toBe(0);

    // ── Gate 4: tick budget unchanged (LOD must not ADD tick cost) ────────
    expect(result.tickBudget.p95Ms).toBeLessThanOrEqual(result.tickBudget.budgetMs);

    // ── Gate 5: LOD is actually engaging + no behavioral cliff ────────────
    // On a spread lobby some bot-ticks are T1/T2 (fidelity allocated away
    // from the audience), cadence skips happen, and combat entry upgrades
    // bots to full fidelity immediately (fights are T0).
    const lt = result.lodTelemetry;
    const offscreenShare = lt.tierShare[1]! + lt.tierShare[2]!;
    expect(offscreenShare).toBeGreaterThan(0);
    expect(lt.thinkTicksSkipped).toBeGreaterThan(0);
    expect(lt.combatTierUpgrades).toBeGreaterThan(0);
    // The always-on half: reactions keep firing at every tier (the reactor
    // is never cadence-gated) — the flinch proof at population scale.
    expect(result.believability.overall.reactionsTotal).toBeGreaterThan(0);

    console.log(formatSummary(result));

    // Persist the report for inspection (same convention as the CI check).
    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = join(here, '..', '..', 'bench-results');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `bot-ai-lod-gates-${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`Report written to ${outFile}`);
  });
});

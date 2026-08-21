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
import { SUB_VARIANTS_BY_TYPE } from '@sector-battle/shared';
import { INTENT_FAMILY_COUNT, LATENCY_BUCKET_COUNT } from '../../src/ai/BotBelievability.ts';
import { REACTION_TYPE_KEYS } from '../../src/ai/reactor/ReactorTypes.ts';

/**
 * CI health-check for the fast-forward bot benchmark harness. Verifies the
 * harness can boot a real room, spawn bots, fast-forward a match end-to-end
 * without crashing, and produce sampled metrics.
 *
 * This runs a SHORT game (default 120s game-time, env-tunable) so it stays
 * fast in CI. For a full 600s benchmark with siege/overtime coverage run the
 * standalone CLI instead:
 *   pnpm --filter @sector-battle/server run bench:bot-ai
 * (or set BENCH_DURATION=600 here).
 */
describe('Bot AI fast-forward benchmark harness', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('runs a fast-forwarded bot match end-to-end and collects metrics', async () => {
    const config: BenchmarkConfig = {
      botFillTo: Number(process.env.BENCH_BOTS ?? 24),
      durationSeconds: Number(process.env.BENCH_DURATION ?? 120),
      sampleEverySeconds: Number(process.env.BENCH_SAMPLE ?? 15),
      seed: Number(process.env.BENCH_SEED ?? 777),
      botDifficulty: 'hard',
      // Use the real procedural map (not demo) so the test exercises actual
      // navigation, looting, and combat. The demo map encloses all loot behind
      // destructible walls, producing 0-kill games that don't validate AI.
      mapType: (process.env.BENCH_MAP as BenchmarkConfig['mapType']) ?? 'procedural',
      lastStandingThreshold: 1,
    };

    // server-alive-counter: enable the per-tick maintained-counter vs full-scan
    // drift assertion for this fast-forward match (dev/test-only flag read by
    // the harness). Any unaudited aliveness transition fails the run loudly.
    const prevAssert = process.env.BENCH_ASSERT_ALIVE_COUNT;
    process.env.BENCH_ASSERT_ALIVE_COUNT = '1';
    let result: Awaited<ReturnType<typeof runBotBenchmark>>;
    try {
      result = await runBotBenchmark(server, config);
    } finally {
      if (prevAssert === undefined) delete process.env.BENCH_ASSERT_ALIVE_COUNT;
      else process.env.BENCH_ASSERT_ALIVE_COUNT = prevAssert;
    }

    // Health assertions.
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.ticksRun).toBeGreaterThan(0);
    expect(result.realDurationMs).toBeGreaterThan(0);
    // Fast-forward must be substantially faster than real-time. The threshold
    // is conservative (2x) to account for slower CI/VPS environments — the
    // fast-forward harness is still meaningfully faster than wall-clock.
    expect(result.speedup).toBeGreaterThan(2);
    // No bot crash: bots spawned (first sample should reflect the fill count
    // or close to it, before attrition).
    const first = result.samples[0]!;
    expect(first.aliveBots).toBeGreaterThan(0);

    // Skill-scoring system must be populated (the per-bot BotSkillTracker wires
    // into getSkillSummaries). Even on the enclosed demo map where arming is
    // hard, the system must produce a tier distribution and finite dimension
    // scores — these guard against the tracker silently returning an empty Map
    // (the original bug where the entire skill block was zeros).
    const sk = result.skill;
    expect(Object.keys(sk.tierDistribution).length).toBeGreaterThan(0);
    // On the procedural map, bots should arm at least some weapons over 120s.
    expect(sk.botsEverArmed).toBeGreaterThan(0);
    // Each named dimension should be a finite number in [0, 100].
    for (const dim of [
      sk.avgCombat,
      sk.avgSurvival,
      sk.avgEconomy,
      sk.avgPositioning,
      sk.avgDecision,
      sk.avgOverall,
    ]) {
      expect(dim).toBeGreaterThanOrEqual(0);
      expect(dim).toBeLessThanOrEqual(100);
      expect(Number.isFinite(dim)).toBe(true);
    }
    // Tick budget: p95 must stay within the 16ms / 60fps hard constraint.
    // p99 is checked with a small tolerance — on shared CI/VPS environments,
    // GC pauses and memory pressure can cause the 99th percentile to briefly
    // exceed budget without indicating a real regression. A consistent p95
    // violation is the reliable signal.
    expect(result.tickBudget.p95Ms).toBeLessThanOrEqual(result.tickBudget.budgetMs);
    expect(result.tickBudget.p99Ms).toBeLessThanOrEqual(result.tickBudget.budgetMs + 4);

    // Believability telemetry (bot-ai-v2 DEC-013, ticket 01): the run must
    // report the reaction-latency histograms, stall telemetry, action
    // diversity, idle/path-efficiency ratios — overall plus the per-archetype
    // and per-difficulty cuts. These are pure observations of the tick stream
    // (deterministic, same-seed stable); here we assert presence + shape.
    const bv = result.believability;
    expect(bv).toBeTruthy();
    const overall = bv.overall;
    expect(overall.bots).toBe(config.botFillTo);
    expect(overall.intentFamilyTicks).toHaveLength(INTENT_FAMILY_COUNT);
    expect(overall.intentFamilyTicks.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // Ratios are per-bot means of [0,1]-bounded values.
    for (const ratio of [
      overall.avgIntentEntropy,
      overall.avgStuckTimeRatio,
      overall.avgIdleRatio,
    ]) {
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
      expect(Number.isFinite(ratio)).toBe(true);
    }
    expect(overall.avgPathEfficiency).toBeGreaterThan(0);
    expect(overall.avgPathEfficiency).toBeLessThanOrEqual(1 + 1e-9);
    // Latency histograms: 7 buckets each + consistent bookkeeping.
    for (const channel of [overall.damageResponse, overall.seenToAttack]) {
      expect(channel.buckets).toHaveLength(LATENCY_BUCKET_COUNT);
      expect(channel.responded).toBe(channel.buckets.reduce((a, b) => a + b, 0));
      expect(channel.stimuli).toBeGreaterThanOrEqual(channel.responded + channel.censored);
      expect(Number.isFinite(channel.avgTicks)).toBe(true);
    }
    // Over a 120s 24-bot hard match the population MUST have seen enemies and
    // taken damage (non-degenerate denominators for the histograms).
    expect(overall.seenToAttack.stimuli).toBeGreaterThan(0);
    expect(overall.damageResponse.stimuli).toBeGreaterThan(0);
    // Stalls and dashes happen in a real match (the qualities this telemetry
    // exists to track — a zero here means the wiring broke).
    expect(overall.suspensions).toBeGreaterThan(0);
    expect(overall.dashTotal).toBeGreaterThan(0);
    expect(Object.keys(overall.dashByReason).length).toBeGreaterThan(0);
    for (const reason of Object.values(overall.dashByReason)) expect(reason).toBeGreaterThan(0);

    // Reactor reaction telemetry (bot-ai-v2 ticket 04, DEC-004): fired-reaction
    // counts by type + the true stimulus→activation latency histogram. The
    // end-to-end wiring proof — the Reactor must fire in a real match (a zero
    // total means the interrupt layer never engaged). Per-type/archetype
    // non-zero gates (windup reactions for ALL archetypes) live in the full
    // bench, not this short CI form.
    expect(overall.reactionsTotal).toBeGreaterThan(0);
    expect(Object.keys(overall.reactionsByType).length).toBeGreaterThan(0);
    const validTypes = new Set<string>(REACTION_TYPE_KEYS);
    for (const type of Object.keys(overall.reactionsByType)) {
      expect(validTypes.has(type)).toBe(true);
      expect(overall.reactionsByType[type]).toBeGreaterThan(0);
    }
    // Histogram bookkeeping: 7 buckets, every counted reaction responded,
    // mean finite. (Stimulus→activation deltas come from the ex-Gaussian
    // arming draws — the spread gate vs baseline is a full-bench concern.)
    expect(overall.reactionLatency.buckets).toHaveLength(LATENCY_BUCKET_COUNT);
    expect(overall.reactionLatency.responded).toBe(
      overall.reactionLatency.buckets.reduce((a, b) => a + b, 0),
    );
    expect(overall.reactionLatency.stimuli).toBe(overall.reactionLatency.responded);
    expect(Number.isFinite(overall.reactionLatency.avgTicks)).toBe(true);
    // Cuts: every observed bot is grouped by archetype and by difficulty; the
    // group counts partition the population.
    expect(Object.keys(bv.byArchetype).length).toBeGreaterThan(0);
    expect(Object.values(bv.byArchetype).reduce((a, b) => a + b.bots, 0)).toBe(config.botFillTo);
    expect(Object.keys(bv.byDifficulty).length).toBeGreaterThan(0);
    expect(Object.values(bv.byDifficulty).reduce((a, b) => a + b.bots, 0)).toBe(config.botFillTo);
    // bot-ai-v2 ticket 08 (DEC-009.1): the all-bot bench lobby pins the WIDE
    // DELIBERATE MIX (20/20/20/20/20 across easy..elite) so believability is
    // measured across tiers — the difficulty cut now spans MULTIPLE tiers
    // (was: exactly one group carrying the room-wide label). The exact
    // per-tier counts are seed-dependent; the partition + span are not.
    expect(result.config.difficultyMix).toBe('bench-wide-mix');
    expect(Object.keys(bv.byDifficulty).length).toBeGreaterThanOrEqual(3);
    for (const tier of Object.keys(bv.byDifficulty)) {
      expect(['easy', 'normal', 'medium', 'hard', 'elite']).toContain(tier);
    }
    // The no-clones block (DEC-009 validation): distribution-distance metrics
    // are present and well-formed (bounded in [0,1]; every observed bot
    // contributed movement samples). Directional thresholds vs the baseline
    // are assessed by the full bench sweep, not this short CI form.
    const nc = bv.noClones;
    expect(nc).toBeTruthy();
    expect(nc.archetypeIntentTvdMax).toBeGreaterThanOrEqual(0);
    expect(nc.archetypeIntentTvdMax).toBeLessThanOrEqual(1);
    expect(nc.difficultyReactionTvdMax).toBeGreaterThanOrEqual(0);
    expect(nc.difficultyReactionTvdMax).toBeLessThanOrEqual(1);
    expect(nc.movementSpeedCvEtaSq).toBeGreaterThanOrEqual(0);
    expect(nc.movementSpeedCvEtaSq).toBeLessThanOrEqual(1);
    expect(nc.movementStoppedEtaSq).toBeGreaterThanOrEqual(0);
    expect(nc.movementStoppedEtaSq).toBeLessThanOrEqual(1);
    expect(nc.movementSamples).toBe(config.botFillTo);
    expect(Object.keys(nc.archetypeIntentTvdPairs).length).toBeGreaterThan(0);
    expect(Object.keys(nc.difficultyReactionTvdPairs).length).toBeGreaterThan(0);
    // Placements carry the assigned tier (DEC-009.1) — the bench's
    // placements-span-tiers gate (easy dies more, hard places higher) reads
    // this join; here we assert the join is complete and well-labeled.
    for (const p of result.placements) {
      expect(p.difficulty).not.toBeNull();
      expect(['easy', 'normal', 'medium', 'hard', 'elite']).toContain(p.difficulty);
    }
    for (const agg of Object.values(bv.byArchetype)) {
      expect(agg.intentFamilyTicks).toHaveLength(INTENT_FAMILY_COUNT);
      expect(agg.damageResponse.buckets).toHaveLength(LATENCY_BUCKET_COUNT);
      expect(agg.seenToAttack.buckets).toHaveLength(LATENCY_BUCKET_COUNT);
      expect(agg.reactionLatency.buckets).toHaveLength(LATENCY_BUCKET_COUNT);
      // Movement features (bot-ai-v2 ticket 08): present, non-negative, and
      // the stopped ratio is a [0,1] fraction.
      expect(agg.avgSpeedCv).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(agg.avgSpeedCv)).toBe(true);
      expect(agg.avgStoppedTickRatio).toBeGreaterThanOrEqual(0);
      expect(agg.avgStoppedTickRatio).toBeLessThanOrEqual(1 + 1e-9);
    }
    // AI-time percentiles (wall-clock — presence + sanity only; masked in the
    // determinism contract, see the harness header).
    const at = result.aiTime;
    expect(at.samples).toBeGreaterThan(0);
    expect(at.p50Ms).toBeGreaterThanOrEqual(0);
    expect(at.p95Ms).toBeGreaterThanOrEqual(at.p50Ms);
    expect(at.p99Ms).toBeGreaterThanOrEqual(at.p95Ms);
    expect(at.maxMs).toBeGreaterThanOrEqual(at.p99Ms);

    // ENFORCED AI BUDGET (bot-ai-v2 ticket 11, DEC-012): the GDD §15.3.1b
    // ≤4 ms target, the sustained-overrun FAIL surface, and the guard's
    // relief tallies. Wall-clock values — masked in the determinism contract
    // (the whole aiBudget block), so here we assert PRESENCE + coherence:
    // percentile ordering, counter bounds, the FAIL threshold wiring, and —
    // the load-bearing harness contract — that relief NEVER fired (under the
    // virtualized performance.now the guard's within-tick delta is always 0;
    // a non-zero relief row would mean the guard read a non-virtual clock).
    // The 63-bot P95 ≤ 4 ms gates live in bot-ai-lod-budget-gates.test.ts.
    const ab = result.aiBudget;
    expect(ab).toBeTruthy();
    expect(ab.targetMs).toBe(4);
    expect(ab.samples).toBe(at.samples);
    expect(ab.p50Ms).toBe(at.p50Ms);
    expect(ab.p95Ms).toBe(at.p95Ms);
    expect(ab.p99Ms).toBe(at.p99Ms);
    expect(ab.ticksOverBudget).toBeGreaterThanOrEqual(0);
    expect(ab.ticksOverBudget).toBeLessThanOrEqual(ab.samples);
    expect(ab.maxConsecutiveOverrunTicks).toBeLessThanOrEqual(ab.ticksOverBudget);
    expect(ab.sustainedOverrunTicks).toBeGreaterThan(0);
    expect(ab.sustainedOverrun).toBe(ab.maxConsecutiveOverrunTicks >= ab.sustainedOverrunTicks);
    expect(ab.reliefTicksByLevel).toHaveLength(4);
    expect(ab.reliefTicksByLevel.reduce((a, b) => a + b, 0)).toBe(ab.samples);
    for (let i = 1; i < 4; i++) {
      expect(ab.reliefTicksByLevel[i]).toBe(0);
    }

    // LOD telemetry (bot-ai-v2 ticket 11): deterministic observation (NOT
    // masked — byte-identity covered). Tier shares partition the bot-ticks;
    // skips are only cadence/relief (relief is inert under the harness, so
    // skips = pure stride arithmetic); a fighting match upgrades bots into
    // combat-tier T0 immediately (combatTierUpgrades > 0).
    const lt = result.lodTelemetry;
    expect(lt).toBeTruthy();
    expect(lt.tierBotTicks).toHaveLength(3);
    const ltTotal = lt.tierBotTicks.reduce((a, b) => a + b, 0);
    expect(ltTotal).toBeGreaterThan(0);
    expect(lt.tierShare.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (const share of lt.tierShare) {
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(lt.thinkTicksExecuted + lt.thinkTicksSkipped).toBe(ltTotal);
    expect(lt.combatTierUpgrades).toBeGreaterThan(0);

    // Stimulus telemetry (bot-ai-v2 ticket 03 / DEC-002): the domain-event →
    // hearing-radius fan-out must be wired end-to-end — a full bot match with
    // real combat produces non-zero deliveries (attacks/damage at minimum)
    // and fight-memory writes from routed attack stimuli.
    const stim = result.stimulus;
    expect(stim).toBeTruthy();
    expect(stim.deliveredTotal).toBeGreaterThan(0);
    expect(stim.deliveredByType.attack).toBeGreaterThan(0);
    expect(stim.deliveredByType.damage).toBeGreaterThan(0);
    expect(stim.fightMemoryWrites).toBeGreaterThan(0);

    // Generation manifest v1 (map-redesign ticket 02): the procedural run must
    // report the seed-authored tier pyramid + per-match hot sector in the
    // benchmark JSON. (A BENCH_MAP=demo override has no shared generation —
    // the manifest is null there and these assertions are skipped.)
    const gm = result.generationManifest;
    if (config.mapType !== 'demo') {
      expect(gm.sectorTiers).not.toBeNull();
      expect(gm.sectorTiers).toHaveLength(4);
      expect(gm.counts).not.toBeNull();
      expect(gm.counts!.hot).toBeGreaterThanOrEqual(2);
      expect(gm.counts!.hot).toBeLessThanOrEqual(3);
      expect(gm.counts!.cold).toBeGreaterThanOrEqual(4);
      expect(gm.counts!.cold).toBeLessThanOrEqual(6);
      expect(gm.hotSector).not.toBeNull();
      const hot = gm.hotSector!;
      expect(gm.sectorTiers![hot.row]![hot.col]).toBe('WARM');

      // Ticket 03 (DEC-001/010): the manifest also reports the map's naming
      // identity — 16 unique sector POI names + the designation.
      expect(gm.designation).not.toBeNull();
      expect(gm.designation).toMatch(/^[A-Z]+ • [A-Z]+ • [0-9A-Z]{2,3}$/);
      expect(gm.poiNames).not.toBeNull();
      expect(gm.poiNames).toHaveLength(4);
      const names = gm.poiNames!.flat();
      expect(names).toHaveLength(16);
      expect(new Set(names).size).toBe(16);
      for (const name of names) expect(name.length).toBeGreaterThan(0);

      // Ticket 04 (DEC-002): the manifest also reports the landmark audit
      // fields — a 4x4 hero composition grid, 2–3 minors, and the rare share.
      expect(gm.heroCompositionIds).not.toBeNull();
      expect(gm.heroCompositionIds).toHaveLength(4);
      const heroIds = gm.heroCompositionIds!.flat();
      expect(heroIds).toHaveLength(16);
      for (const id of heroIds) expect(id.length).toBeGreaterThan(0);
      expect(gm.minorLandmarkCount).not.toBeNull();
      expect(gm.minorLandmarkCount!).toBeGreaterThanOrEqual(2);
      expect(gm.minorLandmarkCount!).toBeLessThanOrEqual(3);
      expect(gm.rareLandmarkCount).not.toBeNull();
      expect(gm.rareLandmarkCount!).toBeLessThanOrEqual(16);

      // Ticket 06 (DEC-004): the manifest gains the fortress variant field —
      // the compound/Citadel template family this map rolled (10 standard /
      // 14 Citadel footprint). The Citadel-frequency audit surface.
      expect(gm.fortressVariant).not.toBeNull();
      expect([
        'CROSS_PARTITION',
        'PILLARED_HALL',
        'COURTYARD_RING',
        'LOOT_ARM',
        'CITADEL',
      ]).toContain(gm.fortressVariant);
      expect(gm.fortressSize).not.toBeNull();
      expect(gm.fortressSize).toBe(gm.fortressVariant === 'CITADEL' ? 14 : 10);

      // Ticket 08 (DEC-007): the manifest gains the skeleton/mirror fields —
      // a 4x4 skeleton (sub-variant) grid drawn from the 5-per-type library
      // and the per-sector mirror flags (both states appear across seeds;
      // any single map just needs the fields present and well-formed).
      expect(gm.sectorSkeletons).not.toBeNull();
      expect(gm.sectorSkeletons).toHaveLength(4);
      const skeletons = gm.sectorSkeletons!.flat();
      expect(skeletons).toHaveLength(16);
      const allSkeletonIds = new Set(Object.values(SUB_VARIANTS_BY_TYPE).flatMap((v) => [...v]));
      for (const id of skeletons) expect(allSkeletonIds.has(id)).toBe(true);
      expect(gm.sectorMirrored).not.toBeNull();
      expect(gm.sectorMirrored).toHaveLength(4);
      expect(gm.sectorMirrored!.flat()).toHaveLength(16);
      for (const flag of gm.sectorMirrored!.flat()) expect(typeof flag).toBe('boolean');
      expect(gm.mirroredSectorCount).not.toBeNull();
      expect(gm.mirroredSectorCount).toBeGreaterThanOrEqual(0);
      expect(gm.mirroredSectorCount!).toBeLessThanOrEqual(16);
      expect(gm.distinctSkeletonCount).not.toBeNull();
      expect(gm.distinctSkeletonCount!).toBeGreaterThanOrEqual(1);
      expect(gm.distinctSkeletonCount!).toBeLessThanOrEqual(20);

      // Ticket 09 (DEC-008): the manifest gains the zone determinism audit —
      // the zone RNG seed (derived from the FINAL map seed on the isolated
      // 'ZSEC' salt — no longer Date.now()) plus the telegraphed target-center
      // sequence captured from the ZoneWarning events during the run (the
      // same next-circle data clients render). Deterministic per bench seed:
      // two same-BENCH_SEED runs produce identical zone fields in the JSON
      // (modulo the established wall-clock masks — pinned by running the
      // standalone bench twice, per the determinism note on the ticket).
      const zone = gm.zone;
      expect(zone).not.toBeNull();
      expect(zone!.seed).not.toBeNull();
      // avalanche() returns an unsigned 32-bit integer.
      expect(Number.isInteger(zone!.seed)).toBe(true);
      expect(zone!.seed!).toBeGreaterThanOrEqual(0);
      expect(zone!.seed!).toBeLessThanOrEqual(0xffffffff);
      // Every captured telegraph is a well-formed next circle: a phase
      // index >= 2, a finite center, a positive radius.
      for (const c of zone!.centers) {
        expect(c.phase).toBeGreaterThanOrEqual(2);
        expect(c.radius).toBeGreaterThan(0);
        expect(Number.isFinite(c.x)).toBe(true);
        expect(Number.isFinite(c.y)).toBe(true);
      }
      // With the production phase table, the first ZoneWarning fires ~60s
      // into phase 2 (phase 1 suppresses the warning — `isWarning()` returns
      // false there and `update()`'s phase-1 branch returns before
      // `checkWarning()`), i.e. ~185s game-time. Any run of >= 240 game-time
      // seconds must have telegraphed at least the first next-circle. The CI
      // default is 120s (assertion skipped); the full standalone bench
      // (600s) captures the whole 5-warning sequence.
      if (config.durationSeconds >= 240) {
        expect(zone!.centers.length).toBeGreaterThanOrEqual(1);
      }

      // Ticket 10 (DEC-009): the manifest COMPLETION — macro shape (the
      // designation's shape vocabulary token), the fairness repair/attempt
      // counts, the post-repair equity worst ratios, and the drop/death
      // distribution audit. (The ≥10-seed distribution BOUNDS live in
      // map-distribution-audit.test.ts; here we assert presence +
      // well-formedness + the per-run drop band.)
      expect(gm.macroShape).not.toBeNull();
      expect(['RINGROAD', 'SPINEWAY', 'RIDGELINE', 'TWINFIELDS']).toContain(gm.macroShape);
      expect(gm.spawnRepairs).not.toBeNull();
      expect(gm.spawnRepairs).toBeGreaterThanOrEqual(0);
      expect(gm.spawnRepairs!).toBeLessThan(64);
      expect(gm.generationAttempts).toBe(1);
      expect(gm.equityMaxRatio).not.toBeNull();
      for (const component of ['weapon', 'chest', 'clump', 'hot'] as const) {
        expect(gm.equityMaxRatio![component]).toBeLessThanOrEqual(1.3 + 1e-9);
      }
      const dist10 = gm.distribution;
      expect(dist10).not.toBeNull();
      expect(dist10!.dropShareBySector).toHaveLength(16);
      expect(dist10!.first60sDeathShareBySector).toHaveLength(16);
      if (config.durationSeconds >= 70) {
        // The drop snapshot only exists once the match went ACTIVE. The
        // [2%, 20%] per-sector drop BAND needs a ~64-player lobby (this CI
        // form defaults to 24 bots, with which empty sectors are expected) —
        // it is asserted by the dedicated 63-bot map-distribution-audit test.
        expect(dist10!.dropTotal).toBe(config.botFillTo);
        expect(dist10!.dropShareBySector.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
      }

      // Ticket 05 (DEC-005): the manifest also carries the lighting-
      // discipline report — the ≤3-hue-family + value-band gates hold (any
      // residual violation is LOGGED here and fails CI), the POI glow layer
      // exists, dark pockets survive the hierarchy, and the on-screen static
      // sample stays far below the ≤80 client target.
      const lighting = gm.lighting;
      expect(lighting).not.toBeNull();
      expect(lighting!.hueViolations).toHaveLength(0);
      expect(lighting!.valueBandViolations).toHaveLength(0);
      expect(lighting!.byKind['beacon']).toBeGreaterThanOrEqual(18);
      expect(lighting!.poiGlowPools).toBeGreaterThan(0);
      expect(lighting!.darkPockets.count).toBeGreaterThan(0);
      expect(lighting!.darkPockets.coldSectorPockets).toBeGreaterThanOrEqual(4);
      expect(lighting!.maxViewportStatics).toBeLessThanOrEqual(20);
    }

    console.log(formatSummary(result));

    // Persist the report for inspection.
    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = join(here, '..', '..', 'bench-results');
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `bot-ai-ci-${Date.now()}.json`);
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`Report written to ${outFile}`);
  }, 180_000);
});

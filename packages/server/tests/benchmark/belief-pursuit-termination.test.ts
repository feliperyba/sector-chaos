import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, cleanup } from '../helpers/test-server.ts';
import { runBotBenchmark, type BenchmarkConfig } from '../helpers/bot-benchmark-harness.ts';

/**
 * Believed-state end-to-end gates (bot-ai-v2 ticket 05, DEC-003) on the
 * fast-forward harness: the belief-source mix is non-degenerate in a real
 * match (seen/heard/damage all written), investigations actually OPEN, and
 * — the revenge-pursuit TERMINATION gate — every opened pursuit ends
 * re-acquired or dropped within the search-failure bound. Bookkeeping
 * exhaustiveness: a pursuit can only be open while its bot is alive, so
 * started − (reacquired + dropped) is at most the number of bots still
 * alive at match end (each holds at most one open investigation).
 *
 * Short CI form (mirrors bot-ai-fullgame): 24 hard bots, 120s, procedural
 * map. Deterministic per seed — all counters are pure observations of the
 * tick stream (same-seed byte-identity contract).
 */
describe('believed-state telemetry + pursuit termination (full match)', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it('belief writes flow end-to-end and revenge pursuits terminate', async () => {
    const config: BenchmarkConfig = {
      botFillTo: 24,
      durationSeconds: 120,
      sampleEverySeconds: 15,
      seed: 1005,
      botDifficulty: 'hard',
      mapType: 'procedural',
      lastStandingThreshold: 1,
    };
    const result = await runBotBenchmark(server, config);
    const bv = result.believability.overall;

    // Belief-source mix: all three sources write in a real match —
    // sightings (perception scans), heard shots (attack stimuli with a
    // firer id), and damage-direction estimates (damage stimuli to
    // victims). A zero in any bucket means the wiring broke.
    expect(bv.beliefWritesBySource.seen ?? 0).toBeGreaterThan(0);
    expect(bv.beliefWritesBySource.heard ?? 0).toBeGreaterThan(0);
    expect(bv.beliefWritesBySource.damage ?? 0).toBeGreaterThan(0);
    expect(bv.beliefWritesTotal).toBe(
      (bv.beliefWritesBySource.seen ?? 0) +
        (bv.beliefWritesBySource.heard ?? 0) +
        (bv.beliefWritesBySource.damage ?? 0),
    );

    // Investigations open (armed bots chase out-of-scan beliefs)…
    expect(bv.pursuitsStarted).toBeGreaterThan(0);
    // …and TERMINATE: every started pursuit ends re-acquired or dropped,
    // except the at-most-one open investigation per bot still alive at
    // match end (all other terminal paths — search-failure, expiry,
    // elimination, death — close the pursuit).
    const openAtEnd = bv.pursuitsStarted - bv.pursuitsReacquired - bv.pursuitsDropped;
    expect(openAtEnd).toBeGreaterThanOrEqual(0);
    expect(openAtEnd).toBeLessThanOrEqual(result.finalSnapshot.aliveBots);
    // Terminations actually happened (the bound is exercised, not vacuous —
    // with zero terminations every pursuit would still be "open", which the
    // alive-bots bound above would then refute for any non-trivial match).
    expect(bv.pursuitsReacquired + bv.pursuitsDropped).toBeGreaterThan(0);
    // The per-outcome non-zero cuts (both outcomes occur) live in the FULL
    // bench, not this short CI form — same convention as the Reactor's
    // per-archetype gates.

    // The cuts carry the new surface (per-difficulty join intact).
    for (const agg of Object.values(result.believability.byDifficulty)) {
      expect(agg.beliefWritesTotal).toBeGreaterThanOrEqual(0);
      expect(agg.pursuitsStarted).toBeGreaterThanOrEqual(
        agg.pursuitsReacquired + agg.pursuitsDropped,
      );
    }
  }, 180_000);
});

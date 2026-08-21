import { describe, it, expect } from 'vitest';
import {
  ZONE,
  TILE_PIXEL_SIZE,
  SECTOR_TILE_SIZE,
  deriveZoneSeed,
  collectZoneBiasAnchors,
  ZONE_SEED_XOR,
  avalanche,
} from '@sector-battle/shared';
import { ZoneService } from '../../../src/domain/services/ZoneService.ts';
import { MapGenerator } from '../../../src/domain/services/MapGenerator.ts';
import type { MapResult } from '../../../src/domain/services/MapGenerator.ts';

/**
 * Zone determinism + landmark-biased endgame (map-redesign ticket 09 /
 * DEC-008 — GDD §5.4 "Zone center randomization uses the same seed").
 *
 * Pins the three ticket criteria at the domain seam (generation-only — no
 * room, no bots, no wall-clock):
 *  1. Same-seed replay: the zone seed derives from the MAP seed on an
 *     isolated salted stream (`deriveZoneSeed`), so two runs of the same map
 *     seed produce an IDENTICAL zone center sequence.
 *  2. Landmark bias sweep (≥50 seeds): the final-phase (phase 6 "Final
 *     Closure") center ends within ONE SECTOR of a hero landmark in ≥80% of
 *     seeds, and the bias measurably pulls finales toward landmarks (paired
 *     median distance vs the unbiased chain) while staying weighted-random,
 *     never forced.
 *  3. Telegraph data: every phase 1..6 (+OT) publishes a non-degenerate
 *     target circle (center + radius) the moment the phase begins — ≥1 phase
 *     of warning before the transition — and the ZoneWarning event carries
 *     that same next-circle payload.
 *
 * Phase table / damage / siege regression is covered by the UNMODIFIED
 * ZoneService.test.ts + siege suites (ticket criterion: they stay green
 * unmodified).
 */

const TILE = TILE_PIXEL_SIZE;
/** "One sector" proximity bar (world px) for the ≥80% finale criterion. */
const ONE_SECTOR_PX = SECTOR_TILE_SIZE * TILE;
/** Deterministic sweep seeds (generation-only; 50 full maps, a few seconds). */
const SWEEP_SEEDS: readonly number[] = Array.from({ length: 50 }, (_, i) => 1 + i);

interface Scenario {
  mapResult: MapResult;
  /** Full DEC-008 bias anchor set: hero landmarks + compound center. */
  anchors: Array<{ x: number; y: number }>;
  /** Hero-landmark anchors alone — the ticket criterion's proximity set. */
  heroAnchors: Array<{ x: number; y: number }>;
  bounds: { width: number; height: number };
}

function buildScenario(mapSeed: number): Scenario {
  const mapResult = new MapGenerator().generate(mapSeed);
  const raw = mapResult.rawMapData!;
  return {
    mapResult,
    anchors: collectZoneBiasAnchors(
      { landmarks: raw.landmarks, fortress: raw.fortress ?? null },
      TILE,
    ),
    heroAnchors: raw.landmarks.heroes.flat().map((h) => ({
      x: h.tileX * TILE + TILE / 2,
      y: h.tileY * TILE + TILE / 2,
    })),
    bounds: {
      width: mapResult.grid[0]!.length * TILE,
      height: mapResult.grid.length * TILE,
    },
  };
}

/** Drive the real ZoneService through every center-selecting phase advance. */
function runZoneChain(
  scenario: Scenario,
  biased: boolean,
): Array<{ phase: number; x: number; y: number }> {
  const svc = new ZoneService();
  svc.initialize(scenario.bounds, deriveZoneSeed(scenario.mapResult.seed));
  svc.setGrid(scenario.mapResult.grid);
  if (biased) svc.setLandmarkBias(scenario.anchors);
  const centers: Array<{ phase: number; x: number; y: number }> = [];
  for (let i = 0; i < 5; i++) {
    svc.advancePhase();
    const z = svc.getCurrentZone();
    centers.push({ phase: z.phase, x: z.targetCenterX, y: z.targetCenterY });
  }
  return centers;
}

function nearestAnchorDistance(
  anchors: Array<{ x: number; y: number }>,
  x: number,
  y: number,
): number {
  let best = Infinity;
  for (const a of anchors) {
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < best) best = d;
  }
  return best;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** Step game-time in ≤250ms chunks (ZoneService.update caps each call at 250ms). */
function advanceTime(svc: ZoneService, totalMs: number): void {
  let remaining = totalMs;
  while (remaining > 0) {
    const delta = Math.min(remaining, 250);
    svc.update(delta);
    remaining -= delta;
  }
}

describe('deriveZoneSeed (ticket 09 / DEC-008.1)', () => {
  it('is a pure function of the map seed (same seed ⇒ same zone seed)', () => {
    expect(deriveZoneSeed(12345)).toBe(deriveZoneSeed(12345));
    expect(deriveZoneSeed(1)).toBe(deriveZoneSeed(1));
  });

  it('routes through the isolated XOR salt + avalanche (ADR 0035 convention)', () => {
    // Pin the exact formula so a future refactor cannot silently re-salt
    // (which would change every map's zone story).
    expect(deriveZoneSeed(12345)).toBe(avalanche(12345 ^ ZONE_SEED_XOR));
  });

  it('decorrelates consecutive map seeds (avalanche spreads low-bit differences)', () => {
    let rotated = 0;
    const tested = 200;
    for (let s = 0; s < tested; s++) {
      if (deriveZoneSeed(s) !== deriveZoneSeed(s + 1)) rotated++;
    }
    // The measured failure mode without the avalanche (lootTiers docs) was
    // ~3% rotation on nearby seeds. Require ≥90% decorrelation.
    expect(rotated / tested).toBeGreaterThan(0.9);
  });
});

describe('collectZoneBiasAnchors (ticket 09 / DEC-008.2)', () => {
  it('places every hero anchor at its tile center in world px', () => {
    const { mapResult, anchors } = buildScenario(7);
    const raw = mapResult.rawMapData!;
    const heroes = raw.landmarks.heroes.flat();
    expect(anchors.length).toBe(heroes.length + (raw.fortress ? 1 : 0));
    const first = heroes[0]!;
    expect(anchors[0]).toEqual({
      x: first.tileX * TILE + TILE / 2,
      y: first.tileY * TILE + TILE / 2,
    });
  });

  it('includes the compound center when a fortress was placed', () => {
    const { mapResult, anchors } = buildScenario(7);
    const raw = mapResult.rawMapData!;
    const f = raw.fortress!;
    expect(f).toBeDefined();
    expect(anchors[anchors.length - 1]).toEqual({
      x: (f.originCol + f.size / 2) * TILE,
      y: (f.originRow + f.size / 2) * TILE,
    });
  });
});

describe('zone same-seed replay (ticket 09 / DEC-008.1, GDD §5.4)', () => {
  it('two runs of the same map seed produce an identical zone center sequence', () => {
    const scenario = buildScenario(42);
    const run1 = runZoneChain(scenario, true);
    const run2 = runZoneChain(scenario, true);
    expect(run2).toEqual(run1);
    expect(run1.map((c) => c.phase)).toEqual([2, 3, 4, 5, 6]);
  });

  it('holds with the bias off too (the unbiased walk is equally seed-pinned)', () => {
    const scenario = buildScenario(99);
    expect(runZoneChain(scenario, false)).toEqual(runZoneChain(scenario, false));
  });

  it('a different map seed yields a different zone story', () => {
    const a = runZoneChain(buildScenario(42), true);
    const b = runZoneChain(buildScenario(43), true);
    // Not a strict guarantee for arbitrary pairs (both are random walks),
    // but adjacent seeds with the avalanche decorrelation must differ.
    expect(a).not.toEqual(b);
  });

  it('zone geometry ignores the wall clock', () => {
    const scenario = buildScenario(42);
    const run1 = runZoneChain(scenario, true);
    // Freeze the reported wall clock 10 minutes ahead between runs — zone
    // GEOMETRY is map-seed-derived, so the second run must match exactly.
    // (Phase TIMING still reads the clock by design; geometry must not.)
    const realNow = Date.now;
    let fake = realNow() + 10 * 60 * 1000;
    Date.now = () => fake;
    try {
      const run2 = runZoneChain(scenario, true);
      expect(run2).toEqual(run1);
      fake += 10 * 60 * 1000;
      expect(runZoneChain(scenario, true)).toEqual(run1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('landmark-biased endgame sweep (ticket 09 / DEC-008.2)', () => {
  it('≥80% of a 50-seed sweep ends within one sector of a hero landmark', () => {
    let within = 0;
    for (const seed of SWEEP_SEEDS) {
      const scenario = buildScenario(seed);
      const finale = runZoneChain(scenario, true).at(-1)!;
      // Strict ticket wording: proximity to a HERO landmark (the bias set
      // also includes the compound per DEC-008, but the criterion counts
      // hero landmarks).
      if (nearestAnchorDistance(scenario.heroAnchors, finale.x, finale.y) <= ONE_SECTOR_PX) {
        within++;
      }
    }
    // Measured: 50/50 (100%) — every sector carries a hero landmark
    // (ticket 04), and the finale lands in the landmark-blanketed center
    // band with the bias pulling it tighter.
    expect(within / SWEEP_SEEDS.length).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it('the bias measurably pulls finales toward landmarks (paired medians, biased < unbiased)', () => {
    const biasedDists: number[] = [];
    const unbiasedDists: number[] = [];
    for (const seed of SWEEP_SEEDS) {
      const scenario = buildScenario(seed);
      const biasedFinale = runZoneChain(scenario, true).at(-1)!;
      const unbiasedFinale = runZoneChain(scenario, false).at(-1)!;
      biasedDists.push(nearestAnchorDistance(scenario.anchors, biasedFinale.x, biasedFinale.y));
      unbiasedDists.push(
        nearestAnchorDistance(scenario.anchors, unbiasedFinale.x, unbiasedFinale.y),
      );
    }
    // The weighted candidate scoring shifts the finale toward structured
    // ground on average (measured: median 1009px → 895px over seeds 1..50).
    expect(median(biasedDists)).toBeLessThan(median(unbiasedDists));
  }, 120_000);

  it('bias is weighted-random, not forced: the roll lands both closer AND farther than the unbiased chain', () => {
    let closer = 0;
    let farther = 0;
    for (const seed of SWEEP_SEEDS) {
      const scenario = buildScenario(seed);
      const biasedFinale = runZoneChain(scenario, true).at(-1)!;
      const unbiasedFinale = runZoneChain(scenario, false).at(-1)!;
      const dBiased = nearestAnchorDistance(scenario.anchors, biasedFinale.x, biasedFinale.y);
      const dUnbiased = nearestAnchorDistance(scenario.anchors, unbiasedFinale.x, unbiasedFinale.y);
      if (dBiased < dUnbiased - 1) closer++;
      if (dBiased > dUnbiased + 1) farther++;
    }
    // A FORCED pick (argmin toward the nearest anchor) would essentially
    // never do worse than the unbiased roll. The weighted roll does both:
    // it prefers near-landmark candidates (closer in most seeds) but can
    // still land on a farther one (bias, not guarantee — DEC-008).
    expect(closer).toBeGreaterThan(farther);
    expect(farther).toBeGreaterThan(0);
  }, 120_000);
});

describe('next-circle telegraph data per phase (ticket 09 / DEC-008.3)', () => {
  /**
   * For EVERY phase 1..6 (+ OT): the moment a phase begins, the published
   * zone state carries a non-degenerate target circle — the client target
   * ring (`ZoneRenderer.targetCircle`, driven by targetCenterX/Y +
   * targetRadius through StateSync → updateZoneRenderer) has data to render
   * for the entire phase, i.e. ≥1 phase of warning before the circle
   * arrives. The ZoneWarning event must carry the same next-circle payload.
   */
  it('publishes a valid target circle at every phase start (1..7)', () => {
    const scenario = buildScenario(5);
    const svc = new ZoneService();
    svc.initialize(scenario.bounds, deriveZoneSeed(scenario.mapResult.seed));
    svc.setGrid(scenario.mapResult.grid);
    svc.setLandmarkBias(scenario.anchors);

    // Phase 1 (initialize): target = full map circle at map center.
    let z = svc.getCurrentZone();
    expect(z.targetRadius).toBeGreaterThan(0);
    expect(z.targetCenterX).toBe(scenario.bounds.width / 2);
    expect(z.targetCenterY).toBe(scenario.bounds.height / 2);

    // Phases 2..7: each advance publishes the new target immediately.
    for (let phase = 2; phase <= 7; phase++) {
      svc.advancePhase();
      z = svc.getCurrentZone();
      expect(z.phase).toBe(phase);
      expect(z.targetRadius).toBeGreaterThan(0);
      expect(Number.isFinite(z.targetCenterX)).toBe(true);
      expect(Number.isFinite(z.targetCenterY)).toBe(true);
      // The target circle stays inside the map at every phase.
      expect(z.targetCenterX).toBeGreaterThanOrEqual(0);
      expect(z.targetCenterX).toBeLessThanOrEqual(scenario.bounds.width);
      expect(z.targetCenterY).toBeGreaterThanOrEqual(0);
      expect(z.targetCenterY).toBeLessThanOrEqual(scenario.bounds.height);
    }
  });

  it('the ZoneWarning event telegraphs the same next circle for every phase (2..6)', () => {
    const scenario = buildScenario(5);
    const svc = new ZoneService();
    svc.initialize(scenario.bounds, deriveZoneSeed(scenario.mapResult.seed));
    svc.setGrid(scenario.mapResult.grid);
    svc.setLandmarkBias(scenario.anchors);
    svc.advancePhase(); // into phase 2
    svc.drainEvents();

    // Advance just past each phase's warning trigger (stable duration minus
    // the warning window), collect exactly one warning per phase, then run
    // out the rest of the phase to reach the next advance.
    const transitionMs = ZONE.ZONE_TRANSITION_DURATION * 1000;
    const warningMs = ZONE.ZONE_WARNING_TIME * 1000;
    const warnings: Array<{ phase: number; x: number; y: number; radius: number }> = [];
    for (let phase = 2; phase <= 6; phase++) {
      const duration = svc.getPhaseDuration(phase);
      const warningStartsAt = duration - transitionMs - warningMs;
      advanceTime(svc, warningStartsAt + 1);
      const events = svc.drainEvents().filter((e) => e.type === 'ZoneWarning');
      expect(events, `phase ${phase} must fire exactly one ZoneWarning`).toHaveLength(1);
      const w = events[0] as unknown as {
        nextPhaseIndex: number;
        nextCenterX: number;
        nextCenterY: number;
        nextRadius: number;
      };
      expect(w.nextPhaseIndex).toBe(phase + 1);
      expect(w.nextRadius).toBeGreaterThan(0);
      expect(Number.isFinite(w.nextCenterX)).toBe(true);
      expect(Number.isFinite(w.nextCenterY)).toBe(true);
      warnings.push({ phase, x: w.nextCenterX, y: w.nextCenterY, radius: w.nextRadius });
      advanceTime(svc, duration - (warningStartsAt + 1) + 1);
    }
    // Every center-selecting phase telegraphed its target circle.
    expect(warnings.map((w) => w.phase)).toEqual([2, 3, 4, 5, 6]);
  });

  it('final-phase (6) target center is selected via the biased path but obeys §8.1.6 constraints', () => {
    const scenario = buildScenario(11);
    const svc = new ZoneService();
    svc.initialize(scenario.bounds, deriveZoneSeed(scenario.mapResult.seed));
    svc.setGrid(scenario.mapResult.grid);
    svc.setLandmarkBias(scenario.anchors);
    for (let i = 0; i < 4; i++) svc.advancePhase();
    const phase5 = svc.getCurrentZone();
    svc.advancePhase(); // into phase 6 — biased selection
    const z = svc.getCurrentZone();
    expect(z.phase).toBe(6);
    // Boundary buffer respected: center keeps the new radius inside the map.
    expect(z.targetCenterX).toBeGreaterThanOrEqual(z.targetRadius - 1);
    expect(z.targetCenterX).toBeLessThanOrEqual(scenario.bounds.width - z.targetRadius + 1);
    expect(z.targetCenterY).toBeGreaterThanOrEqual(z.targetRadius - 1);
    expect(z.targetCenterY).toBeLessThanOrEqual(scenario.bounds.height - z.targetRadius + 1);
    // Selected within the current safe zone (maxOffset = 0.8 × phase-5 radius).
    const maxOffset = phase5.targetRadius * (1 - ZONE.ZONE_CENTER_MIN_BOUNDARY_RATIO);
    const drift = Math.hypot(
      z.targetCenterX - phase5.targetCenterX,
      z.targetCenterY - phase5.targetCenterY,
    );
    expect(drift).toBeLessThanOrEqual(maxOffset + 1);
  });
});

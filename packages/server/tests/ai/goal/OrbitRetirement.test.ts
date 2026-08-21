/**
 * Orbit-retirement + wander-noise retirement tests — bot-ai-v2 ticket 07
 * (DEC-008). GREP-PROOF assertions plus the positional-autocorrelation
 * measurable that the bench gate (sweep-time) consumes.
 *
 * The retired patterns (AUDIT §10a.7 / §10c.1):
 *  - the HUNT priority-3 geometric orbit: deterministic id-hash angle +
 *    ~37° advance per repath ring around the zone center;
 *  - the random barrel-sparse wander target (findBarrelSparseTarget,
 *    re-picked every 120 ticks with no memory or objective).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ringOrbitScore } from '../../../src/ai/goal/GoalBinding.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const AI_SRC = join(HERE, '../../../src/ai');

function readSrc(rel: string): string {
  return readFileSync(join(AI_SRC, rel), 'utf8');
}

/** Strip block comments and line comments — the retirement documentation
 *  MENTIONS the retired patterns; the grep proofs assert the CODE is gone. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

// ---------------------------------------------------------------------------
// grep-proof: the retired patterns are GONE from the executor sources
// ---------------------------------------------------------------------------

describe('retired pattern grep-proofs', () => {
  it('the 37° repath-ring orbit is gone from the roam executors', () => {
    const src = stripComments(readSrc('BotRoamExecutors.ts'));
    // The orbit's signature: an angle advanced by a fixed degree step per
    // repath counter. The executor code must contain neither the step nor
    // the per-repath counter driving an angle sweep.
    expect(src).not.toMatch(/orbitOffset/);
    expect(src).not.toMatch(/% 360/); // the degree-wrap of the swept angle
    expect(src).not.toMatch(/repathCount/);
    expect(src).not.toContain('37'); // the retired angular step
    expect(src).not.toMatch(/radiusJitter/);
  });

  it('the id-hash radial angle helper is deleted (no consumers remain)', () => {
    expect(stripComments(readSrc('BotSystemConstants.ts'))).not.toContain('hashPlayerIdAngle');
    expect(readSrc('BotRoamExecutors.ts')).not.toContain('hashPlayerIdAngle');
  });

  it('the random barrel-sparse wander picker is deleted everywhere', () => {
    expect(stripComments(readSrc('BotSpatialIndex.ts'))).not.toContain('findBarrelSparseTarget');
    // Comments may MENTION the retired picker (the retirement ledger) — the
    // grep proof asserts the CODE is gone, hence stripComments here too.
    expect(stripComments(readSrc('BotRoamExecutors.ts'))).not.toContain('findBarrelSparseTarget');
  });

  it('the hunt/hotspot repath cadence constants are retired with the branch', () => {
    const constants = stripComments(readSrc('BotSystemConstants.ts'));
    expect(constants).not.toContain('HUNT_REPATH_TICKS');
    expect(constants).not.toContain('HOTSPOT_REPATH_TICKS');
  });

  it('the executors BIND to the macro-goal (goalNavTarget consumed)', () => {
    const roam = readSrc('BotRoamExecutors.ts');
    expect(roam).toContain('goalNavTarget');
    const economy = readSrc('BotEconomyExecutors.ts');
    expect(economy).toContain("['LOOT_CLUSTER']");
  });

  it('no RNG draws and no wall-clock reads in the goal modules', () => {
    for (const f of [
      'goal/GoalTypes.ts',
      'goal/GoalTables.ts',
      'goal/GoalScoring.ts',
      'goal/GoalGenerator.ts',
      'goal/GoalBinding.ts',
      'goal/ZoneTiming.ts',
    ]) {
      const src = readSrc(f);
      // Docs may NAME the retired patterns (Math.random / Date.now prose) —
      // the proof is about CODE, so comments are stripped first.
      expect(stripComments(src)).not.toContain('Math.random');
      expect(stripComments(src)).not.toContain('Date.now');
      expect(stripComments(src)).not.toContain('performance.now');
      // ctx.rng / rng.next would be legal per-bot draws — the scoring seam
      // is stricter: fully deterministic, zero draws.
      if (f === 'goal/GoalScoring.ts' || f === 'goal/GoalGenerator.ts') {
        expect(src).not.toMatch(/\brng\b/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The orbit MEASURABLE (positional autocorrelation — the bench gate input)
// ---------------------------------------------------------------------------

describe('ringOrbitScore (the orbit-retirement measurable)', () => {
  const CX = 5120;
  const CY = 5120;
  const R = 1000;

  /** SYNTHETIC retired pattern: the 37°-per-repath ring sweep (samples every
   *  40 ticks, angle advancing 37° each — the AUDIT §10a.7 geometry). */
  function syntheticOrbit(
    samples = 24,
    stepDeg = 37,
    startDeg = 90,
  ): Array<{
    x: number;
    y: number;
    tick: number;
  }> {
    const out: Array<{ x: number; y: number; tick: number }> = [];
    for (let i = 0; i < samples; i++) {
      const a = ((startDeg + i * stepDeg) * Math.PI) / 180;
      out.push({ x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R, tick: i * 40 });
    }
    return out;
  }

  it('flags the retired 37° ring sweep as orbital', () => {
    const score = ringOrbitScore(syntheticOrbit(), CX, CY);
    expect(score.orbital).toBe(true);
    expect(score.signConsistency).toBeGreaterThanOrEqual(0.85);
    expect(Math.abs(score.meanStepDeg)).toBeCloseTo(37, 0);
  });

  it('goal-driven movement (committed destinations, re-scored on cadence) is NOT orbital', () => {
    // A bot alternating between two committed hold points with varying
    // radial depth — the committed-goal signature: arrive, hold, re-score,
    // head elsewhere, reverse. The angular sign flips every leg (no
    // sustained same-sign sweep) and the radius varies (not a ring).
    const goalDriven: Array<{ x: number; y: number; tick: number }> = [];
    for (let i = 0; i < 12; i++) {
      const east = i % 2 === 0;
      const r = 700 + ((i * 137) % 500); // varying radial depth
      const lateral = east ? 400 : -400;
      goalDriven.push({
        x: CX + (east ? r : -r),
        y: CY + lateral,
        tick: i * 45,
      });
    }
    const score = ringOrbitScore(goalDriven, CX, CY);
    expect(score.orbital).toBe(false);
    expect(score.signConsistency).toBeLessThan(0.85);
  });

  it('a radial approach/retreat (no rotation) is NOT orbital', () => {
    const radial: Array<{ x: number; y: number; tick: number }> = [];
    for (let i = 0; i < 12; i++) {
      const r = 400 + i * 120;
      radial.push({ x: CX + r, y: CY, tick: i * 40 });
    }
    const score = ringOrbitScore(radial, CX, CY);
    expect(score.orbital).toBe(false);
    expect(score.signConsistency).toBeLessThan(0.85);
  });

  it('too few samples is never orbital (defensive)', () => {
    expect(ringOrbitScore(syntheticOrbit(5), CX, CY).orbital).toBe(false);
    expect(ringOrbitScore([], CX, CY).orbital).toBe(false);
  });
});

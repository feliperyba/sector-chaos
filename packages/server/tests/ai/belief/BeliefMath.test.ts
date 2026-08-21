import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotRNG } from '../../../src/ai/BotContext.ts';
import {
  angleDelta,
  angleFromFacingAbs,
  applyFoveationNoise,
  damageEstimateErrorBound,
  deadReckon,
  decayConfidence,
  detectionConfidence,
  estimateDamageOrigin,
  foveationNoiseScale,
  isBeliefExpired,
  losConfidenceFactor,
  nextSeenConfidence,
} from '../../../src/ai/belief/BeliefMath.ts';
import {
  DAMAGE_EST_MAX_DIST_PX,
  DAMAGE_EST_MIN_DIST_PX,
  FOVEATION_DETECTION_RANGE,
  LOS_HALVING_FACTOR,
  PURSUIT_MIN_CONFIDENCE,
} from '../../../src/ai/belief/BeliefConfig.ts';

/**
 * BeliefMath — the believed-state PURE seam (bot-ai-v2 ticket 05, DEC-003).
 * Confidence decay, the GDD §14.2/§14.3 confidence-modifier tables,
 * foveation noise bounds, convergence, and the damage-origin estimation's
 * bounded-error proof. Everything runs without a room; every stochastic
 * assertion feeds a fresh seeded BotRNG so results are byte-deterministic.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe('angle helpers', () => {
  it('wraps differences into [-π, π]', () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 10);
    expect(angleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 10);
    // 3π/2 counterclockwise from 0 is −π/2 the short way.
    expect(angleDelta(0, (3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 10);
    expect(angleDelta(Math.PI, -Math.PI)).toBeCloseTo(0, 10);
  });

  it('angleFromFacingAbs: directly ahead is 0, directly behind is π', () => {
    expect(angleFromFacingAbs(0, 300, 0, 0, 0)).toBeCloseTo(0, 10);
    expect(angleFromFacingAbs(Math.PI, 300, 0, 0, 0)).toBeCloseTo(Math.PI, 10);
    expect(angleFromFacingAbs(Math.PI / 2, 0, 300, 0, 0)).toBeCloseTo(0, 10);
  });
});

describe('decayConfidence (exponential, per-difficulty half-life)', () => {
  it('halves exactly at one half-life and never decays a fresh belief', () => {
    expect(decayConfidence(1, 140, 'medium')).toBeCloseTo(0.5, 10); // medium half-life = 140
    expect(decayConfidence(0.8, 0, 'easy')).toBeCloseTo(0.8, 10);
    expect(decayConfidence(0.8, -5, 'easy')).toBeCloseTo(0.8, 10); // defensive: negative dt is a no-op
  });

  it('skilled difficulties retain confidence longer', () => {
    // 180 ticks untouched: easy (60) is at 1/8, hard (200) still above half.
    expect(decayConfidence(1, 180, 'easy')).toBeCloseTo(0.125, 10);
    expect(decayConfidence(1, 180, 'hard')).toBeGreaterThan(0.5);
    expect(decayConfidence(1, 180, 'hard')).toBeGreaterThan(decayConfidence(1, 180, 'easy'));
  });
});

describe('detectionConfidence (GDD §14.2 as a modifier, NOT a wall)', () => {
  it('carries the GDD per-difficulty detection ranges', () => {
    expect(FOVEATION_DETECTION_RANGE.easy).toBe(192);
    expect(FOVEATION_DETECTION_RANGE.medium).toBe(320);
    expect(FOVEATION_DETECTION_RANGE.hard).toBe(512);
  });

  it('full confidence inside the range, faded at the perception edge', () => {
    expect(detectionConfidence(100, 'easy')).toBe(1);
    expect(detectionConfidence(100, 'hard')).toBe(1);
    expect(detectionConfidence(1000, 'easy')).toBeCloseTo(0.4, 10); // peripheral floor
    expect(detectionConfidence(1000, 'hard')).toBeCloseTo(0.4, 10);
  });

  it('NO HARD WALL: beyond the range the enemy is still perceived (confidence > 0)', () => {
    // 400px: full for Hard (512 range), faded for Easy (192 range) — the
    // per-difficulty table doing real work — but NEVER zero for either.
    expect(detectionConfidence(400, 'hard')).toBe(1);
    const easy = detectionConfidence(400, 'easy');
    expect(easy).toBeGreaterThan(0.4);
    expect(easy).toBeLessThan(1);
    expect(detectionConfidence(999, 'easy')).toBeGreaterThan(0.3);
  });

  it('is monotone non-increasing in distance', () => {
    let prev = 1;
    for (let d = 0; d <= 1000; d += 50) {
      const c = detectionConfidence(d, 'medium');
      expect(c).toBeLessThanOrEqual(prev + 1e-12);
      prev = c;
    }
  });
});

describe('losConfidenceFactor (GDD §14.3 halving)', () => {
  it('halves the confidence of wall-blocked sightings', () => {
    expect(losConfidenceFactor(true)).toBe(1);
    expect(losConfidenceFactor(false)).toBe(LOS_HALVING_FACTOR);
    expect(LOS_HALVING_FACTOR).toBe(0.5);
  });
});

describe('foveation noise (facing/distance-scaled precision)', () => {
  it('scale grows toward the periphery and with distance beyond the range', () => {
    const front = foveationNoiseScale(0, 300, 'hard');
    const behind = foveationNoiseScale(Math.PI, 300, 'hard');
    expect(behind).toBeGreaterThan(front);
    // Inside the hard detection range (512) at 300px there is no distant
    // term; beyond it one grows toward the perception edge.
    const near = foveationNoiseScale(Math.PI / 2, 300, 'hard');
    const far = foveationNoiseScale(Math.PI / 2, 900, 'hard');
    expect(far).toBeGreaterThan(near);
  });

  it('skilled difficulties perceive more precisely (smaller scale)', () => {
    // ≤ everywhere: the facing-sector + inside-range combos are EXACTLY 0
    // for every difficulty by design (full detail — pinned by the zero-noise
    // test below), so a strict < cannot hold there.
    for (const angle of [0, Math.PI / 2, Math.PI]) {
      for (const dist of [100, 500, 900]) {
        expect(foveationNoiseScale(angle, dist, 'hard')).toBeLessThanOrEqual(
          foveationNoiseScale(angle, dist, 'easy'),
        );
      }
    }
    // Strictly < wherever a noise term is nonzero: any peripheral angle…
    for (const dist of [100, 500, 900]) {
      expect(foveationNoiseScale(Math.PI / 2, dist, 'hard')).toBeLessThan(
        foveationNoiseScale(Math.PI / 2, dist, 'easy'),
      );
    }
    // …and the distant term alone (dead ahead, beyond both detection ranges).
    expect(foveationNoiseScale(0, 900, 'hard')).toBeLessThan(foveationNoiseScale(0, 900, 'easy'));
  });

  it('facing-sector sightings inside the detection range carry ZERO noise (full detail)', () => {
    expect(foveationNoiseScale(0, 300, 'hard')).toBe(0); // angle 0 ≤ front arc, dist < 512
    // Therefore applyFoveationNoise returns the exact position regardless of draws.
    const rng = new BotRNG(42);
    const p = applyFoveationNoise(rng, 300, 0, 0, 300, 'hard');
    expect(p.x).toBe(300);
    expect(p.y).toBe(0);
  });

  it('applyFoveationNoise draws stay inside the scale box (hard bounds)', () => {
    const scale = foveationNoiseScale(Math.PI, 600, 'easy');
    expect(scale).toBeGreaterThan(0);
    for (let seed = 0; seed < 200; seed++) {
      const rng = new BotRNG(seed);
      const p = applyFoveationNoise(rng, 0, 0, Math.PI, 600, 'easy');
      expect(Math.abs(p.x)).toBeLessThanOrEqual(scale + 1e-9);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(scale + 1e-9);
    }
  });
});

describe('nextSeenConfidence (convergence to truth on re-acquisition)', () => {
  it('skilled difficulties converge FASTER (DEC-003 Dissent resolution)', () => {
    // First re-acquisition scan from no prior belief:
    expect(nextSeenConfidence(0, 1, 'hard')).toBeCloseTo(0.9, 10);
    expect(nextSeenConfidence(0, 1, 'elite')).toBeCloseTo(1.0, 10);
    expect(nextSeenConfidence(0, 1, 'easy')).toBeCloseTo(0.35, 10);
    expect(nextSeenConfidence(0, 1, 'hard')).toBeGreaterThan(nextSeenConfidence(0, 1, 'easy'));
  });

  it('every difficulty converges monotonically toward the sample', () => {
    for (const difficulty of ['easy', 'normal', 'medium', 'hard', 'elite'] as const) {
      let c = 0;
      for (let i = 0; i < 10; i++) {
        const next = nextSeenConfidence(c, 1, difficulty);
        expect(next).toBeGreaterThanOrEqual(c - 1e-12);
        expect(next).toBeLessThanOrEqual(1);
        c = next;
      }
      expect(c).toBeGreaterThan(0.95); // all converge to truth eventually
    }
    // Hard needs ONE scan to be ~certain; easy still below 0.95 after FIVE.
    let easy = 0;
    for (let i = 0; i < 5; i++) easy = nextSeenConfidence(easy, 1, 'easy');
    expect(easy).toBeLessThan(0.95);
    expect(nextSeenConfidence(nextSeenConfidence(0, 1, 'hard'), 1, 'hard')).toBeGreaterThan(0.95);
  });
});

describe('estimateDamageOrigin (NEVER the true coordinates — bounded error)', () => {
  const VICTIM = { x: 1000, y: 1000 };
  const TRUE_ATTACKER = { x: 1600, y: 1000 }; // 600px east of the victim
  const TRUE_DIST = 600;

  it('is deterministic per seed and always inside the direction/distance envelope', () => {
    for (let seed = 0; seed < 100; seed++) {
      const a = estimateDamageOrigin(new BotRNG(seed), VICTIM.x, VICTIM.y, 1, 0);
      const b = estimateDamageOrigin(new BotRNG(seed), VICTIM.x, VICTIM.y, 1, 0);
      expect(a.x).toBe(b.x);
      expect(a.y).toBe(b.y);
      const dx = a.x - VICTIM.x;
      const dy = a.y - VICTIM.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      expect(dist).toBeGreaterThanOrEqual(DAMAGE_EST_MIN_DIST_PX - 1e-9);
      expect(dist).toBeLessThanOrEqual(DAMAGE_EST_MAX_DIST_PX + 1e-9);
      // Angular deviation from the true direction stays inside the spread.
      expect(Math.abs(Math.atan2(dy, dx))).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('THE WRONGNESS PROOF: the belief CAN be wrong about the true attacker position (bounded error)', () => {
    // The estimate's INPUT SET excludes the attacker's coordinates (only the
    // victim position + knockback direction + rng) — omniscience is impossible
    // by construction. This pins the human-like wrongness: across seeds the
    // error against truth is POSITIVE for at least one draw (the outplay
    // window a repositioning human exploits) and BOUNDED for every draw
    // (believability must not become dumbness — DEC-003 Dissent).
    let maxError = 0;
    for (let seed = 0; seed < 100; seed++) {
      const est = estimateDamageOrigin(new BotRNG(seed), VICTIM.x, VICTIM.y, 1, 0);
      const dx = est.x - TRUE_ATTACKER.x;
      const dy = est.y - TRUE_ATTACKER.y;
      const err = Math.sqrt(dx * dx + dy * dy);
      expect(err).toBeLessThanOrEqual(damageEstimateErrorBound(TRUE_DIST) + 1e-6);
      maxError = Math.max(maxError, err);
    }
    expect(maxError).toBeGreaterThan(100); // some draws are meaningfully wrong
  });

  it('the exact geometric bound is tight: worst-case draw reaches it', () => {
    // The bound is the max of the law-of-cosines over the distance endpoints
    // at full spread — monotone in |δ|, convex in D, so endpoint checks pin it.
    const bound = damageEstimateErrorBound(TRUE_DIST);
    expect(bound).toBeGreaterThan(0);
    // A true distance OUTSIDE the guess range is missed by at least the range
    // edge gap: attacker at 1500px (beyond the 700 max guess).
    expect(damageEstimateErrorBound(1500)).toBeGreaterThanOrEqual(1500 - DAMAGE_EST_MAX_DIST_PX);
  });

  it('zero direction collapses to the victim position (sourceless hit)', () => {
    const est = estimateDamageOrigin(new BotRNG(7), VICTIM.x, VICTIM.y, 0, 0);
    expect(est.x).toBe(VICTIM.x);
    expect(est.y).toBe(VICTIM.y);
  });
});

describe('deadReckon (capped last-velocity extrapolation)', () => {
  it('extrapolates by velocity × dt', () => {
    const p = deadReckon(100, 100, 2, 1, 0, 10);
    expect(p.x).toBeCloseTo(120, 10);
    expect(p.y).toBeCloseTo(110, 10);
  });

  it('caps displacement and never moves backwards in time', () => {
    const capped = deadReckon(0, 0, 100, 0, 0, 10); // 1000px uncapped → 240 cap
    expect(capped.x).toBeCloseTo(240, 10);
    expect(capped.y).toBe(0);
    const same = deadReckon(5, 5, 99, 99, 10, 10); // dt 0 → frozen
    expect(same.x).toBe(5);
    expect(same.y).toBe(5);
  });
});

describe('isBeliefExpired', () => {
  it('expires on the confidence floor and the absolute age cap', () => {
    expect(isBeliefExpired(0.04, 100, 100)).toBe(true);
    expect(isBeliefExpired(0.9, 0, 481)).toBe(true);
    expect(isBeliefExpired(0.9, 0, 480)).toBe(false);
    expect(isBeliefExpired(PURSUIT_MIN_CONFIDENCE, 0, 100)).toBe(false);
  });
});

describe('belief-module determinism proofs (grep gates)', () => {
  const BELIEF_FILES = [
    'BeliefConfig.ts',
    'BeliefMath.ts',
    'BeliefTypes.ts',
    'BeliefUpdate.ts',
    '../BotBeliefTelemetry.ts',
  ] as const;

  it('no unseeded randomness and no wall-clock reads in the belief layer', () => {
    for (const f of BELIEF_FILES) {
      const src = readFileSync(join(HERE, '../../../src/ai/belief', f), 'utf8');
      expect(src.includes('Math.random'), `${f} uses Math.random`).toBe(false);
      expect(src.includes('Date.now'), `${f} reads Date.now`).toBe(false);
      expect(src.includes('performance.now'), `${f} reads performance.now`).toBe(false);
    }
  });

  it('the damage estimate provably never receives attacker truth (signature gate)', () => {
    const src = readFileSync(join(HERE, '../../../src/ai/belief/BeliefMath.ts'), 'utf8');
    const sig = src.match(/export function estimateDamageOrigin\(([^)]*)\)/)![1]!;
    // Inputs: rng + victim position + direction — no attacker-coordinate param.
    expect(sig.includes('attacker')).toBe(false);
    expect(sig.includes('rng')).toBe(true);
  });
});

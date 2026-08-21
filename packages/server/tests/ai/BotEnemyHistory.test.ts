import { describe, it, expect } from 'vitest';
import { angleTo, absAngleDelta } from '@sector-battle/shared';
import { BotContext } from '../../src/ai/BotContext.ts';
import { EnemyHistoryRing, ENEMY_HISTORY_MAX_ENEMIES } from '../../src/ai/BotEnemyHistory.ts';
import { predictAim } from '../../src/ai/BotCombatShared.ts';
import type { EnemyInfo } from '../../src/ai/BotContextTypes.ts';
import {
  recordEnemyPosition,
  getEnemyHistory,
  clearEnemyHistory,
  pruneEnemyHistory,
} from '../../src/ai/BotContextEnemyHistory.ts';

/**
 * Ticket 28 — bot-enemy-history-ring.
 *
 * Locks three properties of the per-bot enemy position history:
 *
 *   1. RING ≡ ARRAY: over randomized push sequences (including wraparound
 *      past the 8-slot capacity), the ring exposes exactly the same samples
 *      in the same chronological order as the old `push()` + `shift()`-at-8
 *      array — including the 5-most-recent window `predictAim` reads
 *      (formerly `history.slice(-5)`).
 *   2. READER EQUIVALENCE: `predictAim` (ring storage) returns bit-identical
 *      angles to a verbatim copy of the pre-ticket array-based implementation
 *      fed the same samples and the same RNG stream.
 *   3. LRU BOUND: the history map is capped at ENEMY_HISTORY_MAX_ENEMIES;
 *      eviction removes least-recently-seen entries only, at prune time, and
 *      never removes the current target's or nearest enemy's entry (the two
 *      ids whose history aim prediction actually reads).
 *   4. ZERO-ALLOC STEADY STATE: slot objects are reused in place — the set of
 *      distinct sample object identities never exceeds the 8 slots.
 */

/** Deterministic LCG — same discipline as BotRNG (no Math.random anywhere). */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The OLD storage semantics, verbatim: push + shift-at-8 (BotContext pre-28). */
class ArrayHistory {
  arr: Array<{ x: number; y: number; vx: number; vy: number; t: number }> = [];
  push(x: number, y: number, vx: number, vy: number, t: number): void {
    this.arr.push({ x, y, vx, vy, t });
    if (this.arr.length > 8) this.arr.shift();
  }
}

interface Sample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

/** The OLD reader window semantics, verbatim: slice(-5) + first/last/dt/dirChanges. */
function oldReaderWindow(arr: Sample[]): {
  first: Sample;
  last: Sample;
  dt: number;
  dirChanges: number;
} {
  const recent = arr.slice(-5);
  let dirChanges = 0;
  for (let i = 2; i < recent.length; i++) {
    const prev = recent[i - 1]!;
    const curr = recent[i]!;
    const prevAngle = Math.atan2(prev.vy, prev.vx);
    const currAngle = Math.atan2(curr.vy, curr.vx);
    if (absAngleDelta(prevAngle, currAngle) > Math.PI / 3) dirChanges++;
  }
  const last = recent[recent.length - 1]!;
  const first = recent[0]!;
  return { first, last, dt: last.t - first.t, dirChanges };
}

/** The NEW reader window semantics: ring index walk (predictAim post-28). */
function newReaderWindow(ring: EnemyHistoryRing): {
  first: Sample;
  last: Sample;
  dt: number;
  dirChanges: number;
} {
  const start = ring.length > 5 ? ring.length - 5 : 0;
  let dirChanges = 0;
  for (let i = start + 2; i < ring.length; i++) {
    const prev = ring.at(i - 1);
    const curr = ring.at(i);
    const prevAngle = Math.atan2(prev.vy, prev.vx);
    const currAngle = Math.atan2(curr.vy, curr.vx);
    if (absAngleDelta(prevAngle, currAngle) > Math.PI / 3) dirChanges++;
  }
  const last = ring.at(ring.length - 1);
  const first = ring.at(start);
  return { first, last, dt: last.t - first.t, dirChanges };
}

/** Verbatim copy of the pre-ticket array-based predictAim (BotCombatShared
 *  before ticket 28) — the equivalence oracle for the live ring reader. */
const AIM_ERROR_RAD = 0.03;
function oldPredictAim(
  ctx: BotContext,
  enemy: { id: string; x: number; y: number; vx: number; vy: number },
  history: Array<{ x: number; y: number; vx: number; vy: number; t: number }> | undefined,
  predictionTicks: number,
  precisionRad = AIM_ERROR_RAD,
): number {
  if (!history || history.length < 2) {
    const speed = Math.sqrt(enemy.vx * enemy.vx + enemy.vy * enemy.vy);
    let predX = enemy.x;
    let predY = enemy.y;
    if (speed > 1) {
      predX = enemy.x + enemy.vx * predictionTicks;
      predY = enemy.y + enemy.vy * predictionTicks;
    }
    const angle = angleTo(ctx.x, ctx.y, predX, predY);
    return angle + (ctx.rng.next() - 0.5) * 2 * precisionRad;
  }
  const recent = history.slice(-5);
  let dirChanges = 0;
  for (let i = 2; i < recent.length; i++) {
    const prev = recent[i - 1]!;
    const curr = recent[i]!;
    const prevAngle = Math.atan2(prev.vy, prev.vx);
    const currAngle = Math.atan2(curr.vy, curr.vx);
    if (absAngleDelta(prevAngle, currAngle) > Math.PI / 3) dirChanges++;
  }
  const last = recent[recent.length - 1]!;
  const first = recent[0]!;
  const dt = last.t - first.t;
  let predX = enemy.x;
  let predY = enemy.y;
  if (dt > 0) {
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    const confidence = dirChanges > 0 ? 0.4 : 1.0;
    predX = enemy.x + vx * predictionTicks * confidence;
    predY = enemy.y + vy * predictionTicks * confidence;
  }
  const angle = angleTo(ctx.x, ctx.y, predX, predY);
  return angle + (ctx.rng.next() - 0.5) * 2 * precisionRad;
}

describe('EnemyHistoryRing ≡ old array semantics', () => {
  it('exposes identical samples in identical chronological order across randomized sequences (incl. wraparound)', () => {
    const rng = makeLcg(0x5eed28);
    for (let trial = 0; trial < 300; trial++) {
      const ring = new EnemyHistoryRing();
      const ref = new ArrayHistory();
      const pushes = 1 + Math.floor(rng() * 40); // 1..40 — trials cross the 8-slot wrap
      for (let k = 0; k < pushes; k++) {
        const x = rng() * 4000 - 2000;
        const y = rng() * 4000 - 2000;
        const vx = rng() * 860 - 430;
        const vy = rng() * 860 - 430;
        const t = 1000 + k * 3; // perception cadence
        ring.push(x, y, vx, vy, t);
        ref.push(x, y, vx, vy, t);

        // Full chronological walk must equal the array element-for-element.
        expect(ring.length).toBe(ref.arr.length);
        for (let i = 0; i < ref.arr.length; i++) {
          expect(ring.at(i)).toMatchObject(ref.arr[i]!);
        }
        // The reader window (5 most recent) must equal slice(-5) semantics.
        const oldW = oldReaderWindow(ref.arr);
        const newW = newReaderWindow(ring);
        expect(newW.first).toMatchObject(oldW.first);
        expect(newW.last).toMatchObject(oldW.last);
        expect(newW.dt).toBe(oldW.dt);
        expect(newW.dirChanges).toBe(oldW.dirChanges);
        // newestTick (LRU marker) tracks the most recent push.
        expect(ring.newestTick).toBe(t);
      }
    }
  });

  it('wraps at exactly the 8-sample cap (push 9 drops push 0)', () => {
    const ring = new EnemyHistoryRing();
    for (let k = 0; k < 9; k++) ring.push(k * 10, 0, 0, 0, k);
    expect(ring.length).toBe(8);
    expect(ring.at(0)).toMatchObject({ x: 10, t: 1 }); // oldest retained = push 1
    expect(ring.at(7)).toMatchObject({ x: 80, t: 8 }); // newest = push 8
  });

  it('reuses slot objects in place — steady-state zero per-sample allocation', () => {
    const ring = new EnemyHistoryRing();
    const identities = new Set<unknown>();
    for (let k = 0; k < 200; k++) {
      ring.push(k, k, 1, 1, k);
      for (let i = 0; i < ring.length; i++) identities.add(ring.at(i));
    }
    // All 200 samples ever read live in at most CAPACITY distinct objects.
    expect(identities.size).toBeLessThanOrEqual(EnemyHistoryRing.CAPACITY);
  });
});

describe('predictAim reader equivalence (ring vs pre-ticket array)', () => {
  it('returns bit-identical angles for thick and thin histories under the same RNG stream', () => {
    const rng = makeLcg(0xbeef28);
    for (let trial = 0; trial < 200; trial++) {
      const pushes = Math.floor(rng() * 10); // 0..9 — covers thin (0-1) and wrapped thick
      // Two ctxs with identical playerId → identical BotRNG seed → identical
      // noise stream; one consumes the live ring reader, the oracle the array.
      const ctxLive = new BotContext('p-live');
      const ctxRef = new BotContext('p-live');
      ctxLive.x = rng() * 4000 - 2000;
      ctxLive.y = rng() * 4000 - 2000;
      ctxRef.x = ctxLive.x;
      ctxRef.y = ctxLive.y;
      const enemy = {
        id: 'e1',
        x: rng() * 4000 - 2000,
        y: rng() * 4000 - 2000,
        vx: rng() * 860 - 430,
        vy: rng() * 860 - 430,
      };
      const ref = new ArrayHistory();
      for (let k = 0; k < pushes; k++) {
        const s = {
          x: rng() * 4000 - 2000,
          y: rng() * 4000 - 2000,
          vx: rng() * 860 - 430,
          vy: rng() * 860 - 430,
          t: 500 + k * 3,
        };
        recordEnemyPosition(ctxLive, enemy.id, s.x, s.y, s.vx, s.vy, s.t);
        ref.push(s.x, s.y, s.vx, s.vy, s.t);
      }
      const predictionTicks = 1 + Math.floor(rng() * 12);
      const precision = rng() * 0.2;

      const live = predictAim(ctxLive, enemy as EnemyInfo, predictionTicks, precision);
      const oracle = oldPredictAim(ctxRef, enemy, ref.arr, predictionTicks, precision);
      expect(live).toBe(oracle);
    }
  });
});

// TICKET-05 UPDATE (bot-ai-v2): the four enemy-history accessors moved off
// BotContext into BotContextEnemyHistory.ts (verbatim-extraction partial,
// same bodies — holds the 500-line gate after the believed-state fields
// landed). The assertions below are UNCHANGED; only the call form moved.
describe('history map LRU bound (perf ticket 28)', () => {
  function recordAt(ctx: BotContext, id: string, tick: number): void {
    ctx.tick = tick;
    recordEnemyPosition(ctx, id, tick, tick, 1, 0, tick);
  }

  it('enforces the cap at prune time only (recording alone never evicts)', () => {
    const ctx = new BotContext('p1');
    for (let i = 0; i < 20; i++) recordAt(ctx, `e${i}`, 100 + i);
    // No prune yet — all 20 entries present (eviction happens at scan end).
    for (let i = 0; i < 20; i++) expect(getEnemyHistory(ctx, `e${i}`)).toBeDefined();
    pruneEnemyHistory(ctx);
    expect(ENEMY_HISTORY_MAX_ENEMIES).toBe(16);
    // The 4 least-recently-seen (e0..e3, recorded at the oldest ticks) evicted.
    for (let i = 0; i < 4; i++) expect(getEnemyHistory(ctx, `e${i}`)).toBeUndefined();
    for (let i = 4; i < 20; i++) expect(getEnemyHistory(ctx, `e${i}`)).toBeDefined();
  });

  it('NEVER evicts the current target (even when it is the stalest entry)', () => {
    const ctx = new BotContext('p1');
    ctx.targetId = 'stale-target';
    for (let i = 0; i < 20; i++) {
      // Target seen first (oldest tick) — without the exemption it would be
      // the LRU victim on every eviction round.
      recordAt(ctx, i === 0 ? 'stale-target' : `e${i}`, 100 + i);
    }
    pruneEnemyHistory(ctx);
    expect(getEnemyHistory(ctx, 'stale-target')).toBeDefined();
    // Exactly the cap remains, none of them the target.
    let survivors = 0;
    for (let i = 1; i < 20; i++) if (getEnemyHistory(ctx, `e${i}`)) survivors++;
    expect(survivors).toBe(ENEMY_HISTORY_MAX_ENEMIES - 1);
  });

  it('NEVER evicts the nearest enemy (retreat aim reads it)', () => {
    const ctx = new BotContext('p1');
    const nearest = { id: 'stale-nearest' } as EnemyInfo;
    for (let i = 0; i < 20; i++) {
      recordAt(ctx, i === 0 ? 'stale-nearest' : `e${i}`, 100 + i);
    }
    ctx.nearestEnemy = nearest;
    pruneEnemyHistory(ctx);
    expect(getEnemyHistory(ctx, 'stale-nearest')).toBeDefined();
    let survivors = 0;
    for (let i = 1; i < 20; i++) if (getEnemyHistory(ctx, `e${i}`)) survivors++;
    expect(survivors).toBe(ENEMY_HISTORY_MAX_ENEMIES - 1);
  });

  it('an evicted enemy re-perceived starts a fresh ring (1 sample, thin-history branch)', () => {
    const ctx = new BotContext('p1');
    for (let i = 0; i < 17; i++) recordAt(ctx, `e${i}`, 100 + i); // e0 evicted at prune
    pruneEnemyHistory(ctx);
    expect(getEnemyHistory(ctx, 'e0')).toBeUndefined();
    recordAt(ctx, 'e0', 999);
    const ring = getEnemyHistory(ctx, 'e0');
    expect(ring).toBeDefined();
    expect(ring!.length).toBe(1);
    expect(ring!.newestTick).toBe(999);
  });

  it('clearEnemyHistory still removes the entry (target-drop path)', () => {
    const ctx = new BotContext('p1');
    recordAt(ctx, 'e0', 10);
    expect(getEnemyHistory(ctx, 'e0')).toBeDefined();
    clearEnemyHistory(ctx, 'e0');
    expect(getEnemyHistory(ctx, 'e0')).toBeUndefined();
  });
});

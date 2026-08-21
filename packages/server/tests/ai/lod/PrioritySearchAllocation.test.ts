import { describe, it, expect } from 'vitest';
import {
  Pathfinder,
  MAX_SEARCHES_PER_TICK,
  SEARCH_CLASS_CAPS,
} from '../../../src/ai/navigation/Pathfinder.ts';
import { LodTier } from '../../../src/ai/lod/LodTiers.ts';

/**
 * PRIORITY-ORDERED A* ALLOCATION (bot-ai-v2 ticket 11, DEC-012.3): the shared
 * per-tick search cap is allocated by caller priority class — T0 first —
 * layered ON TOP of ticket 06's deferred sentinel (a class-cap miss returns
 * the same RETRYABLE "not now", never an unreachable collapse).
 *
 * Synthetic pressure model: an open grid where every findPath is an uncached
 * real search, so consuming search budget directly simulates contending
 * bots. The LodTier enum values ARE the priority classes wired at the call
 * sites (BotNavigation/BotEconomyExecutors pass ctx.lodTier).
 */

/** Fully-walkable grid: every findPath is a genuine (uncached) search. */
function openPathfinder(size = 32): Pathfinder {
  const grid: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => true),
  );
  const pf = new Pathfinder(grid);
  pf.beginTick(1);
  return pf;
}

/** Distinct endpoint per call index (injective for i < 900) — never a cache
 *  hit: x walks the columns, y advances a row every 30 columns. */
function endpoint(i: number): { x: number; y: number } {
  return { x: 64 + (i % 30) * 128, y: 64 + Math.floor(i / 30) * 128 };
}

describe('search class caps', () => {
  it('caps are ordered T0 >= T1 >= T2 with T0 equal to the global cap', () => {
    expect(SEARCH_CLASS_CAPS[0]).toBe(MAX_SEARCHES_PER_TICK);
    expect(SEARCH_CLASS_CAPS[1]).toBeLessThan(SEARCH_CLASS_CAPS[0]);
    expect(SEARCH_CLASS_CAPS[2]).toBeLessThan(SEARCH_CLASS_CAPS[1]);
    // The reservation guarantee: even if T1+T2 burn their FULL class caps
    // first, (14 + 6) = 20 < 24 — at least 4 global slots always remain for
    // T0 searches.
    expect(SEARCH_CLASS_CAPS[1] + SEARCH_CLASS_CAPS[2]).toBeLessThan(MAX_SEARCHES_PER_TICK);
  });

  it('LodTier values ARE the priority classes (the wiring contract)', () => {
    expect(LodTier.T0).toBe(0);
    expect(LodTier.T1).toBe(1);
    expect(LodTier.T2).toBe(2);
  });
});

describe('priority-ordered allocation under synthetic search pressure', () => {
  it('a T0 bot pathing COMPLETES while a T2 bot at its class cap DEFERS', () => {
    const pf = openPathfinder();
    // Burn the T2 class to its cap (e.g. every far bot pathed first this
    // tick — map-order pressure).
    for (let i = 0; i < SEARCH_CLASS_CAPS[2]; i++) {
      const to = endpoint(i);
      const path = pf.findPath({ x: 64, y: 64 }, to, LodTier.T2);
      expect(path).not.toBeNull();
    }
    // The T2 class is exhausted: another T2 search defers with the
    // retryable sentinel (NOT unreachable — ticket 06 semantics preserved).
    const t2Path = pf.findPath({ x: 64, y: 64 }, endpoint(100), LodTier.T2);
    expect(t2Path).toBeNull();
    expect(pf.lastFindDeferred).toBe(true);
    // ...while a T0 bot's search still runs to completion: the class caps
    // reserved global budget for it (20 of 24 consumed at most so far).
    const t0Path = pf.findPath({ x: 64, y: 64 }, endpoint(200), LodTier.T0);
    expect(t0Path).not.toBeNull();
    expect(pf.lastFindDeferred).toBe(false);
    expect(t0Path!.length).toBeGreaterThanOrEqual(2);
  });

  it('a T1 bot also defers at its (higher) class cap while T0 completes', () => {
    const pf = openPathfinder();
    for (let i = 0; i < SEARCH_CLASS_CAPS[1]; i++) {
      expect(pf.findPath({ x: 64, y: 64 }, endpoint(i), LodTier.T1)).not.toBeNull();
    }
    expect(pf.findPath({ x: 64, y: 64 }, endpoint(101), LodTier.T1)).toBeNull();
    expect(pf.lastFindDeferred).toBe(true);
    expect(pf.findPath({ x: 64, y: 64 }, endpoint(201), LodTier.T0)).not.toBeNull();
  });

  it('the GLOBAL cap still defers everyone once truly exhausted (T0 included)', () => {
    const pf = openPathfinder();
    for (let i = 0; i < MAX_SEARCHES_PER_TICK; i++) {
      expect(pf.findPath({ x: 64, y: 64 }, endpoint(i), LodTier.T0)).not.toBeNull();
    }
    // All 24 global slots consumed — even T0 defers now (the sentinel, not
    // unreachability).
    expect(pf.findPath({ x: 64, y: 64 }, endpoint(300), LodTier.T0)).toBeNull();
    expect(pf.lastFindDeferred).toBe(true);
    expect(pf.canSearch(LodTier.T0)).toBe(false);
  });

  it('beginTick resets BOTH the global counter and every class counter', () => {
    const pf = openPathfinder();
    for (let i = 0; i < SEARCH_CLASS_CAPS[2]; i++) {
      pf.findPath({ x: 64, y: 64 }, endpoint(i), LodTier.T2);
    }
    expect(pf.canSearch(LodTier.T2)).toBe(false);
    pf.beginTick(2);
    expect(pf.canSearch(LodTier.T2)).toBe(true);
    expect(pf.canSearch(LodTier.T1)).toBe(true);
    expect(pf.canSearch(LodTier.T0)).toBe(true);
    expect(pf.searchesThisTick).toBe(0);
    expect(pf.searchesByPriority.reduce((a, b) => a + b, 0)).toBe(0);
    // And a previously-deferred T2 search now completes (retry-next-tick).
    expect(pf.findPath({ x: 64, y: 64 }, endpoint(100), LodTier.T2)).not.toBeNull();
  });

  it('cached hits do NOT consume budget and clear the deferred sentinel', () => {
    const pf = openPathfinder();
    const to = endpoint(0);
    const first = pf.findPath({ x: 64, y: 64 }, to, LodTier.T0);
    expect(first).not.toBeNull();
    const used = pf.searchesThisTick;
    // Same endpoints → cache hit: no budget consumed, sentinel false.
    const cached = pf.findPath({ x: 64, y: 64 }, to, LodTier.T2);
    expect(cached).toEqual(first);
    expect(pf.searchesThisTick).toBe(used);
    expect(pf.lastFindDeferred).toBe(false);
  });

  it('omitting priority defaults to the T0 class (legacy call-site behavior)', () => {
    const pf = openPathfinder();
    expect(pf.findPath({ x: 64, y: 64 }, endpoint(0))).not.toBeNull();
    expect(pf.searchesByPriority[LodTier.T0]).toBe(1);
    expect(pf.findPathAvoidingHazards({ x: 64, y: 64 }, endpoint(1), new Set())).not.toBeNull();
    expect(
      pf.findPathThroughDestructibles({ x: 64, y: 64 }, endpoint(2), new Map()),
    ).not.toBeNull();
    expect(pf.searchesByPriority[LodTier.T0]).toBe(3);
  });
});

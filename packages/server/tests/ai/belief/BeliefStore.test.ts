import { describe, it, expect } from 'vitest';
import {
  BELIEF_MAX_ENEMIES,
  BeliefStore,
  EnemyBelief,
} from '../../../src/ai/belief/BeliefTypes.ts';

/**
 * BeliefStore — the per-bot belief map's LRU bound (bot-ai-v2 ticket 05,
 * DEC-003). Reuses the enemy-history ring's discipline: least-recently-
 * UPDATED evicted first, cap 16 (>2.5× the worst observed simultaneous live
 * set — the same measured justification as ENEMY_HISTORY_MAX_ENEMIES), with
 * the active pursuit target exempt from eviction.
 */

function belief(id: string, tick: number, confidence = 0.5): EnemyBelief {
  return new EnemyBelief(0, 0, 0, 0, tick, confidence, 'seen');
}

describe('BeliefStore LRU discipline', () => {
  it('holds up to the cap; the 17th write evicts the least-recently-updated', () => {
    const store = new BeliefStore();
    for (let i = 0; i < BELIEF_MAX_ENEMIES; i++) store.set(`e${i}`, belief(`e${i}`, i));
    expect(store.size).toBe(BELIEF_MAX_ENEMIES);
    store.set('newcomer', belief('newcomer', 99));
    expect(store.size).toBe(BELIEF_MAX_ENEMIES);
    expect(store.get('e0')).toBeUndefined(); // oldest update evicted
    expect(store.get('e1')).toBeDefined();
    expect(store.get('newcomer')).toBeDefined();
  });

  it('updating an entry refreshes its recency (a re-set is most-recent)', () => {
    const store = new BeliefStore();
    for (let i = 0; i < BELIEF_MAX_ENEMIES; i++) store.set(`e${i}`, belief(`e${i}`, i));
    store.set('e0', belief('e0', 100)); // refresh the oldest
    store.set('newcomer', belief('newcomer', 101));
    expect(store.get('e0')).toBeDefined(); // survived — no longer LRU
    expect(store.get('e1')).toBeUndefined(); // next-oldest evicted instead
  });

  it('the pursued target is EXEMPT from eviction', () => {
    const store = new BeliefStore();
    for (let i = 0; i < BELIEF_MAX_ENEMIES; i++) store.set(`e${i}`, belief(`e${i}`, i));
    store.exemptId = 'e0'; // the bot is investigating e0's believed position
    store.set('newcomer', belief('newcomer', 99));
    expect(store.get('e0')).toBeDefined();
    expect(store.get('e1')).toBeUndefined();
  });

  it('freshest() picks the max-tick belief with deterministic tie-breaks', () => {
    const store = new BeliefStore();
    expect(store.freshest()).toBeNull();
    expect(store.freshestId()).toBeNull();
    store.set('a', belief('a', 10));
    store.set('b', belief('b', 30));
    store.set('c', belief('c', 20));
    expect(store.freshestId()).toBe('b');
    expect(store.freshest()!.tick).toBe(30);
    // Tie: first-inserted of equally-fresh wins (Map insertion order).
    store.set('d', belief('d', 30));
    expect(store.freshestId()).toBe('b');
  });

  it('delete/clear/forEach behave as a bounded map', () => {
    const store = new BeliefStore();
    store.set('a', belief('a', 1));
    store.set('b', belief('b', 2));
    store.delete('a');
    expect(store.size).toBe(1);
    const seen: string[] = [];
    store.forEach((_b, id) => seen.push(id));
    expect(seen).toEqual(['b']);
    store.clear();
    expect(store.size).toBe(0);
  });
});

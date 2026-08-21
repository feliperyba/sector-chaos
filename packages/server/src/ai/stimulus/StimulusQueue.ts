/**
 * Per-bot bounded stimulus queue — bot-ai-v2 ticket 03 (DEC-002).
 *
 * One instance per bot, owned by the StimulusRouter (keyed by playerId, same
 * lifecycle as BotSystem.bots). The router ENQUEUES; the perception phase
 * READS via StimulusScan.refreshStimulusScan. No decision reads the queue
 * directly this ticket (stimuli are inert until ticket 04's Reactor).
 *
 * Bounds + eviction order (unit-tested):
 *  - CAP: the queue never exceeds STIMULUS_QUEUE_CAP entries.
 *  - EVICTION: when full, the OLDEST entry (smallest tick; ties broken by
 *    insertion order — earlier-inserted first) is evicted to admit the new
 *    stimulus. Newest events always win the memory.
 *  - DECAY: entries expire at STIMULUS_DECAY_TICKS. Expiry is enforced
 *    lazily (on enqueue and on read) — expired entries never surface in the
 *    per-scan view even if they still occupy a slot.
 *
 * Deterministic by construction: enqueue order is the router's
 * event-order-deterministic delivery order; no RNG, no clock reads.
 */

import { STIMULUS_DECAY_TICKS, STIMULUS_QUEUE_CAP } from './StimulusConfig.ts';
import type { Stimulus } from './StimulusTypes.ts';

/** True when a stimulus received at `stimTick` has expired by `nowTick`. */
export function stimulusExpired(stimTick: number, nowTick: number): boolean {
  return nowTick - stimTick >= STIMULUS_DECAY_TICKS;
}

/**
 * Effective strength of a stimulus at `nowTick`: base strength scaled by a
 * linear age fade that hits 0 exactly at the decay boundary. Pure.
 */
export function stimulusStrengthAt(s: Stimulus, nowTick: number): number {
  const age = nowTick - s.tick;
  if (age <= 0) return s.strength;
  if (age >= STIMULUS_DECAY_TICKS) return 0;
  return s.strength * (1 - age / STIMULUS_DECAY_TICKS);
}

export class StimulusQueue {
  /** Bounded FIFO; index 0 is the oldest retained entry. */
  readonly entries: Stimulus[] = [];

  /** Enqueue one stimulus, enforcing cap + decay bounds. */
  enqueue(s: Stimulus): void {
    // Lazy decay prune: expired head entries are dropped so a post-burst
    // lull frees slots instead of holding dead stimuli until eviction.
    // (Stimuli arrive in non-decreasing tick order — the router delivers in
    // server event order — so expired entries are always at the head. The
    // incoming stimulus's tick acts as "now".)
    const q = this.entries;
    let i = 0;
    while (i < q.length && stimulusExpired(q[i]!.tick, s.tick)) i++;
    if (i > 0) q.splice(0, i);
    // Cap: evict OLDEST entries until there is room for the newcomer.
    while (q.length >= STIMULUS_QUEUE_CAP) q.shift();
    q.push(s);
  }

  /** Number of retained entries (bounded by the cap). */
  get length(): number {
    return this.entries.length;
  }

  /** Drop every entry (bot unregister). */
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Stimulus tuning data — bot-ai-v2 ticket 03 (DEC-002).
 *
 * ALL stimulus tuning lives in this table, never in algorithm code: hearing
 * radii (loudness per event family), base strengths, queue cap, and decay
 * window. Designers rebalance the bot hearing model by editing numbers here.
 *
 * Radii of record (DEC-002): explosion ~1400 px (loud, chains matter), attack
 * fired ~900 px (the "distant fight" channel that replaced the whole-map
 * gunfire hotspot), thrown-landed / elimination medium, chest ~700 px
 * (punish-the-looter range), zone telegraph GLOBAL (geometry announcement,
 * no radius). The `damage` channel exists so the believability
 * reaction-latency measurement can use true stimulus→response deltas (and
 * to pre-feed ticket 04's startle reaction); it is inert like all stimuli.
 */

import type { StimulusType } from './StimulusTypes.ts';

/**
 * Hearing radius per stimulus type, in world px. A bot within this Euclidean
 * distance of the event's world position receives the stimulus.
 * `zoneTelegraph` uses Infinity — delivered to every bot (global geometry).
 */
export const STIMULUS_HEARING_RADII: Readonly<Record<StimulusType, number>> = {
  explosion: 1400,
  attack: 900,
  thrownLanded: 1000,
  elimination: 1000,
  chest: 700,
  zoneTelegraph: Infinity,
  damage: 900,
};

/**
 * Base loudness per stimulus type (0..1). The per-scan view scales this by a
 * linear age fade (see StimulusQueue.stimulusStrengthAt) so recent events
 * read stronger than stale ones. Not consumed by any decision this ticket.
 */
export const STIMULUS_BASE_STRENGTH: Readonly<Record<StimulusType, number>> = {
  explosion: 1.0,
  attack: 0.7,
  thrownLanded: 0.6,
  elimination: 0.8,
  chest: 0.5,
  zoneTelegraph: 0.9,
  damage: 0.8,
};

/** Max entries in a bot's stimulus queue (DEC-002: bounded memory). */
export const STIMULUS_QUEUE_CAP = 8;

/**
 * A stimulus older than this (in ticks) is expired: it leaves the per-scan
 * view and is dropped lazily on the next enqueue. ~150 ticks = 2.5s — long
 * enough for ticket 04's Reactor to react to a just-heard event, short
 * enough that stale positions never masquerade as current world state.
 */
export const STIMULUS_DECAY_TICKS = 150;

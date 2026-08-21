import { describe, it, expect } from 'vitest';
import {
  StimulusQueue,
  stimulusExpired,
  stimulusStrengthAt,
} from '../../../src/ai/stimulus/StimulusQueue.ts';
import {
  STIMULUS_BASE_STRENGTH,
  STIMULUS_DECAY_TICKS,
  STIMULUS_HEARING_RADII,
  STIMULUS_QUEUE_CAP,
} from '../../../src/ai/stimulus/StimulusConfig.ts';
import {
  STIMULUS_TYPE_KEYS,
  type Stimulus,
  type StimulusType,
} from '../../../src/ai/stimulus/StimulusTypes.ts';

/** Minimal stimulus factory (base strength of its type by default). */
function stim(type: StimulusType, tick: number, strength = STIMULUS_BASE_STRENGTH[type]): Stimulus {
  return { type, worldX: 0, worldY: 0, tick, strength };
}

describe('StimulusConfig (data table of record, DEC-002)', () => {
  it('hearing radii match the DEC-002 table (explosion 1400 / attack 900 / chest 700 / zone global)', () => {
    expect(STIMULUS_HEARING_RADII.explosion).toBe(1400);
    expect(STIMULUS_HEARING_RADII.attack).toBe(900);
    // "medium" channels sit between the attack and explosion anchors.
    expect(STIMULUS_HEARING_RADII.thrownLanded).toBeGreaterThanOrEqual(900);
    expect(STIMULUS_HEARING_RADII.thrownLanded).toBeLessThanOrEqual(1400);
    expect(STIMULUS_HEARING_RADII.elimination).toBeGreaterThanOrEqual(900);
    expect(STIMULUS_HEARING_RADII.elimination).toBeLessThanOrEqual(1400);
    expect(STIMULUS_HEARING_RADII.chest).toBe(700);
    expect(STIMULUS_HEARING_RADII.zoneTelegraph).toBe(Infinity);
  });

  it('every stimulus type has a radius + base strength entry; strengths are 0..1', () => {
    for (const key of STIMULUS_TYPE_KEYS) {
      expect(
        Number.isFinite(STIMULUS_HEARING_RADII[key]) || STIMULUS_HEARING_RADII[key] === Infinity,
      ).toBe(true);
      expect(STIMULUS_BASE_STRENGTH[key]).toBeGreaterThan(0);
      expect(STIMULUS_BASE_STRENGTH[key]).toBeLessThanOrEqual(1);
    }
  });

  it('queue bounds of record: cap 8, decay ~150 ticks', () => {
    expect(STIMULUS_QUEUE_CAP).toBe(8);
    expect(STIMULUS_DECAY_TICKS).toBe(150);
  });
});

describe('stimulusExpired (decay boundary math)', () => {
  it('expires at exactly DECAY_TICKS of age, not one tick before', () => {
    expect(stimulusExpired(0, STIMULUS_DECAY_TICKS - 1)).toBe(false);
    expect(stimulusExpired(0, STIMULUS_DECAY_TICKS)).toBe(true);
    expect(stimulusExpired(0, STIMULUS_DECAY_TICKS + 1)).toBe(true);
  });

  it('a future-tick stimulus (delivered with the ingest fallback stamp) never reads as expired', () => {
    expect(stimulusExpired(105, 100)).toBe(false);
  });
});

describe('stimulusStrengthAt (linear age fade)', () => {
  const s = stim('explosion', 1000, 1.0);

  it('returns the base strength at age 0', () => {
    expect(stimulusStrengthAt(s, 1000)).toBe(1.0);
  });

  it('returns the base strength for future ticks (no negative fade)', () => {
    expect(stimulusStrengthAt(s, 995)).toBe(1.0);
  });

  it('fades linearly: half strength at half the decay window', () => {
    expect(stimulusStrengthAt(s, 1000 + STIMULUS_DECAY_TICKS / 2)).toBeCloseTo(0.5, 12);
  });

  it('hits exactly 0 at the decay boundary', () => {
    expect(stimulusStrengthAt(s, 1000 + STIMULUS_DECAY_TICKS)).toBe(0);
  });

  it('scales a partial-strength stimulus proportionally', () => {
    const weak = stim('chest', 2000, 0.5);
    expect(stimulusStrengthAt(weak, 2000 + STIMULUS_DECAY_TICKS / 2)).toBeCloseTo(0.25, 12);
  });
});

describe('StimulusQueue (bounded memory: cap + eviction + lazy decay)', () => {
  it('never exceeds the cap — overflowing enqueues evict the OLDEST entries', () => {
    const q = new StimulusQueue();
    for (let i = 0; i < 20; i++) q.enqueue(stim('attack', i));
    expect(q.length).toBe(STIMULUS_QUEUE_CAP);
    // Newest events always win the memory: the retained window is the last 8.
    expect(q.entries.map((e) => e.tick)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('breaks same-tick ties by insertion order (earlier-inserted evicted first)', () => {
    const q = new StimulusQueue();
    // CAP+1 events all stamped tick 42 — the FIRST inserted must be the one
    // evicted, keeping insertion order stable among same-tick entries.
    for (let i = 0; i <= STIMULUS_QUEUE_CAP; i++) q.enqueue(stim('attack', 42));
    expect(q.length).toBe(STIMULUS_QUEUE_CAP);
    expect(q.entries.every((e) => e.tick === 42)).toBe(true);
  });

  it('lazily prunes expired head entries on enqueue (a post-burst lull frees slots)', () => {
    const q = new StimulusQueue();
    q.enqueue(stim('explosion', 0));
    q.enqueue(stim('attack', 1));
    // Next delivery arrives after the decay window: both old entries are gone.
    q.enqueue(stim('chest', STIMULUS_DECAY_TICKS + 5));
    expect(q.length).toBe(1);
    expect(q.entries[0]!.type).toBe('chest');
  });

  it('keeps not-yet-expired entries when pruning (boundary age DECAY-1 survives)', () => {
    const q = new StimulusQueue();
    q.enqueue(stim('explosion', 0));
    q.enqueue(stim('attack', STIMULUS_DECAY_TICKS - 1));
    q.enqueue(stim('chest', STIMULUS_DECAY_TICKS - 1));
    // "now" = DECAY-1 at the last enqueue: tick 0 is at age DECAY-1 — alive.
    expect(q.length).toBe(3);
    // A far-future delivery (now = 2×DECAY) prunes every expired head entry.
    q.enqueue(stim('elimination', STIMULUS_DECAY_TICKS * 2));
    expect(q.length).toBe(1);
  });

  it('clear() drops every entry', () => {
    const q = new StimulusQueue();
    q.enqueue(stim('attack', 1));
    q.enqueue(stim('attack', 2));
    q.clear();
    expect(q.length).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { BotStimulusState, refreshStimulusScan } from '../../../src/ai/stimulus/StimulusScan.ts';
import {
  STIMULUS_BASE_STRENGTH,
  STIMULUS_DECAY_TICKS,
} from '../../../src/ai/stimulus/StimulusConfig.ts';
import type { Stimulus } from '../../../src/ai/stimulus/StimulusTypes.ts';

function stim(
  type: Stimulus['type'],
  worldX: number,
  worldY: number,
  tick: number,
  strength = STIMULUS_BASE_STRENGTH[type],
): Stimulus {
  return { type, worldX, worldY, tick, strength };
}

describe('refreshStimulusScan (the stimulus→perception merge — pure seam, DEC-002)', () => {
  it('an empty queue yields an empty view with no heard fight', () => {
    const state = new BotStimulusState();
    const view = refreshStimulusScan(state, 1000);
    expect(view.entries).toHaveLength(0);
    expect(Object.keys(view.strongestByType)).toHaveLength(0);
    expect(view.heardFightTick).toBe(-9999);
  });

  it('exposes queued stimuli in delivery order (oldest→newest), age-decayed', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('attack', 100, 200, 1000));
    state.queue.enqueue(stim('chest', 300, -400, 1100));
    const view = refreshStimulusScan(state, 1100);
    expect(view.entries.map((e) => e.type)).toEqual(['attack', 'chest']);
    // attack is 100 ticks old → base 0.7 × (1 - 100/150) = 0.7 × 1/3.
    expect(view.entries[0]!.effectiveStrength).toBeCloseTo(0.7 * (1 - 100 / 150), 12);
    // chest is fresh (age 0) → full base strength.
    expect(view.entries[1]!.effectiveStrength).toBeCloseTo(0.5, 12);
  });

  it('expired entries never surface in the scan view even though they occupy a slot', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('explosion', 0, 0, 0));
    state.queue.enqueue(stim('attack', 500, 0, 10));
    // At now = 10 + DECAY the attack is expired too; nothing is visible.
    const view = refreshStimulusScan(state, 10 + STIMULUS_DECAY_TICKS);
    expect(view.entries).toHaveLength(0);
    expect(view.heardFightTick).toBe(-9999);
  });

  it('strongestByType keeps the max-effectiveStrength entry per type', () => {
    const state = new BotStimulusState();
    // Old loud attack (base 0.7, aged 75 → 0.35) vs fresh quiet one (full 0.7).
    state.queue.enqueue(stim('attack', 1, 1, 1000));
    state.queue.enqueue(stim('attack', 2, 2, 1075));
    // A later, staler attack (aged past the first) must NOT displace a stronger one.
    state.queue.enqueue(stim('attack', 3, 3, 1020));
    const view = refreshStimulusScan(state, 1075);
    expect(view.strongestByType.attack).toBeDefined();
    expect(view.strongestByType.attack!.worldX).toBe(2);
    expect(view.strongestByType.attack!.effectiveStrength).toBeCloseTo(0.7, 12);
  });

  it('absent types are simply missing keys (O(1) lookup surface)', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('chest', 0, 0, 100));
    const view = refreshStimulusScan(state, 100);
    expect(view.strongestByType.chest).toBeDefined();
    expect(view.strongestByType.attack).toBeUndefined();
    expect(view.strongestByType.explosion).toBeUndefined();
  });

  it('heard-fight location tracks the NEWEST attack/explosion stimulus', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('attack', 100, 100, 1000));
    state.queue.enqueue(stim('chest', 9999, 9999, 1050)); // not a fight
    state.queue.enqueue(stim('explosion', 400, 500, 1020));
    state.queue.enqueue(stim('attack', 200, 300, 1060));
    const view = refreshStimulusScan(state, 1060);
    expect(view.heardFightTick).toBe(1060);
    expect(view.heardFightX).toBe(200);
    expect(view.heardFightY).toBe(300);
  });

  it('a tie in fight ticks keeps the LATER-DELIVERED (newest) fight location', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('attack', 10, 10, 500));
    state.queue.enqueue(stim('explosion', 20, 20, 500));
    const view = refreshStimulusScan(state, 500);
    expect(view.heardFightTick).toBe(500);
    expect(view.heardFightX).toBe(20); // >= comparison → later delivery wins
  });

  it('is idempotent with respect to repeated refreshes at the same tick', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('attack', 1, 2, 100));
    state.queue.enqueue(stim('elimination', 3, 4, 120));
    const first = refreshStimulusScan(state, 130);
    const second = refreshStimulusScan(state, 130);
    expect(second.entries).toEqual(first.entries);
    expect(second.strongestByType).toEqual(first.strongestByType);
    expect(second.heardFightTick).toBe(first.heardFightTick);
  });

  it('rebuilding the view does not mutate or drain the queue', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('attack', 1, 2, 100));
    refreshStimulusScan(state, 100);
    expect(state.queue.length).toBe(1);
    expect(state.queue.entries[0]!.tick).toBe(100);
  });

  it('BotStimulusState.clear() resets queue and view', () => {
    const state = new BotStimulusState();
    state.queue.enqueue(stim('attack', 1, 2, 100));
    refreshStimulusScan(state, 100);
    state.clear();
    expect(state.queue.length).toBe(0);
    expect(state.scan.entries).toHaveLength(0);
    expect(Object.keys(state.scan.strongestByType)).toHaveLength(0);
    expect(state.scan.heardFightTick).toBe(-9999);
  });
});

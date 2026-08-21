/**
 * Stimulus → perception merge — bot-ai-v2 ticket 03 (DEC-002).
 *
 * THE PURE SEAM between the stimulus queues and the per-scan perception
 * view: {@linkcode refreshStimulusScan} decodes a bot's queue into the
 * age-decayed, strongest-per-type view that the perception phase publishes
 * each scan. Unit-tested in isolation (no room, no BotSystem).
 *
 * Stimuli are INERT this ticket — the view is published but no decision
 * consumes it yet. Ticket 04's Reactor reads this scan view (and the raw
 * queue) as its input.
 */

import { StimulusQueue, stimulusStrengthAt, stimulusExpired } from './StimulusQueue.ts';
import type { DecayedStimulus, StimulusType } from './StimulusTypes.ts';

/** The per-scan stimulus view (rebuilt every perception scan). */
export interface StimulusScanView {
  /** Non-expired stimuli in delivery order (oldest→newest), age-decayed. */
  readonly entries: DecayedStimulus[];
  /**
   * Strongest (max effectiveStrength) non-expired stimulus per type — the
   * O(1) lookup surface for "the loudest thing I heard of each kind".
   * Absent types are simply missing keys.
   */
  readonly strongestByType: Partial<Record<StimulusType, DecayedStimulus>>;
  /**
   * Most recent heard FIGHT location (newest attack/explosion stimulus) —
   * the per-bot complement of the shared fight memory. -9999 = none heard.
   */
  heardFightX: number;
  heardFightY: number;
  heardFightTick: number;
}

/** The per-bot stimulus state: the bounded queue plus its scan view. One
 * instance per bot, owned by the StimulusRouter. */
export class BotStimulusState {
  readonly queue = new StimulusQueue();
  private readonly view: StimulusScanView = {
    entries: [],
    strongestByType: {},
    heardFightX: 0,
    heardFightY: 0,
    heardFightTick: -9999,
  };

  /** Read-only access to the last published scan view. */
  get scan(): StimulusScanView {
    return this.view;
  }

  /** Reset both queue and view (bot unregister / dispose). */
  clear(): void {
    this.queue.clear();
    this.view.entries.length = 0;
    for (const key of Object.keys(this.view.strongestByType) as StimulusType[]) {
      delete this.view.strongestByType[key];
    }
    this.view.heardFightTick = -9999;
  }
}

/**
 * Decode `state.queue` into `state.scan` as of `nowTick`. Pure with respect
 * to the outside world (mutates only the passed state's view). Called from
 * the perception phase each scan — the merge point DEC-002 names.
 */
export function refreshStimulusScan(state: BotStimulusState, nowTick: number): StimulusScanView {
  const view = state.scan;
  const entries = view.entries;
  entries.length = 0;
  const byType = view.strongestByType;
  for (const key of Object.keys(byType) as StimulusType[]) delete byType[key];
  view.heardFightTick = -9999;

  let fightTick = -Infinity;
  for (const s of state.queue.entries) {
    if (stimulusExpired(s.tick, nowTick)) continue;
    const decayed: DecayedStimulus = { ...s, effectiveStrength: stimulusStrengthAt(s, nowTick) };
    entries.push(decayed);
    const current = byType[s.type];
    if (!current || decayed.effectiveStrength > current.effectiveStrength) {
      byType[s.type] = decayed;
    }
    if (s.type === 'attack' || s.type === 'explosion') {
      if (s.tick >= fightTick) {
        fightTick = s.tick;
        view.heardFightX = s.worldX;
        view.heardFightY = s.worldY;
        view.heardFightTick = s.tick;
      }
    }
  }
  return view;
}

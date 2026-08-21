/**
 * Stimulus-driven fight memory — bot-ai-v2 ticket 03 (DEC-002).
 *
 * THE HOTSPOT MIGRATION. The pre-v2 shared combat hotspot was fed by two
 * polling writers: the whole-map gunfire scan (`recordGunfireHotspot` — any
 * bot that attacked within 30 ticks wrote the shared hotspot) and the
 * per-sighting write (`contributeCombatHotspot`). Both are RETIRED; the one
 * writer is now this module, fed by routed WeaponFired (attack) and
 * BarrelExploded (explosion) stimuli — the server's own authoritative
 * record of where fights happened, covering HUMAN gunfire too (the old
 * gunfire scan only ever saw bot attacks).
 *
 * The consumer surface is UNCHANGED: HUNT bots still read `bb.hotspot`
 * (the `CombatHotspotMemory` carried by the TickBlackboard) with the same
 * freshness window (HOTSPOT_MEMORY_TICKS) and the same attract/saturation
 * logic. Only the data source changed — no compatibility shim remains.
 *
 * Write guards preserved verbatim from the retired writers (they are what
 * keep a converged cluster from re-anchoring the memory onto itself):
 *  - a fresh fight within FIGHT_MEMORY_MIN_SEPARATION_PX of the current
 *    memory is the SAME fight — skip;
 *  - an aged-out memory (or one from a distant fight) is overwritten.
 */

import { distance } from '@sector-battle/shared';
import { HOTSPOT_MEMORY_TICKS } from '../BotSystemConstants.ts';
import type { CombatHotspotMemory } from '../TickBlackboard.ts';
import type { Stimulus } from './StimulusTypes.ts';

/**
 * Minimum separation (px) between a new fight stimulus and the current
 * fight memory for the write to count as a NEW fight. Same value the
 * retired hotspot writers used.
 */
export const FIGHT_MEMORY_MIN_SEPARATION_PX = 500;

/** Stimulus types that mark a location as a fight. */
export function isFightStimulus(type: Stimulus['type']): boolean {
  return type === 'attack' || type === 'explosion';
}

/**
 * Fold one fight stimulus into the shared fight memory. Mutates `mem` in
 * place (it is the persistent cross-tick object BotSystem carries and each
 * tick's blackboard references). Pure function of (mem, stimulus).
 */
export function writeFightMemory(mem: CombatHotspotMemory, s: Stimulus): void {
  const fresh = s.tick - mem.tick < HOTSPOT_MEMORY_TICKS;
  if (fresh) {
    if (distance(s.worldX, s.worldY, mem.x, mem.y) <= FIGHT_MEMORY_MIN_SEPARATION_PX) return;
  }
  mem.x = s.worldX;
  mem.y = s.worldY;
  mem.tick = s.tick;
}

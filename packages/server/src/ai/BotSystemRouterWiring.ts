/**
 * BotSystemRouterWiring — verbatim extraction of the BotSystem constructor's
 * StimulusRouter deps adapter (bot-ai-v2 ticket 07, for the module-length
 * gate; same house style as the other BotSystem partials).
 *
 * Every callback body is byte-identical to the original inline literals
 * except `this.` → `system.`. Behavior is preserved by construction.
 */

import { StimulusRouter } from './stimulus/StimulusRouter.ts';
import type { BotSystem } from './BotSystem.ts';
import {
  writeDamageDirectionBelief,
  writeHeardBelief,
  dropEliminatedBelief,
} from './belief/BeliefUpdate.ts';

/**
 * Build the room's StimulusRouter wired to the system's shared state. The
 * deps adapter reads the world snapshot (grid range queries + player-position
 * lookup for ChestOpened) and forwards damage-stimulus deliveries to the
 * per-bot believability counters (the true stimulus→response latency source).
 */
export function createStimulusRouterFor(system: BotSystem): StimulusRouter {
  return new StimulusRouter({
    bots: system.bots,
    queryPlayers: (cx, cy, range, cb) => system.worldSnapshot.queryPlayers(cx, cy, range, cb),
    resolvePlayerPos: (id) => {
      const dto = system.worldSnapshot.getPlayerById(id);
      return dto ? { x: dto.x, y: dto.y } : null;
    },
    combatHotspot: system.combatHotspot,
    noteDamageStimulus: (botId, tick) => {
      system.skillTrackers.get(botId)?.believability.noteDamageStimulus(tick);
    },
    // Believed-state hooks (bot-ai-v2 ticket 05, DEC-003): delivered
    // stimuli write the receiving bot's belief store between ticks. All
    // deterministic — the damage estimate's spread draws from the victim's
    // own per-bot BotRNG.
    noteAttackHeard: (botId, firerId, x, y, tick) => {
      const ctx = system.bots.get(botId);
      if (!ctx || !ctx.isAlive) return;
      writeHeardBelief(
        ctx,
        system.skillTrackers.get(botId)?.believability.beliefs ?? null,
        firerId,
        x,
        y,
        tick,
      );
    },
    noteDamageDirection: (botId, attackerId, x, y, dirX, dirY, tick) => {
      const ctx = system.bots.get(botId);
      if (!ctx || !ctx.isAlive) return;
      if (attackerId === null) return; // no identity — nothing to key the belief on
      writeDamageDirectionBelief(
        ctx,
        system.skillTrackers.get(botId)?.believability.beliefs ?? null,
        attackerId,
        tick,
        x,
        y,
        dirX,
        dirY,
      );
    },
    noteEliminationHeard: (botId, victimId, x, y, tick) => {
      if (victimId === null) return;
      const ctx = system.bots.get(botId);
      if (!ctx || !ctx.isAlive) return;
      // KILL-FEED AWARENESS (bot-ai-v2 ticket 09, DEC-010.4): the heard
      // elimination writes the per-bot memory BEFORE the belief drop — the
      // decaying sector danger (quiet-side bias) + the safe-loot window
      // (LOOT_CLUSTER bias toward the fresh corpse seat). Deterministic,
      // RNG-free; dims come from the system's map bounds.
      ctx.combat.killFeed.noteElimination(x, y, system.mapWidth, system.mapHeight, tick);
      dropEliminatedBelief(
        ctx,
        system.skillTrackers.get(botId)?.believability.beliefs ?? null,
        victimId,
      );
    },
    // KILL PROGRESS (bot-ai-v2 ticket 06, DEC-005.3): kills are one of the
    // three sanctioned anti-stall progress classes.
    noteKillScored: (killerId, tick) => {
      const ctx = system.bots.get(killerId);
      if (ctx?.isAlive) ctx.lastProgressTick = tick;
    },
  });
}

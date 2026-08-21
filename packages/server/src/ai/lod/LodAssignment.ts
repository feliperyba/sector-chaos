/**
 * PER-TICK LOD ASSIGNMENT — bot-ai-v2 ticket 11 (DEC-012.1): the wiring that
 * turns {@linkcode computeLodTier} (the pure seam) into per-bot ctx state
 * each BotSystem.tick.
 *
 * Two steps, both deterministic from the tick stream:
 *
 *  1. collectLodReferences — ONE snapshot pass gathering the reference
 *     players for proximity tiering: every ALIVE HUMAN when at least one is
 *     alive (the audience's focus — DEC-012 "distance to nearest human"),
 *     otherwise EVERY alive player (the all-bot-lobby / benchmark fallback —
 *     "nearest-bot in all-bot matches"). Positions are held in BotSystem
 *     scratch arrays (filled in place, no per-tick allocation).
 *  2. assignBotLodTier — per living bot: nearest reference distance (own id
 *     excluded in the all-bot case so a bot never tiers off itself) + the
 *     engagement inputs → {@linkcode computeLodTier} → ctx.lodTier /
 *     ctx.lodCombatTier. Recomputed EVERY tick from THIS tick's state, which
 *     is what makes combat-entry upgrades immediate (no hysteresis, no
 *     stickiness — a far T2 bot that takes damage is T0 on the very next
 *     BotSystem.tick, before the attacker's follow-up swing).
 *
 * No RNG, no clock reads — the same-seed byte-identity contract holds (see
 * LodTiers.ts for the purity statement).
 */

import { distance } from '@sector-battle/shared';
import { BotState, type BotContext } from '../BotContext.ts';
import type { BotSystem } from '../BotSystem.ts';
import {
  aiClockNow,
  noteLodTick,
  noteReliefApplied,
  reliefLevelForElapsed,
} from './AiBudgetGuard.ts';
import { computeLodTier, isThinkTick, type LodAssignment } from './LodTiers.ts';

/** The result of one bot's tier assignment this tick. */
export interface BotLodAssignment extends LodAssignment {
  /** Distance to the nearest reference player (px; Infinity when alone). */
  nearestReferenceDist: number;
  /** True when this tick transitioned the bot INTO combat-tier T0 — the
   *  immediate-upgrade telemetry edge. */
  combatEntry: boolean;
}

/**
 * Fill the BotSystem's LOD reference scratch (lodRefX/lodRefY/lodRefIds —
 * sized MAX_PLAYERS) with this tick's reference players and set
 * lodRefCount/lodRefsIncludeBots. Called once per tick, after the
 * WorldSnapshot sync, before the per-bot loop.
 */
export function collectLodReferences(system: BotSystem): void {
  const snap = system.worldSnapshot;
  let humans = 0;
  snap.forEachActivePlayer((dto) => {
    if (dto.isAlive && !dto.isBot) humans++;
  });
  // All-bot lobbies (the benchmark) tier off the nearest OTHER bot; any live
  // human switches the reference set to humans only.
  const includeBots = humans === 0;
  let count = 0;
  const cap = system.lodRefX.length;
  snap.forEachActivePlayer((dto) => {
    if (!dto.isAlive) return;
    if (!includeBots && dto.isBot) return;
    if (count >= cap) return;
    system.lodRefX[count] = dto.x;
    system.lodRefY[count] = dto.y;
    system.lodRefIds[count] = dto.id;
    count++;
  });
  system.lodRefCount = count;
  system.lodRefsIncludeBots = includeBots;
}

/** Nearest reference-player distance for one bot (own id excluded in the
 *  all-bot case — self-distance 0 would pin every bot at T0). */
export function nearestReferenceDistance(system: BotSystem, ctx: BotContext): number {
  const n = system.lodRefCount;
  if (n === 0) return Infinity;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    if (system.lodRefsIncludeBots && system.lodRefIds[i] === ctx.playerId) continue;
    const d = distance(ctx.x, ctx.y, system.lodRefX[i]!, system.lodRefY[i]!);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Assign one bot's tier from this tick's state and write it to the ctx.
 * PURE with respect to the world — reads committed state + reference
 * positions, writes only the three ctx LOD fields. Returns the assignment
 * (plus the combat-entry edge) for the caller's telemetry.
 */
export function assignBotLodTier(
  ctx: BotContext,
  tick: number,
  system: BotSystem,
): BotLodAssignment {
  const nearestReferenceDist = nearestReferenceDistance(system, ctx);
  const assignment = computeLodTier({
    inFightState: ctx.state === BotState.ENGAGE || ctx.state === BotState.RETREAT,
    nearestEnemyDist: ctx.nearestEnemy !== null ? ctx.nearestEnemy.distance : null,
    lastDamageTick: ctx.lastDamageTick,
    tick,
    nearestReferenceDist,
  });
  const combatEntry = assignment.combatTier && !ctx.lodCombatTier;
  ctx.lodTier = assignment.tier;
  ctx.lodCombatTier = assignment.combatTier;
  ctx.lodNearestRefDist = nearestReferenceDist;
  return { ...assignment, nearestReferenceDist, combatEntry };
}

/**
 * The per-bot LOD tick step (ticket 11), called by BotSystem.tick for every
 * LIVING bot right before tickBot: assign the tier (pure), read the budget
 * guard's relief level off the GUARD clock (performance.now — the
 * harness-virtualizable abstraction; within-tick deltas are 0 under the
 * bench, so relief NEVER fires there and behavior stays deterministic),
 * record the observation counters, and return the think-cadence verdict that
 * gates the deliberative phases in tickBot.
 *
 * Always-on surfaces are structurally NOT part of this function — relief and
 * cadence only ever answer "does this bot re-score intents this tick".
 */
export function runLodForBot(
  system: BotSystem,
  ctx: BotContext,
  tick: number,
  guardT0: number,
): boolean {
  const lod = assignBotLodTier(ctx, tick, system);
  const relief = reliefLevelForElapsed(aiClockNow() - guardT0);
  ctx.lodRelief = relief;
  noteReliefApplied(system.aiBudget, relief);
  const think = isThinkTick(
    ctx.lodTier,
    ctx.lodCombatTier,
    tick,
    ctx.perceptionPhase,
    ctx.perceptionPhase9,
    relief,
  );
  noteLodTick(system.aiBudget, ctx.lodTier, lod.combatEntry, think);
  return think;
}

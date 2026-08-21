/**
 * Enemy-history accessors — verbatim extraction of the four methods from
 * BotContext.ts (bot-ai-v2 ticket 05, holding the module-length gate; the
 * house partial-split style). The class keeps the `enemyHistory` map (now
 * `readonly` public — this module is its access discipline); each function
 * body is byte-identical to the original method modulo `this.` → `ctx.`.
 */

import type { BotContext } from './BotContext.ts';
import { EnemyHistoryRing, pruneEnemyHistoryMap } from './BotEnemyHistory.ts';

export function recordEnemyPosition(
  ctx: BotContext,
  id: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  tick: number,
): void {
  let hist = ctx.enemyHistory.get(id);
  if (!hist) {
    hist = new EnemyHistoryRing();
    ctx.enemyHistory.set(id, hist);
  }
  hist.push(x, y, vx, vy, tick);
}

export function getEnemyHistory(ctx: BotContext, id: string): EnemyHistoryRing | undefined {
  return ctx.enemyHistory.get(id);
}

export function clearEnemyHistory(ctx: BotContext, id: string): void {
  ctx.enemyHistory.delete(id);
}

/**
 * Enforce the ENEMY_HISTORY_MAX_ENEMIES bound on this bot's history map
 * (LRU eviction, least-recently-seen first). Called at the end of every
 * perception scan; the eviction exemptions (current target + nearest enemy —
 * the only two ids whose history aim prediction reads) and the full reader
 * audit live in `pruneEnemyHistoryMap` (BotEnemyHistory.ts).
 */
export function pruneEnemyHistory(ctx: BotContext): void {
  pruneEnemyHistoryMap(ctx.enemyHistory, ctx.targetId, ctx.nearestEnemy?.id ?? null);
}

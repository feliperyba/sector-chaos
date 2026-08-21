/**
 * Real loot contests — bot-ai-v2 ticket 09 (DEC-010.5).
 *
 * THE DEFECT (AUDIT §10c.2/§10c.4): CONTEST_LOOT routed to LOOT without
 * locking the item, and item claims were PER-TICK only (bb.claimedItems) —
 * two bots alternated claiming the same item across ticks, so the "race"
 * degraded into ordinary looting with visible ping-pong.
 *
 * THE MODEL (three parts):
 *  1. PERSISTENT CLAIMS: claims survive across ticks for ITEM_CLAIM_TICKS
 *     (refreshed by the claimant while it keeps targeting the item, lazily
 *     pruned on write — bounded memory). The first claimant exclusively
 *     reserves the item; later bots pick other loot. The per-tick
 *     bb.claimedItems spread stays (soft same-tick spread), the persistent
 *     claim adds the cross-tick exclusivity that kills the alternation.
 *  2. INTERCEPT PATHING: a contesting bot routes not to the item's center but
 *     to the INTERCEPT POINT on the item's enemy-approach side — the point on
 *     the enemy→item line just inside the item's interaction reach. The bot
 *     arrives FIRST on the racing enemy's line and blocks/grabs from there
 *     (the tense human loot-race move, not a blind beeline).
 *  3. CLEAN BREAK-OFF: when the race is decisively lost (the enemy is far
 *     closer and closing), the bot breaks off ONCE — the intent-layer
 *     suspension window (ctx.combat.contestBreakOffUntilTick) plus a short
 *     item blacklist prevent an immediate re-contest: no ping-pong.
 *
 * Determinism: pure geometry + tick arithmetic. No RNG, no wall-clock.
 */

import { distance } from '@sector-battle/shared';

/** A persistent item claim (mutated in place; lives on BotSystem.itemClaims). */
export interface ItemClaim {
  botId: string;
  untilTick: number;
}

/** How long a claim survives without refresh (ticks, ~1.7 s). */
export const ITEM_CLAIM_TICKS = 100;
/** Cap on retained claim entries (lazy prune oldest-first on write). */
const ITEM_CLAIM_CAP = 64;

/** How far inside the item's reach the intercept point sits from the item. */
export const INTERCEPT_INSET_PX = 24;
/** Max offset of the intercept point from the item toward the enemy (px). */
export const INTERCEPT_MAX_OFFSET_PX = 130;

/** Race lost when myDist > enemyDist × this factor (+ the slack below). */
export const CONTEST_BREAK_OFF_FACTOR = 1.6;
/** Flat slack added to the break-off comparison (px). */
export const CONTEST_BREAK_OFF_SLACK_PX = 120;
/** Re-contest suspension after a break-off (ticks, 4 s — no ping-pong). */
export const CONTEST_RECONTEST_SUSPEND_TICKS = 240;
/** Item blacklist after a lost race (ticks, 4 s — steer to other loot). */
export const CONTEST_BREAK_OFF_BLACKLIST_TICKS = 240;

/** The persistent-claim store shape (BotSystem.itemClaims satisfies this). */
export type ItemClaimStore = Map<string, ItemClaim>;

/** Lazily prune expired/over-cap entries (oldest-first eviction). A claim
 *  written at tick t covers exactly ITEM_CLAIM_TICKS ticks (t .. t+ITEM_
 * CLAIM_TICKS−1) — it is expired AT t+ITEM_CLAIM_TICKS. */
function pruneClaims(store: ItemClaimStore, tick: number): void {
  for (const [id, claim] of store) {
    if (tick >= claim.untilTick) store.delete(id);
  }
  while (store.size > ITEM_CLAIM_CAP) {
    // Oldest expiry first — deterministic eviction order.
    let oldestKey: string | null = null;
    let oldestTick = Infinity;
    for (const [id, claim] of store) {
      if (claim.untilTick < oldestTick) {
        oldestTick = claim.untilTick;
        oldestKey = id;
      }
    }
    if (oldestKey === null) break;
    store.delete(oldestKey);
  }
}

/**
 * Write/refresh MY persistent claim on an item (the claimant refreshes every
 * tick it keeps targeting the item; expiry handles abandoned races).
 *
 * LIVE-CLAIM TAKEOVER IS IMPOSSIBLE (review m6): a live foreign claim can
 * never be overwritten — only an expired entry (pruned above) or my own
 * claim is writable. Every production caller is gated by
 * {@linkcode itemClaimedBy} first (the exclusivity contract), so a foreign
 * hit here means a caller bypassed the gate — fail loudly instead of
 * silently stealing the exclusivity the whole contest model is built on.
 */
export function claimItem(
  store: ItemClaimStore,
  itemId: string,
  botId: string,
  tick: number,
): void {
  pruneClaims(store, tick);
  const existing = store.get(itemId);
  if (existing) {
    if (existing.botId !== botId) {
      throw new Error(
        `claimItem: live-claim takeover attempted on ${itemId} by ${botId} ` +
          `(held by ${existing.botId} until tick ${existing.untilTick}; current tick ${tick}) — ` +
          'callers must gate on itemClaimedBy before claiming',
      );
    }
    existing.untilTick = tick + ITEM_CLAIM_TICKS;
    return;
  }
  store.set(itemId, { botId, untilTick: tick + ITEM_CLAIM_TICKS });
}

/**
 * Is the item claimed by ANOTHER bot right now? Returns the other claimant's
 * id, or null when unclaimed/mine/expired (expired entries are lazily
 * deleted on read — an abandoned claim frees the item without waiting for
 * the next write's prune). My own claim never blocks me.
 */
export function itemClaimedBy(
  store: ItemClaimStore,
  itemId: string,
  botId: string,
  tick: number,
): string | null {
  const claim = store.get(itemId);
  if (!claim) return null;
  if (tick >= claim.untilTick) {
    store.delete(itemId);
    return null;
  }
  return claim.botId === botId ? null : claim.botId;
}

/**
 * The INTERCEPT POINT on the contested item's enemy-approach side: the point
 * on the enemy→item line at min(INTERCEPT_MAX_OFFSET_PX, reach − inset) from
 * the item, toward the enemy. Stays inside the item's interaction reach
 * (arriving there wins chest-opens outright; weapon pickups close the last
 * px on the next straight step) while sitting squarely on the racing enemy's
 * approach line. Degenerates to the item seat itself when the geometry
 * collapses (enemy on top of the item / reach smaller than the inset).
 */
export function contestInterceptPoint(
  itemX: number,
  itemY: number,
  enemyX: number,
  enemyY: number,
  reachRadius: number,
): { x: number; y: number } {
  const enemyDist = distance(itemX, itemY, enemyX, enemyY);
  const offset = Math.min(INTERCEPT_MAX_OFFSET_PX, Math.max(0, reachRadius - INTERCEPT_INSET_PX));
  if (enemyDist <= 1 || offset <= 0) return { x: itemX, y: itemY };
  // Clamp the offset to half the enemy distance — never step PAST the enemy.
  const step = Math.min(offset, enemyDist * 0.5);
  const ux = (enemyX - itemX) / enemyDist;
  const uy = (enemyY - itemY) / enemyDist;
  return { x: itemX + ux * step, y: itemY + uy * step };
}

/**
 * Is the race decisively lost? (myDist vs enemyDist with the factor+slack
 * margin — the clean break-off predicate; called with fresh distances.)
 */
export function contestRaceLost(myDist: number, enemyDist: number): boolean {
  return myDist > enemyDist * CONTEST_BREAK_OFF_FACTOR + CONTEST_BREAK_OFF_SLACK_PX;
}

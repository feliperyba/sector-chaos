/**
 * BotCombatAwareness — bot-ai-v2 ticket 09 (DEC-010).
 *
 * The per-bot combat-awareness carrier: ONE composed object on the BotContext
 * (`ctx.combat`, class-field-initialized like `ctx.beliefs`) holding the six
 * stateful combat-believability mechanisms of this ticket:
 *
 *  1. STICKY WEAVE        — the committed perpendicular strafe under projectile
 *                           fire (direction + window; see BotCombatWeave.ts).
 *  2. DISENGAGE DISCRETION— the mid-fight break-off bookkeeping (last trigger
 *                           tick/cause + cooldown; see DiscretionTables.ts).
 *  3. KILL-FEED AWARENESS — the decaying sector danger memory + the safe-loot
 *                           window from heard eliminations (BotKillFeedMemory).
 *  4. RECENT DAMAGE       — the per-enemy damage-taken tracker restoring the
 *                           GDD §14.8 recentDamage targeting term
 *                           (BotRecentDamage.ts).
 *  5. ITEM CONTEST        — the contested-item seat + break-off window
 *                           (ItemContests.ts).
 *  6. WEAPON BREAK        — the active-weapon-break stamp the executor seam
 *                           reacts to (WeaponBreakReaction.ts).
 *
 * TELEMETRY DRAIN PATTERN: decision sites that have no tracker reference (the
 * intent layer) bump the `pending*` counters here; recordTickTelemetry drains
 * them into the believability surface once per tick — one observation seam,
 * same discipline as the stuck-ladder rung drain.
 *
 * Determinism: every stochastic draw in this family routes through the
 * per-bot BotRNG (the weave direction/window draw); everything else is a pure
 * function of the tick stream. No wall-clock reads anywhere.
 */

import { KillFeedMemory } from './BotKillFeedMemory.ts';
import { RecentDamageTracker } from './BotRecentDamage.ts';
import type { DisengageCause } from './DiscretionTables.ts';

export class BotCombatAwareness {
  // ── 1. sticky weave (DEC-010.1) ──────────────────────────────────────────
  /** Committed weave side (+1 | -1); 0 = no commitment yet. */
  weaveDir = 0;
  /** Tick the weave commitment expires (re-draw allowed at/after it). */
  weaveUntilTick = -9999;

  // ── 2. disengage discretion (DEC-010.3) ──────────────────────────────────
  /** Tick of the last accepted disengage trigger (the cooldown anchor). */
  lastDisengageTick = -9999;
  /** The cause of the last accepted trigger (telemetry/debug label). */
  lastDisengageCause: DisengageCause | null = null;

  // ── 3. kill-feed awareness (DEC-010.4) ───────────────────────────────────
  readonly killFeed = new KillFeedMemory();

  // ── 4. third-party target preference (DEC-010.6) ─────────────────────────
  readonly recentDamage = new RecentDamageTracker();

  // ── 5. real loot contests (DEC-010.5) ────────────────────────────────────
  /** The item this bot is actively racing for (server item id), if any. */
  contestedItemId: string | null = null;
  /** Contested item seat (world px) — the intercept-pathing anchor. */
  contestedItemX = 0;
  contestedItemY = 0;
  /** The racing enemy's last observed seat (world px). */
  contestedEnemyX = 0;
  contestedEnemyY = 0;
  /** Tick the contested-item state was last refreshed by the intent. */
  contestClaimTick = -9999;
  /** While > ctx.tick, CONTEST_LOOT stays invalid — the race was lost and
   *  broken off; the suspension window prevents an immediate re-contest
   *  (the ping-pong guard, DEC-010.5). */
  contestBreakOffUntilTick = -9999;

  // ── 6. weapon-break reaction (DEC-010.7) ─────────────────────────────────
  /** Tick the ACTIVE weapon was observed breaking (-9999 = never). The
   *  executor seam (WeaponBreakReaction) reacts while fresh + unhandled. */
  weaponBrokeTick = -9999;

  // ── pending telemetry (drained by recordTickTelemetry) ───────────────────
  /** Weave commitments made since the last drain. */
  pendingWeaveCommits = 0;
  /** Σ committed weave windows (ticks) since the last drain. */
  pendingWeaveCommitTicks = 0;
  /** Disengage triggers accepted since the last drain, by cause key. */
  readonly pendingDisengages: Record<string, number> = {};
  /** Contest outcomes resolved since the last drain ('win' | 'loss' | 'breakOff'). */
  readonly pendingContestOutcomes: Record<string, number> = {};
  /** Weapon-break reactions emitted since the last drain ('switch' | 'disengage'). */
  readonly pendingWeaponBreakReactions: Record<string, number> = {};

  /** Bump a pending counter record (drain contract: the drain zeroes it). */
  bump(record: Record<string, number>, key: string): void {
    record[key] = (record[key] ?? 0) + 1;
  }
}

import { TILE_PIXEL_SIZE } from '@sector-battle/shared';
import type { BotContext } from '../BotContext.ts';
import type { IntentId, IntentContext } from './Intent.ts';

export function distToZoneCenter(ctx: BotContext): number {
  const dx = ctx.x - ctx.zoneCenterX;
  const dy = ctx.y - ctx.zoneCenterY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function hpRatio(ctx: BotContext): number {
  return ctx.health / ctx.maxHealth;
}

/** True if outside the safe radius (HP-aware margin, mirrors legacy). */
export function isOutsideZone(ctx: BotContext): boolean {
  if (ctx.zoneRadius <= 0) return false;
  const r = hpRatio(ctx);
  let margin: number;
  if (r < 0.3) margin = ctx.zoneIsShrinking ? 0.65 : 0.8;
  else if (r < 0.5) margin = ctx.zoneIsShrinking ? 0.75 : 0.92;
  else margin = ctx.zoneIsShrinking ? 0.85 : 0.97;
  return distToZoneCenter(ctx) > ctx.zoneRadius * margin;
}

export function isOnSiegeWarning(ctx: BotContext): boolean {
  if (ctx.siegeWarnings.length === 0) return false;
  // Siege warnings are GRID coords ({x: gridX, y: gridY}, see BotZoneSafety);
  // convert to world via the SHARED tile-size constant (DEC-006 fix 1: this
  // previously hardcoded 64, half of TILE_PIXEL_SIZE — the checked point sat
  // at half the pending wall's true world position, thousands of px off far
  // from the origin, so the SURVIVE_ZONE siege hard-flee almost never fired
  // from proximity). Proximity radius: 2.5 tiles around the wall center.
  const tileSize = TILE_PIXEL_SIZE;
  const near = tileSize * 2.5;
  for (const w of ctx.siegeWarnings) {
    const dx = w.x * tileSize - ctx.x;
    const dy = w.y * tileSize - ctx.y;
    if (dx * dx + dy * dy < near * near) return true;
  }
  return false;
}

// Heal-threshold constant mirrored here so intents are self-contained (the
// legacy cascade defined these inline; centralizing them in one place is a
// side-benefit of the refactor).
export const SEEK_HEALTH_HP_PERCENT = 0.6;

// ---------- Per-(bot, intent, tick) value memo (perf tickets 26 + 27) ----------
//
// THE PROBLEM: the selector invokes an intent's isValid() and score() in both
// its committed-preempt loop and its full re-score loop (IntentSelector.select),
// so one intent can be asked the same question 2-3x per bot per tick. The
// pre-ticket-27 loot/retreat shape made this worse: score() itself started by
// calling isValid(), so every predicate in the chain ran TWICE per re-score.
//
// THE FIX: intents compute their per-tick values (inner scans, or the merged
// {valid, score} decision of ticket 27) ONCE and hand every caller (score/
// isValid/execute) the same object, keyed by IntentId on the per-bot
// BotContext.
//
// BEHAVIOR-PRESERVING PROOF (why reusing one result across score/isValid/
// execute within a single bot's tick is safe):
//
// Per-tick ordering in the driver (BotTickDriver.tickBot):
//   updateSelfState (syncs health/weapons/slots) → scanWorld/rescanHazards →
//   zone/self writes → [demolition early-return path — no intent code] →
//   anti-stall writes → selector.select(ic) (line 317) → intentsById lookup
//   (line 320, pure) → chosen.execute(ic) (line 321) → post-select writes
//   (lines 322-344, AFTER execute) → executeState (legacy executor, line 346).
//
// The memo's validity window is [first memoized call inside select()] →
// [execute()]. Code that runs inside that window:
//   - IntentSelector.select internals: isSuspended (selector-private Map) and
//     the other intents' isValid/score/commitTicks. All intents' score/
//     isValid/commitTicks are pure reads (verified across intentEngage.ts,
//     intentSurvival.ts, intentLoot.ts, intentHelpers.ts — no ctx writes; the
//     Intent contract executes nothing during selection).
//   - The driver between select() returning and execute() running: only the
//     intentsById() map lookup (pure). The state/strafe/demolition writes at
//     BotTickDriver.ts:322-344 happen AFTER execute(), outside the window.
//
// Window write-set: EMPTY ⇒ every read-set intersects it in ∅.
//
// Value semantics: entries may hold live references from ctx collections —
// safe because nothing mutates those objects inside the window (the per-scan
// mutators run inside scanWorld, before selection) and no consumer mutates a
// memoized result.
//
// Invalidation: entries carry the tick they were computed at; a hit requires
// entry.tick === ctx.tick. ctx.tick is set once per simulation tick
// (BotSystem.tick, before tickBot), so every tick boundary forces a recompute.
// Entry PRESENCE (with a matching tick) distinguishes "computed null/0/false
// this tick" from "not yet computed this tick".
//
// IC-SHAPE GUARD (perf ticket 27): ticket-27 decisions (the loot/retreat
// {valid, score} collapse) read ic-LEVEL inputs too — profile, aliveBotCount,
// enemyInFightRange — not just ctx. (Ticket 10 added the match-arc state to
// the guarded shape: the arc mods feed the loot/engage-family scores.) In production the driver builds exactly
// ONE IntentContext per bot per tick (BotTickDriver.ts:310) and threads it
// through select()→execute(), so those inputs are constant within the tick
// and the guard never rejects a hit (zero extra computations). It exists for
// correctness under out-of-contract reuse (e.g. a unit test comparing two
// personalities against one shared ctx at one tick): the entry additionally
// records the ic shape it was computed from, and any mismatch forces a
// recompute. Ticket-26's engage scans read only ctx, so the guard is
// over-conservative (harmless) for them.
//
// Lives on the ctx (not the Intent instances) because the ctx is per-bot by
// construction — one BotContext per playerId — so the memo is per-bot per
// intent even if intent instances are ever shared.
//
// Lazily attached: unit-test ctx factories build plain object literals (cast
// to BotContext) that may omit class-initialized fields; a null check keeps
// those working.

/** Entry type for the per-(bot, intent, tick) value memo — see memoizedScan. */
export interface IntentMemoEntry {
  tick: number;
  /** ic shape the value was computed from (see IC-SHAPE GUARD above). */
  profile: IntentContext['profile'];
  aliveBotCount: number;
  enemyInFightRange: boolean;
  zoneIsLethal: boolean;
  /** Match-arc state (bot-ai-v2 ticket 10): the arc mods now feed loot/
   *  engage-family scores, so the ic shape includes the arc OBJECT IDENTITY —
   *  a unit test comparing two arcs against one shared ctx at one tick must
   *  not reuse a memo computed under the other arc. Production is unaffected
   *  (one arc object per tick, one ic per bot per tick — the guard never
   *  rejects a hit). */
  arc: IntentContext['arc'];
  value: unknown;
}

export function memoizedScan<T>(
  ic: IntentContext,
  id: IntentId,
  compute: (ic: IntentContext) => T,
): T {
  const ctx = ic.ctx;
  // Lazily attach: test ctx factories build plain literals cast to BotContext.
  let memo = ctx.intentScanMemo;
  if (!memo) {
    memo = new Map();
    ctx.intentScanMemo = memo;
  }
  const entry = memo.get(id);
  if (
    entry !== undefined &&
    entry.tick === ctx.tick &&
    entry.profile === ic.profile &&
    entry.aliveBotCount === ic.aliveBotCount &&
    entry.enemyInFightRange === ic.enemyInFightRange &&
    entry.zoneIsLethal === ic.zoneIsLethal &&
    entry.arc === ic.arc
  ) {
    return entry.value as T;
  }
  const value = compute(ic);
  memo.set(id, {
    tick: ctx.tick,
    profile: ic.profile,
    aliveBotCount: ic.aliveBotCount,
    enemyInFightRange: ic.enemyInFightRange,
    zoneIsLethal: ic.zoneIsLethal,
    arc: ic.arc,
    value,
  });
  return value;
}

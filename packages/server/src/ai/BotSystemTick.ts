/**
 * BotSystem.tick — the per-tick orchestrator pass (bot-ai-v2 ticket 11
 * partial extraction, for the module-length gate). The body is the verbatim
 * tick() the BotSystem class owned, with `this.` → `system.`; the class
 * method is now a one-line delegate. All per-tick documentation (the two
 * clocks, the tick blackboard, fight memory, LOD) lives HERE.
 */

import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import type { BotSystem } from './BotSystem.ts';
import { computeMatchArc } from './arc/MatchArc.ts';
import { buildBarrelDensity, buildDestructibleMap } from './BotSpatialIndex.ts';
import { tickBot } from './BotTickDriver.ts';
import { recordBotDeath, recordTickTelemetry } from './BotTelemetry.ts';
import { createTickBlackboard } from './TickBlackboard.ts';
import { updateZoneInfo, type ZoneInfo } from './BotZoneSafety.ts';
import { aiClockNow, beginAiTick, hrtimeMs, recordAiTickEnd } from './lod/AiBudgetGuard.ts';
import { collectLodReferences, runLodForBot } from './lod/LodAssignment.ts';

/**
 * One BotSystem tick: snapshot sync, shared per-tick rebuilds, the tick
 * blackboard, the LOD tier pass, and the per-bot loop (delegating to
 * tickBot). Returns the bots' queued inputs for this tick.
 */
export function botSystemTick(system: BotSystem, tick: number): QueuedInput[] {
  // TWO CLOCKS (bot-ai-v2 ticket 11, DEC-012) — see lod/AiBudgetGuard.ts:
  //
  //  - METRIC (hrtime, never virtualized): read-only observation feeding the
  //    aiTime percentiles + the budget's sustained-overrun FAIL surface. The
  //    value never feeds back into behavior; the resulting fields are
  //    WALL-CLOCK fields in the bench JSON's masked set
  //    (timestamp/realDurationMs/speedup/tickBudget/aiTime/aiBudget — see
  //    the harness header).
  //  - GUARD (performance.now, the clock the harness VIRTUALIZES): the one
  //    sanctioned wall-clock read in the AI pass. Under the fast-forward
  //    harness the virtual clock does not advance within a tick, so every
  //    within-tick delta is 0 — LOD relief NEVER fires in a benchmark and
  //    behavior stays a pure function of the tick stream (same-seed
  //    byte-identity). In production this is real time and the guard
  //    actually enforces the ≤4 ms target with T2-first relief.
  const aiT0 = hrtimeMs();
  const guardT0 = aiClockNow();
  const inputs = system.tickInputs;
  inputs.length = 0;

  system.worldSnapshot.sync(system.entityMaps);

  // MATCH ARC (ticket 10): GDD §14.3 bands from this tick's alive counts.
  system.matchArc = computeMatchArc(
    system.worldSnapshot.alivePlayerCount,
    system.worldSnapshot.playerActiveCount,
  );

  if (system.match.consumeGridDirty()) {
    system.syncPathfinderGrid();
  }

  system.pathfinder.beginTick(tick);

  // Rebuild the destructible-position map every 30 ticks. This feeds the
  // DEMOLITION intercept (now wired into ALL navigation states): when a bot's
  // pathfinder can't route to a target, it scans this map for a destructible
  // wall blocking the way and breaks it. Without this, bots get permanently
  // stuck behind crates/walls and slide into them forever (the back-and-forth
  // bounce). 30 ticks (0.5s) keeps the map fresh enough that bots don't swing
  // at long-broken walls; the rebuild is a single cheap pass over destructibles.
  if (tick % 30 === 0) buildDestructibleMap(system);

  // Rebuild the barrel density grid every 30 ticks (shared across all bots).
  // This is a single pass over destructibles — cheap vs per-bot perception.
  if (tick % 30 === 0) buildBarrelDensity(system);

  // TICK BLACKBOARD (ticket 35): fresh per-tick coordination state —
  // convergingCount / huntersPerTarget / claimedItems (the old
  // resetCombatCoordinator zero+clear, now a construction) and zoneIsLethal
  // (written by updateZoneInfo just below). ONE instance is shared by
  // reference with every bot's tickBot in `bots` map order, so later bots
  // still see earlier bots' hunter counts, item claims and convergence
  // slots within the tick (cross-bot sequential semantics preserved). The
  // combat hotspot is carried BY REFERENCE from system.combatHotspot — the
  // one piece of coordinator state that was never reset per tick (20s
  // memory), so carrying the reference reproduces the old reset semantics
  // exactly. Constructed before updateZoneInfo because that call now
  // writes bb.zoneIsLethal; no reader observes either ordering difference
  // (all readers are inside the per-bot loop below).
  const bb = createTickBlackboard(system.combatHotspot);

  const zoneInfo: ZoneInfo = updateZoneInfo(system, bb);

  // LOD (ticket 11, DEC-012): one snapshot pass gathers this tick's
  // reference players for proximity tiering (alive humans, else all alive
  // players); each living bot's tier is then assigned inside the loop below
  // — pure from positions/engagement, recomputed EVERY tick, so combat
  // entry upgrades a far bot to full fidelity on the very next tick.
  collectLodReferences(system);
  beginAiTick(system.aiBudget);

  // NOTE: the alive-bot count is NO LONGER recomputed here. It is maintained
  // as a side effect of the worldSnapshot player sync pass above —
  // syncWorldPlayers increments worldSnapshot.aliveBotCount inline using the
  // exact predicate an old post-sync loop used (`dto.isAlive && dto.isBot`),
  // so the value every downstream reader (IntentContext, endgame thresholds)
  // sees is identical to that recount.

  // FIGHT MEMORY (bot-ai-v2 ticket 03, DEC-002): the retired whole-map
  // gunfire scan (recordGunfireHotspot) and the per-sighting write
  // (contributeCombatHotspot) are GONE. The hotspot is written by the
  // StimulusRouter from routed WeaponFired/BarrelExploded events (see
  // ingestStimulusEvents — called by GameOrchestrator.update after this
  // tick's bot pass, so HUNT reads the memory from the next tick on, one
  // tick of stimulus latency — same cadence as the bots' own inputs).
  // Humans' gunfire now feeds the memory too (previously bot-only).

  system.bots.forEach((ctx) => {
    const dto = system.worldSnapshot.getPlayerById(ctx.playerId);
    const tracker = system.skillTrackers.get(ctx.playerId);
    if (!dto || !dto.isAlive) {
      // Detect the alive→dead transition to freeze survival time and tally
      // the death cause exactly once. The cause is inferred from the bot's
      // last context (zone/siege/barrel proximity) since the per-bot AI loop
      // doesn't see the elimination event directly.
      if (ctx.isAlive && tracker && !tracker.isDead) {
        recordBotDeath(system, ctx, tracker, tick);
      }
      ctx.isAlive = false;
      return;
    }
    ctx.isAlive = true;
    ctx.tick = tick;
    // THIS tick's position for the tier pass: updateSelfState (inside
    // tickBot, below) is the canonical sync, but it runs AFTER the LOD
    // assignment — a freshly-registered bot still holds the (0,0) ctx
    // default, so its first tier would be computed from the map corner
    // (a false proximity-T0/T2 read). Same write, same source: idempotent.
    ctx.x = dto.x;
    ctx.y = dto.y;
    // LOD + GUARD (ticket 11): tier assignment (pure), relief level from the
    // guard clock, and the think-cadence verdict — all in one helper so the
    // per-bot loop stays a single readable line (lod/LodAssignment).
    const thinkTick = runLodForBot(system, ctx, tick, guardT0);
    tickBot(system, ctx, dto, zoneInfo, bb, inputs, thinkTick);
    if (tracker) recordTickTelemetry(system, ctx, dto, tracker, zoneInfo);
  });

  const aiElapsedMs = hrtimeMs() - aiT0;
  system.aiTickTimes.push(aiElapsedMs);
  recordAiTickEnd(system.aiBudget, aiElapsedMs);
  return inputs;
}

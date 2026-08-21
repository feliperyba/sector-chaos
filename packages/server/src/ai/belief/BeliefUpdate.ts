/**
 * Believed-state updates — bot-ai-v2 ticket 05 (DEC-003).
 *
 * The mutation layer over the per-bot {@link BeliefStore}, run BETWEEN
 * perception and the executors:
 *
 *  WRITE SOURCES (all deterministic — the only RNG draws are the per-bot
 *  stream's foveation noise and damage-estimate spread):
 *   - seen    per perception scan (runBeliefScan): every scanned enemy writes
 *             a foveated belief — position noised by angle-from-facing ×
 *             distance × difficulty, confidence = GDD §14.2 detection-range
 *             fade × GDD §14.3 LOS-halving, converged toward the sample by
 *             the per-difficulty ramp. In-scan combat keeps reading ground
 *             truth (ctx.enemies); the noised belief is what the bot
 *             remembers once the enemy leaves perception.
 *   - heard   StimulusRouter-driven (writeHeardBelief): a delivered 'attack'
 *             stimulus writes a low-confidence belief about the FIRER at the
 *             stimulus seat (a shot's sound carries its origin roughly).
 *   - damage  StimulusRouter-driven (writeDamageDirectionBelief): a 'damage'
 *             stimulus delivered to the VICTIM writes a direction + per-bot
 *             RNG-spread ESTIMATE about the attacker — NEVER the attacker's
 *             true coordinates. This replaces the audited nearest-enemy
 *             misattribution (AUDIT §3.3.1) as the Reactor's startle origin
 *             and the revenge-pursuit seed.
 *
 *  READS (the believed-world consumers):
 *   - pursueBelievedEnemy — the HUNT investigation target: the freshest
 *     above-threshold belief for an enemy OUTSIDE the current scan.
 *   - Belief-freshness gating of target locks lives in BotTargeting.
 *   - The Reactor's startle origin lives in ReactorConditions.
 *
 *  SEARCH-FAILURE MEMORY (DEC-003, "extends the existing suspension
 *  mechanism from goals to targets"): a pursuit opened by
 *  pursueBelievedEnemy that goes SEARCH_FAILURE_TICKS without re-acquiring
 *  the enemy drops the belief AND suspends the pursuing intent family via
 *  the SAME selector.suspend() the goal-stall path uses (no parallel
 *  mechanism) — no infinite ghost chases.
 */

import type { BotSystem } from '../BotSystem.ts';
import type { BotContext } from '../BotContext.ts';
import type { PersonalityProfile } from '../intent/PersonalityProfile.ts';
import { botStateToIntentFamily } from '../intent/intents.ts';
import { noteGoalSuspension } from '../BotTelemetry.ts';
import type { BotBeliefTelemetry } from '../BotBeliefTelemetry.ts';
import { EnemyBelief, type BeliefSource } from './BeliefTypes.ts';
import {
  DAMAGE_CONFIDENCE,
  DAMAGE_NO_DIRECTION_CONFIDENCE,
  HEARD_CONFIDENCE,
  PURSUIT_MIN_CONFIDENCE,
  SEARCH_FAILURE_TICKS,
  TARGET_SEARCH_SUSPEND_TICKS,
} from './BeliefConfig.ts';
import {
  angleFromFacingAbs,
  applyFoveationNoise,
  deadReckon,
  decayConfidence,
  detectionConfidence,
  estimateDamageOrigin,
  isBeliefExpired,
  losConfidenceFactor,
  nextSeenConfidence,
} from './BeliefMath.ts';

/** Tracker lookup for the scan-tick paths (null = no telemetry). */
function beliefTelemetryOf(system: BotSystem, playerId: string): BotBeliefTelemetry | null {
  return system.skillTrackers.get(playerId)?.believability.beliefs ?? null;
}

// ---------------------------------------------------------------------------
// SEEN — per-scan foveated writes (the believed memory of sightings)
// ---------------------------------------------------------------------------

/**
 * Write/refresh beliefs for every enemy in this scan's ctx.enemies. Runs on
 * perception-scan ticks only (called from runBeliefScan). Consumes exactly
 * two ctx.rng draws per scanned enemy (foveation noise), in ctx.enemies
 * order — deterministic.
 */
function updateSeenBeliefs(system: BotSystem, ctx: BotContext, profile: PersonalityProfile): void {
  const difficulty = profile.difficulty;
  const store = ctx.beliefs;
  const believability = beliefTelemetryOf(system, ctx.playerId);
  for (const e of ctx.enemies) {
    // Belief-freshness gate for RE-ACQUISITION: seeing the pursued enemy in
    // the current scan closes the pursuit as a success (the investigation
    // found its target — DEC-003's "re-acquire or drop" happy path).
    if (ctx.pursuitTargetId === e.id) {
      closePursuit(ctx, believability, 'reacquired');
    }
    const sample =
      detectionConfidence(e.distance, difficulty) *
      losConfidenceFactor(
        system.pathfinder.hasLineOfSightWorld({ x: ctx.x, y: ctx.y }, { x: e.x, y: e.y }),
      );
    const prev = store.get(e.id);
    const prevConfidence = prev ? prev.confidence : 0;
    const noised = applyFoveationNoise(
      ctx.rng,
      e.x,
      e.y,
      angleFromFacingAbs(ctx.facingAngle, e.x, e.y, ctx.x, ctx.y),
      e.distance,
      difficulty,
    );
    store.set(
      e.id,
      new EnemyBelief(
        noised.x,
        noised.y,
        e.vx,
        e.vy,
        ctx.tick,
        nextSeenConfidence(prevConfidence, sample, difficulty),
        'seen',
      ),
    );
    believability?.noteBeliefWrite('seen');
  }
}

// ---------------------------------------------------------------------------
// HEARD — router-driven belief writes from attack stimuli
// ---------------------------------------------------------------------------

/**
 * A heard shot: the firer is believed to be at (roughly) the stimulus seat.
 * RNG-free (the seat is the event's own audible origin; the uncertainty is
 * encoded in HEARD_CONFIDENCE + zero velocity). Never downgrades a fresher
 * or just-seen belief about the same enemy.
 */
export function writeHeardBelief(
  ctx: BotContext,
  believability: BotBeliefTelemetry | null,
  firerId: string,
  x: number,
  y: number,
  tick: number,
): void {
  const store = ctx.beliefs;
  const prev = store.get(firerId);
  if (prev && prev.tick >= tick) return; // a fresher belief already exists
  // "Just saw them" = the freshest possible class: seen this tick or the
  // previous one (the stimulus is ingested AFTER the bot pass, so a same-
  // tick sighting hits the guard above; a 1-tick-old sighting is the most
  // recent scan under the 3-tick perception stride). A wider window (the
  // original `<= 3`) spans a WHOLE scan cycle: with the attack hearing
  // radius (900px) inside the perception range (1000px), every heard firer
  // was seen within 3 ticks — the heard channel was structurally starved
  // (0 writes across a full 24-bot match). A 2+-tick-old seen belief is
  // foveation-noised stale data; the heard seat is the firer's TRUE fire
  // position — the write proceeds and the next scan re-converges.
  if (prev && prev.source === 'seen' && tick - prev.tick <= 1) return;
  store.set(firerId, new EnemyBelief(x, y, 0, 0, tick, HEARD_CONFIDENCE, 'heard'));
  believability?.noteBeliefWrite('heard');
}

// ---------------------------------------------------------------------------
// DAMAGE — the direction+spread estimate (DEC-003's core belief)
// ---------------------------------------------------------------------------

/**
 * THE DAMAGE-DIRECTION BELIEF. The victim of a damage stimulus writes an
 * ESTIMATED attacker position: direction = the negated knockback vector
 * (server-authoritative physics), spread + guessed distance drawn from the
 * victim's per-bot BotRNG (estimateDamageOrigin). The attacker's true
 * coordinates are never inputs. Also publishes ctx.lastDamageBelief* — the
 * Reactor's startle origin seam (ReactorConditions.resolveDamageThreatOrigin).
 */
export function writeDamageDirectionBelief(
  ctx: BotContext,
  believability: BotBeliefTelemetry | null,
  attackerId: string,
  tick: number,
  victimX: number,
  victimY: number,
  dirX: number,
  dirY: number,
): void {
  const hasDirection = dirX !== 0 || dirY !== 0;
  const estimate = estimateDamageOrigin(ctx.rng, victimX, victimY, dirX, dirY);
  const store = ctx.beliefs;
  const prev = store.get(attackerId);
  if (prev && prev.tick > tick) return; // stale event ordering guard
  if (prev && prev.source === 'seen' && tick - prev.tick <= 3) {
    // The attacker is in sight RIGHT NOW — the visible position is better
    // data than a direction estimate. Still publish the flinch origin: the
    // startle faces where the HIT came from, which is the same enemy.
    ctx.lastDamageBeliefX = prev.x;
    ctx.lastDamageBeliefY = prev.y;
    ctx.lastDamageBeliefTick = tick;
    believability?.noteBeliefWrite('damage');
    return;
  }
  store.set(
    attackerId,
    new EnemyBelief(
      estimate.x,
      estimate.y,
      0,
      0,
      tick,
      hasDirection ? DAMAGE_CONFIDENCE : DAMAGE_NO_DIRECTION_CONFIDENCE,
      'damage',
    ),
  );
  ctx.lastDamageBeliefX = estimate.x;
  ctx.lastDamageBeliefY = estimate.y;
  ctx.lastDamageBeliefTick = tick;
  believability?.noteBeliefWrite('damage');
}

/**
 * An elimination stimulus: the victim's belief is dropped (dead enemies are
 * not worth investigating). An open pursuit on the victim closes as
 * 'dropped' (the investigation ended without re-acquisition — the target is
 * gone). Router-driven, RNG-free.
 */
export function dropEliminatedBelief(
  ctx: BotContext,
  believability: BotBeliefTelemetry | null,
  victimId: string,
): void {
  if (!ctx.beliefs.get(victimId)) return;
  ctx.beliefs.delete(victimId);
  if (ctx.pursuitTargetId === victimId) {
    closePursuit(ctx, believability, 'dropped');
  }
}

// ---------------------------------------------------------------------------
// Pursuit (the investigation state) + search-failure memory
// ---------------------------------------------------------------------------

/**
 * The out-of-scan pursuit read seam (HUNT's Priority-1 replacement for the
 * raw lastSeenEnemy chase): the FRESHEST belief whose confidence is at or
 * above PURSUIT_MIN_CONFIDENCE and whose enemy is NOT in the current scan
 * (in-scan enemies are ground truth — the live executors own them).
 *
 * Opening (or re-confirming) a pursuit arms the investigation clock; the
 * search-failure enforcement (below) bounds it. Returns the dead-reckoned
 * believed position (last velocity extrapolation, capped).
 */
export function pursueBelievedEnemy(
  ctx: BotContext,
  believability: BotBeliefTelemetry | null,
): { id: string; x: number; y: number; confidence: number; source: BeliefSource } | null {
  // In-scan exclusion set (small: the last scan's enemy list).
  let bestId: string | null = null;
  let best: EnemyBelief | null = null;
  for (const [id, belief] of ctx.beliefs.entriesById()) {
    if (belief.confidence < PURSUIT_MIN_CONFIDENCE) continue;
    let inScan = false;
    for (const e of ctx.enemies) {
      if (e.id === id) {
        inScan = true;
        break;
      }
    }
    if (inScan) continue;
    if (!best || belief.tick > best.tick) {
      best = belief;
      bestId = id;
    }
  }
  if (!best || bestId === null) return null;
  if (ctx.pursuitTargetId !== bestId) {
    if (ctx.pursuitTargetId !== null) {
      // Switching investigation targets: the old pursuit ended WITHOUT
      // re-acquisition (a fresher belief won) — close its bookkeeping as
      // 'dropped' so every opened pursuit yields exactly one outcome (the
      // pursuit-outcome accounting invariant).
      believability?.notePursuitOutcome('dropped');
    }
    ctx.pursuitTargetId = bestId;
    ctx.pursuitStartTick = ctx.tick;
    ctx.beliefs.exemptId = bestId;
    believability?.notePursuitStart();
  }
  const pos = deadReckon(best.x, best.y, best.vx, best.vy, best.tick, ctx.tick);
  return { id: bestId, x: pos.x, y: pos.y, confidence: best.confidence, source: best.source };
}

/** Close the open pursuit with an outcome. Idempotent (no pursuit → no-op). */
function closePursuit(
  ctx: BotContext,
  believability: BotBeliefTelemetry | null,
  outcome: 'reacquired' | 'dropped',
): void {
  if (ctx.pursuitTargetId === null) return;
  ctx.pursuitTargetId = null;
  ctx.pursuitStartTick = -9999;
  if (ctx.beliefs.exemptId !== null) ctx.beliefs.exemptId = null;
  believability?.notePursuitOutcome(outcome);
}

/**
 * SEARCH-FAILURE MEMORY (DEC-003): a pursuit that has investigated for
 * SEARCH_FAILURE_TICKS without re-acquiring its enemy (the re-acquisition
 * close happens in updateSeenBeliefs when the enemy re-enters the scan) is
 * dropped: the belief is deleted, the pursuing intent family is SUSPENDED
 * via the goal-suspension mechanism (selector.suspend — the SAME mechanism
 * the anti-stall path uses; the extension is that the "goal" being
 * suspended over is now a TARGET), and the pursuit closes as 'dropped'.
 */
function enforceSearchFailure(system: BotSystem, ctx: BotContext): void {
  const targetId = ctx.pursuitTargetId;
  if (targetId === null) return;
  for (const e of ctx.enemies) {
    if (e.id === targetId) return; // in the current scan — not a failure
  }
  if (ctx.tick - ctx.pursuitStartTick <= SEARCH_FAILURE_TICKS) return;
  const believability = beliefTelemetryOf(system, ctx.playerId);
  ctx.beliefs.delete(targetId);
  closePursuit(ctx, believability, 'dropped');
  const family = botStateToIntentFamily(ctx.state);
  const selector = system.selectors.get(ctx.playerId);
  if (selector) {
    selector.suspend(family, ctx.tick + TARGET_SEARCH_SUSPEND_TICKS);
    selector.forceReevaluate();
  }
  noteGoalSuspension(system, ctx.playerId, family, 'search-failure');
}

/**
 * Decay + expiry pass over the store (scan-tick cadence). Decay recomputes
 * from each belief's WRITE-TIME anchor (`confidence0`) over the full elapsed
 * span, so repeated passes never compound the decay. Expiry: confidence
 * floor OR the absolute age cap. Expired beliefs are deleted; an expired
 * PURSUIT target closes as 'dropped' with the same family-cooldown as an
 * explicit search failure (both are "investigated without re-acquisition").
 */
function maintainBeliefs(system: BotSystem, ctx: BotContext, profile: PersonalityProfile): void {
  const difficulty = profile.difficulty;
  const telemetry = beliefTelemetryOf(system, ctx.playerId);
  const expired: string[] = [];
  for (const [id, belief] of ctx.beliefs.entriesById()) {
    const dt = ctx.tick - belief.tick;
    if (dt > 0) {
      belief.confidence = decayConfidence(belief.confidence0 ?? belief.confidence, dt, difficulty);
    }
    if (isBeliefExpired(belief.confidence, belief.tick, ctx.tick)) expired.push(id);
  }
  for (const id of expired) {
    ctx.beliefs.delete(id);
    if (ctx.pursuitTargetId === id) {
      // Natural expiry of a pursued belief — same closure as search failure
      // (bounded investigation, family cooldown, relocate).
      closePursuit(ctx, telemetry, 'dropped');
      const family = botStateToIntentFamily(ctx.state);
      const selector = system.selectors.get(ctx.playerId);
      if (selector) {
        selector.suspend(family, ctx.tick + TARGET_SEARCH_SUSPEND_TICKS);
        selector.forceReevaluate();
      }
      noteGoalSuspension(system, ctx.playerId, family, 'search-failure');
    }
  }
}

/**
 * The per-scan belief maintenance entry point — called from the perception
 * phase (BotTickPhases.runPerception) on scan ticks, AFTER scanWorld and the
 * stimulus-scan refresh. Order: seen-writes first (fresh sightings converge
 * + close re-acquired pursuits), then decay/expiry, then the search-failure
 * bound (a belief refreshed this scan has dt 0, so decay never touches it).
 */
export function runBeliefScan(
  system: BotSystem,
  ctx: BotContext,
  profile: PersonalityProfile,
): void {
  updateSeenBeliefs(system, ctx, profile);
  maintainBeliefs(system, ctx, profile);
  enforceSearchFailure(system, ctx);
}

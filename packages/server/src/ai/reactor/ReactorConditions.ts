/**
 * Reactor condition checks — bot-ai-v2 ticket 04 (DEC-004).
 *
 * THE PURE SEAM of the Reactor: each priority's condition is a FLAG READ off
 * the bot's already-published perception/stimulus state (ctx fields +
 * StimulusScanView), never a spatial query (DEC-004 dissent: the condition
 * list is O(#reactions ~5) of flag checks — no grid queries, no scans). All
 * five detectors are pure functions of their arguments: no RNG, no clock, no
 * mutation (dedupe reads the per-bot state; the CALLER records dedupe marks
 * so an unsuppressed/suppressed trigger is decided in one place).
 *
 * Priority order (highest first) — the caller walks detectors in this order:
 *   1. imminentDeath   — siege-crush tile / lethal-zone crossing (GDD §14.4
 *                        instant-override semantics: zero latency, may
 *                        preempt an active reaction).
 *   2. projectile      — incoming projectile on an intercept course with the
 *                        bot's hitbox (the promoted 250px steering nudge).
 *   3. startle         — took damage: the STARTLE cause (faces the damage-
 *                        direction BELIEF — an estimated origin, DEC-003;
 *                        see resolveDamageThreatOrigin).
 *   4. explosion       — a heard explosion above threshold, still fresh.
 *   5. windup          — an enemy windup aimed at me (the retired
 *                        shouldDodgeWindup gates, MINUS the personality
 *                        caution gate — un-gated for every archetype).
 */

import type { BotContext } from '../BotContext.ts';
import type { StimulusScanView } from '../stimulus/StimulusScan.ts';
import type { PersonalityProfile } from '../intent/PersonalityProfile.ts';
import { safeGetWeaponDef } from '../BotLoadout.ts';
import type { ReactionTrigger, ReactorBotState } from './ReactorTypes.ts';
import {
  DAMAGE_FRESH_TICKS,
  EXPLOSION_MAX_AGE_TICKS,
  EXPLOSION_MIN_EFFECTIVE_STRENGTH,
  PROJECTILE_IMPACT_HORIZON_TICKS,
  PROJECTILE_INTERCEPT_MARGIN_PX,
  PROJECTILE_MIN_DISTANCE_PX,
  WINDUP_EPISODE_COOLDOWN_TICKS,
  WINDUP_LEAD_TICKS,
  WINDUP_RANGE_FACTOR,
  WINDUP_THREAT_DOT,
} from './ReactorConfig.ts';

/** windupMs → ticks conversion (matches BotCombatShared's PERCENT_TO_TICKS:
 *  ms × 60 ticks/s ÷ 1000). */
const MS_TO_TICKS = 0.06;

/**
 * True when the bot is currently OUTSIDE the damaging zone ring (the
 * exposure predicate of the lethal-zone channel). Pure — the reactor's
 * every-tick edge-memory write (BotReactor.runReactionTick's finally) is its
 * ONLY writer, so the rising-edge semantics stay in one place.
 */
export function computeOutsideLethalZone(ctx: BotContext, zoneIsLethal: boolean): boolean {
  return (
    zoneIsLethal &&
    ctx.zoneRadius > 0 &&
    dist(ctx.x, ctx.y, ctx.zoneCenterX, ctx.zoneCenterY) > ctx.zoneRadius
  );
}

/**
 * Priority 1 — imminent death. Two OR-ed causes:
 *  - SIEGE CRUSH: a pending siege-wall warning sits on the bot's own tile.
 *    `ctx.siegeWarnings` carries GRID coordinates (see syncZoneState); the
 *    solidifyAt wall-clock field is deliberately never read (determinism
 *    contract) — a pending warning on my tile is imminent by construction,
 *    because SiegeWallManager prunes warnings the moment they solidify.
 *  - LETHAL-ZONE CROSSING: rising edge of (outside a damaging zone). Fires
 *    once on the crossing; the steady-state flee belongs to the SURVIVE_ZONE
 *    intent (the selector already preempts with it instantly — this reaction
 *    is the reflex spike on top: dash + panic move toward safety).
 *
 * Returns a trigger with a null threat (the escape direction is the zone-safe
 * point, computed at emit time) and zero-latency handling upstream.
 */
export function detectImminentDeath(
  ctx: BotContext,
  st: ReactorBotState,
  zoneIsLethal: boolean,
  tileSize: number,
): ReactionTrigger | null {
  // Siege crush: any pending warning tile that IS the bot's tile.
  if (ctx.siegeWarnings.length > 0 && tileSize > 0) {
    const gx = Math.floor(ctx.x / tileSize);
    const gy = Math.floor(ctx.y / tileSize);
    for (const w of ctx.siegeWarnings) {
      if (w.x === gx && w.y === gy) {
        return {
          type: 'imminentDeath',
          stimulusTick: ctx.tick,
          threatX: null,
          threatY: null,
          key: `siege:${gx}:${gy}`,
          subjectId: null,
        };
      }
    }
  }
  // Lethal-zone crossing (rising edge). PURE READ (review M3): the edge
  // memory is written by the reactor on EVERY tick (runReactionTick's
  // finally block) — including ticks this detector does not run (an active
  // imminent-death window, pending latency, refractory) — so it always holds
  // the PREVIOUS tick's exposure here. A re-entry DURING a reaction window
  // therefore leaves a fresh rising edge for the next detector read, instead
  // of freezing at the arming tick's value and silently swallowing the next
  // crossing.
  const outside = computeOutsideLethalZone(ctx, zoneIsLethal);
  const crossed = outside && !st.wasOutsideLethalZone;
  if (!crossed) return null;
  return {
    type: 'imminentDeath',
    stimulusTick: ctx.tick,
    threatX: null,
    threatY: null,
    key: `zone:${ctx.tick}`,
    subjectId: null,
  };
}

/**
 * Priority 2 — incoming projectile on an intercept course. A projectile
 * counts as incoming when its velocity closes on the bot, its ray passes
 * within the intercept margin of the bot's center (i.e. the hitbox), and the
 * impact lands inside the horizon. Deduped per projectile id (one evade per
 * round). Picks the SOONEST-impacting match (deterministic tie-break:
 * perception array order).
 */
export function detectIncomingProjectile(
  ctx: BotContext,
  st: ReactorBotState,
): ReactionTrigger | null {
  let best: ReactionTrigger | null = null;
  let bestImpact = Infinity;
  for (const proj of ctx.projectiles) {
    if (st.reactedProjectiles.has(proj.id)) continue;
    const speed = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy);
    if (speed < 1) continue;
    const ux = proj.vx / speed;
    const uy = proj.vy / speed;
    const dx = ctx.x - proj.x;
    const dy = ctx.y - proj.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < PROJECTILE_MIN_DISTANCE_PX) continue;
    const along = ux * dx + uy * dy; // bot's projection onto the ray
    if (along <= 0) continue; // receding — not incoming
    const perp = Math.abs(ux * dy - uy * dx); // perpendicular distance to the ray
    if (perp > PROJECTILE_INTERCEPT_MARGIN_PX) continue; // passing wide
    const impactTicks = along / speed;
    if (impactTicks > PROJECTILE_IMPACT_HORIZON_TICKS) continue;
    if (impactTicks < bestImpact) {
      bestImpact = impactTicks;
      best = {
        type: 'projectile',
        stimulusTick: ctx.tick,
        threatX: proj.x,
        threatY: proj.y,
        key: `proj:${proj.id}`,
        subjectId: proj.id,
      };
    }
  }
  return best;
}

/**
 * Priority 3 — took damage (STARTLE). Fires on the rising edge of
 * ctx.lastDamageTick (one startle per hit), while the hit is fresh. The
 * threat origin is the DAMAGE-DIRECTION BELIEF (bot-ai-v2 ticket 05,
 * DEC-003): the stimulus router's damage delivery writes an estimated
 * attacker position (knockback direction + per-bot RNG spread — see
 * BeliefUpdate.writeDamageDirectionBelief) into ctx.lastDamageBelief*,
 * replacing the audited nearest-enemy misattribution.
 */
export function detectDamageStartle(ctx: BotContext, st: ReactorBotState): ReactionTrigger | null {
  if (ctx.lastDamageTick <= st.lastReactedDamageTick) return null; // no new hit
  if (ctx.tick - ctx.lastDamageTick > DAMAGE_FRESH_TICKS) return null; // stale hit — skip (the flinch window passed)
  const origin = resolveDamageThreatOrigin(ctx);
  return {
    type: 'startle',
    stimulusTick: ctx.lastDamageTick,
    threatX: origin.x,
    threatY: origin.y,
    key: `dmg:${ctx.lastDamageTick}`,
    subjectId: null,
  };
}

/**
 * The believed damage-direction source (bot-ai-v2 ticket 05, DEC-003 — the
 * seam ticket 04 left). Reads the damage-direction BELIEF's published
 * estimate (ctx.lastDamageBelief*, written by the stimulus router between
 * ticks): a direction + per-bot-RNG-spread ESTIMATE of the attacker's
 * position, never the attacker's true coordinates. Null when no estimable
 * direction exists (no knockback vector on the hit, or no belief was ever
 * written): an unseen sniper startles WITHOUT a direction — the reaction
 * still fires; the mix's movement is what's visible, and a sourceless
 * flinch is exactly what a human does. Freshness window = DAMAGE_FRESH_TICKS,
 * aligned with the detector's own edge window.
 */
export function resolveDamageThreatOrigin(ctx: BotContext): { x: number | null; y: number | null } {
  if (ctx.lastDamageBeliefTick > 0 && ctx.tick - ctx.lastDamageBeliefTick <= DAMAGE_FRESH_TICKS) {
    return { x: ctx.lastDamageBeliefX, y: ctx.lastDamageBeliefY };
  }
  return { x: null, y: null };
}

/**
 * Priority 4 — explosion within hearing radius (the stimulus system's
 * explosion channel, already radius-filtered at delivery). Fires for a
 * non-expired, still-strong explosion stimulus the bot has not yet reacted
 * to. Reads ONLY the published per-scan view (strongestByType) — no queue
 * walks, no queries.
 */
export function detectExplosionHeard(
  ctx: BotContext,
  scan: StimulusScanView | undefined,
  st: ReactorBotState,
): ReactionTrigger | null {
  const entry = scan?.strongestByType.explosion;
  if (!entry) return null;
  const age = ctx.tick - entry.tick;
  if (age < 0 || age > EXPLOSION_MAX_AGE_TICKS) return null;
  if (entry.effectiveStrength < EXPLOSION_MIN_EFFECTIVE_STRENGTH) return null;
  const key = `boom:${entry.tick}:${Math.round(entry.worldX)}:${Math.round(entry.worldY)}`;
  if (st.reactedExplosionKeys.has(key)) return null;
  return {
    type: 'explosion',
    stimulusTick: entry.tick,
    threatX: entry.worldX,
    threatY: entry.worldY,
    key,
    subjectId: null,
  };
}

/**
 * Priority 5 — enemy windup aimed at me. The retired shouldDodgeWindup's
 * gates MOVED here, UN-GATED from the personality threshold: there is no
 * caution read — every archetype reacts (DEC-010.2; the bench gates on
 * windup-reaction counts > 0 for ALL archetypes). The surviving gates are
 * correctness, not personality:
 *  - SKILL: windupRemaining > the bot's reaction knob + lead (a swing that
 *    lands before the bot could ever move is un-reactable).
 *  - THREAT: the enemy faces us and we're inside its reach.
 *  - EPISODE: one reaction per enemy per windup episode (per-enemy cooldown).
 * @param profile read ONLY for skill.reactionLatencyTicks — the un-gating
 *  proof: no weights field (caution/aggression) is consulted anywhere here.
 */
export function detectWindupThreat(
  ctx: BotContext,
  st: ReactorBotState,
  profile: PersonalityProfile,
): ReactionTrigger | null {
  const enemy = ctx.nearestEnemy;
  if (!enemy || !enemy.isInWindup) return null;
  const def = safeGetWeaponDef(enemy.weaponType);
  if (!def) return null;
  const enemyRange = def.baseStats.range;
  const windupTotal = Math.ceil((def.baseStats.windupMs ?? 100) * MS_TO_TICKS);
  // Clamp the perception-cached remaining to the weapon's known total —
  // guards against stale reads (perception runs every 3 ticks) making a
  // finished windup look live (carried over verbatim from the retired check).
  const remaining = Math.min(enemy.windupRemaining, windupTotal);
  // Gate 1 — skill: can we react in time?
  if (remaining <= profile.skill.reactionLatencyTicks + WINDUP_LEAD_TICKS) return null;
  // Gate 2 — threat: is the swing actually aimed at us?
  const toUsX = ctx.x - enemy.x;
  const toUsY = ctx.y - enemy.y;
  const toUsLen = Math.sqrt(toUsX * toUsX + toUsY * toUsY) || 1;
  const facingDot =
    (Math.cos(enemy.facingAngle) * toUsX + Math.sin(enemy.facingAngle) * toUsY) / toUsLen;
  if (facingDot < WINDUP_THREAT_DOT) return null;
  if (enemy.distance > enemyRange * WINDUP_RANGE_FACTOR) return null;
  // Gate 3 — episode dedupe: one reaction per windup episode per enemy.
  const last = st.windupReactTicks.get(enemy.id);
  if (last !== undefined && ctx.tick - last < WINDUP_EPISODE_COOLDOWN_TICKS) return null;
  return {
    type: 'windup',
    stimulusTick: ctx.tick,
    threatX: enemy.x,
    threatY: enemy.y,
    key: `windup:${enemy.id}:${ctx.tick}`,
    subjectId: enemy.id,
  };
}

/** The prioritized detector walk (index 0 = priority 1). Evaluating in
 *  REACTION_TYPE_KEYS order IS the priority semantics; imminentDeath's edge
 *  memory still updates when a higher-priority... there is none higher —
 *  imminentDeath is first, so its edge bookkeeping always runs when the walk
 *  reaches it. */
export function detectTopReaction(
  ctx: BotContext,
  scan: StimulusScanView | undefined,
  st: ReactorBotState,
  profile: PersonalityProfile,
  zoneIsLethal: boolean,
  tileSize: number,
): ReactionTrigger | null {
  // Ordered walk: first non-null detector wins.
  const death = detectImminentDeath(ctx, st, zoneIsLethal, tileSize);
  if (death) return death;
  const proj = detectIncomingProjectile(ctx, st);
  if (proj) return proj;
  const startle = detectDamageStartle(ctx, st);
  if (startle) return startle;
  const boom = detectExplosionHeard(ctx, scan, st);
  if (boom) return boom;
  return detectWindupThreat(ctx, st, profile);
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

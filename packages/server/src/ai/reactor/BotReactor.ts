/**
 * BotReactor — bot-ai-v2 ticket 04 (DEC-004/DEC-007).
 *
 * The per-bot Reactor: a prioritized interrupt layer ABOVE executor dispatch.
 * {@linkcode runReactionTick} is called every tick AFTER perception, BEFORE
 * executor dispatch (see BotTickDriver's phase order): it evaluates the
 * priority conditions, arms latency-jittered reactions, and — while a
 * reaction window owns the tick — returns the reaction's observable inputs so
 * the driver skips intent selection + the executor entirely (reactions
 * override movement/aim for their window, then return control). It bypasses
 * the IntentSelector's commit windows/hysteresis BY CONSTRUCTION: it never
 * touches the selector (reactions are NOT intents — DEC-004's rejected
 * alternative), so a bot in ANY intent state flinches.
 *
 * Determinism: latency draws and the committed strafe sign come from the
 * per-bot BotRNG only; no wall-clock read, no unseeded randomness anywhere in
 * this module (the reaction path is virtual-clock-safe for the benchmark's
 * byte-identity contract).
 *
 * Telemetry: every ACTIVATION is counted on the bot's believability surface
 * (reactionsByType + the reactionLatency histogram with the true
 * stimulus→activation delta) — feeding the per-archetype/per-difficulty cuts
 * the benchmark already computes, and making the reaction-latency histogram
 * non-degenerate (ex-Gaussian spread, not a delta spike).
 */

import type { QueuedInput } from '../../application/simulation/InputQueue.ts';
import type { BotContext } from '../BotContext.ts';
import type { PlayerDTO } from '../WorldSnapshot.ts';
import type { BotBelievabilityCounters } from '../BotBelievability.ts';
import type { PersonalityProfile } from '../intent/PersonalityProfile.ts';
import type { Pathfinder } from '../navigation/Pathfinder.ts';
import type { StimulusScanView } from '../stimulus/StimulusScan.ts';
import {
  ARCHETYPE_REACTION_MIXES,
  REACTION_LATENCY_BY_DIFFICULTY,
  REACTION_MAX_WINDOW_TICKS,
  REACTION_REFRACTORY_TICKS,
  STARTLE_ACCURACY_TICKS,
  STARTLE_AIM_PENALTY,
  STARTLE_CONFUSION_TAIL_TICKS,
  SUPPRESSED_DURING_OWN_WINDUP,
  WINDUP_EPISODE_COOLDOWN_TICKS,
} from './ReactorConfig.ts';
import {
  detectImminentDeath,
  detectTopReaction,
  computeOutsideLethalZone,
} from './ReactorConditions.ts';
import { drawReactionLatencyTicks } from './ReactorLatency.ts';
import { emitReactionTick } from './ReactorActions.ts';
import { seedWeaveFromReaction } from '../combat/BotCombatWeave.ts';
import {
  createReactorBotState,
  type ActiveReaction,
  type ReactorBotState,
  type ReactionTrigger,
} from './ReactorTypes.ts';

/** DASH cooldown in ticks (3s). Same value as BotCombatShared's
 *  DASH_COOLDOWN_TICKS; declared locally so the reactor module family has no
 *  runtime import into the combat partials (the combat partials import
 *  nothing from the reactor either — the aim-penalty reader goes through the
 *  BotSystem field). */
const REACTION_DASH_COOLDOWN_TICKS = 180;

/** Upper bound on retained explosion dedupe keys (insertion-ordered prune;
 *  one key per HEARD explosion — far below the queue cap in practice). */
const REACTED_EXPLOSION_KEY_CAP = 32;

/** The reactor's view of its host system (BotSystem satisfies this
 *  structurally; unit tests pass a plain literal — no room needed). */
export interface BotReactorDeps {
  /** Per-bot trackers (the believability observation surface). */
  readonly skillTrackers: ReadonlyMap<string, { believability: BotBelievabilityCounters }>;
  /** Tile size in px (siege grid→world math; from the pathfinder). */
  getTileSize(): number;
  /** Map center (safe-direction fallback when no zone geometry exists). */
  readonly mapCenter: { x: number; y: number };
  /** The pathfinder — wall validation on every emitted reaction movement
   *  angle (DEC-005.1 at the reactor seam, review M1). */
  readonly pathfinder: Pathfinder;
}

export class BotReactor {
  private readonly deps: BotReactorDeps;
  /** Per-bot reaction state (same lifecycle pairing as the stimulus states:
   *  created on registerBot, dropped on unregisterBot). */
  private readonly states = new Map<string, ReactorBotState>();

  constructor(deps: BotReactorDeps) {
    this.deps = deps;
  }

  /** Pair with BotSystem.registerBot. */
  registerBot(playerId: string): void {
    if (!this.states.has(playerId)) this.states.set(playerId, createReactorBotState());
  }

  /** Pair with BotSystem.unregisterBot. */
  unregisterBot(playerId: string): void {
    this.states.delete(playerId);
  }

  /** Drop every bot state (BotSystem.dispose). */
  clearStates(): void {
    this.states.clear();
  }

  /** STARTLE confusion window (DEC-007): while true the intent selector must
   *  NOT switch intents (BotTickPhases.runIntentSelection holds the current
   *  intent). The window covers the startle reaction window plus a short
   *  tail; the Reactor's own imminent-death reaction stays above it. */
  isConfused(playerId: string, tick: number): boolean {
    const st = this.states.get(playerId);
    return st !== undefined && tick < st.confusedUntilTick;
  }

  /**
   * Startle accuracy penalty at `tick`: STARTLE_AIM_PENALTY scaled by a
   * linear decay across the penalty window; 0 when not startled. Consumers
   * multiply their aim spread by (1 + penalty) — see executeEngage/
   * executeRetreat. Pure.
   */
  startleAimPenalty(playerId: string, tick: number): number {
    const st = this.states.get(playerId);
    if (!st || st.startlePenaltyUntilTick <= 0) return 0;
    if (tick >= st.startlePenaltyUntilTick) return 0;
    const elapsed = tick - st.startlePenaltyStartTick;
    const window = st.startlePenaltyUntilTick - st.startlePenaltyStartTick;
    if (window <= 0 || elapsed < 0) return 0;
    return STARTLE_AIM_PENALTY * (1 - elapsed / window);
  }

  /**
   * One bot's reactor tick. Called from the tick driver AFTER perception,
   * BEFORE executor dispatch.
   *
   * @param scan the bot's last published stimulus scan view (from the
   *  stimulus router; refreshed EVERY tick by runPerception since ticket 11).
   * @returns the reaction's inputs when a reaction OWNS this tick (the
   *  driver pushes them and skips the executor — the interrupt), or null to
   *  continue the normal intent pipeline. A non-null return is NEVER an
   *  empty array (the visibility invariant — emitReactionTick pushes the
   *  MOVE unconditionally).
   */
  runReactionTick(
    ctx: BotContext,
    dto: PlayerDTO,
    scan: StimulusScanView | undefined,
    zoneIsLethal: boolean,
    profile: PersonalityProfile,
  ): QueuedInput[] | null {
    const st = this.states.get(ctx.playerId);
    if (!st) return null;

    try {
      return this.runReactionTickInner(ctx, dto, scan, zoneIsLethal, profile, st);
    } finally {
      // LETHAL-EDGE MEMORY (review M3): ONE write, EVERY tick, on EVERY path —
      // active window (including an active imminentDeath window, whose branch
      // skips the detector), pending latency, refractory, and the no-trigger
      // path alike. The detector reads the memory as "exposure at the previous
      // tick" (it never writes — the pure seam), so a re-entry during a
      // reaction window leaves a fresh rising edge for the next detector read
      // instead of freezing at the arming tick's value.
      st.wasOutsideLethalZone = computeOutsideLethalZone(ctx, zoneIsLethal);
    }
  }

  /** The tick body (see runReactionTick — the wrapper owns the edge write). */
  private runReactionTickInner(
    ctx: BotContext,
    dto: PlayerDTO,
    scan: StimulusScanView | undefined,
    zoneIsLethal: boolean,
    profile: PersonalityProfile,
    st: ReactorBotState,
  ): QueuedInput[] | null {
    this.pruneDedupeMemory(ctx, st);
    const ownWindup = dto.isInWindup;

    // ── ACTIVE window: the reaction owns this tick ─────────────────────────
    const active = st.active;
    if (active && ctx.tick < active.untilTick) {
      // GDD §14.4 instant-override: imminent death PREEMPTS any active
      // reaction (never the reverse — that would be chaining). The preempt
      // path reuses the same detector so the zone-edge bookkeeping is shared.
      if (active.type !== 'imminentDeath') {
        const death = detectImminentDeath(ctx, st, zoneIsLethal, this.deps.getTileSize());
        if (death) {
          this.recordDedupe(ctx, st, death);
          this.activate(ctx, st, death, profile);
          return this.emitOwned(ctx, st, profile, ownWindup);
        }
      }
      return this.emitOwned(ctx, st, profile, ownWindup);
    }
    // Window ended: clear it. The refractory (set at activation) now bars
    // new arming — the NO-CHAINING bound (imminent death excepted below).
    st.active = null;

    // ── PENDING reaction: waiting out the ex-Gaussian latency ─────────────
    const pending = st.pending;
    if (pending) {
      // GDD §14.4: imminent death also preempts a LATENCY-ARMING reaction —
      // the instant override beats the human delay (which the pending is).
      const death = detectImminentDeath(ctx, st, zoneIsLethal, this.deps.getTileSize());
      if (death) {
        st.pending = null;
        this.recordDedupe(ctx, st, death);
        this.activate(ctx, st, death, profile);
        return this.emitOwned(ctx, st, profile, ownWindup);
      }
      if (ctx.tick >= pending.armAtTick) {
        // Suppression mask at activation (own windup): the swing is committed
        // and uncancellable — drop the pending reaction, don't fight it.
        if (ownWindup && SUPPRESSED_DURING_OWN_WINDUP[pending.type]) {
          st.pending = null;
        } else if (pending.type === 'windup' && !this.windupStillLive(ctx, pending.windupEnemyId)) {
          // Windup re-validation: the swing already landed — a ghost dodge
          // would be a flinch at nothing.
          st.pending = null;
        } else {
          st.pending = null;
          const trigger: ReactionTrigger = {
            type: pending.type,
            stimulusTick: pending.stimulusTick,
            threatX: pending.threatX,
            threatY: pending.threatY,
            key: '',
            subjectId: pending.windupEnemyId,
          };
          this.activate(ctx, st, trigger, profile);
          return this.emitOwned(ctx, st, profile, ownWindup);
        }
      }
      // Pending but not yet armed: normal behavior continues (the human
      // delay is visible as the bot NOT yet reacting).
      return null;
    }

    // ── REFRACTORY: no new reaction arms inside the post-window gap ───────
    // Applies to every type EXCEPT imminentDeath (review M3, GDD §14.4
    // instant-override): a lethal crossing during the gap must fire NOW — a
    // dying bot showing ~166ms of normal behavior mid-panic is the defect.
    // Re-fire stays bounded by the RISING EDGE (continuous exposure does not
    // re-arm — steady-state zone fleeing remains SURVIVE_ZONE's job; only
    // exit-then-re-entry, or a fresh siege warning, spikes again). Steady
    // state: the selector already preempts with SURVIVE_ZONE instantly,
    // outside this layer entirely.
    if (ctx.tick < st.refractoryUntilTick) {
      const death = detectImminentDeath(ctx, st, zoneIsLethal, this.deps.getTileSize());
      if (death) {
        this.recordDedupe(ctx, st, death);
        this.activate(ctx, st, death, profile);
        return this.emitOwned(ctx, st, profile, ownWindup);
      }
      return null;
    }

    // ── Detect → dedupe → suppression mask → arm (or fire at zero latency) ─
    const trigger = detectTopReaction(
      ctx,
      scan,
      st,
      profile,
      zoneIsLethal,
      this.deps.getTileSize(),
    );
    if (!trigger) return null;
    // Record dedupe marks for THIS cause (one reaction per cause) BEFORE the
    // suppression check: a masked stimulus is consumed, not deferred —
    // reacting to it after our swing completes would be chaining.
    this.recordDedupe(ctx, st, trigger);
    if (ownWindup && SUPPRESSED_DURING_OWN_WINDUP[trigger.type]) return null;
    const latency =
      trigger.type === 'imminentDeath'
        ? 0 // GDD §14.4: immediate threats bypass reaction delay entirely.
        : drawReactionLatencyTicks(ctx.rng, REACTION_LATENCY_BY_DIFFICULTY[profile.difficulty]);
    if (latency <= 0) {
      this.activate(ctx, st, trigger, profile);
      return this.emitOwned(ctx, st, profile, ownWindup);
    }
    st.pending = {
      type: trigger.type,
      armAtTick: ctx.tick + latency,
      stimulusTick: trigger.stimulusTick,
      threatX: trigger.threatX,
      threatY: trigger.threatY,
      windupEnemyId: trigger.subjectId,
    };
    return null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Bounded-memory prune of the per-cause dedupe structures. */
  private pruneDedupeMemory(ctx: BotContext, st: ReactorBotState): void {
    if (st.reactedProjectiles.size > 0) {
      for (const id of st.reactedProjectiles) {
        let present = false;
        for (const p of ctx.projectiles) {
          if (p.id === id) {
            present = true;
            break;
          }
        }
        if (!present) st.reactedProjectiles.delete(id);
      }
    }
    if (st.windupReactTicks.size > 0) {
      for (const [id, tick] of st.windupReactTicks) {
        if (ctx.tick - tick > WINDUP_EPISODE_COOLDOWN_TICKS * 2) {
          st.windupReactTicks.delete(id);
        }
      }
    }
  }

  /** Detect→active transition: window bounds, startle extras, telemetry. */
  private activate(
    ctx: BotContext,
    st: ReactorBotState,
    trigger: ReactionTrigger,
    profile: PersonalityProfile,
  ): void {
    const mix = ARCHETYPE_REACTION_MIXES[trigger.type][profile.archetype];
    // Bounded by construction (the table is clamped too — belt and braces:
    // a hand-edited table entry can never exceed the DEC-004 bound).
    const duration = Math.min(mix.durationTicks, REACTION_MAX_WINDOW_TICKS);
    const active: ActiveReaction = {
      type: trigger.type,
      startTick: ctx.tick,
      untilTick: ctx.tick + duration,
      stimulusTick: trigger.stimulusTick,
      threatX: trigger.threatX,
      threatY: trigger.threatY,
      // Committed strafe side — per-bot RNG draw (deterministic; the mix —
      // the WHAT — stays archetype-fixed, only timing/side vary).
      perpSign: ctx.rng.next() < 0.5 ? -1 : 1,
      emittedFirstTick: false,
    };
    st.active = active;
    st.refractoryUntilTick = active.untilTick + REACTION_REFRACTORY_TICKS;
    // DODGE→WEAVE HANDOFF (bot-ai-v2 ticket 09, DEC-010.1/010.2 — the
    // combat-side integration of the un-gated dodges): a projectile/windup
    // dodge SEEDS the sticky weave with the dodge's own committed side, so
    // the post-reaction movement continues the SAME strafe instead of
    // re-rolling — the readable dodge→committed-strafe continuation a human
    // shows under fire.
    if (trigger.type === 'projectile' || trigger.type === 'windup') {
      seedWeaveFromReaction(ctx, active.perpSign);
    }
    if (trigger.type === 'startle') {
      // STARTLE extras (DEC-007): confusion (no intent switching) outlasts
      // the flinch by a short tail; the accuracy penalty decays over its own
      // (longer) window.
      st.confusedUntilTick = active.untilTick + STARTLE_CONFUSION_TAIL_TICKS;
      st.startlePenaltyStartTick = ctx.tick;
      st.startlePenaltyUntilTick = ctx.tick + STARTLE_ACCURACY_TICKS;
    }
    // Telemetry: count + the TRUE stimulus→activation delta (the ex-Gaussian
    // draw makes this histogram non-degenerate by construction).
    const tracker = this.deps.skillTrackers.get(ctx.playerId);
    if (tracker) {
      tracker.believability.noteReaction(
        trigger.type,
        Math.max(0, ctx.tick - trigger.stimulusTick),
      );
    }
  }

  /** Emit the owned tick's inputs (visibility invariant: never empty). */
  private emitOwned(
    ctx: BotContext,
    st: ReactorBotState,
    profile: PersonalityProfile,
    ownWindup: boolean,
  ): QueuedInput[] {
    const active = st.active!;
    const mix = ARCHETYPE_REACTION_MIXES[active.type][profile.archetype];
    // The dash is suppressed during the bot's own windup by DESIGN (the
    // server would ACCEPT it — canDash gates fresh-spawn/stagger/cooldown
    // only — but the swing is a committed, uncancellable action; a mid-swing
    // dash would visibly cancel what players learn is unbreakable. DEC-004
    // suppression mask), never the MOVE. Cooldown bookkeeping is done here
    // for reaction dashes so cooldowns stay honest across layers.
    const allowDash = !ownWindup && ctx.tick - ctx.lastDashTick >= REACTION_DASH_COOLDOWN_TICKS;
    if (allowDash && mix.dash && !active.emittedFirstTick) ctx.lastDashTick = ctx.tick;
    const safeX = ctx.zoneSafeX || this.deps.mapCenter.x;
    const safeY = ctx.zoneSafeY || this.deps.mapCenter.y;
    return emitReactionTick(ctx, active, mix, allowDash, safeX, safeY, this.deps.pathfinder);
  }

  /** Record per-cause dedupe marks so one cause reacts once. */
  private recordDedupe(ctx: BotContext, st: ReactorBotState, trigger: ReactionTrigger): void {
    switch (trigger.type) {
      case 'startle':
        st.lastReactedDamageTick = ctx.lastDamageTick;
        break;
      case 'explosion':
        st.reactedExplosionKeys.add(trigger.key);
        // Insertion-ordered prune (Sets iterate oldest-first): drop the
        // oldest key when over the cap — bounded memory.
        if (st.reactedExplosionKeys.size > REACTED_EXPLOSION_KEY_CAP) {
          const oldest = st.reactedExplosionKeys.values().next().value;
          if (oldest !== undefined) st.reactedExplosionKeys.delete(oldest);
        }
        break;
      case 'projectile':
        if (trigger.subjectId) st.reactedProjectiles.add(trigger.subjectId);
        break;
      case 'windup':
        if (trigger.subjectId) st.windupReactTicks.set(trigger.subjectId, ctx.tick);
        break;
      default:
        break; // imminentDeath: bounded by the rising edge (the wrapper's
      // every-tick memory write) — continuous exposure never re-arms; only
      // exit-then-re-entry or a fresh siege-warning tile spikes again.
    }
  }

  /** Is the windup that armed this reaction still live at arm time? */
  private windupStillLive(ctx: BotContext, enemyId: string | null): boolean {
    if (!enemyId) return false;
    const enemy = ctx.nearestEnemy;
    return enemy !== null && enemy.id === enemyId && enemy.isInWindup;
  }
}

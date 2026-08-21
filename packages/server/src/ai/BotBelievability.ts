/**
 * BotBelievability — per-bot, read-only observation telemetry for the
 * bot-ai-v2 "Lively Bots" effort (DEC-013, ticket 01).
 *
 * THE PROBLEM THIS SOLVES: the benchmark harness could only see population
 * aggregates (kills, engage%, clustering). It could not see the qualities the
 * redesign fixes — reaction latency, stalls, action diversity, idle time,
 * path waste — so tuning iterations optimized the wrong objective.
 *
 * OBSERVATION-ONLY by contract: never feeds a value back into any decision
 * (written from already-final per-tick state, read only by the harness /
 * skill summaries); draws NO randomness and reads NO clock (every value is a
 * pure function of the deterministic tick stream, so the same-seed
 * byte-identity contract holds; AI-time in BotSystem is the one masked
 * wall-clock field).
 *
 * Reaction-latency channels (DEC-013, upgraded by ticket 03/DEC-002):
 *  - `damageResponse` is a TRUE stimulus→response channel: the StimulusRouter
 *    calls {@link noteDamageStimulus} when it delivers a PlayerDamaged
 *    stimulus TO THIS BOT (the victim), between ticks — the stimulus
 *    timestamp is the domain event's own tick; resolved next observeTick.
 *  - `seenToAttack` remains a v1 approximation (enemy-seen rising edge →
 *    first attack) — sight is a perception derivation, not a domain event.
 *  - `reactionLatency` (ticket 04, DEC-004) is the Reactor channel: the TRUE
 *    stimulus→activation delta of every FIRED reaction (ex-Gaussian arming
 *    draws — non-degenerate by construction).
 *  - Ticket 05 composes `.beliefs`; ticket 06 the stall surface; ticket 07
 *    the macro-goal surface (`.goals`: goal-mix + pre-position samples).
 */

import { InputAction } from '@sector-battle/shared';
import type { QueuedInput } from '../application/simulation/InputQueue.ts';
import { BotState } from './BotContextTypes.ts';
import { readInputReason } from './BotInput.ts';
import { BotBeliefTelemetry } from './BotBeliefTelemetry.ts';
import { BotGoalTelemetry } from './BotGoalTelemetry.ts';
import { BotMovementTelemetry } from './BotMovementTelemetry.ts';
import { BotCombatTelemetry } from './combat/BotCombatTelemetry.ts';

// --- intent-mix families — verbatim extraction to BotBelievabilityFamilies.ts
// (bot-ai-v2 ticket 09, module-length gate); re-exported below for the
// historical import path (tests, BotSkillTracker). ---
export {
  INTENT_FAMILY_KEYS,
  INTENT_FAMILY_COUNT,
  botStateFamilyIndex,
  type IntentFamilyKey,
} from './BotBelievabilityFamilies.ts';
import { INTENT_FAMILY_COUNT, botStateFamilyIndex } from './BotBelievabilityFamilies.ts';

// intentFamilyEntropy lives in BotBelievabilitySummary.ts (bot-ai-v2 ticket
// 06 move, for the module-length gate); re-exported below for the historical
// import path.

// --- reaction-latency histograms (v1 — see module docs) ---

/** Tick-delta bucket upper bounds (inclusive), last bucket open-ended. */
export const LATENCY_BUCKET_EDGES = [2, 5, 11, 17, 29, 59] as const;

/** Human-readable bucket labels (JSON-stable, also serves as the bin count). */
export const LATENCY_BUCKET_LABELS = [
  '0-2',
  '3-5',
  '6-11',
  '12-17',
  '18-29',
  '30-59',
  '60+',
] as const;

export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_LABELS.length;

/** Bucket a stimulus→response tick delta. Negative deltas clamp to bucket 0
 *  (defensive — cannot occur from the state machine, which only records
 *  non-negative deltas); deltas past the last edge land in the open bucket. */
export function bucketLatencyTicks(delta: number): number {
  if (delta <= LATENCY_BUCKET_EDGES[0]!) return 0;
  for (let i = 1; i < LATENCY_BUCKET_EDGES.length; i++) {
    if (delta <= LATENCY_BUCKET_EDGES[i]!) return i;
  }
  return LATENCY_BUCKET_COUNT - 1;
}

/** A reaction-latency histogram with its censoring bookkeeping. */
export interface LatencyHistogram {
  /** Count per bucket (LATENCY_BUCKET_COUNT entries, LATENCY_BUCKET_LABELS order). */
  buckets: number[];
  /** Total stimuli observed on this channel. */
  stimuli: number;
  /** Stimuli that produced a response inside the window (sum of buckets). */
  responded: number;
  /** Stimuli whose window expired without a response (right-censored). */
  censored: number;
}

/** A per-bot read model of one channel's histogram (raw counts + ratios). */
export interface LatencyHistogramSummary extends LatencyHistogram {
  /** Mean response delta in ticks over responded stimuli (-1 when none). */
  avgTicks: number;
}

function emptyHistogram(): {
  buckets: number[];
  stimuli: number;
  responded: number;
  censored: number;
} {
  return {
    buckets: Array.from({ length: LATENCY_BUCKET_COUNT }, () => 0),
    stimuli: 0,
    responded: 0,
    censored: 0,
  };
}

/** Observation windows. Damage→state-change must be quick to read as a
 *  reaction (1.5s — mirrors the checkGoalStall short window); seen→attack
 *  allows approach time (3s). Stimuli unanswered within the window are
 *  right-censored, not dropped, so the histogram keeps its denominator. */
const DAMAGE_RESPONSE_WINDOW_TICKS = 90;
const SEEN_ATTACK_WINDOW_TICKS = 180;

/** Displacement below which a 90-tick window counts as stuck. Mirrors
 *  checkGoalStall's short window (25px / 1.5s) — the existing operational
 *  definition of "wedged". */
const STUCK_WINDOW_TICKS = 90;
const STUCK_WINDOW_PX = 25;

/** Path-efficiency accounting window (3s). */
const PATH_WINDOW_TICKS = 180;

/** The minimal per-tick state view the counters observe. Structural on
 * purpose: unit tests feed plain literals, the AI feeds BotContext. */
export interface BelievabilityTickView {
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BotState;
  /** Whether an enemy is in perception this tick (nearestEnemy !== null). */
  hasEnemy: boolean;
  forceWanderUntilTick: number;
}

/**
 * Per-bot believability counters. One instance lives on each BotSkillTracker
 * (created at registration, kept after death — full-match tallies) and is
 * written from a handful of seams, all observation-only:
 *  1. {@link noteEmittedInputs} — the executor-input tally (reason tags +
 *     attack-emission stamps).
 *  2. {@link noteSuspension} — the goal-suspension call sites.
 *  3. {@link observeTick} — the per-tick state machine (intent mix, latency
 *     channels, idle, stuck, path efficiency, forced-wander edges).
 *  4. {@link noteReaction} — the BotReactor's fired-reaction tally (ticket 04).
 *  5. `.beliefs` (BotBeliefTelemetry) — the believed-state layer's
 *     belief-source mix + pursuit outcomes (ticket 05).
 */
export class BotBelievabilityCounters {
  // --- action diversity ---
  /** Ticks spent per intent family (INTENT_FAMILY_KEYS order). */
  readonly intentFamilyTicks: number[] = Array.from({ length: INTENT_FAMILY_COUNT }, () => 0);
  readonly dashByReason: Record<string, number> = {};
  readonly throwByReason: Record<string, number> = {};
  readonly switchByReason: Record<string, number> = {};
  dashTotal = 0;
  throwTotal = 0;
  switchTotal = 0;

  // --- stall telemetry ---
  suspensions = 0;
  readonly suspensionsByFamily: Record<string, number> = {};
  /** Suspensions by reason tag ('stall' | 'search-failure' — ticket 05
   *  extended the suspension mechanism from goals to targets). */
  readonly suspensionsByReason: Record<string, number> = {};
  forcedWanderActivations = 0;
  stuckTicks = 0;
  // --- stuck-ladder telemetry (bot-ai-v2 ticket 06, DEC-005/DEC-013) ---
  /** Ladder rung ENTRY counts by key (STUCK_LADDER_RUNG_KEYS labels). Bench
   *  gate: rungs fire while total suspensions/stuck-time DROP (the ladder
   *  prevents wedges that used to escalate all the way to relocation). */
  readonly ladderRungsByRung: Record<string, number> = {};
  /** Total rung entries (Σ ladderRungsByRung values). */
  ladderRungsTotal = 0;
  /** Deaths at low HP adjacent to a wall tile (DEC-005.4 — the navigated
   *  break-line retreat's directional gate). */
  wallAdjacentLowHpDeaths = 0;

  // --- reaction latency (v1 channels) ---
  readonly damageResponse: LatencyHistogram = emptyHistogram();
  /** Σ responded deltas (ticks) — the histogram mean numerator. */
  damageResponseTickSum = 0;
  readonly seenToAttack: LatencyHistogram = emptyHistogram();
  /** Σ responded deltas (ticks) — the histogram mean numerator. */
  seenToAttackTickSum = 0;

  // --- Reactor reactions (bot-ai-v2 ticket 04, DEC-004) ---
  /** Fired-reaction counts by Reactor type (REACTION_TYPE_KEYS order) —
   *  the per-type cut the benchmark joins per-archetype/per-difficulty. */
  readonly reactionsByType: Record<string, number> = {};
  /** Total fired reactions (Σ reactionsByType values). */
  reactionsTotal = 0;
  /**
   * TRUE stimulus→activation latency of fired reactions: the Reactor notes
   * each activation with the delta from its originating stimulus tick. The
   * ex-Gaussian arming draws (DEC-007) make this histogram non-degenerate BY
   * CONSTRUCTION (spread across buckets, not a delta spike) — the reaction-
   * latency gate compares its spread against the pre-v2 baseline.
   */
  readonly reactionLatency: LatencyHistogram = emptyHistogram();
  /** Σ noted deltas (ticks) — the histogram mean numerator. */
  reactionLatencyTickSum = 0;

  /** Believed-state telemetry (ticket 05, DEC-003): belief-source mix +
   *  pursuit outcomes (own module — the belief layer depends on the small
   *  type, not on this counters class). */
  readonly beliefs = new BotBeliefTelemetry();
  /** Macro-goal telemetry (ticket 07, DEC-008): goal-mix + pre-position
   *  samples (own module like `.beliefs`; never read back by decisions). */
  readonly goals = new BotGoalTelemetry();
  /** Movement-feature telemetry (ticket 08, DEC-009.2): idle ticks + speed
   *  CV / stopped-ratio moments (own module like `.beliefs`). */
  readonly movement = new BotMovementTelemetry();
  /** Combat-believability telemetry (bot-ai-v2 ticket 09, DEC-010): the
   *  weave-commit / disengage-cause / contest-outcome / weapon-break
   *  surface, drained from ctx.combat's pending counters once per tick (the
   *  single observation seam — see recordTickTelemetry). */
  readonly combat = new BotCombatTelemetry();

  // --- path efficiency (idle + speed moments live on `.movement`) ---
  /** Σ straight-line window displacement (numerator). */
  straightPx = 0;
  /** Σ traveled within windows (denominator). */
  traveledPx = 0;

  // --- private observation state (not reported directly) ---
  private prevX = NaN;
  private prevY = NaN;
  private prevState: BotState | null = null;
  /**
   * prevState at the ENTRY of the last observeTick — i.e. the state the bot
   * was in one tick before the last observed one. noteDamageStimulus (which
   * the router calls BETWEEN ticks) snapshots this as the state-at-stimulus:
   * the damage landed during tick N (pre-botAI), so the baseline is the end
   * of tick N-1, exactly what this field holds after observeTick(N) ran.
   */
  private lastPrevState: BotState | null = null;
  private prevHadEnemy = false;
  private prevForceWanderUntil = -9999;
  private pendingDamageTick = -1;
  private stateAtDamage: BotState | null = null;
  private pendingSeenTick = -1;
  private lastAttackEmittedTick = -1;
  private stuckSnapTick = -1;
  private stuckSnapX = 0;
  private stuckSnapY = 0;
  private pathWindowTick = -1;
  private pathWindowX = 0;
  private pathWindowY = 0;
  private pathWindowTraveled = 0;

  /** Tally one executor-input batch: reason-tagged dash/throw/switch counts
   *  plus attack-emission stamps (which resolve the seen→attack channel). */
  noteEmittedInputs(inputs: readonly QueuedInput[], tick: number): void {
    for (const qi of inputs) {
      switch (qi.action) {
        case InputAction.DASH:
          this.noteDash(readInputReason(qi));
          break;
        case InputAction.THROW:
          this.noteThrow(readInputReason(qi));
          this.lastAttackEmittedTick = tick;
          break;
        case InputAction.SWITCH_SLOT:
          this.noteSwitch(readInputReason(qi));
          break;
        case InputAction.ATTACK:
          this.lastAttackEmittedTick = tick;
          break;
        default:
          break;
      }
    }
  }

  noteDash(reason: string | undefined): void {
    this.dashTotal++;
    const key = reason ?? 'untagged';
    this.dashByReason[key] = (this.dashByReason[key] ?? 0) + 1;
  }

  noteThrow(reason: string | undefined): void {
    this.throwTotal++;
    const key = reason ?? 'untagged';
    this.throwByReason[key] = (this.throwByReason[key] ?? 0) + 1;
  }

  noteSwitch(reason: string | undefined): void {
    this.switchTotal++;
    const key = reason ?? 'untagged';
    this.switchByReason[key] = (this.switchByReason[key] ?? 0) + 1;
  }

  /** Record a goal suspension. `reason` (ticket 05) distinguishes stall
   *  relocations from search-failure target drops (the suspension mechanism
   *  extended from goals to targets); untagged calls read 'stall'. */
  noteSuspension(familyLabel: string, reason: string = 'stall'): void {
    this.suspensions++;
    this.suspensionsByFamily[familyLabel] = (this.suspensionsByFamily[familyLabel] ?? 0) + 1;
    this.suspensionsByReason[reason] = (this.suspensionsByReason[reason] ?? 0) + 1;
  }

  /** Record stuck-ladder rung ENTRIES (ticket 06; drained from
   *  StuckLadderState.firedByRung by recordTickTelemetry). */
  noteLadderRung(rungKey: string, count = 1): void {
    this.ladderRungsByRung[rungKey] = (this.ladderRungsByRung[rungKey] ?? 0) + count;
    this.ladderRungsTotal += count;
  }

  /** Record a death at low HP adjacent to a wall tile (DEC-005.4). */
  noteWallAdjacentDeath(): void {
    this.wallAdjacentLowHpDeaths++;
  }

  /**
   * Record one FIRED reaction (called by the BotReactor at ACTIVATION — the
   * fourth and final observation seam). `type` is the Reactor's reaction
   * type; `deltaTicks` is the true stimulus→activation delta (the ex-Gaussian
   * latency the bot drew for that reaction).
   */
  noteReaction(type: string, deltaTicks: number): void {
    this.reactionsByType[type] = (this.reactionsByType[type] ?? 0) + 1;
    this.reactionsTotal++;
    this.reactionLatency.stimuli++;
    const delta = Math.max(0, Math.round(deltaTicks));
    this.reactionLatency.buckets[bucketLatencyTicks(delta)]!++;
    this.reactionLatency.responded++;
    this.reactionLatencyTickSum += delta;
  }

  /**
   * Record a TRUE damage stimulus delivery to this bot (ticket 03): called
   * by the StimulusRouter when a PlayerDamaged stimulus is enqueued for the
   * VICTIM, between ticks — `stimulusTick` is the domain event's own tick.
   * The response detector in {@link observeTick} resolves it on the first
   * later state change away from the state-at-stimulus. Back-to-back
   * stimuli restart the clock (the unanswered one is right-censored), so
   * the histogram keeps its denominator — same window discipline as v1.
   */
  noteDamageStimulus(stimulusTick: number): void {
    if (this.pendingDamageTick >= 0) {
      this.damageResponse.censored++;
      this.pendingDamageTick = -1;
    }
    this.damageResponse.stimuli++;
    this.pendingDamageTick = stimulusTick;
    // State the bot was in when the hit landed (end of the previous tick —
    // see lastPrevState). Null when no observeTick has run yet (bot spawned
    // mid-tick); such a stimulus can only censor, never falsely respond.
    this.stateAtDamage = this.lastPrevState;
  }

  /** The per-tick state machine. Call once per alive tick, AFTER the tick's
   * intent selection + executor ran (all view fields are final for the
   * tick). See module docs for the channel semantics. */
  observeTick(v: BelievabilityTickView): void {
    this.intentFamilyTicks[botStateFamilyIndex(v.state)]!++;

    // --- damage-stimulus → state-change latency (ticket 03: TRUE
    // stimulus→response — the stimulus is noted between ticks by
    // noteDamageStimulus; here we only resolve/censor the pending one). ---
    if (this.pendingDamageTick >= 0) {
      if (v.tick - this.pendingDamageTick > DAMAGE_RESPONSE_WINDOW_TICKS) {
        this.damageResponse.censored++;
        this.pendingDamageTick = -1;
      } else if (this.stateAtDamage !== null && v.state !== this.stateAtDamage) {
        const delta = Math.max(0, v.tick - this.pendingDamageTick);
        this.damageResponse.buckets[bucketLatencyTicks(delta)]!++;
        this.damageResponse.responded++;
        this.damageResponseTickSum += delta;
        this.pendingDamageTick = -1;
      }
    }

    // --- enemy-seen → first-attack latency (v1) ---
    if (!this.prevHadEnemy && v.hasEnemy) {
      this.seenToAttack.stimuli++;
      this.pendingSeenTick = v.tick;
    } else if (this.prevHadEnemy && !v.hasEnemy && this.pendingSeenTick >= 0) {
      // Enemy lost without an attack — the response can no longer arrive.
      this.seenToAttack.censored++;
      this.pendingSeenTick = -1;
    }
    if (this.pendingSeenTick >= 0 && this.lastAttackEmittedTick >= this.pendingSeenTick) {
      const delta = this.lastAttackEmittedTick - this.pendingSeenTick;
      this.seenToAttack.buckets[bucketLatencyTicks(delta)]!++;
      this.seenToAttack.responded++;
      this.seenToAttackTickSum += delta;
      this.pendingSeenTick = -1;
    } else if (
      this.pendingSeenTick >= 0 &&
      v.tick - this.pendingSeenTick > SEEN_ATTACK_WINDOW_TICKS
    ) {
      this.seenToAttack.censored++;
      this.pendingSeenTick = -1;
    }
    this.prevHadEnemy = v.hasEnemy;

    // --- forced wander activations (rising edge of the forced window) ---
    if (v.forceWanderUntilTick > this.prevForceWanderUntil) this.forcedWanderActivations++;
    this.prevForceWanderUntil = v.forceWanderUntilTick;

    // --- stuck windows (displacement-based, mirrors checkGoalStall) ---
    if (this.stuckSnapTick < 0) {
      this.stuckSnapTick = v.tick;
      this.stuckSnapX = v.x;
      this.stuckSnapY = v.y;
    } else if (v.tick - this.stuckSnapTick >= STUCK_WINDOW_TICKS) {
      const dx = v.x - this.stuckSnapX;
      const dy = v.y - this.stuckSnapY;
      if (Math.sqrt(dx * dx + dy * dy) < STUCK_WINDOW_PX) {
        this.stuckTicks += v.tick - this.stuckSnapTick;
      }
      this.stuckSnapTick = v.tick;
      this.stuckSnapX = v.x;
      this.stuckSnapY = v.y;
    }

    // --- idle + movement features (ticket 08, DEC-009.2): the per-tick
    // speed moments live on `.movement` (idle ticks, speed CV numerator,
    // stopped ticks — the signature movement's measurable surface). ---
    this.movement.observe(v.vx, v.vy);

    // --- path efficiency (windowed straight vs traveled) ---
    if (this.pathWindowTick < 0) {
      this.pathWindowTick = v.tick;
      this.pathWindowX = v.x;
      this.pathWindowY = v.y;
      this.pathWindowTraveled = 0;
      this.prevX = v.x;
      this.prevY = v.y;
    } else {
      const sx = v.x - this.prevX;
      const sy = v.y - this.prevY;
      this.pathWindowTraveled += Math.sqrt(sx * sx + sy * sy);
      if (v.tick - this.pathWindowTick >= PATH_WINDOW_TICKS) {
        const wx = v.x - this.pathWindowX;
        const wy = v.y - this.pathWindowY;
        this.straightPx += Math.sqrt(wx * wx + wy * wy);
        this.traveledPx += this.pathWindowTraveled;
        this.pathWindowTick = v.tick;
        this.pathWindowX = v.x;
        this.pathWindowY = v.y;
        this.pathWindowTraveled = 0;
      }
      this.prevX = v.x;
      this.prevY = v.y;
    }

    this.lastPrevState = this.prevState;
    this.prevState = v.state;
  }
}

// Summary read model + intentFamilyEntropy live in BotBelievabilitySummary.ts
// (length-gate splits, tickets 04/06); re-exported for the historical path.
export {
  summarizeBelievability,
  intentFamilyEntropy,
  type BelievabilitySummary,
} from './BotBelievabilitySummary.ts';

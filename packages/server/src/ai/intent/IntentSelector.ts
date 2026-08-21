/**
 * IntentSelector — the single decision point that replaced the legacy
 * priority cascade (ADR-0036).
 *
 * Each tick:
 *   1. Hard-validate the current intent. If invalid (prey died, zone forced),
 *      drop it immediately regardless of commit window.
 *   2. If inside the current intent's commit window, keep it UNLESS another
 *      intent scores at least PREEMPT_MARGIN higher. Commitment is what stops
 *      the per-tick flip-flopping; the preempt margin is what keeps the bot
 *      reactive to real opportunity.
 *   3. Otherwise, score all intents and pick the max.
 *
 * WHY THIS IS DIFFERENT FROM THE LEGACY CASCADE:
 *   - The cascade had ONE global priority order for all bots. The selector
 *     weights scores by PERSONALITY, so two bots in the same situation pick
 *     different intents (Aggressor → DUEL, Survivor → RETREAT_AND_RESET).
 *   - The cascade re-evaluated every tick. The selector commits for an intent-
 *     specific window, so a committed flank doesn't get abandoned because the
 *     enemy moved 10px.
 *   - The cascade couldn't see opportunity (only threat+proximity). The new
 *     intents (Phase 3) score off the perception-enrichment signals.
 *
 * The selector returns the chosen IntentId + the commit deadline; the BotSystem
 * tickBot dispatches to the legacy executor (FLEE_ZONE/ENGAGE/LOOT/...) based on
 * an IntentId → BotState mapping. This keeps the selector pure (trivially
 * unit-testable) and lets Phase 3 add new intents without touching selection.
 */
import { IntentId, PREEMPT_MARGIN, type Intent, type IntentContext } from './Intent.ts';

export interface SelectionResult {
  intentId: IntentId;
  /** Tick until which this intent is committed (hysteresis deadline). */
  committedUntilTick: number;
  /** Whether the selection changed this tick (for transition side-effects). */
  changed: boolean;
  /** The score of the winning intent (for diagnostics/benchmarking). */
  score: number;
}

export class IntentSelector {
  private readonly intents: Intent[];
  /** Current committed intent id, or null if none yet. */
  private currentId: IntentId | null = null;
  private committedUntilTick = 0;
  /**
   * Per-intent SUSPENSION: intentId → tick until which it is EXCLUDED from
   * selection. The core anti-stall mechanism. When an executor detects a
   * stall (checkGoalStall, universal anti-stall), it calls suspend() on its
   * current intent. During the suspension window the selector CANNOT pick
   * that intent — so the bot falls through to a DIFFERENT goal (armed → HUNT,
   * unarmed → WANDER) that relocates it to a new area. By the time the
   * suspension expires, the bot is somewhere else with a fresh set of
   * (potentially reachable) items/enemies.
   *
   * This is the structural fix for the LOOT→WANDER→LOOT oscillation that
   * produced 100s+ idle periods. The legacy stack had 7 overlapping stall
   * detectors that all responded with `forceWander` — but forceWander was
   * invisible to this selector. The commit window expired, the selector
   * re-scored, and picked LOOT again (items still visible from the same
   * position). Suspending the intent at the DECISION layer breaks that loop
   * at its source. SURVIVE_ZONE is never suspended (zone death is immediate
   * — a stalled bot still needs to flee).
   */
  private readonly suspendedUntil: Map<IntentId, number> = new Map();
  /**
   * id → intent, built ONCE in the constructor (perf ticket 33). Replaces the
   * per-tick `.find()` closure scans for current-intent lookup, the WANDER
   * fallback, and by-id access — two closures + two O(n) scans × 63 bots per
   * tick. First occurrence wins on (hypothetical) duplicate ids, matching
   * Array.find semantics exactly; buildPhase2Intents emits distinct ids.
   */
  private readonly intentsByIdMap: Map<IntentId, Intent> = new Map();

  // --- read-only believability counters (DEC-013 ticket 01) ---
  // Observation only: incremented inside suspend()/isSuspended()/
  // clearSuspensions() and never read by any decision. The benchmark's
  // per-bot full-match suspension tallies live on the BotSkillTracker's
  // believability counters (which survive death); these counters expose the
  // selector's own lifecycle for unit tests and live inspection.
  /** Total suspend() calls that took effect (SURVIVE_ZONE no-ops excluded). */
  suspensionsIssued = 0;
  /** Suspensions that aged out (tick passed the until-tick) at read time. */
  suspensionsExpired = 0;
  /** Suspensions dropped by clearSuspensions() (e.g. pickup success). */
  suspensionsCleared = 0;
  /** suspend() calls that took effect, per intent family. */
  readonly suspensionsByFamily: Map<IntentId, number> = new Map();

  constructor(intents: Intent[]) {
    this.intents = intents;
    for (const intent of intents) {
      if (!this.intentsByIdMap.has(intent.id)) {
        this.intentsByIdMap.set(intent.id, intent);
      }
    }
  }

  /**
   * Force a full intent re-evaluation next tick by clearing the committed intent.
   * Called by the universal anti-stall timeout when a bot has been in the same
   * state too long without progress. The next select() call will re-score all
   * intents from scratch instead of honoring the commit window.
   *
   * NOTE: this does NOT clear suspensions. A bot that just stalled should not
   * re-select the same goal. Use suspend() for that.
   */
  forceReevaluate(): void {
    this.currentId = null;
    this.committedUntilTick = 0;
  }

  /**
   * Suspend an intent from being selected until `untilTick`. Called when an
   * executor detects that pursuing this goal stalled the bot (couldn't reach
   * its target — grid/SAT mismatch, unreachable item, geometry wedge). During
   * the suspension, the selector excludes this intent entirely, forcing the
   * bot to pursue a different goal that moves it elsewhere. Survival intents
   * (SURVIVE_ZONE) cannot be suspended.
   */
  suspend(intentId: IntentId, untilTick: number): void {
    if (intentId === IntentId.SURVIVE_ZONE) return; // never suspend survival
    this.suspendedUntil.set(intentId, untilTick);
    // Observation-only counter (DEC-013) — never read by selection logic.
    this.suspensionsIssued++;
    this.suspensionsByFamily.set(intentId, (this.suspensionsByFamily.get(intentId) ?? 0) + 1);
  }

  /** Clear all suspensions (e.g. on zone-shrink forcing a relocation, or on
   *  a successful pickup which proves the bot CAN reach loot). */
  clearSuspensions(): void {
    // Observation-only counter (DEC-013) — never read by selection logic.
    this.suspensionsCleared += this.suspendedUntil.size;
    this.suspendedUntil.clear();
  }

  /** Is this intent currently suspended (excluded from selection)? */
  private isSuspended(id: IntentId, tick: number): boolean {
    const until = this.suspendedUntil.get(id);
    if (until === undefined) return false;
    if (tick > until) {
      this.suspendedUntil.delete(id);
      // Observation-only counter (DEC-013) — never read by selection logic.
      this.suspensionsExpired++;
      return false;
    }
    return true;
  }

  /**
   * Select the intent for this tick. Pure with respect to the IntentContext
   * (no external mutation; commits are tracked internally).
   */
  select(ic: IntentContext): SelectionResult {
    const tick = ic.ctx.tick;

    // --- SURVIVE_ZONE always preempts: zone/siege death is immediate. ---
    // We don't even consult commit windows for it — survival overrides all.

    // 1. If we have a committed intent, validate it and honor the window.
    if (this.currentId !== null) {
      const current = this.intentsByIdMap.get(this.currentId);
      if (current) {
        // SUSPENSION GATE: if the current intent just got suspended (the
        // executor detected a stall and called suspend() between ticks),
        // drop it immediately and fall through to a full re-score that
        // excludes it. This is what breaks the LOOT→WANDER→LOOT loop: the
        // bot can't re-commit to a goal it just abandoned as unreachable.
        if (this.isSuspended(this.currentId, tick)) {
          this.currentId = null;
          this.committedUntilTick = 0;
        } else if (!current.isValid(ic)) {
          // Hard invalidate: prey died, target lost, zone forced.
          this.currentId = null;
          this.committedUntilTick = 0;
        } else if (tick < this.committedUntilTick) {
          // Inside commit window. Allow preemption only if another VALID intent
          // scores clearly higher (PREEMPT_MARGIN). Validity is checked here
          // because score() may return a high value for an intent that isn't
          // actually viable (e.g. SURVIVE_ZONE.score() always returns 1.0 but
          // isValid() gates it on actually being outside the zone). Without
          // this isValid gate, SURVIVE_ZONE would spuriously preempt every tick.
          const currentScore = current.score(ic);
          let bestAlt: Intent | null = null;
          let bestAltScore = -Infinity;
          for (const intent of this.intents) {
            if (intent.id === this.currentId) continue;
            if (this.isSuspended(intent.id, tick)) continue; // stalled goals can't preempt
            if (!intent.isValid(ic)) continue; // only valid alternatives can preempt
            const s = intent.score(ic);
            if (s > bestAltScore) {
              bestAltScore = s;
              bestAlt = intent;
            }
          }
          // SURVIVE_ZONE forces its way through even mid-commit (it's already
          // validity-gated above, so if it's the bestAlt it's genuinely needed).
          const survivalForces =
            bestAlt && bestAlt.id === IntentId.SURVIVE_ZONE && bestAltScore > 0;
          if (survivalForces || bestAltScore > currentScore + PREEMPT_MARGIN) {
            // Preempt.
            const winner = bestAlt!;
            this.currentId = winner.id;
            this.committedUntilTick = tick + Math.max(1, winner.commitTicks(ic));
            return {
              intentId: winner.id,
              committedUntilTick: this.committedUntilTick,
              changed: true,
              score: bestAltScore,
            };
          }
          // Hold the current intent.
          return {
            intentId: this.currentId,
            committedUntilTick: this.committedUntilTick,
            changed: false,
            score: currentScore,
          };
        }
      } else {
        this.currentId = null;
      }
    }

    // 2. No committed intent (or commit expired) — full re-score.
    let best: Intent | null = null;
    let bestScore = -Infinity;
    for (const intent of this.intents) {
      if (this.isSuspended(intent.id, tick)) continue; // stalled goals excluded
      if (!intent.isValid(ic)) continue;
      const s = intent.score(ic);
      if (s > bestScore) {
        bestScore = s;
        best = intent;
      }
    }
    if (!best || bestScore <= 0) {
      // Nothing valid with positive score — fall back to WANDER.
      const wander = this.intentsByIdMap.get(IntentId.WANDER);
      this.currentId = IntentId.WANDER;
      const commit = wander ? Math.max(1, wander.commitTicks(ic)) : 30;
      this.committedUntilTick = tick + commit;
      return {
        intentId: IntentId.WANDER,
        committedUntilTick: this.committedUntilTick,
        changed: true,
        score: 0,
      };
    }
    const changed = this.currentId !== best.id;
    this.currentId = best.id;
    this.committedUntilTick = tick + Math.max(1, best.commitTicks(ic));
    return {
      intentId: best.id,
      committedUntilTick: this.committedUntilTick,
      changed,
      score: bestScore,
    };
  }

  /** For diagnostics: the current committed intent id. */
  get currentIntentId(): IntentId | null {
    return this.currentId;
  }

  /** Look up an intent by id (so the caller can invoke execute() on the
   *  winner). Returns undefined if not found (defensive). */
  intentsById(id: IntentId): Intent | undefined {
    return this.intentsByIdMap.get(id);
  }
}

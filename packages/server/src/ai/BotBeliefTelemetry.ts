/**
 * BotBeliefTelemetry — the believed-state observation surface
 * (bot-ai-v2 ticket 05, DEC-003).
 *
 * Per-bot, read-only observation of the believed-state layer: the belief-
 * SOURCE mix (seen/heard/damage writes) and the INVESTIGATION outcomes
 * (pursuits opened / re-acquired / dropped). Composed into
 * BotBelievabilityCounters (`.beliefs`) so it flows through the existing
 * skill-tracker → summarizeBelievability → benchmark-aggregate pipeline.
 *
 * Standing alone as a type ALSO decouples the belief layer: BeliefUpdate's
 * write paths take a `BotBeliefTelemetry | null` instead of the whole
 * believability counters object — the belief module never imports the
 * believability module.
 *
 * OBSERVATION-ONLY by contract: values are pure functions of the
 * (deterministic) tick/stimulus stream — no RNG, no clock reads, never fed
 * back into a decision. Covered by the benchmark's same-seed byte-identity
 * gate.
 */

/** Belief-source keys in JSON-stable order: the writesBySource literal below
 *  is seeded with all three keys, so the JSON shape is stable even before the
 *  first write (seen/heard/damage — mirrors BeliefTypes.BeliefSource). */
export class BotBeliefTelemetry {
  /** Belief writes by source — the belief-source mix. Seeded with all three
   *  keys so the JSON shape is stable even before the first write. */
  readonly writesBySource: Record<string, number> = { seen: 0, heard: 0, damage: 0 };
  /** Total belief writes (Σ writesBySource values). */
  writesTotal = 0;
  /** Investigations opened (pursueBelievedEnemy arming a pursuit). */
  pursuitsStarted = 0;
  /** Investigations that ended by RE-ACQUIRING the enemy in a scan. */
  pursuitsReacquired = 0;
  /** Investigations that ended by DROPPING the belief (search-failure,
   *  belief expiry, target elimination, or the bot's own death) — every
   *  non-reacquired terminal path. */
  pursuitsDropped = 0;

  /** Record one belief write by source. */
  noteBeliefWrite(source: string): void {
    this.writesBySource[source] = (this.writesBySource[source] ?? 0) + 1;
    this.writesTotal++;
  }

  /** Record an investigation opening. */
  notePursuitStart(): void {
    this.pursuitsStarted++;
  }

  /** Record an investigation terminal outcome: every opened pursuit ends in
   *  exactly one of these unless the bot is still alive and investigating at
   *  match end (the revenge-pursuit termination gate's bookkeeping). */
  notePursuitOutcome(outcome: 'reacquired' | 'dropped'): void {
    if (outcome === 'reacquired') this.pursuitsReacquired++;
    else this.pursuitsDropped++;
  }
}

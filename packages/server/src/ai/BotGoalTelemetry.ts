/**
 * BotGoalTelemetry — the macro-goal observation surface (bot-ai-v2 ticket
 * 07, DEC-008/DEC-013).
 *
 * Per-bot, read-only observation of the macro-goal generator: the GOAL MIX
 * (commits by kind — the per-archetype goal-mix distribution gate) and the
 * PRE-POSITION samples (ticks-ahead-of-shrink at each PRE_POSITION commit —
 * the rotation-timing spread: early movers vs late cutters per archetype).
 * Composed into BotBelievabilityCounters (`.goals`) so it flows through the
 * existing skill-tracker → summarizeBelievability → benchmark-aggregate
 * pipeline; standing alone as a type keeps the goal module decoupled from
 * the believability module (same pattern as BotBeliefTelemetry).
 *
 * OBSERVATION-ONLY by contract: pure functions of the (deterministic) tick
 * stream — no RNG, no clock reads, never fed back into a decision. Covered
 * by the benchmark's same-seed byte-identity gate.
 */

/**
 * Pre-position ticks-ahead bucket UPPER bounds (inclusive; last bucket
 * open-ended). ~3 s / 10 s / 20 s / 40 s ahead of the shrink — coarse
 * enough for a stable JSON shape, fine enough to separate the early movers
 * (SURVIVOR margins) from the late cutters (AGGRESSOR margins).
 */
export const PRE_POSITION_BUCKET_EDGES = [180, 600, 1200, 2400] as const;

/** Bucket labels (JSON-stable; also serves as the bin count). */
export const PRE_POSITION_BUCKET_LABELS = [
  '0-180',
  '181-600',
  '601-1200',
  '1201-2400',
  '2401+',
] as const;

export const PRE_POSITION_BUCKET_COUNT = PRE_POSITION_BUCKET_LABELS.length;

/** Bucket a ticks-ahead value (negative values clamp to bucket 0 — a commit
 *  during the transition itself is "just in time", not before it). */
export function bucketPrePositionTicks(ticksAhead: number): number {
  if (ticksAhead <= PRE_POSITION_BUCKET_EDGES[0]!) return 0;
  for (let i = 1; i < PRE_POSITION_BUCKET_EDGES.length; i++) {
    if (ticksAhead <= PRE_POSITION_BUCKET_EDGES[i]!) return i;
  }
  return PRE_POSITION_BUCKET_COUNT - 1;
}

export class BotGoalTelemetry {
  /**
   * Macro-goal commits by kind label (GoalTypes.MACRO_GOAL_KIND_LABELS:
   * lootCluster/quietSide/unexploredSector/prePosition/hotspotStalk/
   * endgameHold). Seeded with all six keys so the JSON shape is stable
   * before the first commit. The per-archetype cut of this record is the
   * goal-mix distribution gate (DEC-008: distinct mixes per archetype).
   */
  readonly commitsByKind: Record<string, number> = {
    lootCluster: 0,
    quietSide: 0,
    unexploredSector: 0,
    prePosition: 0,
    hotspotStalk: 0,
    endgameHold: 0,
  };
  /** Total goal commits (Σ commitsByKind values). */
  commitsTotal = 0;
  /** PRE_POSITION commits sampled (the ticks-ahead histogram denominator). */
  prePositionSamples = 0;
  /** Σ ticks-ahead at PRE_POSITION commits (the distribution mean numerator). */
  prePositionTicksAheadSum = 0;
  /** Ticks-ahead histogram (PRE_POSITION_BUCKET_LABELS bins). */
  readonly prePositionBuckets: number[] = Array.from(
    { length: PRE_POSITION_BUCKET_COUNT },
    () => 0,
  );

  /** Record one macro-goal commit by kind label. */
  noteMacroGoal(kindLabel: string): void {
    this.commitsByKind[kindLabel] = (this.commitsByKind[kindLabel] ?? 0) + 1;
    this.commitsTotal++;
  }

  /**
   * Record one PRE_POSITION commit's ticks-ahead-of-shrink (the rotation
   * clock at commit time; the margin table maps archetype → this value's
   * expected distribution — early movers vs late cutters).
   */
  notePrePosition(ticksAhead: number): void {
    this.prePositionSamples++;
    this.prePositionTicksAheadSum += Math.max(0, ticksAhead);
    this.prePositionBuckets[bucketPrePositionTicks(ticksAhead)]!++;
  }
}

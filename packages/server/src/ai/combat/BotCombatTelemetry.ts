/**
 * BotCombatTelemetry — the combat-believability observation surface
 * (bot-ai-v2 ticket 09, DEC-010/DEC-013).
 *
 * Per-bot, read-only observation of this ticket's mechanisms, composed into
 * BotBelievabilityCounters (`.combat`, same pattern as `.goals` / `.beliefs`
 * / `.movement`). The counters are fed from ONE drain seam: decision sites
 * without a tracker reference (the intent layer) bump pending counters on
 * ctx.combat, and recordTickTelemetry drains them here once per tick — the
 * same discipline as the stuck-ladder rung drain.
 *
 * Surface (the bench gates join these per-archetype/per-difficulty):
 *  - weaveCommits / weaveCommitTicksSum  — the sticky-weave commitment
 *    histogram numerator (NOT per-tick flips: one commit per 0.5-1 s window);
 *  - disengageByCause / disengagesTotal  — engagement-discretion triggers by
 *    cause (the both-directions engage-fraction gate's explanation surface);
 *  - contestWins / contestLosses / contestBreakOffs — real-loot-contest
 *    outcomes (the win/loss/break-off telemetry);
 *  - weaponBreakByReaction — the break-response mix (switch vs disengage).
 *
 * OBSERVATION-ONLY by contract: never fed back into a decision; pure
 * deterministic tallies (same-seed byte-identity holds).
 */

export class BotCombatTelemetry {
  /** Sticky-weave commitments (one per committed 0.5-1 s window). */
  weaveCommits = 0;
  /** Σ committed weave windows (ticks) — the mean commitment denominator. */
  weaveCommitTicksSum = 0;
  /** Disengage triggers by cause ('hp' | 'supply' | 'thirdParty' |
   *  'outnumbered'). Seeded with all four keys for a stable JSON shape. */
  readonly disengageByCause: Record<string, number> = {
    hp: 0,
    supply: 0,
    thirdParty: 0,
    outnumbered: 0,
  };
  /** Total accepted disengage triggers (Σ disengageByCause values). */
  disengagesTotal = 0;
  /** Loot-contest outcomes (the race for an item resolved). */
  contestWins = 0;
  contestLosses = 0;
  contestBreakOffs = 0;
  /** Weapon-break reactions by kind ('switch' | 'disengage'). */
  readonly weaponBreakByReaction: Record<string, number> = {
    switch: 0,
    disengage: 0,
  };

  /** Record one weave commitment of `ticks` length. */
  noteWeaveCommit(ticks: number): void {
    this.weaveCommits++;
    this.weaveCommitTicksSum += ticks;
  }

  /** Record one accepted disengage trigger. */
  noteDisengage(cause: string): void {
    this.disengageByCause[cause] = (this.disengageByCause[cause] ?? 0) + 1;
    this.disengagesTotal++;
  }

  /** Record one resolved loot-contest outcome. */
  noteContest(outcome: 'win' | 'loss' | 'breakOff'): void {
    if (outcome === 'win') this.contestWins++;
    else if (outcome === 'loss') this.contestLosses++;
    else this.contestBreakOffs++;
  }

  /** Record one weapon-break reaction ('switch' | 'disengage'). */
  noteWeaponBreak(kind: string): void {
    this.weaponBreakByReaction[kind] = (this.weaponBreakByReaction[kind] ?? 0) + 1;
  }
}

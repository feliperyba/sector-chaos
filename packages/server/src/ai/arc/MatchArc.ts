/**
 * Match-arc engine — bot-ai-v2 ticket 10 (DEC-011).
 *
 * THE PURE SEAM for the intra-match aggression ramp: the GDD §14.3
 * phase-weight table (never implemented before this ticket) applied for real
 * as intent-family score multipliers. Two functions carry everything:
 *
 *  - {@linkcode computeMatchArc}: alive counts → the per-tick arc state (band
 *    + the GDD's base multipliers). A PURE function of alive counts — no RNG,
 *    no wall-clock, no room. Same inputs → the same state object value, every
 *    time (the same-seed bench byte-identity gate).
 *  - {@linkcode arcModFor}: (arc state × archetype × family) → the EFFECTIVE
 *    multiplier, after the per-archetype slope (MatchArcTables). Also pure.
 *
 * Application contract (DEC-011 — see the intent/goal seams that call these):
 *  - combatMod    → DUEL / HUNT_VULNERABLE / HUNT intent scores.
 *  - lootingMod   → LOOT / ARM_UP intent scores.
 *  - positioningMod → SURVIVE_ZONE pre-positioning score + the macro-goal
 *    rotation margins (GoalScoring.scorePrePosition).
 * The multipliers shape SCORES only — the selector's commit-window /
 * hysteresis / preemption mechanics are untouched by design.
 *
 * Zero wall-clock reads: the arc is tick/alive-count driven (the alive counts
 * are maintained inline by the WorldSnapshot player sync). The game's own
 * phase tables and timings are NOT modified — this is AI-side score shaping
 * only; bots remain players on the input pipeline.
 */

import { PersonalityArchetype } from '../intent/PersonalityProfile.ts';
import {
  ARCHETYPE_ARC_SLOPES,
  DEFAULT_ARC_SLOPES,
  EARLY_BAND_ALIVE_RATIO_ABOVE,
  GDD_PHASE_WEIGHTS,
  LATE_BAND_ALIVE_RATIO_BELOW,
  type ArchetypeArcSlopes,
  type MatchArcBand,
} from './MatchArcTables.ts';

export type { MatchArcBand } from './MatchArcTables.ts';

/** The per-tick global match-arc state (carried by IntentContext +
 *  MacroGoalInputs; recomputed once per BotSystem.tick). */
export interface MatchArcState {
  readonly band: MatchArcBand;
  /** alive / total this tick (1.0 when there is no denominator yet). */
  readonly aliveRatio: number;
  /** GDD §14.3 base combatMod for the band (slope applied per consumer). */
  readonly combatMod: number;
  /** GDD §14.3 base lootingMod for the band. */
  readonly lootingMod: number;
  /** GDD §14.3 base positioningMod for the band. */
  readonly positioningMod: number;
}

/** The arc modifiable families (one per consumer group — DEC-011). */
export type MatchArcModKind = 'combat' | 'looting' | 'positioning';

/**
 * The mid-band arc used when NO arc is carried (unit-test ic/goal-input
 * literals, pre-cadence ticks, defensive nulls): the identity — all mods 1.0,
 * exactly the pre-ticket-10 behavior. This is why every existing selector /
 * intent / goal suite that omits the arc stays green WITHOUT modification:
 * absence of arc information is semantically "no arc shaping", the same
 * optionality pattern as IntentContext.pathfinder/stimulusScan.
 */
export const IDENTITY_MATCH_ARC: MatchArcState = {
  ...GDD_PHASE_WEIGHTS.mid,
  band: 'mid',
  aliveRatio: 1,
};

/** Band for an alive ratio — the GDD §14.3 trigger column (boundaries mid). */
export function matchArcBandFor(aliveRatio: number): MatchArcBand {
  if (aliveRatio > EARLY_BAND_ALIVE_RATIO_ABOVE) return 'early';
  if (aliveRatio >= LATE_BAND_ALIVE_RATIO_BELOW) return 'mid';
  return 'late';
}

/**
 * Compute the arc state from alive counts. PURE and RNG-free: the same
 * (alive, total) pair always produces the same state (DEC-011 determinism
 * gate). `total <= 0` (no players yet — pre-lobby) yields ratio 1.0 → the
 * early band: nothing has been eliminated, which is literally true.
 */
export function computeMatchArc(alivePlayers: number, totalPlayers: number): MatchArcState {
  const aliveRatio = totalPlayers > 0 ? alivePlayers / totalPlayers : 1;
  const band = matchArcBandFor(aliveRatio);
  const weights = GDD_PHASE_WEIGHTS[band];
  return {
    band,
    aliveRatio,
    combatMod: weights.combatMod,
    lootingMod: weights.lootingMod,
    positioningMod: weights.positioningMod,
  };
}

/** The slope row for an archetype index (defensive fallback on malformed
 *  input — the raw GDD table, no shaping). */
function slopesFor(archetype: number): ArchetypeArcSlopes {
  return ARCHETYPE_ARC_SLOPES[archetype as PersonalityArchetype] ?? DEFAULT_ARC_SLOPES;
}

/**
 * The EFFECTIVE multiplier for one (arc, archetype, family): the band's base
 * GDD value bent by the archetype's slope —
 *   mod = 1 + (bandMod − 1) × slope
 * with the slope chosen by direction (suppress below 1, escalate above 1;
 * bandMod === 1 collapses to 1 for any slope — the mid band is always raw).
 * Returns 1 when `arc` is undefined/null (the identity default above).
 */
export function arcModFor(
  arc: MatchArcState | undefined | null,
  archetype: number,
  kind: MatchArcModKind,
): number {
  if (!arc) return 1;
  const bandMod =
    kind === 'combat' ? arc.combatMod : kind === 'looting' ? arc.lootingMod : arc.positioningMod;
  const slope =
    bandMod < 1 ? slopesFor(archetype)[kind].suppress : slopesFor(archetype)[kind].escalate;
  return 1 + (bandMod - 1) * slope;
}

/**
 * Apply the effective multiplier to an INTENT score and clamp to the Intent
 * contract's 0..1 range (score() promises "0..1 attractiveness"). The clamp
 * keeps amplified scores from exceeding the documented contract — and, by
 * capping at exactly the hard-survival score (SURVIVE_ZONE returns 1.0 for
 * siege / lethal-outside), amplified intents can TIE but never DOMINATE
 * survival (SURVIVE_ZONE is first in the intent array, so ties keep it).
 */
export function applyArcMod(
  score: number,
  arc: MatchArcState | undefined | null,
  archetype: number,
  kind: MatchArcModKind,
): number {
  return Math.min(1, score * arcModFor(arc, archetype, kind));
}

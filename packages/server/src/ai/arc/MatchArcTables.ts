/**
 * Match-arc tuning DATA — bot-ai-v2 ticket 10 (DEC-011).
 *
 * TWO tables live here, with different authority:
 *
 * 1. {@linkcode GDD_PHASE_WEIGHTS} — the GDD §14.3 phase-weight table,
 *    VERBATIM. Band edges AND multiplier values are BUSINESS RULES
 *    (docs/GDD.md §14.3 "Game Phase Awareness"): a change here requires a
 *    GDD change first. Never "tune" this table.
 * 2. {@linkcode ARCHETYPE_ARC_SLOPES} — the per-archetype escalation shape
 *    (DEC-011: "archetype slopes are tuning data, not constants-in-code").
 *    Designers rebalance WHO ramps WHEN by editing numbers here; the band
 *    edges and base multipliers stay GDD-fixed.
 *
 * Dissent obligations encoded in the slope table (DEC-011):
 *  - Viktor: early fights must still exist for AGGRESSOR-type players — the
 *    AGGRESSOR combat suppression slope is shallow (early combatMod stays
 *    high), so individual early aggression survives while the population
 *    curve flattens.
 *  - Marcus: matches must not drag — no slope suppresses late-game combat
 *    below the mid-band (1.0); the escalation shape only bounds how far ABOVE
 *    1.0 an archetype ramps.
 */

import { PersonalityArchetype } from '../intent/PersonalityProfile.ts';

/** The three GDD §14.3 alive-ratio bands. */
export type MatchArcBand = 'early' | 'mid' | 'late';

/**
 * The base multipliers one band applies. Field names are the GDD's own
 * (blackboard keys: phaseWeights (combatMod, lootingMod, positioningMod)).
 */
export interface MatchArcBandWeights {
  readonly combatMod: number;
  readonly lootingMod: number;
  readonly positioningMod: number;
}

/**
 * GDD §14.3 — "Game Phase Awareness" phase-weight table, VERBATIM:
 *
 * | Phase | Trigger      | combatMod | lootingMod | positioningMod |
 * |-------|--------------|-----------|------------|----------------|
 * | Early | >50% alive   | 0.5       | 1.5        | 1.0            |
 * | Mid   | 25-50% alive | 1.0       | 1.0        | 1.0            |
 * | Late  | <25% alive   | 1.5       | 0.5        | 1.5            |
 *
 * Source of truth: docs/GDD.md §14.3 (bot-ai-v2 DEC-011). The trigger column
 * is encoded in {@linkcode EARLY_BAND_ALIVE_RATIO_ABOVE} /
 * {@linkcode LATE_BAND_ALIVE_RATIO_BELOW} — boundary values belong to the
 * MID band (Early is strictly >50%, Late strictly <25%, per the table).
 */
export const GDD_PHASE_WEIGHTS: Record<MatchArcBand, MatchArcBandWeights> = {
  early: { combatMod: 0.5, lootingMod: 1.5, positioningMod: 1.0 },
  mid: { combatMod: 1.0, lootingMod: 1.0, positioningMod: 1.0 },
  late: { combatMod: 1.5, lootingMod: 0.5, positioningMod: 1.5 },
};

/** Early band: alive ratio strictly ABOVE this (GDD §14.3 trigger ">50%"). */
export const EARLY_BAND_ALIVE_RATIO_ABOVE = 0.5;
/** Late band: alive ratio strictly BELOW this (GDD §14.3 trigger "<25%"). */
export const LATE_BAND_ALIVE_RATIO_BELOW = 0.25;

// ---------------------------------------------------------------------------
// Per-archetype slopes (tuning data — DEC-011)
// ---------------------------------------------------------------------------

/**
 * How an archetype honors one multiplier's band pressure. The effective mod
 * is `1 + (bandMod − 1) × slope`, applied per direction:
 *  - {@linkcode suppress}: slope for band values BELOW 1 (how much the band's
 *    suppression is honored). 1 = full table value; <1 = the archetype
 *    resists suppression (AGGRESSOR combat — "never fully suppresses").
 *  - {@linkcode escalate}: slope for band values ABOVE 1 (how much the band's
 *    amplification is honored). 1 = full table value; <1 = the archetype
 *    never fully ramps (SURVIVOR combat — bounded late game).
 * A slope of exactly 1 on both sides is the GDD table raw.
 */
export interface MatchArcSlope {
  readonly suppress: number;
  readonly escalate: number;
}

/** The three arc-modifiable families (the consumers are fixed by DEC-011). */
export interface ArchetypeArcSlopes {
  /** DUEL / HUNT_VULNERABLE / HUNT intent-family scores. */
  readonly combat: MatchArcSlope;
  /** LOOT / ARM_UP intent-family scores. */
  readonly looting: MatchArcSlope;
  /** SURVIVE_ZONE pre-positioning + macro-goal rotation margins. */
  readonly positioning: MatchArcSlope;
}

/**
 * THE per-archetype escalation-shape table (DEC-011). Numeric intent (see
 * MatchArc.applyArcSlope for the formula):
 *
 *  - AGGRESSOR  combat: shallow suppression (early combatMod 0.85 — Viktor's
 *    early-fights gate), FULL escalation (late 1.5 — "ramps early" to the
 *    table's full late game). Softer looting/positioning arc.
 *  - SURVIVOR   combat: full suppression (early 0.5 — the population arc
 *    holds), bounded escalation (late 1.2 — "never fully ramps"). Full
 *    looting + positioning arc (the loot-shy opening is THEIR opening).
 *  - DUELIST    combat: near-full both directions (early 0.725 / late 1.475)
 *    — duelists duel, at any phase.
 *  - SCAVENGER  looting: near-full arc; combat escalation bounded (1.225) —
 *    scavengers do not turn into closers.
 *  - TRAPPER    middle of the road on every axis.
 */
export const ARCHETYPE_ARC_SLOPES: Record<PersonalityArchetype, ArchetypeArcSlopes> = {
  [PersonalityArchetype.AGGRESSOR]: {
    combat: { suppress: 0.3, escalate: 1.0 },
    looting: { suppress: 0.55, escalate: 0.55 },
    positioning: { suppress: 0.5, escalate: 0.65 },
  },
  [PersonalityArchetype.SCAVENGER]: {
    combat: { suppress: 1.0, escalate: 0.45 },
    looting: { suppress: 0.85, escalate: 1.0 },
    positioning: { suppress: 0.9, escalate: 1.0 },
  },
  [PersonalityArchetype.TRAPPER]: {
    combat: { suppress: 0.8, escalate: 0.7 },
    looting: { suppress: 0.7, escalate: 0.8 },
    positioning: { suppress: 0.8, escalate: 0.85 },
  },
  [PersonalityArchetype.DUELIST]: {
    combat: { suppress: 0.55, escalate: 0.95 },
    looting: { suppress: 0.6, escalate: 0.7 },
    positioning: { suppress: 0.7, escalate: 0.85 },
  },
  [PersonalityArchetype.SURVIVOR]: {
    combat: { suppress: 1.0, escalate: 0.4 },
    looting: { suppress: 1.0, escalate: 1.0 },
    positioning: { suppress: 1.0, escalate: 1.0 },
  },
};

/** Defensive fallback for unknown archetype indices (total on malformed
 *  input — the raw GDD table with no shaping; mirrors DEFAULT_GOAL_PROFILE). */
export const DEFAULT_ARC_SLOPES: ArchetypeArcSlopes = {
  combat: { suppress: 1.0, escalate: 1.0 },
  looting: { suppress: 1.0, escalate: 1.0 },
  positioning: { suppress: 1.0, escalate: 1.0 },
};

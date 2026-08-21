/**
 * Macro-goal tuning DATA — bot-ai-v2 ticket 07 (DEC-008).
 *
 * ALL macro-goal tuning lives in this table, never in algorithm code:
 * cadence windows, per-archetype candidate weights, rotation-timing margins,
 * zone-as-cost HP budgets and endgame edge/center preferences. Designers
 * rebalance rotations/loot routes by editing numbers here (SPEC user story
 * 35: personality/timing tuning in data tables).
 *
 * Dissent obligations encoded here (DEC-008):
 *  - Viktor: bots must visibly VALUE survival — rotation margins and
 *    zone-as-cost budgets are archetype-scaled so SURVIVOR/SCAVENGER read
 *    prudent, AGGRESSOR greedy (small margin: sometimes eats storm damage,
 *    like people).
 *  - Elena: quiet-side legibility — AGGRESSOR/DUELIST may INVERT toward the
 *    fight density (deadside inversion flag below); the fight-density source
 *    is stimulus history (DEC-002), so bot and player knowledge agree.
 */

import { PLAYER } from '@sector-battle/shared';
import { PersonalityArchetype } from '../intent/PersonalityProfile.ts';

// ---------------------------------------------------------------------------
// Cadence (ticks; 60 ticks/s)
// ---------------------------------------------------------------------------

/** Re-score cadence: every ~2-3 s, staggered per bot via hashPhase
 *  (120-179 ticks). The committed goal SURVIVES between passes. */
export const MACRO_GOAL_RESCORE_BASE_TICKS = 120;
/** Stagger spread added to the base (hashPhase(playerId, 60) → 0-59). */
export const MACRO_GOAL_RESCORE_STAGGER_TICKS = 60;

/** Commit window: 3-6 s (DEC-008's commit-sticky range), scaled by the
 *  profile's commitMultiplier then clamped back into the range. */
export const MACRO_GOAL_COMMIT_MIN_TICKS = 180;
export const MACRO_GOAL_COMMIT_MAX_TICKS = 360;
/** Commit-length per-bot spread (hashPhase over this span) so the lobby
 *  doesn't flip goals in lockstep at the same tick. */
export const MACRO_GOAL_COMMIT_STAGGER_TICKS = 90;

// ---------------------------------------------------------------------------
// Fight-density + quiet side
// ---------------------------------------------------------------------------

/** Density falloff scale (px): a fight 800 px away contributes half its
 *  strength; the field is LOCAL by design (a map-wide average would erase
 *  the deadside structure the player sees). */
export const FIGHT_DENSITY_FALLOFF_PX = 800;

/** Shared-hotspot strength when folded into the density field (the hotspot
 *  is one fight's seat, not a stimulus — fixed mid strength). */
export const HOTSPOT_FIGHT_STRENGTH = 0.5;

/** Candidate ring radius for quiet-side points (fraction of the NEXT-zone
 *  radius) — inside the next ring, off the wall. */
export const QUIET_SIDE_RING_FRACTION = 0.55;

/** Angular candidate count for quiet-side direction sampling. */
export const QUIET_SIDE_ANGLE_COUNT = 8;

/**
 * Deadside inversion (Elena/DEC-008): AGGRESSOR/DUELIST rotate TOWARD the
 * fight density instead of away — but capped at the edge (the separate
 * HOTSPOT_STALK candidate owns the true approach; the inverted quiet side
 * merely refuses to flee the whole region).
 */
export const QUIET_SIDE_DENSITY_CAP = 1.0;

/**
 * KILL-FEED DANGER MEMORY weight (bot-ai-v2 ticket 09, DEC-010.4): how hard
 * the quiet-side scorer bends away from sectors where deaths have been
 * clustering (per-unit of decayed danger pressure; ~2 deaths ≈ the pull of a
 * full fight-density spread). "The map's danger has memory" (SPEC #16).
 */
export const QUIET_SIDE_DANGER_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Hotspot-edge stalk
// ---------------------------------------------------------------------------

/** Stalk ring radius around a fresh fight centroid: outside a duel's
 *  engagement range but within hunting distance (the "edge" of the hotspot). */
export const HOTSPOT_STALK_EDGE_RADIUS = 900;

/** Stalk saturation: once this many bots hold a HOTSPOT_STALK goal toward
 *  the same fight, further bots score it down (a fight draws a few
 *  stalkers, not the lobby — same rationale as HOTSPOT_SATURATION). */
export const HOTSPOT_STALK_SATURATION = 12;

// ---------------------------------------------------------------------------
// Loot / exploration
// ---------------------------------------------------------------------------

/** Loot-cluster attraction range (px). Beyond it, remembered loot scores 0
 *  (the travel time outweighs the committed window). */
export const LOOT_CLUSTER_RANGE_PX = 2600;

/** Unexplored-sector age normalization (ticks): a sector unvisited for this
 *  long scores the full exploration weight. */
export const SECTOR_VISIT_AGE_TICKS = 3600; // 60 s

// ---------------------------------------------------------------------------
// Per-archetype macro-goal profiles (the DATA TABLE of record)
// ---------------------------------------------------------------------------

/** Per-archetype macro-goal tuning. All fields are pure data — the scoring
 *  seam reads them; no algorithm branches on the archetype enum directly. */
export interface ArchetypeGoalProfile {
  /** Rotation-timing margin: rotate when
   *  timeUntilShrink < travelEstimate × margin. SURVIVOR large (moves
   *  early, visibly values survival); AGGRESSOR tiny (cuts it close, eats
   *  storm damage sometimes — like people). */
  readonly rotationMargin: number;
  /** Deadside inversion: bias quiet-side TOWARD fight density. */
  readonly quietSideInverted: boolean;
  /** Zone-as-cost HP budget: the fraction of CURRENT health a shallow-zone
   *  shortcut may cost. Personality-gated; the never-lethal floor applies
   *  on top (ZoneTiming.LETHAL_FLOOR_HP). */
  readonly zoneShortcutBudgetFraction: number;
  /** Endgame edge bias (1 = hold the ring edge, 0 = collapse to center).
   *  Blended toward center for EVERYONE as the final phase closes (see
   *  ZoneTiming.endgameHoldPoint) so matches still finish naturally. */
  readonly endgameEdgeBias: number;
  /** Candidate base weights (multiplied into each candidate's raw score). */
  readonly lootWeight: number;
  readonly quietWeight: number;
  readonly exploreWeight: number;
  readonly prePositionWeight: number;
  readonly stalkWeight: number;
}

/**
 * THE per-archetype table (DEC-008): margins archetype-scaled so SURVIVOR
 * reads prudent and AGGRESSOR greedy; AGGRESSOR/DUELIST invert the deadside;
 * stalk weights track aggression; exploration tracks greed/caution.
 */
export const ARCHETYPE_GOAL_PROFILES: Record<PersonalityArchetype, ArchetypeGoalProfile> = {
  [PersonalityArchetype.AGGRESSOR]: {
    rotationMargin: 0.85,
    quietSideInverted: true,
    zoneShortcutBudgetFraction: 0.15,
    endgameEdgeBias: 0.15,
    lootWeight: 0.6,
    quietWeight: 0.55,
    exploreWeight: 0.5,
    prePositionWeight: 0.6,
    stalkWeight: 1.25,
  },
  [PersonalityArchetype.SCAVENGER]: {
    rotationMargin: 1.5,
    quietSideInverted: false,
    zoneShortcutBudgetFraction: 0.08,
    endgameEdgeBias: 0.6,
    lootWeight: 1.3,
    quietWeight: 1.0,
    exploreWeight: 1.1,
    prePositionWeight: 1.1,
    stalkWeight: 0.5,
  },
  [PersonalityArchetype.TRAPPER]: {
    rotationMargin: 1.25,
    quietSideInverted: false,
    zoneShortcutBudgetFraction: 0.1,
    endgameEdgeBias: 0.5,
    lootWeight: 0.9,
    quietWeight: 0.9,
    exploreWeight: 0.95,
    prePositionWeight: 1.0,
    stalkWeight: 0.8,
  },
  [PersonalityArchetype.DUELIST]: {
    rotationMargin: 1.0,
    quietSideInverted: true,
    zoneShortcutBudgetFraction: 0.12,
    endgameEdgeBias: 0.35,
    lootWeight: 0.6,
    quietWeight: 0.7,
    exploreWeight: 0.6,
    prePositionWeight: 0.85,
    stalkWeight: 1.15,
  },
  [PersonalityArchetype.SURVIVOR]: {
    rotationMargin: 1.8,
    quietSideInverted: false,
    zoneShortcutBudgetFraction: 0.06,
    endgameEdgeBias: 0.8,
    lootWeight: 0.9,
    quietWeight: 1.2,
    exploreWeight: 0.9,
    prePositionWeight: 1.3,
    stalkWeight: 0.45,
  },
};

/** Fallback profile for unknown archetypes (defensive — every registered
 *  bot carries a profile; this keeps scoring total on malformed input). */
export const DEFAULT_GOAL_PROFILE: ArchetypeGoalProfile =
  ARCHETYPE_GOAL_PROFILES[PersonalityArchetype.SURVIVOR];

// ---------------------------------------------------------------------------
// Endgame activation thresholds
// ---------------------------------------------------------------------------

/** ENDGAME_HOLD activates when the safe radius shrinks inside this (px) OR
 *  the alive count drops to this band — whichever first. */
export const ENDGAME_SAFE_RADIUS_PX = 1400;
export const ENDGAME_ALIVE_COUNT = 8;

/**
 * Endgame contact floor: at ≤ this many survivors the edge bias collapses
 * toward center for EVERY archetype (the duel-finale contact guarantee —
 * keeps final circles resolving instead of two edge-holders starving the
 * match; matches must FINISH naturally, bench gate).
 */
export const ENDGAME_CONTACT_ALIVE = 3;

/**
 * ENDGAME_HOLD dominance: when the endgame condition is active, positioning
 * IS the objective — this multiplier is applied on top of the archetype's
 * pre-position/explore weights so the hold beats roaming candidates.
 */
export const ENDGAME_HOLD_DOMINANCE = 1.6;

// ---------------------------------------------------------------------------
// Zone-as-cost (shared with ZoneTiming — the gate thresholds live here)
// ---------------------------------------------------------------------------

/** A shallow-zone shortcut is only considered when the SAFE alternative is
 *  at least this multiple of the direct distance (a genuinely long detour)
 *  OR crosses the danger gate below — otherwise there is nothing to trade. */
export const ZONE_SHORTCUT_DETOUR_RATIO = 1.6;

/** Fight-density level on the safe corridor above which the shortcut trade
 *  is considered (the "high-danger corridor" clause of DEC-008). */
export const ZONE_SHORTCUT_DANGER_GATE = 0.6;

/** Pathing-overhead discount on the base walk speed (straight-line travel
 *  estimates; real routes corner). */
const TRAVEL_PATH_FACTOR = 0.85;

/** Estimated walk speed for travel-time estimates (px/tick), derived from
 *  PLAYER.BASE_SPEED (named shared reference — no magic literals). */
export const TRAVEL_SPEED_PX_PER_TICK = PLAYER.BASE_SPEED * TRAVEL_PATH_FACTOR;

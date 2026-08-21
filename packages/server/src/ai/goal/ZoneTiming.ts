/**
 * Zone timing + zone-as-cost pure models — bot-ai-v2 ticket 07 (DEC-008).
 *
 * THE PURE SEAM for everything time-related in the macro-goal layer:
 *  - {@linkcode msToTicks}: ms→tick conversion via the named NETWORK
 *    constant (the only place the conversion lives).
 *  - {@linkcode travelTicksEstimate}: distance→travel-ticks estimate.
 *  - {@linkcode shouldRotateForShrink}: the HUMAN rotation rule — rotate
 *    when timeUntilShrink < travelEstimate × personalityMargin (SURVIVOR
 *    margin large, AGGRESSOR tiny; per-archetype table in GoalTables).
 *  - {@linkcode evaluateZoneShortcut}: zone-as-cost — a shallow-zone
 *    shortcut is accepted only inside a small, personality-gated HP budget
 *    that can NEVER be lethal (Viktor's dissent: bots visibly value
 *    survival; an AGGRESSOR trades a sliver of HP, a SURVIVOR refuses).
 *  - {@linkcode endgameHoldPoint}: the goal-driven endgame positioning that
 *    replaces the retired 37°-orbit — edge-early/center-late by archetype.
 *
 * ZERO wall-clock reads: every input is ticks/ms accumulated by the server
 * (timeUntilShrink originates in ZoneService.getMsUntilShrink — derived
 * from phaseElapsedMs, which the benchmark virtual clock drives). Pure
 * functions of their arguments; unit-tested without a room.
 */

import { NETWORK } from '@sector-battle/shared';
import {
  TRAVEL_SPEED_PX_PER_TICK,
  ZONE_SHORTCUT_DETOUR_RATIO,
  ZONE_SHORTCUT_DANGER_GATE,
} from './GoalTables.ts';

/** Convert a duration in ms to ticks (ceil — a partial tick still passes). */
export function msToTicks(ms: number): number {
  return Math.ceil(ms / NETWORK.TICK_INTERVAL);
}

/** Estimated travel time (ticks) for a straight-line distance. */
export function travelTicksEstimate(distPx: number): number {
  return Math.ceil(distPx / TRAVEL_SPEED_PX_PER_TICK);
}

/**
 * The rotation rule of record (DEC-008): a bot rotates when
 * `timeUntilShrink < travelTicks × margin`, margin from the per-archetype
 * data table. With margin > 1 the bot leaves early (SURVIVOR — the travel
 * estimate times the margin exceeds the remaining time, so the inequality
 * fires well before the wall closes); with margin < 1 the bot deliberately
 * departs later than physically comfortable (AGGRESSOR — sometimes eats
 * storm damage, like people).
 */
export function shouldRotateForShrink(
  timeUntilShrinkTicks: number,
  travelTicks: number,
  margin: number,
): boolean {
  // Unknown timing (−1) or no shrink ahead (≤0 happens during the actual
  // transition — always "rotate now").
  if (timeUntilShrinkTicks < 0) return false;
  return timeUntilShrinkTicks < travelTicks * margin;
}

// ---------------------------------------------------------------------------
// Zone-as-cost
// ---------------------------------------------------------------------------

/** HP below which NO zone shortcut is ever taken (never-lethal floor). */
export const LETHAL_FLOOR_HP = 30;

/** Inputs to {@linkcode evaluateZoneShortcut}. All estimates come from the
 *  caller's geometry helpers (pure — see GoalBinding.routeThroughZone). */
export interface ZoneShortcutQuery {
  /** Estimated ticks spent taking damage on the DIRECT (shortcut) route. */
  readonly outsideTicks: number;
  /** Estimated ticks for the FULL direct route (safe + outside portions). */
  readonly directTicks: number;
  /** Estimated ticks on the SAFE alternative route (stays inside the ring). */
  readonly safeTicks: number;
  /** Fight density along the safe corridor (0..~2, fightDensityAt units). */
  readonly dangerAlongSafe: number;
  /** Zone damage per tick outside the circle (5; 10 sudden death). */
  readonly zoneDamagePerTick: number;
  /** The bot's CURRENT health. */
  readonly health: number;
  /** Personality-gated budget: fraction of current health the shortcut may
   *  cost (GoalTables.ARCHETYPE_GOAL_PROFILES[..].zoneShortcutBudgetFraction). */
  readonly budgetFraction: number;
}

export interface ZoneShortcutVerdict {
  readonly accept: boolean;
  /** HP the shortcut would cost (outsideTicks × damage). */
  readonly hpCost: number;
  /** HP the bot is willing to spend (min(fraction × health, health − floor)). */
  readonly budget: number;
}

/**
 * Zone-as-cost verdict. Accept ONLY when ALL hold:
 *  1. TRADE EXISTS: the safe route is a genuinely worse option — at least
 *     ZONE_SHORTCUT_DETOUR_RATIO × the direct route time, OR it crosses a
 *     high-danger corridor (fight density ≥ the danger gate). Without a
 *     trade there is nothing to buy with HP.
 *  2. BUDGET: hpCost ≤ min(health × budgetFraction, health − LETHAL_FLOOR_HP)
 *     — personality-gated AND never lethal, unconditionally (the floor is
 *     not scaled by personality; a greedy bot may spend a bigger SLIVER,
 *     never its life).
 *  3. Zone damage must actually apply (damagePerTick > 0) and there must be
 *     an outside portion at all (outsideTicks > 0; a fully-inside direct
 *     route needs no verdict — callers treat it as direct).
 */
export function evaluateZoneShortcut(q: ZoneShortcutQuery): ZoneShortcutVerdict {
  const hpCost = q.outsideTicks * q.zoneDamagePerTick;
  const budget = Math.max(0, Math.min(q.health * q.budgetFraction, q.health - LETHAL_FLOOR_HP));
  if (q.zoneDamagePerTick <= 0 || q.outsideTicks <= 0) {
    return { accept: false, hpCost, budget };
  }
  const tradeExists =
    q.safeTicks >= q.directTicks * ZONE_SHORTCUT_DETOUR_RATIO ||
    q.dangerAlongSafe >= ZONE_SHORTCUT_DANGER_GATE;
  if (!tradeExists || hpCost > budget) {
    return { accept: false, hpCost, budget };
  }
  return { accept: true, hpCost, budget };
}

// ---------------------------------------------------------------------------
// Endgame positioning (replaces the retired HUNT priority-3 orbit)
// ---------------------------------------------------------------------------

/** Inputs to {@linkcode endgameHoldPoint}. */
export interface EndgameHoldQuery {
  /** Anchor (next-zone center). */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Current safe ring radius (px). */
  readonly radius: number;
  /** Archetype edge bias 0..1 (1 = edge-holder, 0 = center-collapser). */
  readonly edgeBias: number;
  /** 0..1 — how far the endgame has progressed (1 = final closure). Blends
   *  EVERY archetype toward center as the ring closes (matches must finish
   *  naturally — the bench gate). */
  readonly lateProgress: number;
  /** Alive count: at ≤ ENDGAME_CONTACT_ALIVE the edge bias collapses to
   *  near-center for everyone (the duel-finale contact guarantee). */
  readonly aliveCount: number;
  /** Endgame contact threshold (GoalTables.ENDGAME_CONTACT_ALIVE). */
  readonly contactAlive: number;
}

export interface EndgameHoldPoint {
  readonly x: number;
  readonly y: number;
  /** The ring fraction actually used (telemetry-friendly). */
  readonly ringFraction: number;
  /** Stable per-bot angle (radians) — deterministic from the caller's hash,
   *  NOT swept per repath (the retired orbit advanced ~37°/repath; a hold
   *  point is a POSITION, not a merry-go-round). */
  readonly angle: number;
}

/**
 * Goal-driven endgame positioning: edge-early/center-late by archetype.
 * The hold radius = radius × ringFraction where
 *   ringFraction = edgeBias × (1 − 0.7 × lateProgress)  [drift to center]
 * clamped to [0.05, 0.85]; with aliveCount ≤ contactAlive the fraction
 * collapses to ≤ 0.1 so the last survivors converge on the same ground
 * (contact guaranteed — the showdown the orbit used to prevent).
 */
export function endgameHoldPoint(q: EndgameHoldQuery, stableAngleRad: number): EndgameHoldPoint {
  const contact = q.aliveCount > 0 && q.aliveCount <= q.contactAlive;
  let ring = q.edgeBias * (1 - 0.7 * clamp01(q.lateProgress));
  if (contact) ring = Math.min(ring, 0.1);
  const ringFraction = Math.max(0.05, Math.min(0.85, ring));
  return {
    x: q.anchorX + Math.cos(stableAngleRad) * q.radius * ringFraction,
    y: q.anchorY + Math.sin(stableAngleRad) * q.radius * ringFraction,
    ringFraction,
    angle: stableAngleRad,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

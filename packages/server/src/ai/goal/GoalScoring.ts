/**
 * Macro-goal candidate scoring — bot-ai-v2 ticket 07 (DEC-008).
 *
 * THE PURE SEAM of the goal generator: {@linkcode scoreMacroGoals} maps a
 * read-only {@linkcode MacroGoalInputs} to a scored candidate list. No
 * room, no BotSystem, no RNG, no clock — the same inputs always produce the
 * same candidates in the same order (ties break by MACRO_GOAL_KIND_KEYS
 * order). Unit tests feed plain literals. Candidate set (DEC-008):
 *  1. LOOT_CLUSTER       — remembered loot (in-scan chest/weapon, heard
 *                          chest seat, unarmed best-tier sector route) +
 *                          POI/tier flavor (read-only map identity).
 *  2. QUIET_SIDE         — AWAY from the stimulus fight-density field (the
 *                          deadside); AGGRESSOR/DUELIST may invert (table).
 *  3. UNEXPLORED_SECTOR  — least-recently-visited sector (visit memory).
 *  4. PRE_POSITION       — next-ring point gated by the human rotation rule
 *                          (ZoneTiming.shouldRotateForShrink).
 *  5. HOTSPOT_STALK      — edge ring around the freshest fight centroid
 *                          (NOT the centroid: stalkers hold the edge).
 *  6. ENDGAME_HOLD       — goal-driven endgame positioning (edge/center by
 *                          archetype; replaces the retired 37° orbit).
 */

import { hashPhase } from '../BotContext.ts';
import { arcModFor } from '../arc/MatchArc.ts';
import {
  ARCHETYPE_GOAL_PROFILES,
  DEFAULT_GOAL_PROFILE,
  ENDGAME_ALIVE_COUNT,
  ENDGAME_CONTACT_ALIVE,
  ENDGAME_HOLD_DOMINANCE,
  ENDGAME_SAFE_RADIUS_PX,
  FIGHT_DENSITY_FALLOFF_PX,
  HOTSPOT_STALK_EDGE_RADIUS,
  HOTSPOT_STALK_SATURATION,
  QUIET_SIDE_ANGLE_COUNT,
  QUIET_SIDE_DANGER_WEIGHT,
  QUIET_SIDE_DENSITY_CAP,
  QUIET_SIDE_RING_FRACTION,
  SECTOR_VISIT_AGE_TICKS,
} from './GoalTables.ts';
import { endgameHoldPoint, shouldRotateForShrink, travelTicksEstimate } from './ZoneTiming.ts';
import {
  MACRO_GOAL_KIND_KEYS,
  mapSectorPoint,
  mapTierAt,
  type FightPoint,
  type MacroGoalInputs,
  type MacroGoalKind,
} from './GoalTypes.ts';

/** One scored candidate. */
export interface ScoredCandidate {
  readonly kind: MacroGoalKind;
  readonly score: number;
  readonly x: number;
  readonly y: number;
  readonly poiName?: string;
  readonly poiTier: number;
}

/** The per-archetype tuning row type (from the data table of record). */
type GoalProfileRow = (typeof ARCHETYPE_GOAL_PROFILES)[keyof typeof ARCHETYPE_GOAL_PROFILES];

/**
 * Fight-density field read (the deadside source): Σ strength/(1+dist/σ) over
 * the heard-fight samples. Stimulus history IS the density source (DEC-008
 * dissent resolution) — bot and player knowledge roughly agree, because the
 * player heard the same fights.
 */
export function fightDensityAt(x: number, y: number, fights: readonly FightPoint[]): number {
  let density = 0;
  for (let i = 0; i < fights.length; i++) {
    const f = fights[i]!;
    const dx = x - f.x;
    const dy = y - f.y;
    density += f.strength / (1 + Math.sqrt(dx * dx + dy * dy) / FIGHT_DENSITY_FALLOFF_PX);
  }
  return density;
}

/** Is the endgame positioning condition active (radius OR alive count)? */
export function isEndgame(safeRadius: number, aliveCount: number): boolean {
  return (
    (safeRadius > 0 && safeRadius <= ENDGAME_SAFE_RADIUS_PX) || aliveCount <= ENDGAME_ALIVE_COUNT
  );
}

/**
 * Score all candidates. Deterministic: fixed kind order, pure math over the
 * inputs, no RNG, no clock. The list is sorted by MACRO_GOAL_KIND_KEYS
 * order (the tie-break contract — the FIRST of equal-scoring kinds wins).
 */
export function scoreMacroGoals(inputs: MacroGoalInputs): ScoredCandidate[] {
  const profile =
    ARCHETYPE_GOAL_PROFILES[inputs.archetype as keyof typeof ARCHETYPE_GOAL_PROFILES] ??
    DEFAULT_GOAL_PROFILE;
  const out: ScoredCandidate[] = [];

  const loot = scoreLootCluster(inputs, profile);
  if (loot) out.push(loot);

  if (inputs.fightPoints.length > 0) {
    const quiet = scoreQuietSide(inputs, profile);
    if (quiet) out.push(quiet);
  }

  if (inputs.mapIdentity) {
    const explore = scoreUnexploredSector(inputs, profile);
    if (explore) out.push(explore);
  }

  const pre = scorePrePosition(inputs, profile);
  if (pre) out.push(pre);

  const stalk = scoreHotspotStalk(inputs, profile);
  if (stalk) out.push(stalk);

  if (isEndgame(inputs.zone.safeRadius, inputs.aliveCount)) {
    const hold = scoreEndgameHold(inputs, profile);
    if (hold) out.push(hold);
  }

  out.sort((a, b) => MACRO_GOAL_KIND_KEYS.indexOf(a.kind) - MACRO_GOAL_KIND_KEYS.indexOf(b.kind));
  return out;
}

// ---------------------------------------------------------------------------
// 1. LOOT_CLUSTER — verbatim-extracted to GoalScoringLoot.ts (bot-ai-v2
// ticket 09, module-length gate), extended with the kill-feed safe-loot
// source (DEC-010.4). Imported below.
// ---------------------------------------------------------------------------

import { scoreLootCluster } from './GoalScoringLoot.ts';

// ---------------------------------------------------------------------------
// 2. QUIET_SIDE
// ---------------------------------------------------------------------------

/**
 * Quiet side: the deadside heuristic. Samples QUIET_SIDE_ANGLE_COUNT points
 * on a ring inside the NEXT zone; scores each by fight density (away =
 * high) — unless the archetype inverts (AGGRESSOR/DUELIST data-table flag),
 * in which case TOWARD wins, capped at the edge so the inverted bot stalks
 * the busy side without walking into the kill zone.
 */
function scoreQuietSide(inputs: MacroGoalInputs, profile: GoalProfileRow): ScoredCandidate | null {
  const zone = inputs.zone;
  const ringR = Math.max(240, zone.nextRadius * QUIET_SIDE_RING_FRACTION);
  const halfSector = Math.PI / QUIET_SIDE_ANGLE_COUNT;
  const densities: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  let total = 0;
  for (let i = 0; i < QUIET_SIDE_ANGLE_COUNT; i++) {
    const a = (i / QUIET_SIDE_ANGLE_COUNT) * Math.PI * 2 + halfSector;
    const px = zone.nextX + Math.cos(a) * ringR;
    const py = zone.nextY + Math.sin(a) * ringR;
    const d = fightDensityAt(px, py, inputs.fightPoints);
    densities.push(d);
    xs.push(px);
    ys.push(py);
    total += d;
  }
  const avg = total / QUIET_SIDE_ANGLE_COUNT;
  let minD = Infinity;
  let maxD = -Infinity;
  for (const d of densities) {
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  const spread = Math.max(1e-6, maxD - minD);
  let bestScore = -Infinity;
  let bestX = 0;
  let bestY = 0;
  for (let i = 0; i < QUIET_SIDE_ANGLE_COUNT; i++) {
    const d = densities[i]!;
    let directional: number;
    if (profile.quietSideInverted) {
      // Deadside inversion: prefer TOWARD the fights, but capped — the
      // inverted bot holds the busy side's edge; density past the cap
      // (the kill zone proper) is penalized, not rewarded.
      directional = (d - minD) / spread;
      if (d > QUIET_SIDE_DENSITY_CAP) directional -= (d - QUIET_SIDE_DENSITY_CAP) * 2;
    } else {
      directional = (maxD - d) / spread;
    }
    // KILL-FEED DANGER MEMORY (bot-ai-v2 ticket 09, DEC-010.4): the decayed
    // sector-danger pressure (deaths clustering there, match-long with decay)
    // subtracts from BOTH orientations — even an inverted (toward-fights)
    // archetype refuses the map's established killing fields. This is the
    // "danger memory feeds quiet-side scoring" interaction with ticket 07.
    if (inputs.dangerAt) {
      directional -= QUIET_SIDE_DANGER_WEIGHT * inputs.dangerAt(xs[i]!, ys[i]!);
    }
    // Prefer points inside the CURRENT circle too: a quiet side that
    // requires leaving the ring NOW is not quiet — it is zone damage.
    const inCurrent =
      dist2D(xs[i]!, ys[i]!, zone.safeX, zone.safeY) <= Math.max(1, zone.safeRadius);
    const raw = directional + (inCurrent ? 0.25 : 0);
    if (raw > bestScore) {
      bestScore = raw;
      bestX = xs[i]!;
      bestY = ys[i]!;
    }
  }
  const intensity = Math.min(1, avg * 1.5); // a louder world → a stronger deadside pull
  const score = profile.quietWeight * (0.45 + 0.55 * intensity) * clamp01(bestScore / 1.2);
  if (score <= 0) return null;
  return {
    kind: 'QUIET_SIDE',
    score,
    x: bestX,
    y: bestY,
    poiTier: inputs.mapIdentity ? mapTierAt(inputs.mapIdentity, bestX, bestY) : -1,
  };
}

// ---------------------------------------------------------------------------
// 3. UNEXPLORED_SECTOR
// ---------------------------------------------------------------------------

/**
 * Unexplored sector: oldest visit stamp wins, tier-flavored, zone-aware.
 * The CURRENT sector scores near-zero (just been there); sectors inside the
 * next ring get a bonus (exploring ground the shrink won't erase).
 */
function scoreUnexploredSector(
  inputs: MacroGoalInputs,
  profile: GoalProfileRow,
): ScoredCandidate | null {
  const id = inputs.mapIdentity!;
  const hereFlat = currentSectorFlat(inputs);
  let bestScore = -Infinity;
  let bestRow = -1;
  let bestCol = -1;
  for (let row = 0; row < id.rows; row++) {
    for (let col = 0; col < id.cols; col++) {
      const flat = row * id.cols + col;
      const lastVisit = inputs.sectorVisits[flat] ?? 0;
      const ageNorm = clamp01((inputs.tick - lastVisit) / SECTOR_VISIT_AGE_TICKS);
      const point = mapSectorPoint(id, row, col);
      const insideNext =
        dist2D(point.x, point.y, inputs.zone.nextX, inputs.zone.nextY) <=
        Math.max(1, inputs.zone.nextRadius * 1.15);
      const tier = mapTierAt(id, point.x, point.y);
      const tierBonus = tier >= 2 ? 0.2 : tier >= 1 ? 0.1 : 0;
      const raw = ageNorm * (flat === hereFlat ? 0.1 : 1) + tierBonus + (insideNext ? 0.25 : -0.15);
      if (raw > bestScore) {
        bestScore = raw;
        bestRow = row;
        bestCol = col;
      }
    }
  }
  if (bestRow < 0) return null;
  const point = mapSectorPoint(id, bestRow, bestCol);
  const score = profile.exploreWeight * clamp01(bestScore / 1.45) * (inputs.armed ? 0.8 : 1.1);
  if (score <= 0) return null;
  return {
    kind: 'UNEXPLORED_SECTOR',
    score,
    x: point.x,
    y: point.y,
    poiName: point.poiName,
    poiTier: mapTierAt(id, point.x, point.y),
  };
}

// ---------------------------------------------------------------------------
// 4. PRE_POSITION
// ---------------------------------------------------------------------------

/**
 * Pre-position: gated by the HUMAN rotation rule (shouldRotateForShrink —
 * timeUntilShrink vs travel estimate × personality margin, the per-archetype
 * data table). The point is a STABLE per-bot angle on the next ring
 * (hash-derived, never swept — the retired orbit advanced ~37° every
 * repath; a pre-position is a destination, not a carousel).
 *
 * MATCH ARC (bot-ai-v2 ticket 10, DEC-011): positioningMod × archetype slope
 * scales BOTH the rotation margin (mod > 1 → rotate EARLIER: the inequality
 * fires sooner) and the candidate score — the "rotation margins" consumer
 * DEC-011 names. Unclamped by design: goal-candidate scores are comparative
 * weights (GoalTables weights already exceed 1), not 0..1 intent scores.
 */
function scorePrePosition(
  inputs: MacroGoalInputs,
  profile: GoalProfileRow,
): ScoredCandidate | null {
  const zone = inputs.zone;
  if (zone.timeUntilShrinkTicks < 0) return null; // timing unknown — no gate
  const positioningMod = arcModFor(inputs.arc, inputs.archetype, 'positioning');
  const holdR = Math.max(200, zone.nextRadius * 0.6);
  const angle = stableAngleRad(inputs.playerId);
  const px = zone.nextX + Math.cos(angle) * holdR;
  const py = zone.nextY + Math.sin(angle) * holdR;
  const travel = travelTicksEstimate(dist2D(inputs.x, inputs.y, px, py));
  const margin = profile.rotationMargin * positioningMod;
  if (!shouldRotateForShrink(zone.timeUntilShrinkTicks, travel, margin)) {
    return null; // not this bot's time yet — the margin is the personality clock
  }
  // Urgency ramps as the window closes: starts at the margin trip, dominates
  // as timeUntilShrink → 0. The ramp span is 3× the trip distance (margin units).
  const ramp = Math.max(1, travel * margin * 3);
  const urgency = clamp01(1 - zone.timeUntilShrinkTicks / ramp);
  const score =
    profile.prePositionWeight *
    positioningMod *
    (0.5 + 0.5 * urgency) *
    (zone.isShrinking ? 1.2 : 1);
  if (score <= 0) return null;
  return {
    kind: 'PRE_POSITION',
    score,
    x: px,
    y: py,
    poiTier: inputs.mapIdentity ? mapTierAt(inputs.mapIdentity, px, py) : -1,
  };
}

// --- 5. HOTSPOT_STALK ---

/**
 * Hotspot-edge stalk: an EDGE point on the ring around the loudest fight
 * sample — the angle minimizes (fight density, barrel density, distance) so
 * the stalker approaches the fight's quiet edge, never the kill-zone
 * center. Saturating: once HOTSPOT_STALK_SATURATION bots hold a stalk this
 * tick, later bots score it toward zero (a fight draws a few stalkers, not
 * the lobby — the same saturation rationale as the retired HUNT hotspot
 * branch, now enforced at the scoring seam).
 */
function scoreHotspotStalk(
  inputs: MacroGoalInputs,
  profile: GoalProfileRow,
): ScoredCandidate | null {
  let centroid: FightPoint | null = null;
  for (const f of inputs.fightPoints) {
    if (!centroid || f.strength > centroid.strength) centroid = f;
  }
  if (!centroid) return null;
  const saturation = Math.max(0, 1 - inputs.hotspotStalkers / HOTSPOT_STALK_SATURATION);
  if (saturation <= 0.05) return null;
  const base = stableAngleRad(inputs.playerId);
  let bestCost = Infinity;
  let bestX = 0;
  let bestY = 0;
  for (let i = 0; i < QUIET_SIDE_ANGLE_COUNT; i++) {
    const a = (i / QUIET_SIDE_ANGLE_COUNT) * Math.PI * 2 + Math.PI / QUIET_SIDE_ANGLE_COUNT + base;
    const px = centroid.x + Math.cos(a) * HOTSPOT_STALK_EDGE_RADIUS;
    const py = centroid.y + Math.sin(a) * HOTSPOT_STALK_EDGE_RADIUS;
    const density = fightDensityAt(px, py, inputs.fightPoints);
    const barrels = inputs.barrelDensityAt ? inputs.barrelDensityAt(px, py) : 0;
    const dist = dist2D(inputs.x, inputs.y, px, py);
    const cost = density + barrels * 0.15 + dist / 2000;
    if (cost < bestCost) {
      bestCost = cost;
      bestX = px;
      bestY = py;
    }
  }
  const centroidStrength = Math.min(1, centroid.strength * 1.4);
  const score = profile.stalkWeight * saturation * centroidStrength * 0.9;
  if (score <= 0) return null;
  return {
    kind: 'HOTSPOT_STALK',
    score,
    x: bestX,
    y: bestY,
    poiTier: inputs.mapIdentity ? mapTierAt(inputs.mapIdentity, bestX, bestY) : -1,
  };
}

// --- 6. ENDGAME_HOLD ---

/**
 * Endgame hold: edge/center by archetype (ZoneTiming.endgameHoldPoint) —
 * the goal-driven positioning that replaced the HUNT priority-3 orbit.
 * Dominant when active (positioning IS the endgame objective).
 */
function scoreEndgameHold(
  inputs: MacroGoalInputs,
  profile: GoalProfileRow,
): ScoredCandidate | null {
  const zone = inputs.zone;
  const radius = Math.max(1, zone.nextRadius > 0 ? zone.nextRadius : zone.safeRadius);
  const lateProgress = lateProgressOf(zone.safeRadius);
  const hold = endgameHoldPoint(
    {
      anchorX: zone.nextX,
      anchorY: zone.nextY,
      radius,
      edgeBias: profile.endgameEdgeBias,
      lateProgress,
      aliveCount: inputs.aliveCount,
      contactAlive: ENDGAME_CONTACT_ALIVE,
    },
    stableAngleRad(inputs.playerId),
  );
  return {
    kind: 'ENDGAME_HOLD',
    score: ENDGAME_HOLD_DOMINANCE * (0.7 + 0.3 * lateProgress),
    x: hold.x,
    y: hold.y,
    poiTier: inputs.mapIdentity ? mapTierAt(inputs.mapIdentity, hold.x, hold.y) : -1,
  };
}

/**
 * Late-phase progress 0..1: how close the safe ring is to the final closure.
 * Blends EVERY archetype's hold toward center as the ring closes — matches
 * must still finish naturally (the bench gate).
 */
export function lateProgressOf(safeRadius: number): number {
  if (safeRadius <= 0) return 1; // sudden death / collapsed — full center pressure
  return clamp01(1 - safeRadius / ENDGAME_SAFE_RADIUS_PX);
}

/**
 * Stable per-bot angle (radians), hash-derived, constant over the match. The
 * STABILITY is the point: the retired orbit swept this angle every repath
 * (~37°/40 ticks); holds and pre-positions keep ONE angle and only re-score
 * on cadence.
 */
export function stableAngleRad(playerId: string): number {
  return (hashPhase(playerId, 360) * Math.PI) / 180;
}

/** Flat row-major sector index of the bot's position (−1 without identity). */
function currentSectorFlat(inputs: MacroGoalInputs): number {
  const id = inputs.mapIdentity;
  if (!id) return -1;
  const col = Math.min(id.cols - 1, Math.max(0, Math.floor((inputs.x / id.mapWidth) * id.cols)));
  const row = Math.min(id.rows - 1, Math.max(0, Math.floor((inputs.y / id.mapHeight) * id.rows)));
  return row * id.cols + col;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function dist2D(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

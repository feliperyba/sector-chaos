/**
 * GoalScoringLoot — verbatim extraction of the LOOT_CLUSTER scorer from
 * GoalScoring.ts (bot-ai-v2 ticket 09, for the module-length gate), extended
 * with the KILL-FEED safe-loot source: a nearby fight that just ENDED (a
 * heard elimination, fresh within the window) becomes a loot-cluster
 * candidate at the corpse seat — the "bots loot the aftermath of a nearby
 * fight" behavior (DEC-010.4 / SPEC #25).
 */

import { HOTSPOT_MEMORY_TICKS } from '../BotSystemConstants.ts';
import { LOOT_CLUSTER_RANGE_PX } from './GoalTables.ts';
import { SAFE_LOOT_BASE_VALUE, SAFE_LOOT_WINDOW_TICKS } from '../combat/BotKillFeedMemory.ts';
import {
  mapPoiNameAt,
  mapSectorPoint,
  mapTierAt,
  type MapIdentityView,
  type MacroGoalInputs,
} from './GoalTypes.ts';
import type { ScoredCandidate } from './GoalScoring.ts';

/** The per-archetype tuning row type (from the data table of record). */
type GoalProfileRow = {
  readonly lootWeight: number;
};

/**
 * Loot-cluster: remembered loot value × distance falloff × tier/POI flavor.
 * Sources in priority order: in-scan loot (chest/upgrade weapon — fresh
 * ground truth), heard chest seat (stimulus memory — the fresh-loot window),
 * the SAFE-LOOT seat (ticket 09: a fresh elimination nearby — the aftermath
 * of a fight is lootable ground while the window is open), or — only for an
 * UNARMED bot with map identity — the best-tier sector anchor (the opening
 * "loot route to named ground" that replaces blind wandering during the drop).
 */
export function scoreLootCluster(
  inputs: MacroGoalInputs,
  profile: GoalProfileRow,
): ScoredCandidate | null {
  let px = 0;
  let py = 0;
  let value = 0;
  /** True for the unarmed best-tier sector route — a strategic map-level
   *  destination, NOT remembered loot (see the range gate below). */
  let isTierRoute = false;
  if (inputs.inScanLoot) {
    px = inputs.inScanLoot.x;
    py = inputs.inScanLoot.y;
    value = inputs.inScanLoot.value;
  } else if (inputs.heardChest) {
    px = inputs.heardChest.x;
    py = inputs.heardChest.y;
    const age = Math.max(0, inputs.tick - inputs.heardChest.tick);
    value = Math.max(0, 0.8 * (1 - age / HOTSPOT_MEMORY_TICKS));
  } else if (inputs.heardElimination) {
    // SAFE-LOOT WINDOW (DEC-010.4): the elimination-memory seat with its
    // linear age bias — a FRESH kill site scores near a heard chest, fading
    // to zero across the window.
    px = inputs.heardElimination.x;
    py = inputs.heardElimination.y;
    const age = Math.max(0, inputs.tick - inputs.heardElimination.tick);
    value = Math.max(0, SAFE_LOOT_BASE_VALUE * (1 - age / SAFE_LOOT_WINDOW_TICKS));
  } else if (!inputs.armed && inputs.mapIdentity) {
    const route = bestTierSectorPoint(inputs.mapIdentity);
    if (!route) return null;
    px = route.x;
    py = route.y;
    value = 0.5;
    isTierRoute = true;
  } else {
    return null;
  }
  if (value <= 0) return null;
  const dist = dist2D(inputs.x, inputs.y, px, py);
  // The attraction range gates REMEMBERED loot only (in-scan/heard/safe-loot
  // seats: past it the travel time outweighs the committed window). The
  // unarmed tier route is the opening "loot route to named ground" that
  // replaces blind wandering during the drop (DEC-008) — it must fire from
  // anywhere on the map, so it bypasses the gate and floors its falloff
  // instead (far routes still score lower than near ones, never zero).
  if (!isTierRoute && dist > LOOT_CLUSTER_RANGE_PX) return null;
  const falloff = Math.max(0, 1 - dist / LOOT_CLUSTER_RANGE_PX);
  const identity = inputs.mapIdentity;
  let tierBonus = 0;
  let poiName: string | undefined;
  let poiTier = -1;
  if (identity) {
    poiTier = mapTierAt(identity, px, py);
    if (poiTier >= 2) tierBonus = 0.25;
    else if (poiTier >= 1) tierBonus = 0.15;
    // POI/tier READ-ONLY flavor (DEC-008 map-identity clause): named
    // destinations read as intentional routes, not random wander.
    poiName = mapPoiNameAt(identity, px, py);
    if (poiName) tierBonus += 0.1;
  }
  const greedAmp = 0.6 + inputs.greed * 0.6;
  const score = profile.lootWeight * greedAmp * (value + tierBonus) * (0.35 + 0.65 * falloff);
  if (score <= 0) return null;
  return { kind: 'LOOT_CLUSTER', score, x: px, y: py, poiName, poiTier };
}

/** Best-tier sector point (HOT > WARM; ties → first in row-major order —
 *  deterministic). Null when the identity carries no tiers. */
function bestTierSectorPoint(identity: MapIdentityView): { x: number; y: number } | null {
  let bestTier = 0;
  let bestRow = -1;
  let bestCol = -1;
  for (let row = 0; row < identity.rows; row++) {
    for (let col = 0; col < identity.cols; col++) {
      const tier = identity.tierGrid[row]?.[col] ?? -1;
      if (tier > bestTier) {
        bestTier = tier;
        bestRow = row;
        bestCol = col;
      }
    }
  }
  if (bestRow < 0) return null;
  const p = mapSectorPoint(identity, bestRow, bestCol);
  return { x: p.x, y: p.y };
}

function dist2D(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

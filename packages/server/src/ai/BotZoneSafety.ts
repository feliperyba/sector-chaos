/**
 * Zone safety helpers extracted from the original BotSystem.ts.
 *
 * `pickZoneSafePoint` was already a free function (no `this`); moved verbatim.
 * `updateZoneInfo` was a method; its body is byte-identical except `this.`
 * → `system.` (and the zoneIsLethal write now targets the tick blackboard,
 * ticket 35). Behavior is provably preserved by construction.
 *
 * Zone SOURCE (perf-arc ticket 17): the zone geometry now arrives via the
 * per-tick WorldSnapshot zone view (`system.worldSnapshot.zone`, refreshed by
 * syncZoneView from the zoneService/siegeWallManager feed) — the retired
 * path was a per-bot-tick call through a closure over the wire
 * MatchStateProjector (`zoneDataGetter`), which forced a full state
 * projection per tick to feed these same fields. Same reads, same tick:
 * zone state only mutates outside the sim step, so values are identical.
 */

import type { BotSystem } from './BotSystem.ts';
import type { TickBlackboard } from './TickBlackboard.ts';

/**
 * The point a bot should head toward to stay safe from the zone. During a
 * center-transition (or in the warning window before one), this is the
 * TARGET center the zone is shrinking toward, so bots pre-position inside
 * the next ring instead of getting caught outside the current one mid-shrink.
 * Otherwise it's the current center.
 */
export function pickZoneSafePoint(
  centerX: number,
  centerY: number,
  targetCenterX: number,
  targetCenterY: number,
  currentRadius: number,
  targetRadius: number,
  isTransitioningCenter: boolean,
  nextPreview: { centerX: number; centerY: number; radius: number } | null,
): { x: number; y: number; radius: number } {
  // During an active center transition, run toward where the zone is going.
  if (isTransitioningCenter) {
    return { x: targetCenterX, y: targetCenterY, radius: targetRadius };
  }
  // If the current phase is still shrinking toward its target radius, head
  // toward the target center at the target radius. This pre-positions bots
  // inside the final ring before the shrink completes.
  if (targetRadius > 0 && currentRadius > targetRadius + 1) {
    return { x: targetCenterX, y: targetCenterY, radius: targetRadius };
  }
  // If we have a preview of the next phase and its center differs notably from
  // the current one, start drifting toward it early.
  if (nextPreview && currentRadius > 0) {
    const dx = nextPreview.centerX - centerX;
    const dy = nextPreview.centerY - centerY;
    const drift = Math.sqrt(dx * dx + dy * dy);
    if (drift > currentRadius * 0.1) {
      return { x: nextPreview.centerX, y: nextPreview.centerY, radius: nextPreview.radius };
    }
  }
  return { x: centerX, y: centerY, radius: currentRadius };
}

/**
 * Refresh the zone geometry for this tick. Also writes the per-tick
 * `zoneIsLethal` flag into the tick blackboard (recomputed from
 * zone.currentPhase every tick — fresh-construction equivalent of the old
 * in-place rewrite of the system field).
 */
export function updateZoneInfo(system: BotSystem, bb: TickBlackboard): ZoneInfo {
  // Zone source is the per-tick snapshot view (perf-arc ticket 17). No feed
  // → null view → the same neutral map-center fallback the old null
  // zoneDataGetter produced.
  const zone = system.worldSnapshot.zone;
  if (!zone) {
    return {
      centerX: system.mapCenter.x,
      centerY: system.mapCenter.y,
      radius: 0,
      isShrinking: false,
      siegeWarnings: [],
      targetCenterX: system.mapCenter.x,
      targetCenterY: system.mapCenter.y,
      targetRadius: 0,
      nextPreview: null,
      currentPhase: 0,
      msUntilShrink: -1,
    };
  }
  const siegeWarnings = zone.siegeWallWarnings.map((w) => ({ x: w.gridX, y: w.gridY }));
  // The zone only deals damage from phase 2 onward (phase 1 = drop = 0 damage,
  // per ZoneService.getTickDamage). Corner-spawned bots are geometrically
  // outside the inscribed zone circle at spawn; without this gate, they'd flee
  // for the entire harmless drop and never loot.
  bb.zoneIsLethal = zone.currentPhase >= 2;
  // The zone is "shrinking" (from the bot's perspective) if EITHER the center
  // is transitioning OR the radius is still interpolating down toward its
  // target. The server only sets isTransitioningCenter for center moves, but a
  // radius-only shrink (center stays, radius contracts) is equally dangerous —
  // bots near the edge get caught outside. Detecting both keeps the tighter
  // flee margin active during all shrink phases.
  const radiusShrinking = zone.currentRadius > zone.targetRadius + 1; // +1 epsilon for float jitter
  return {
    centerX: zone.centerX,
    centerY: zone.centerY,
    radius: zone.currentRadius,
    isShrinking: zone.isTransitioningCenter || radiusShrinking,
    siegeWarnings,
    targetCenterX: zone.targetCenterX,
    targetCenterY: zone.targetCenterY,
    targetRadius: zone.targetRadius,
    nextPreview: zone.nextPhasePreview,
    currentPhase: zone.currentPhase,
    msUntilShrink: zone.msUntilShrink,
  };
}

export interface ZoneInfo {
  centerX: number;
  centerY: number;
  radius: number;
  isShrinking: boolean;
  siegeWarnings: Array<{ x: number; y: number }>;
  /** Where the zone is shrinking toward (target center for the current phase). */
  targetCenterX: number;
  targetCenterY: number;
  targetRadius: number;
  /** Preview of the NEXT phase's center/radius, for pre-positioning. */
  nextPreview: { centerX: number; centerY: number; radius: number } | null;
  /** Current zone phase (1=drop … 7=sudden death). */
  currentPhase: number;
  /**
   * Ms until the current/first radius transition begins (bot-ai-v2 ticket
   * 07, DEC-008): the rotation clock the macro-goal generator consumes
   * (rotation timing = timeUntilShrink vs travel estimate × personality
   * margin). −1 = unknown (no zone feed on the snapshot). Server-side
   * read-only — no gameplay rule reads this.
   */
  msUntilShrink: number;
}

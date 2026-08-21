/**
 * Zone view for the WorldSnapshot per-tick sync (perf-arc ticket 17).
 *
 * Bots used to read zone state through a constructor closure over the wire
 * `MatchStateProjector` (`orchestrator.getMatchState()`), which forced a FULL
 * state projection per tick just to feed 2 zone fields. The feed below is the
 * replacement: the snapshot sync pass reads the SAME `zoneService`/
 * `siegeWallManager` instances the projector reads, directly at snapshot time.
 *
 * Determinism (the ticket's zero-tolerance bar): zone geometry mutates only in
 * `GameOrchestrator.update` (zoneService.update runs BEFORE the sim step that
 * hosts the bot pass; siege warnings mutate only in mapSiegeService.update,
 * which runs AFTER it). The old closure read the values from inside
 * botSystemTick; syncZoneView reads them from the same tick's snapshot sync,
 * and nothing between the two sites mutates zone state — so bots see
 * tick-for-tick identical values (same-seed bench is byte-identical).
 */

import type { ZoneService } from '../domain/services/ZoneService.ts';
import type { SiegeWallManager, SiegeWallWarning } from '../domain/aggregates/SiegeWallManager.ts';
import type { WorldSnapshot } from './WorldSnapshot.ts';

/**
 * The zone read feed: the same per-match service instances the wire projector
 * reads. Handed to the WorldSnapshot ONCE at construction (replacing the
 * retired `zoneDataGetter` closure on BotSystem construction).
 */
export interface ZoneFeed {
  readonly zoneService: ZoneService;
  readonly siegeWallManager: SiegeWallManager;
}

/**
 * The bots' per-tick zone read view, refreshed by {@linkcode syncZoneView}.
 * Field-for-field the zone surface `updateZoneInfo` (BotZoneSafety) consumes —
 * exactly what the old projector path fed it, minus `phaseStartTime`/
 * `phaseEndTime` (carried by the wire ZoneCache for the StateMapper, never
 * read by any bot consumer).
 */
export interface ZoneView {
  currentPhase: number;
  centerX: number;
  centerY: number;
  targetCenterX: number;
  targetCenterY: number;
  currentRadius: number;
  targetRadius: number;
  isTransitioningCenter: boolean;
  /**
   * Ms until the current/first radius transition begins (bot-ai-v2 ticket 07,
   * DEC-008). Wall-clock-free (accumulated deltas); −1 = unknown.
   */
  msUntilShrink: number;
  /** Preview of the NEXT phase's center/radius (reshaped from the service's
   *  `{center:{x,y}, radius}` form, same as the projector's cache did). */
  nextPhasePreview: { centerX: number; centerY: number; radius: number } | null;
  /** LIVE warning list reference — warnings only mutate in
   *  mapSiegeService.update (after the sim step), so the reference is stable
   *  for the whole tick the snapshot serves. */
  siegeWallWarnings: SiegeWallWarning[];
}

/**
 * Refresh the snapshot's zone view from the feed. Reads mirror the projector's
 * zone block verbatim (phase→currentPhase rename included); the preview is
 * COPIED into the snapshot's persistent cache object (never aliases the
 * service's live preview), matching the projector's pc-cache pattern. No-op
 * when the snapshot was built without a feed (updateZoneInfo then falls back
 * to its neutral map-center ZoneInfo, as it did for a null zoneDataGetter).
 */
export function syncZoneView(snapshot: WorldSnapshot): void {
  const feed = snapshot.zoneFeed;
  const view = snapshot.zone;
  if (!feed || !view) return;

  const zoneData = feed.zoneService.getCurrentZone();
  view.currentPhase = zoneData.phase;
  view.centerX = zoneData.centerX;
  view.centerY = zoneData.centerY;
  view.targetCenterX = zoneData.targetCenterX;
  view.targetCenterY = zoneData.targetCenterY;
  view.isTransitioningCenter = zoneData.isTransitioningCenter;
  view.currentRadius = zoneData.currentRadius;
  view.targetRadius = zoneData.targetRadius;
  view.msUntilShrink = zoneData.msUntilShrink;

  const preview = feed.zoneService.getNextPhasePreview();
  if (preview) {
    const pc = snapshot.zonePreviewCache;
    pc.centerX = preview.center.x;
    pc.centerY = preview.center.y;
    pc.radius = preview.radius;
    view.nextPhasePreview = pc;
  } else {
    view.nextPhasePreview = null;
  }

  view.siegeWallWarnings = feed.siegeWallManager.getWarnings();
}

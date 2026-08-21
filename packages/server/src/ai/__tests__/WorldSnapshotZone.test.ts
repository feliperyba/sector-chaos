import { describe, it, expect } from 'vitest';
import { WorldSnapshot } from '../WorldSnapshot.ts';
import type { EntityMaps } from '../../domain/aggregates/GameMatchEntityOps.ts';
import { syncZoneView } from '../WorldSnapshotZone.ts';
import { updateZoneInfo } from '../BotZoneSafety.ts';
import { createTickBlackboard, type CombatHotspotMemory } from '../TickBlackboard.ts';
import type { BotSystem } from '../BotSystem.ts';
import { ZoneService } from '../../domain/services/ZoneService.ts';
import { SiegeWallManager } from '../../domain/aggregates/SiegeWallManager.ts';
import { MatchStateProjector } from '../../application/services/MatchStateProjector.ts';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { GameSimulation } from '../../application/simulation/GameSimulation.ts';
import type {
  EliminationService,
  MatchFlowService,
  SiegeService,
} from '../../domain/services/index.ts';
import type { MapSiegeService } from '../../domain/services/MapSiegeService.ts';

/**
 * perf-arc ticket 17 — the bot zone feed moved from a constructor closure
 * over the wire MatchStateProjector (one FULL state projection per tick to
 * feed 2 zone fields) into the per-tick WorldSnapshot sync.
 *
 * The tests below pin the migration contract:
 *  1. EQUIVALENCE — for identical zoneService/siegeWallManager state, the
 *     snapshot's zone view carries exactly the values the retired projector
 *     path produced (the byte-identical benchmark gate is the same proof at
 *     match scale; this is the unit-level version).
 *  2. FALLBACK — no feed ⇒ null view ⇒ updateZoneInfo's neutral map-center
 *     ZoneInfo, same as the old null zoneDataGetter.
 *  3. WIRING — syncWorldSnapshot refreshes the view (not just syncZoneView),
 *     and updateZoneInfo consumes the view (warnings mapped, zoneIsLethal
 *     written, shrink detection intact).
 */

const EMPTY_MAPS = {
  players: new Map(),
  projectiles: new Map(),
  powerUps: new Map(),
  traps: new Map(),
  chests: new Map(),
  destructibles: new Map(),
  weaponPickups: new Map(),
  exits: new Map(),
  explosions: new Map(),
  projectileMeta: new Map(),
  tileIndex: {},
} as unknown as EntityMaps;

const HOTSPOT: CombatHotspotMemory = { x: 0, y: 0, tick: -9999 };

/**
 * Deterministic short-phase zone (seeded — same seed ⇒ same center walk):
 * 2s drop, then 4s phases shrinking to 0.7 / 0.5 of the map radius, 2s
 * stable→transition split, 1s warnings. update() clamps each delta to 250ms,
 * so time is driven in 50ms steps. Timeline: 0-2s phase 1; 2-6s phase 2
 * (stable 2-4s, transition 4-6s); 6s+ phase 3.
 */
function createZoneService(): ZoneService {
  const zoneService = new ZoneService();
  zoneService.initialize({ width: 4000, height: 4000 }, 12345);
  zoneService.configure({
    phases: [
      { index: 1, radiusRatio: 1.0, duration: 2, name: 'drop' },
      { index: 2, radiusRatio: 0.7, duration: 4, name: 'shrink-1' },
      { index: 3, radiusRatio: 0.5, duration: 4, name: 'shrink-2' },
    ],
    transitionDuration: 2,
    warningDuration: 1,
  });
  return zoneService;
}

/** The RETIRED read path, verbatim: the projector the room closure used to
 *  call (via orchestrator.getMatchState()). Only its zone-relevant deps are
 *  real — the rest are stubs it touches but bots never read. */
function createProjector(
  zoneService: ZoneService,
  siegeWallManager: SiegeWallManager,
): MatchStateProjector {
  return new MatchStateProjector({
    match: { getState: () => ({ tick: 0, grid: [] }) } as unknown as GameMatch,
    simulation: { lastProcessedInput: 0 } as unknown as GameSimulation,
    matchFlow: { getCurrentState: () => ({ phase: 0 }) } as unknown as MatchFlowService,
    eliminationService: { getEliminations: () => [] } as unknown as EliminationService,
    siegeService: { getSiegedSectors: () => [] } as unknown as SiegeService,
    siegeWallManager,
    mapSiegeService: { getSideProgress: () => [] } as unknown as MapSiegeService,
    zoneService,
  });
}

function driveMs(zoneService: ZoneService, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) zoneService.update(50);
}

describe('WorldSnapshot zone feed (ticket 17)', () => {
  it('view matches the retired projector path field-for-field across phases', () => {
    const zoneService = createZoneService();
    const siegeWallManager = new SiegeWallManager(32, 32);
    const projector = createProjector(zoneService, siegeWallManager);
    const snapshot = new WorldSnapshot(undefined, { zoneService, siegeWallManager });
    snapshot.setMapBounds(4000, 4000);

    // Cumulative sample points spanning: phase 1 (preview null), phase 2
    // stable (preview live), phase 2 mid-transition (interpolated
    // center/radius), phase 3 start (fresh advance).
    let drivenMs = 0;
    for (const sampleMs of [1500, 3000, 4500, 6000]) {
      driveMs(zoneService, sampleMs - drivenMs);
      drivenMs = sampleMs;
      // Warnings grow add-only BETWEEN ticks (mapSiegeService mutates them
      // only after the sim step) — emulate one post-sim-step warning drop.
      siegeWallManager.addWarning(drivenMs, drivenMs, drivenMs + 5000);

      const oldZone = projector.project().zone; // retired path values
      snapshot.sync(EMPTY_MAPS); // new path: per-tick snapshot sync
      const view = snapshot.zone!;

      expect(view.currentPhase).toBe(oldZone.currentPhase);
      expect(view.centerX).toBe(oldZone.centerX);
      expect(view.centerY).toBe(oldZone.centerY);
      expect(view.targetCenterX).toBe(oldZone.targetCenterX);
      expect(view.targetCenterY).toBe(oldZone.targetCenterY);
      expect(view.currentRadius).toBe(oldZone.currentRadius);
      expect(view.targetRadius).toBe(oldZone.targetRadius);
      expect(view.isTransitioningCenter).toBe(oldZone.isTransitioningCenter);
      expect(view.msUntilShrink).toBe(oldZone.msUntilShrink);
      expect(view.nextPhasePreview).toEqual(oldZone.nextPhasePreview);
      expect(view.siegeWallWarnings).toBe(siegeWallManager.getWarnings());
    }

    // The samples actually covered the intended spread.
    expect(snapshot.zone!.currentPhase).toBe(3);
  });

  it('nextPhasePreview is a copied cache, never the live service object', () => {
    const zoneService = createZoneService();
    const siegeWallManager = new SiegeWallManager(32, 32);
    const snapshot = new WorldSnapshot(undefined, { zoneService, siegeWallManager });

    driveMs(zoneService, 3000); // phase 2 → preview exists (phase < 6)
    const preview = zoneService.getNextPhasePreview();
    expect(preview).not.toBeNull();

    snapshot.sync(EMPTY_MAPS);
    const view = snapshot.zone!;
    // Same VALUES, distinct OBJECT (the projector's pc-cache pattern — the
    // view must never alias the service's live preview).
    expect(view.nextPhasePreview).not.toBe(preview);
    expect(view.nextPhasePreview).toEqual({
      centerX: preview!.center.x,
      centerY: preview!.center.y,
      radius: preview!.radius,
    });
  });

  it('no feed ⇒ null view, and syncZoneView is a no-op', () => {
    const snapshot = new WorldSnapshot();
    expect(() => syncZoneView(snapshot)).not.toThrow();
    snapshot.sync(EMPTY_MAPS);
    expect(snapshot.zone).toBeNull();
  });
});

describe('updateZoneInfo via the snapshot view (ticket 17)', () => {
  function systemStub(snapshot: WorldSnapshot): BotSystem {
    return { worldSnapshot: snapshot, mapCenter: { x: 2000, y: 2000 } } as unknown as BotSystem;
  }

  it('fed snapshot mirrors the view into ZoneInfo (lethal gate, warnings, shrink)', () => {
    const zoneService = createZoneService();
    const siegeWallManager = new SiegeWallManager(32, 32);
    siegeWallManager.addWarning(3, 4, 99999);
    const snapshot = new WorldSnapshot(undefined, { zoneService, siegeWallManager });
    snapshot.setMapBounds(4000, 4000);

    driveMs(zoneService, 4500); // phase 2, mid-transition
    snapshot.sync(EMPTY_MAPS);

    const bb = createTickBlackboard(HOTSPOT);
    const info = updateZoneInfo(systemStub(snapshot), bb);
    const view = snapshot.zone!;
    expect(view.currentPhase).toBe(2);

    expect(info.centerX).toBe(view.centerX);
    expect(info.centerY).toBe(view.centerY);
    expect(info.currentPhase).toBe(view.currentPhase);
    expect(info.targetCenterX).toBe(view.targetCenterX);
    expect(info.targetCenterY).toBe(view.targetCenterY);
    expect(info.targetRadius).toBe(view.targetRadius);
    expect(info.msUntilShrink).toBe(view.msUntilShrink);
    expect(info.nextPreview).toEqual(view.nextPhasePreview);
    expect(info.siegeWarnings).toEqual([{ x: 3, y: 4 }]);
    // Phase ≥ 2 ⇒ zone damage is live (the corner-spawn loot gate).
    expect(bb.zoneIsLethal).toBe(true);
    // Mid-transition: the radius is interpolating down toward its target —
    // "shrinking" from the bot's perspective (covers center moves AND
    // radius contraction).
    expect(info.isShrinking).toBe(true);
  });

  it('phase 1 (drop) is not lethal', () => {
    const zoneService = createZoneService();
    const siegeWallManager = new SiegeWallManager(32, 32);
    const snapshot = new WorldSnapshot(undefined, { zoneService, siegeWallManager });

    driveMs(zoneService, 1000); // still phase 1
    snapshot.sync(EMPTY_MAPS);

    const bb = createTickBlackboard(HOTSPOT);
    const info = updateZoneInfo(systemStub(snapshot), bb);
    expect(info.currentPhase).toBe(1);
    expect(bb.zoneIsLethal).toBe(false);
  });

  it('no feed ⇒ neutral map-center ZoneInfo (the retired null-getter fallback)', () => {
    const snapshot = new WorldSnapshot();
    snapshot.sync(EMPTY_MAPS);

    const bb = createTickBlackboard(HOTSPOT);
    const info = updateZoneInfo(systemStub(snapshot), bb);
    expect(info).toEqual({
      centerX: 2000,
      centerY: 2000,
      radius: 0,
      isShrinking: false,
      siegeWarnings: [],
      targetCenterX: 2000,
      targetCenterY: 2000,
      targetRadius: 0,
      nextPreview: null,
      currentPhase: 0,
      msUntilShrink: -1,
    });
    expect(bb.zoneIsLethal).toBe(false);
  });
});

/**
 * MatchStateProjector.ts — Cached projection of the orchestrator's match state.
 *
 * `getMatchState()` is called every tick by the StateMapper. Building the state
 * object fresh each tick allocated several objects (a spread of the entity maps,
 * a fresh zone sub-object, and a conditional next-phase-preview object) for data
 * that is largely identical to the previous tick. StateMapper reads the fields
 * once per tick and projects them to the Colyseus schema in place — it never
 * retains the reference — so a single cached object mutated in place is safe.
 *
 * This class owns that cache (the top-level state object, the zone sub-object,
 * and the next-phase-preview sub-object) and mutates their fields each tick.
 */
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type { GameSimulation } from '../simulation/GameSimulation.ts';
import type { EliminationService, SiegeService, ZoneService } from '../../domain/services/index.ts';
import type { SiegeWallManager } from '../../domain/aggregates/SiegeWallManager.ts';
import type { MapSiegeService } from '../../domain/services/MapSiegeService.ts';
import type { MatchFlowService } from '../../domain/services/MatchFlowService.ts';

/** Dependencies the projector reads from each tick. */
export interface MatchStateProjectorDeps {
  match: GameMatch;
  simulation: GameSimulation;
  matchFlow: MatchFlowService;
  eliminationService: EliminationService;
  siegeService: SiegeService;
  siegeWallManager: SiegeWallManager;
  mapSiegeService: MapSiegeService;
  zoneService: ZoneService;
}

export interface ZoneCache {
  currentPhase: number;
  centerX: number;
  centerY: number;
  targetCenterX: number;
  targetCenterY: number;
  isTransitioningCenter: boolean;
  currentRadius: number;
  targetRadius: number;
  shrinkSpeed: number;
  damagePerTick: number;
  nextShrinkTick: number;
  phaseStartTime: number;
  phaseEndTime: number;
  /**
   * Ms until the current/first radius transition begins (bot-ai-v2 ticket
   * 07, DEC-008): read-only zone surfacing for the bot macro-goal layer —
   * carried from ZoneService.getMsUntilShrink (accumulated-delta derived,
   * wall-clock-free). −1 when the zone data getter is absent.
   */
  msUntilShrink: number;
  nextPhasePreview: { centerX: number; centerY: number; radius: number } | null;
}

export class MatchStateProjector {
  private readonly deps: MatchStateProjectorDeps;
  private state: ReturnType<MatchStateProjector['buildState']> | null = null;
  private readonly zoneCache: ZoneCache = {
    currentPhase: 0,
    centerX: 0,
    centerY: 0,
    targetCenterX: 0,
    targetCenterY: 0,
    isTransitioningCenter: false,
    currentRadius: 0,
    targetRadius: 0,
    shrinkSpeed: 0,
    damagePerTick: 0,
    nextShrinkTick: 0,
    phaseStartTime: 0,
    phaseEndTime: 0,
    msUntilShrink: -1,
    nextPhasePreview: null,
  };
  private readonly nextPhasePreviewCache = { centerX: 0, centerY: 0, radius: 0 };

  constructor(deps: MatchStateProjectorDeps) {
    this.deps = deps;
  }

  /** Build the cached state object once from the stable map references. */
  private buildState() {
    const base = this.deps.match.getState();
    return {
      players: base.players,
      projectiles: base.projectiles,
      powerUps: base.powerUps,
      traps: base.traps,
      chests: base.chests,
      destructibles: base.destructibles,
      exits: base.exits,
      explosions: base.explosions,
      weaponPickups: base.weaponPickups,
      projectileMeta: base.projectileMeta,
      destructibleVersion: 0,
      exitVersion: 0,
      tick: 0,
      phase: 0,
      zone: this.zoneCache,
      grid: base.grid,
      matchTime: 0,
      lastProcessedInput: 0,
      eliminations: this.deps.eliminationService.getEliminations(),
      siegedSectors: this.deps.siegeService.getSiegedSectors(),
      siegeWallWarnings: this.deps.siegeWallManager.getWarnings(),
      mapSiegeProgress: this.deps.mapSiegeService.getSideProgress(),
    };
  }

  /** Return the cached match state, mutating scalar fields in place. */
  project() {
    const state = this.state ?? (this.state = this.buildState());
    const base = this.deps.match.getState();

    state.tick = base.tick;
    state.phase = this.deps.matchFlow.getCurrentState().phase;
    state.grid = base.grid;
    state.matchTime = base.matchTime;
    state.destructibleVersion = base.destructibleVersion;
    state.exitVersion = base.exitVersion;
    state.lastProcessedInput = this.deps.simulation.lastProcessedInput;
    state.eliminations = this.deps.eliminationService.getEliminations();
    state.siegedSectors = this.deps.siegeService.getSiegedSectors();
    state.siegeWallWarnings = this.deps.siegeWallManager.getWarnings();
    state.mapSiegeProgress = this.deps.mapSiegeService.getSideProgress();

    const zoneData = this.deps.zoneService.getCurrentZone();
    const z = this.zoneCache;
    z.currentPhase = zoneData.phase;
    z.centerX = zoneData.centerX;
    z.centerY = zoneData.centerY;
    z.targetCenterX = zoneData.targetCenterX;
    z.targetCenterY = zoneData.targetCenterY;
    z.isTransitioningCenter = zoneData.isTransitioningCenter;
    z.currentRadius = zoneData.currentRadius;
    z.targetRadius = zoneData.targetRadius;
    z.phaseStartTime = zoneData.phaseStartTime;
    z.phaseEndTime = zoneData.phaseEndTime;
    z.msUntilShrink = zoneData.msUntilShrink;

    const preview = this.deps.zoneService.getNextPhasePreview();
    if (preview) {
      const pc = this.nextPhasePreviewCache;
      pc.centerX = preview.center.x;
      pc.centerY = preview.center.y;
      pc.radius = preview.radius;
      z.nextPhasePreview = pc;
    } else {
      z.nextPhasePreview = null;
    }
    return state;
  }
}

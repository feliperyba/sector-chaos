import { ZONE, SeededRNG, TileType, type ZonePhase } from '@sector-battle/shared';
import { Interpolation } from '@sector-battle/shared';
import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';
import { logger } from '@sector-battle/shared';
import { selectBiasedFinalCenter, selectNextCenter } from './ZoneServiceCenterSelection.ts';

const DEFAULT_TRANSITION_DURATION_MS = ZONE.ZONE_TRANSITION_DURATION * 1000;
const DEFAULT_WARNING_DURATION_MS = ZONE.ZONE_WARNING_TIME * 1000;
const ZONE_PHASE_SEED_MULTIPLIER = 7;

/**
 * The final phase that selects a NEW zone center (map-redesign ticket 09 /
 * DEC-008). Phase 7 (overtime/sudden death) freezes the center at the phase 6
 * target per GDD §8.1.1, so the phase 5→6 advance is the last center
 * selection — the one the landmark bias applies to (Marcus's dissent
 * resolution: bias applies to the FINAL phase only). The selection
 * algorithms themselves live in ZoneServiceCenterSelection (partial).
 */
const FINAL_CENTER_PHASE = 6;

export interface ZoneData {
  centerX: number;
  centerY: number;
  targetCenterX: number;
  targetCenterY: number;
  isTransitioningCenter: boolean;
  isWarning: boolean;
  currentRadius: number;
  targetRadius: number;
  phase: number;
  phaseStartTime: number;
  phaseEndTime: number;
  /**
   * Milliseconds until the current (or first) radius TRANSITION begins
   * (bot-ai-v2 ticket 07, DEC-008): 0 once the transition is underway or in
   * sudden death. READ-ONLY surfacing for the bot macro-goal rotation model
   * — derived from the accumulated phaseElapsedMs (update(deltaMs) input),
   * NEVER from Date.now(), so the benchmark's virtual-clock determinism
   * contract holds. No gameplay rule consumes this value.
   */
  msUntilShrink: number;
}

export class ZoneService {
  private zoneCenter: { x: number; y: number } = { x: 0, y: 0 };
  private targetCenter: { x: number; y: number } = { x: 0, y: 0 };
  private startCenter: { x: number; y: number } = { x: 0, y: 0 };
  private mapBounds: { width: number; height: number } = { width: 0, height: 0 };
  private fullMapRadius: number = 0;
  private currentRadius: number = 0;
  private targetRadius: number = 0;
  private startRadius: number = 0;
  private phase: number = 1;
  private phaseElapsedMs: number = 0;
  private phaseStartTime: number = 0;
  private initialized: boolean = false;
  private eventCollector = new EventCollector<GameEvent>();
  private rngSeed: number = 0;
  private rng: SeededRNG = new SeededRNG(1);
  private centerTransitioning: boolean = false;
  private warningFiredForPhase: number = 0;
  private nextPhasePreview: { center: { x: number; y: number }; radius: number } | null = null;
  private grid: TileType[][] | null = null;
  private tickAccumulator: number = 0;
  private customPhases: ZonePhase[] | null = null;
  private transitionDurationMs: number = DEFAULT_TRANSITION_DURATION_MS;
  private warningDurationMs: number = DEFAULT_WARNING_DURATION_MS;
  private suddenDeathDamageOverride: number = 0;
  private suddenDeathShrinkMultiplier: number = 0;
  private suddenDeathShrinkSpeed: number = 0;
  /**
   * Landmark-bias anchors (world px) for the final-phase center selection
   * (map-redesign ticket 09 / DEC-008.2): hero-POI + compound positions from
   * the shared MapData. Empty (default) = bias off — the zone keeps the plain
   * per-phase random walk, byte-identical to the pre-ticket behavior.
   */
  private landmarkBiasAnchors: ReadonlyArray<{ x: number; y: number }> = [];

  initialize(mapBounds: { width: number; height: number }, seed: number): void {
    this.mapBounds = { ...mapBounds };
    this.fullMapRadius = mapBounds.width / 2;
    this.rngSeed = seed;
    this.rng = new SeededRNG(seed);

    this.zoneCenter = {
      x: mapBounds.width / 2,
      y: mapBounds.height / 2,
    };
    this.targetCenter = { x: this.zoneCenter.x, y: this.zoneCenter.y };
    this.startCenter = { x: this.zoneCenter.x, y: this.zoneCenter.y };

    this.phase = 1;
    this.currentRadius = this.fullMapRadius;
    this.targetRadius = this.fullMapRadius;
    this.startRadius = this.fullMapRadius;
    this.phaseElapsedMs = 0;
    this.phaseStartTime = Date.now();
    this.centerTransitioning = false;
    this.warningFiredForPhase = 0;
    this.nextPhasePreview = null;
    this.initialized = true;
  }

  setGrid(grid: TileType[][]): void {
    this.grid = grid;
  }

  /**
   * Provide the landmark-bias anchors (world px) for the final-phase center
   * selection (map-redesign ticket 09 / DEC-008.2). Server-authoritative: the
   * caller (GameOrchestratorInit) derives them from the shared MapData
   * (`collectZoneBiasAnchors`); an empty array leaves the zone unbiased.
   */
  setLandmarkBias(anchors: ReadonlyArray<{ x: number; y: number }>): void {
    this.landmarkBiasAnchors = anchors;
  }

  configure(config: {
    phases?: ZonePhase[];
    transitionDuration?: number;
    warningDuration?: number;
  }): void {
    if (config.phases) {
      this.customPhases = [...config.phases];
    }
    if (config.transitionDuration !== undefined) {
      this.transitionDurationMs = config.transitionDuration * 1000;
    }
    if (config.warningDuration !== undefined) {
      this.warningDurationMs = config.warningDuration * 1000;
    }
  }

  setSuddenDeathModifiers(
    damagePerTick: number,
    shrinkMultiplier: number,
    shrinkSpeed: number,
  ): void {
    this.suddenDeathDamageOverride = damagePerTick;
    this.suddenDeathShrinkMultiplier = shrinkMultiplier;
    this.suddenDeathShrinkSpeed = shrinkSpeed;
  }

  update(deltaMs: number): void {
    try {
      if (!this.initialized) return;
      if (deltaMs <= 0) return;

      this.phaseElapsedMs += Math.min(deltaMs, 250);

      const phaseDurationMs = this.getPhaseDuration(this.phase);

      if (this.phase === 7) {
        this.currentRadius = this.targetRadius;
        this.zoneCenter = { x: this.targetCenter.x, y: this.targetCenter.y };
        this.centerTransitioning = false;
        return;
      }

      if (this.phase === 1) {
        if (phaseDurationMs > 0 && this.phaseElapsedMs >= phaseDurationMs) {
          this.advancePhase();
          return;
        }
        this.currentRadius = this.fullMapRadius;
        this.targetRadius = this.fullMapRadius;
        this.zoneCenter = { x: this.targetCenter.x, y: this.targetCenter.y };
        this.centerTransitioning = false;
        return;
      }

      if (phaseDurationMs > 0 && this.phaseElapsedMs >= phaseDurationMs) {
        this.advancePhase();
      }

      this.checkWarning();

      const stableDurationMs = this.getStableDurationMs(this.phase);

      if (this.phaseElapsedMs < stableDurationMs) {
        this.currentRadius = this.startRadius;
        this.zoneCenter = { x: this.startCenter.x, y: this.startCenter.y };
        this.centerTransitioning = false;
      } else if (this.phaseElapsedMs < phaseDurationMs) {
        const transitionElapsed = this.phaseElapsedMs - stableDurationMs;
        const t = Math.max(0, Math.min(1, transitionElapsed / this.transitionDurationMs));
        this.currentRadius = Interpolation.lerp(this.startRadius, this.targetRadius, t);
        this.zoneCenter = {
          x: Interpolation.lerp(this.startCenter.x, this.targetCenter.x, t),
          y: Interpolation.lerp(this.startCenter.y, this.targetCenter.y, t),
        };
        this.centerTransitioning =
          this.startCenter.x !== this.targetCenter.x || this.startCenter.y !== this.targetCenter.y;
      } else {
        this.currentRadius = this.targetRadius;
        this.zoneCenter = { x: this.targetCenter.x, y: this.targetCenter.y };
        this.centerTransitioning = false;
      }

      if (isNaN(this.currentRadius)) {
        this.currentRadius = this.startRadius;
      }

      this.currentRadius = Math.max(0, this.currentRadius);
    } catch (err) {
      logger.error('update failed', err);
    }
  }

  advancePhase(): void {
    if (this.phase >= 7) return;

    const previousPhase = this.phase;
    this.phase += 1;
    this.rng = new SeededRNG(this.rngSeed + this.phase * ZONE_PHASE_SEED_MULTIPLIER);
    this.startRadius = this.targetRadius;
    this.startCenter = { x: this.targetCenter.x, y: this.targetCenter.y };
    this.targetRadius = this.getTargetRadiusForPhase(this.phase);

    if (this.phase === 7) {
      this.targetCenter = { x: this.startCenter.x, y: this.startCenter.y };
    } else if (this.phase === FINAL_CENTER_PHASE && this.landmarkBiasAnchors.length > 0) {
      // Final-phase landmark bias (ticket 09 / DEC-008.2): score candidates by
      // proximity to hero-POI/compound anchors and pick weighted-random — the
      // finale is DRAWN TOWARD structured ground without being forced onto it.
      this.targetCenter = selectBiasedFinalCenter(
        this.rng,
        this.landmarkBiasAnchors,
        this.grid,
        this.startCenter,
        this.startRadius,
        this.targetRadius,
        this.mapBounds,
      );
    } else {
      this.targetCenter = selectNextCenter(
        this.rng,
        this.grid,
        this.startCenter,
        this.startRadius,
        this.targetRadius,
        this.mapBounds,
      );
    }

    this.nextPhasePreview =
      this.phase < 6
        ? { center: { x: this.targetCenter.x, y: this.targetCenter.y }, radius: this.targetRadius }
        : null;

    this.phaseElapsedMs = 0;
    this.phaseStartTime = Date.now();

    this.eventCollector.emit({
      type: 'ZonePhaseChanged',
      tick: 0,
      timestamp: Date.now(),
      previousPhase,
      newPhase: this.phase,
      currentRadius: this.currentRadius,
      targetRadius: this.targetRadius,
    });
  }

  isWarning(): boolean {
    if (this.phase === 1) return false;
    if (this.phase >= 7) return false;
    const stableDurationMs = this.getStableDurationMs(this.phase);
    const warningTriggerMs = stableDurationMs - this.warningDurationMs;
    return this.phaseElapsedMs >= warningTriggerMs;
  }

  getNextPhasePreview(): { center: { x: number; y: number }; radius: number } | null {
    if (this.phase === 1) return null;
    if (this.phase >= 6) return null;
    return this.nextPhasePreview;
  }

  private checkWarning(): void {
    if (this.phase >= 7) return;
    if (this.warningFiredForPhase === this.phase) return;
    if (!this.isWarning()) return;

    this.warningFiredForPhase = this.phase;

    const stableDurationMs = this.getStableDurationMs(this.phase);
    const transitionStartsInMs = Math.max(0, stableDurationMs - this.phaseElapsedMs);

    this.eventCollector.emit({
      type: 'ZoneWarning',
      tick: 0,
      timestamp: Date.now(),
      nextPhaseIndex: this.phase + 1,
      nextCenterX: this.targetCenter.x,
      nextCenterY: this.targetCenter.y,
      nextRadius: this.targetRadius,
      transitionStartsInMs,
    });
  }

  private getStableDurationMs(phase: number): number {
    return this.getPhaseDuration(phase) - this.transitionDurationMs;
  }

  drainEvents(): GameEvent[] {
    return this.eventCollector.drain();
  }

  getCurrentZone(): ZoneData {
    const phaseDuration = this.getPhaseDuration(this.phase);
    return {
      centerX: this.zoneCenter.x,
      centerY: this.zoneCenter.y,
      targetCenterX: this.targetCenter.x,
      targetCenterY: this.targetCenter.y,
      isTransitioningCenter: this.centerTransitioning,
      isWarning: this.isWarning(),
      currentRadius: this.currentRadius,
      targetRadius: this.targetRadius,
      phase: this.phase,
      phaseStartTime: this.phaseStartTime,
      phaseEndTime: this.phaseStartTime + phaseDuration,
      msUntilShrink: this.getMsUntilShrink(),
    };
  }

  /**
   * Ms until the current (or first) radius transition begins — the bot
   * rotation clock (bot-ai-v2 ticket 07, DEC-008). Read-only; derived purely
   * from phaseElapsedMs (the accumulated update() deltas — the benchmark
   * virtual clock drives them, so this is deterministic; phaseStartTime's
   * Date.now() is deliberately NOT used here).
   *  - Phase 1 (drop, never shrinks): remaining drop time + phase 2's stable
   *    window = time until the FIRST shrink.
   *  - Phases 2-6: remaining stable-window time (0 once transitioning).
   *  - Phase 7 (sudden death): 0 — the continuous shrink is always on.
   */
  getMsUntilShrink(): number {
    if (this.phase >= 7) return 0;
    const stable = this.getStableDurationMs(this.phase);
    if (this.phase === 1) {
      const dropRemaining = Math.max(0, this.getPhaseDuration(1) - this.phaseElapsedMs);
      return dropRemaining + this.getStableDurationMs(2);
    }
    return Math.max(0, stable - this.phaseElapsedMs);
  }

  isInZone(x: number, y: number): boolean {
    if (this.currentRadius <= 0) return false;
    const dx = x - this.zoneCenter.x;
    const dy = y - this.zoneCenter.y;
    return Math.sqrt(dx * dx + dy * dy) <= this.currentRadius;
  }

  isOvertime(): boolean {
    return this.phase >= 7;
  }

  getSiegeInterval(): number {
    return this.phase >= 7
      ? ZONE.SIEGE_WALL_DROP_INTERVAL_OT * 1000
      : ZONE.SIEGE_WALL_DROP_INTERVAL * 1000;
  }

  shouldTick(deltaMs: number): boolean {
    if (deltaMs <= 0) return false;
    this.tickAccumulator += deltaMs;
    if (this.tickAccumulator >= ZONE.ZONE_TICK_INTERVAL_MS) {
      this.tickAccumulator -= ZONE.ZONE_TICK_INTERVAL_MS;
      return true;
    }
    return false;
  }

  getTickDamage(): number {
    if (this.phase === 1) return 0;
    if (this.phase >= 7) return ZONE.ZONE_DAMAGE_SUDDEN_DEATH;
    if (this.phase >= 6) return ZONE.ZONE_DAMAGE_SUDDEN_DEATH;
    return ZONE.ZONE_DAMAGE_PER_TICK;
  }

  getPhaseDuration(phase: number): number {
    const phases = this.customPhases ?? ZONE.PHASES;
    const phaseConfig = phases.find((p) => p.index === phase);
    return (phaseConfig?.duration ?? 0) * 1000;
  }

  private getTargetRadiusForPhase(phase: number): number {
    const phases = this.customPhases ?? ZONE.PHASES;
    const phaseConfig = phases.find((p) => p.index === phase);
    if (!phaseConfig) return 0;
    return this.fullMapRadius * phaseConfig.radiusRatio;
  }
}

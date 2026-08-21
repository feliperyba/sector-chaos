/**
 * Phase transition logic for GameOrchestrator.
 * Extracted for single-responsibility — handles match phase state machine,
 * overtime activation, match end detection, and sudden death updates.
 */
import {
  MatchPhase,
  MatchPhaseStateMachine,
  NETWORK,
  type PhaseEventType,
} from '@sector-battle/shared';
import type { GameEvent } from '../../domain/events/index.ts';
import type { GameMatch } from '../../domain/aggregates/GameMatch.ts';
import type {
  MatchFlowService,
  EliminationService,
  MatchEndService,
  SuddenDeathService,
  ZoneService,
  PlayerRoundStats,
} from '../../domain/services/index.ts';

export interface PhaseContext {
  match: GameMatch;
  matchFlow: MatchFlowService;
  eliminationService: EliminationService;
  matchEndService: MatchEndService;
  suddenDeathService: SuddenDeathService;
  zoneService: ZoneService;
  matchEndedEmitted: boolean;
  /** Alive count at/below which the match ends (1 = real battle-royale, 0 = Test Scene). */
  lastStandingThreshold: number;
}

export interface PhaseResult {
  events: GameEvent[];
  newPhase: MatchPhase;
  matchEndedEmitted: boolean;
}

const phaseStateMachine = new MatchPhaseStateMachine();

/**
 * Runs one tick of phase transition logic.
 * Returns new events, the updated phase, and the matchEndedEmitted flag.
 */
export function tickPhaseTransitions(ctx: PhaseContext): PhaseResult {
  const events: GameEvent[] = [];
  const aliveCount = ctx.matchFlow.getAlivePlayerCount();
  const previousPhase = ctx.matchFlow.getCurrentState().phase;
  ctx.matchFlow.update(NETWORK.TICK_INTERVAL);
  events.push(...ctx.matchFlow.drainEvents());
  const currentPhase = ctx.matchFlow.getCurrentState().phase;

  if (previousPhase !== currentPhase) {
    ctx.match.setPhase(currentPhase);
  }

  if (previousPhase === MatchPhase.COUNTDOWN && currentPhase === MatchPhase.ACTIVE) {
    handleMatchStart(ctx.match, ctx.matchFlow, events);
  }

  const result = phaseStateMachine.tick(currentPhase, {
    aliveCount,
    elapsedMs: ctx.matchFlow.getCurrentState().elapsedMs,
    isZoneOvertime: ctx.zoneService.isOvertime(),
    lastStandingThreshold: ctx.lastStandingThreshold,
  });
  if (result.newPhase !== currentPhase) {
    applyPhaseTransition(ctx, events, result.newPhase, result.events);
  }

  updateSuddenDeath(ctx.suddenDeathService, ctx.zoneService, events);

  // Final sync: ensure match.phase reflects any transitions from phaseStateMachine
  const finalPhase = ctx.matchFlow.getCurrentState().phase;
  if (finalPhase !== currentPhase) {
    ctx.match.setPhase(finalPhase);
  }

  return {
    events,
    newPhase: finalPhase,
    matchEndedEmitted: ctx.matchEndedEmitted,
  };
}

function handleMatchStart(
  match: GameMatch,
  matchFlow: MatchFlowService,
  events: GameEvent[],
): void {
  const currentTick = match.currentTick;
  for (const playerId of matchFlow.getPlayerIds()) {
    const player = match.getPlayer(playerId);
    if (player) player.revive(currentTick);
  }
  events.push({
    type: 'MatchStarted',
    tick: currentTick,
    timestamp: Date.now(),
    mapSeed: match.mapSeed,
    playerCount: match.alivePlayerCount,
  });
}

function applyPhaseTransition(
  ctx: PhaseContext,
  events: GameEvent[],
  newPhase: MatchPhase,
  transitionEvents: PhaseEventType[],
): void {
  if (transitionEvents.includes('check_match_end')) {
    tryEndMatch(ctx, events);
  } else if (transitionEvents.includes('activate_overtime')) {
    activateOvertime(ctx, events);
  } else {
    ctx.matchFlow.transitionTo(newPhase);
  }
}

function tryEndMatch(ctx: PhaseContext, events: GameEvent[]): void {
  if (ctx.matchEndedEmitted) return;
  const phaseElapsedMs = ctx.matchFlow.getPhaseElapsedMs();
  const alivePlayerStats: PlayerRoundStats[] = [];
  ctx.match.forEachAlivePlayer((p) => {
    alivePlayerStats.push({
      playerId: p.id,
      alive: p.isActive,
      hp: p.health.current,
      kills: p.kills,
      damageDealt: p.damageDealt,
      damageTaken: p.damageTaken,
      itemsCollected: p.itemsCollected,
      survivalTimeMs: p.getSurvivalTimeMs(
        p.statusEffects.deathTick > 0 ? p.statusEffects.deathTick : ctx.match.currentTick,
        60,
      ),
      weaponsUsed: p.combat.weaponsUsedCount,
    });
  });
  const suddenDeathState = ctx.suddenDeathService.getState();
  const result = ctx.matchEndService.checkRoundEnd(
    alivePlayerStats,
    ctx.eliminationService.getEliminations(),
    ctx.eliminationService.getDeadPlayerStats(),
    phaseElapsedMs,
    suddenDeathState.elapsedMs,
    ctx.lastStandingThreshold,
  );
  if (result) {
    ctx.matchEndedEmitted = true;
    events.push({
      type: 'MatchEnded',
      tick: ctx.match.currentTick,
      timestamp: Date.now(),
      winnerId: result.winnerId,
      placements: result.placements,
    });
    ctx.matchFlow.transitionTo(MatchPhase.FINISHED);
  }
}

function activateOvertime(ctx: PhaseContext, events: GameEvent[]): void {
  ctx.matchFlow.transitionTo(MatchPhase.OVERTIME);
  const aliveIds: string[] = [];
  ctx.match.forEachAlivePlayer((p) => {
    aliveIds.push(p.id);
  });
  ctx.suddenDeathService.activate(Date.now(), aliveIds);
  ctx.zoneService.setSuddenDeathModifiers(
    ctx.suddenDeathService.getDamagePerTick(),
    ctx.suddenDeathService.getShrinkRateMultiplier(),
    ctx.suddenDeathService.getShrinkSpeed(),
  );
  events.push(...ctx.suddenDeathService.drainEvents());
}

function updateSuddenDeath(
  suddenDeathService: SuddenDeathService,
  zoneService: ZoneService,
  events: GameEvent[],
): void {
  suddenDeathService.update(NETWORK.TICK_INTERVAL);
  if (suddenDeathService.getState().active) {
    zoneService.setSuddenDeathModifiers(
      suddenDeathService.getDamagePerTick(),
      suddenDeathService.getShrinkRateMultiplier(),
      suddenDeathService.getShrinkSpeed(),
    );
  }
  events.push(...suddenDeathService.drainEvents());
}

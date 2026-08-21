import { MATCH, MatchPhase } from '@sector-battle/shared';
import type { GameEvent } from '../events/index.ts';
import { EventCollector } from '../shared/EventCollector.ts';
import type { MatchPhaseChangedEvent } from '../events/MatchPhaseChanged.ts';
import type { SpawnService } from './SpawnService.ts';

const COUNTDOWN_DURATION = MATCH.COUNTDOWN_DURATION * 1000;

const VALID_TRANSITIONS: Map<MatchPhase, MatchPhase[]> = new Map([
  [MatchPhase.WAITING, [MatchPhase.COUNTDOWN]],
  [MatchPhase.COUNTDOWN, [MatchPhase.ACTIVE]],
  [MatchPhase.ACTIVE, [MatchPhase.ZONE_SHRINKING, MatchPhase.FINISHED]],
  [MatchPhase.ZONE_SHRINKING, [MatchPhase.FINAL_CLOSURE, MatchPhase.FINISHED]],
  [MatchPhase.FINAL_CLOSURE, [MatchPhase.OVERTIME, MatchPhase.FINISHED]],
  [MatchPhase.OVERTIME, [MatchPhase.FINISHED]],
  [MatchPhase.FINISHED, []],
]);

export class MatchFlowService {
  private phase: MatchPhase = MatchPhase.WAITING;
  private elapsedMs: number = 0;
  private phaseElapsedMs: number = 0;
  private playerIds: string[] = [];
  private eventCollector = new EventCollector<GameEvent>();
  private alivePlayerIds: Set<string> = new Set();

  startMatch(playerIds: string[], spawnService: SpawnService): void {
    if (this.phase !== MatchPhase.WAITING) {
      throw new Error(`Cannot start match from phase ${MatchPhase[this.phase]}`);
    }

    this.playerIds = [...playerIds];
    this.alivePlayerIds = new Set(playerIds);
    this.eventCollector.clear();
    spawnService.assignSpawnPoints(playerIds);

    this.transitionTo(MatchPhase.COUNTDOWN);
  }

  update(deltaMs: number): void {
    this.elapsedMs += deltaMs;
    this.phaseElapsedMs += deltaMs;

    if (this.phase === MatchPhase.COUNTDOWN && this.phaseElapsedMs >= COUNTDOWN_DURATION) {
      this.transitionTo(MatchPhase.ACTIVE);
    }
  }

  getCurrentState(): {
    phase: MatchPhase;
    elapsedMs: number;
  } {
    return {
      phase: this.phase,
      elapsedMs: this.elapsedMs,
    };
  }

  transitionTo(newState: MatchPhase): void {
    const allowed = VALID_TRANSITIONS.get(this.phase);
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(
        `Invalid phase transition from ${MatchPhase[this.phase]} to ${MatchPhase[newState]}`,
      );
    }

    const event: MatchPhaseChangedEvent = {
      type: 'MatchPhaseChanged',
      tick: Math.floor(this.elapsedMs / 50),
      timestamp: Date.now(),
      from: this.phase,
      to: newState,
    };
    this.eventCollector.emit(event);

    this.phase = newState;
    this.phaseElapsedMs = 0;
  }

  isInputAllowed(): boolean {
    return (
      this.phase === MatchPhase.ACTIVE ||
      this.phase === MatchPhase.ZONE_SHRINKING ||
      this.phase === MatchPhase.FINAL_CLOSURE ||
      this.phase === MatchPhase.OVERTIME
    );
  }

  drainEvents(): GameEvent[] {
    return this.eventCollector.drain();
  }

  getAlivePlayerIds(): Set<string> {
    return new Set(this.alivePlayerIds);
  }

  /** Size of the alive set without materializing the defensive copy
   *  (hot per-tick phases path — GameOrchestratorPhases reads only the count). */
  getAlivePlayerCount(): number {
    return this.alivePlayerIds.size;
  }

  markPlayerDead(playerId: string): void {
    this.alivePlayerIds.delete(playerId);
  }

  addLatePlayer(playerId: string): void {
    this.playerIds.push(playerId);
    this.alivePlayerIds.add(playerId);
  }

  getPhaseElapsedMs(): number {
    return this.phaseElapsedMs;
  }

  getPlayerIds(): string[] {
    return [...this.playerIds];
  }

  forceFinish(): void {
    this.phase = MatchPhase.FINISHED;
    this.phaseElapsedMs = 0;
  }
}

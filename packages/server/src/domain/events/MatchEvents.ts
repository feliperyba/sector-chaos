import type { DomainEvent } from './DomainEvent.ts';
import type { PlacementData } from '../services/MatchEndService.ts';

export interface SuddenDeathTriggeredEvent extends DomainEvent {
  type: 'SuddenDeathTriggered';
  timestamp: number;
  remainingPlayers: string[];
}

export interface MatchStartedEvent extends DomainEvent {
  type: 'MatchStarted';
  mapSeed: number;
  playerCount: number;
}

export interface MatchEndedEvent extends DomainEvent {
  type: 'MatchEnded';
  winnerId: string;
  placements: PlacementData[];
}

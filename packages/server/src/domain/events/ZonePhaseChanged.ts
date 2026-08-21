import type { DomainEvent } from './DomainEvent.ts';

export interface ZonePhaseChangedEvent extends DomainEvent {
  type: 'ZonePhaseChanged';
  previousPhase: number;
  newPhase: number;
  currentRadius: number;
  targetRadius: number;
}

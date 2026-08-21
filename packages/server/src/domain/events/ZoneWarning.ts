import type { DomainEvent } from './DomainEvent.ts';

export interface ZoneWarningEvent extends DomainEvent {
  type: 'ZoneWarning';
  nextPhaseIndex: number;
  nextCenterX: number;
  nextCenterY: number;
  nextRadius: number;
  transitionStartsInMs: number;
}

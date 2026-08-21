import type { DomainEvent } from './DomainEvent.ts';

export interface SiegeWallWarningEvent extends DomainEvent {
  type: 'SiegeWallWarning';
  gridX: number;
  gridY: number;
  solidifyAt: number;
}

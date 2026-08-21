import type { DomainEvent } from './DomainEvent.ts';

export interface SectorSiegeStartedEvent extends DomainEvent {
  type: 'SectorSiegeStarted';
  sectorRow: number;
  sectorCol: number;
}

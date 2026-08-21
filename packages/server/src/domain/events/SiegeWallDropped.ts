import type { DomainEvent } from './DomainEvent.ts';

export interface SiegeWallDroppedEvent extends DomainEvent {
  type: 'SiegeWallDropped';
  gridX: number;
  gridY: number;
  sectorRow: number;
  sectorCol: number;
  ring: number;
  tileIndex: number;
  audible: boolean;
}

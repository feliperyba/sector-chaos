import type { DomainEvent } from './DomainEvent.ts';

export interface SpectatingTransitionEvent extends DomainEvent {
  type: 'SpectatingTransition';
  playerId: string;
  killerId: string | null;
  cameraZoomFactor: number;
  cameraZoomDuration: number;
}

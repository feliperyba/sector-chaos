import type { DomainEvent } from './DomainEvent.ts';

export interface PowerUpEffectExpiredEvent extends DomainEvent {
  type: 'PowerUpEffectExpired';
  playerId: string;
  effectType: string;
}

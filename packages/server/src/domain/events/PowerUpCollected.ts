import type { DomainEvent } from './DomainEvent.ts';
import { PowerUpType } from '@sector-battle/shared';

export interface PowerUpCollectedEvent extends DomainEvent {
  type: 'PowerUpCollected';
  playerId: string;
  powerUpId: string;
  powerUpType: PowerUpType;
}

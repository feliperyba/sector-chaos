import type { DomainEvent } from './DomainEvent.ts';
import { ChestRarity } from '@sector-battle/shared';

export interface ChestOpenedEvent extends DomainEvent {
  type: 'ChestOpened';
  chestId: string;
  playerId: string;
  tier: ChestRarity;
  lootContents: unknown;
}

export interface ChestRejectedEvent extends DomainEvent {
  type: 'ChestRejected';
  chestId: string;
  playerId: string;
  reason: string;
}

export interface ChestOpeningInterruptedEvent extends DomainEvent {
  type: 'ChestOpeningInterrupted';
  chestId: string;
  playerId: string;
}

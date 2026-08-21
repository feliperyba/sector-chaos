import type { DomainEvent } from './DomainEvent.ts';
import { TrapType } from '@sector-battle/shared';
import type { TrapEffect } from '../entities/Trap.ts';

export interface TrapTriggeredEvent extends DomainEvent {
  type: 'TrapTriggered';
  trapId: string;
  trapType: TrapType;
  targetId: string;
  effects: TrapEffect[];
}

export interface TrapCooldownExpiredEvent extends DomainEvent {
  type: 'TrapCooldownExpired';
  trapId: string;
}

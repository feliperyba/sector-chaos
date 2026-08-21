import type { DomainEvent } from './DomainEvent.ts';

export interface SuddenDeathEscalationEvent extends DomainEvent {
  type: 'SuddenDeathEscalation';
  level: number;
  damagePerTick: number;
  shrinkRateMultiplier: number;
}

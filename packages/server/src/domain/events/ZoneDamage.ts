import type { DomainEvent } from './DomainEvent.ts';

export interface ZoneDamageEvent extends DomainEvent {
  type: 'ZoneDamage';
  playersDamaged: { playerId: string; damage: number }[];
}

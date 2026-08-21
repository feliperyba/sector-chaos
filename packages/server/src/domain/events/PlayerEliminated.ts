import type { DomainEvent } from './DomainEvent.ts';
import { WeaponType } from '@sector-battle/shared';

export interface PlayerEliminatedEvent extends DomainEvent {
  type: 'PlayerEliminated';
  playerId: string;
  playerName: string;
  killedBy: string;
  killerName: string;
  placement: number;
  weapon: WeaponType;
  x: number;
  y: number;
  cause: string;
}

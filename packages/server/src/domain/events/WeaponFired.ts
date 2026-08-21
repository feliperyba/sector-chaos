import type { DomainEvent } from './DomainEvent.ts';
import { AttackType, WeaponType } from '@sector-battle/shared';

export interface WeaponFiredEvent extends DomainEvent {
  type: 'WeaponFired';
  playerId: string;
  weaponType: WeaponType;
  attackType: AttackType;
  direction: number;
  x: number;
  y: number;
}

import type { DomainEvent } from './DomainEvent.ts';
import { WeaponType } from '@sector-battle/shared';

export interface WeaponBrokenEvent extends DomainEvent {
  type: 'WeaponBroken';
  playerId: string;
  weaponType: WeaponType;
  slotIndex: number;
  x: number;
  y: number;
}

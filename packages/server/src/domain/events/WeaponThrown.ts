import type { DomainEvent } from './DomainEvent.ts';
import { WeaponType } from '@sector-battle/shared';

export interface WeaponThrownEvent extends DomainEvent {
  type: 'WeaponThrown';
  playerId: string;
  weaponType: WeaponType;
  weaponSlot: number;
  x: number;
  y: number;
}

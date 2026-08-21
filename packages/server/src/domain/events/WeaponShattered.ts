import type { DomainEvent } from './DomainEvent.ts';
import { WeaponType } from '@sector-battle/shared';

export interface WeaponShatteredEvent extends DomainEvent {
  type: 'WeaponShattered';
  projectileId: string;
  weaponType: WeaponType;
  x: number;
  y: number;
}

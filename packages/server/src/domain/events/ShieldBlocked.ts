import type { DomainEvent } from './DomainEvent.ts';
import type { DamageType } from '@sector-battle/shared';

export interface ShieldBlockedEvent extends DomainEvent {
  type: 'ShieldBlocked';
  playerId: string;
  damageType: DamageType;
  sourceId: string;
  x: number;
  y: number;
  /** Swept-melee clash info: where the attacker's blade met the guard. */
  contactX?: number;
  contactY?: number;
  attackerWeaponType?: number;
}

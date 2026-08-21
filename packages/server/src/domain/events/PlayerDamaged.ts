import type { DomainEvent } from './DomainEvent.ts';
import { EntityType, type DamageType } from '@sector-battle/shared';

export interface PlayerDamagedEvent extends DomainEvent {
  type: 'PlayerDamaged';
  playerId: string;
  damage: number;
  sourceId: string;
  sourceType: EntityType;
  damageType: DamageType;
  knockbackX: number;
  knockbackY: number;
  killed: boolean;
  x: number;
  y: number;
}

import type { DomainEvent } from './DomainEvent.ts';
import type { WeaponType } from '@sector-battle/shared';

/**
 * A melee swing's weapon segment struck a blocking tile mid-strike.
 * The swing is interrupted and the attacker recoils.
 */
export interface WeaponWallHitEvent extends DomainEvent {
  type: 'WeaponWallHit';
  playerId: string;
  weaponType: WeaponType;
  /** Contact point (world px) where the blade met the wall. */
  x: number;
  y: number;
  gridX: number;
  gridY: number;
}

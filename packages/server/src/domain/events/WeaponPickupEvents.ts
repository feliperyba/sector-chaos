import type { DomainEvent } from './DomainEvent.ts';
import { WeaponTier, type WeaponType } from '@sector-battle/shared';

export interface WeaponPickupCollectedEvent extends DomainEvent {
  type: 'WeaponPickupCollected';
  playerId: string;
  pickupId: string;
  weaponType: WeaponType;
  tier: WeaponTier;
}

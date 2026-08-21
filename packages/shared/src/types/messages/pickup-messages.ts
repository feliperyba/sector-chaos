/**
 * Pickup channel message types.
 *
 * Channel: pickup
 */

import type { WeaponTier } from '../../enums/WeaponTier.js';

export interface PowerUpCollectedMessage {
  eventType: 'PowerUpCollected';
  playerId: string;
  powerUpId: string;
  powerUpType: number;
  tick: number;
}

export interface ChestOpenedMessage {
  eventType: 'ChestOpened';
  chestId: string;
  playerId: string;
  tier: number;
  lootContents: unknown;
  tick: number;
}

export interface PowerUpEffectExpiredMessage {
  eventType: 'PowerUpEffectExpired';
  playerId: string;
  effectType: string;
  tick: number;
}

export interface ChestRejectedMessage {
  eventType: 'ChestRejected';
  chestId: string;
  playerId: string;
  reason: string;
  tick: number;
}

export interface TrapTriggeredMessage {
  eventType: 'TrapTriggered';
  trapId: string;
  trapType: number;
  targetId: string;
  tick: number;
}

export interface ChestOpeningInterruptedMessage {
  eventType: 'ChestOpeningInterrupted';
  chestId: string;
  playerId: string;
  tick: number;
}

export interface TrapCooldownExpiredMessage {
  eventType: 'TrapCooldownExpired';
  trapId: string;
  trapType?: number;
  tick: number;
}

export interface WeaponPickupCollectedMessage {
  eventType: 'WeaponPickupCollected';
  playerId: string;
  pickupId: string;
  weaponType: number;
  /** Pickup tier — wire carries the `WeaponTier` numeric enum value. */
  tier: WeaponTier;
  tick: number;
}

export type PickupChannelMessage =
  | PowerUpCollectedMessage
  | ChestOpenedMessage
  | PowerUpEffectExpiredMessage
  | ChestRejectedMessage
  | TrapTriggeredMessage
  | ChestOpeningInterruptedMessage
  | TrapCooldownExpiredMessage
  | WeaponPickupCollectedMessage;

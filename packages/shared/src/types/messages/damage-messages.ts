/**
 * Damage & kill feed channel message types.
 *
 * Channels: kill_feed, damage
 */

import type { DamageType } from '../../enums/DamageType.js';
import type { WeaponType } from '../../enums/WeaponType.js';

// --- kill_feed channel ---

export interface PlayerEliminatedMessage {
  playerId: string;
  playerName: string;
  killedBy: string;
  killerName: string;
  placement: number;
  /** Fatal weapon — wire carries the `WeaponType` numeric enum value. */
  weapon: WeaponType;
  cause: string;
  tick: number;
  x: number;
  y: number;
  sessionId: string;
  attackType?: string;
}

// --- damage channel ---

export interface PlayerDamagedMessage {
  eventType: 'PlayerDamaged';
  playerId: string;
  damage: number;
  sourceId: string;
  sourceType: number;
  damageType?: string;
  knockbackX: number;
  knockbackY: number;
  killed: boolean;
  tick: number;
  x: number;
  y: number;
}

export interface WeaponBrokenMessage {
  eventType: 'WeaponBroken';
  playerId: string;
  weaponType: number;
  slotIndex: number;
  x: number;
  y: number;
  tick: number;
  damage?: number;
  knockbackX?: number;
  knockbackY?: number;
  sourceType?: number;
  sourceId?: string;
  killed?: boolean;
}

export interface ShieldBlockedMessage {
  eventType: 'ShieldBlocked';
  playerId: string;
  /** Wire carries the `DamageType` string enum value (e.g. `'melee_hit'`). */
  damageType: DamageType;
  sourceId: string;
  x: number;
  y: number;
  tick: number;
  sourceType?: number;
  damage?: number;
  knockbackX?: number;
  knockbackY?: number;
  killed?: boolean;
  /** Swept-melee clash info: where the attacker's blade met the guard. */
  contactX?: number;
  contactY?: number;
  attackerWeaponType?: number;
}

export type DamageChannelMessage =
  | PlayerDamagedMessage
  | WeaponBrokenMessage
  | ShieldBlockedMessage;

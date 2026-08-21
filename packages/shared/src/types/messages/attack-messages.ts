/**
 * Attack channel message types.
 *
 * Channel: attack
 */

import type { TileType } from '../../enums/TileType.js';

export interface WeaponFiredMessage {
  eventType?: 'WeaponFired';
  playerId: string;
  weaponType: number;
  attackType: string;
  direction: number;
  tick: number;
  x: number;
  y: number;
  gridX?: number;
  gridY?: number;
  hitTile?: boolean;
}

export interface ProjectileBouncedMessage {
  eventType?: 'ProjectileBounced';
  projectileId: string;
  x: number;
  y: number;
  remainingBounces: number;
  tick: number;
  attackType?: string;
  playerId?: string;
  direction?: number;
  weaponType?: number;
  gridX?: number;
  gridY?: number;
  hitTile?: boolean;
}

export interface ProjectileDestroyedMessage {
  eventType?: 'ProjectileDestroyed';
  projectileId: string;
  x: number;
  y: number;
  hitTile: boolean;
  /** Hit tile's enum value; wire carries `undefined` when none struck. */
  tileType?: TileType;
  gridX: number;
  gridY: number;
  tick: number;
  attackType?: string;
  playerId?: string;
  direction?: number;
  weaponType?: number;
}

export interface WeaponShatteredMessage {
  eventType: 'WeaponShattered';
  projectileId: string;
  weaponType: number;
  x: number;
  y: number;
  tick: number;
  attackType?: string;
  direction?: number;
  playerId?: string;
  gridX?: number;
  gridY?: number;
  hitTile?: boolean;
}

/** A melee swing's weapon segment struck a blocking tile mid-strike. */
export interface WeaponWallHitMessage {
  eventType: 'WeaponWallHit';
  playerId: string;
  weaponType: number;
  x: number;
  y: number;
  gridX: number;
  gridY: number;
  tick: number;
}

export type AttackChannelMessage =
  | WeaponFiredMessage
  | ProjectileBouncedMessage
  | ProjectileDestroyedMessage
  | WeaponShatteredMessage
  | WeaponWallHitMessage;

/**
 * Explosion channel message types.
 *
 * Channel: explosion
 */

export interface DestructibleDestroyedMessage {
  eventType?: 'DestructibleDestroyed';
  id: string;
  gridX: number;
  gridY: number;
  x: number;
  y: number;
  droppedLoot: unknown;
  tick: number;
  destructibleType?: string;
}

export interface BarrelExplodedMessage {
  eventType?: 'BarrelExploded';
  id: string;
  x: number;
  y: number;
  radius: number;
  damage: number;
  tick: number;
  gridX?: number;
  gridY?: number;
  destructibleType?: string;
}

export interface DestructibleRespawnedMessage {
  eventType?: 'DestructibleRespawned';
  id: string;
  destructibleType: string;
  tick: number;
  x?: number;
  y?: number;
  gridX?: number;
  gridY?: number;
}

export type ExplosionChannelMessage =
  | DestructibleDestroyedMessage
  | BarrelExplodedMessage
  | DestructibleRespawnedMessage;

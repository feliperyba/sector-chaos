import type { DomainEvent } from './DomainEvent.ts';

export interface DestructibleDestroyedEvent extends DomainEvent {
  type: 'DestructibleDestroyed';
  id: string;
  destructibleType: string;
  position: { x: number; y: number };
  droppedLoot: unknown | null;
  gridX: number;
  gridY: number;
}

export interface BarrelExplodedEvent extends DomainEvent {
  type: 'BarrelExploded';
  id: string;
  position: { x: number; y: number };
  radius: number;
  damage: number;
}

export interface DestructibleRespawnedEvent extends DomainEvent {
  type: 'DestructibleRespawned';
  id: string;
  destructibleType: string;
  position: { x: number; y: number };
}

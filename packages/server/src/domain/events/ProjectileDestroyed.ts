import type { DomainEvent } from './DomainEvent.ts';
import { TileType } from '@sector-battle/shared';

export interface ProjectileDestroyedEvent extends DomainEvent {
  type: 'ProjectileDestroyed';
  projectileId: string;
  x: number;
  y: number;
  hitTile: boolean;
  tileType?: TileType;
  gridX: number;
  gridY: number;
}

import type { DomainEvent } from './DomainEvent.ts';

export interface ProjectileBouncedEvent extends DomainEvent {
  type: 'ProjectileBounced';
  projectileId: string;
  x: number;
  y: number;
  remainingBounces: number;
}

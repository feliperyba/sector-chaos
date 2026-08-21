import type { Projectile } from '../entities/index.ts';

export interface ThrowResult {
  projectile: Projectile | null;
  consumed: boolean;
}

export interface ProjectileHit {
  playerId: string;
  damage: number;
}

export interface DestructibleHit {
  destructibleId: string;
  destroyed: boolean;
  shouldExplode: boolean;
}

export interface ProjectileUpdateResult {
  alive: boolean;
  hits: ProjectileHit[];
  bouncesRemaining: number;
  durability: number;
  convertedToPickup: boolean;
  pickupPosition: { x: number; y: number } | null;
  shattered: boolean;
  destructibleHits: DestructibleHit[];
  boomerangCaught?: boolean;
  returnTargetId?: string;
  originalSlot?: number;
}

/**
 * server-projectile-collider-unify (ticket 20): the hit radii + owner-immunity
 * window moved to `ProjectileCollider.ts` with the S3/S4 entity-hit scans.
 * Re-exported here under their historical names so existing import paths
 * (the ticket-17 regression harness, the thrown flight model) keep working.
 */
export { THROWN_HIT_RADIUS as PLAYER_HIT_RADIUS } from './ProjectileCollider.ts';
export { THROWN_OWNER_IMMUNITY_TICKS as THROW_IMMUNITY_TICKS } from './ProjectileCollider.ts';

/** Result from player collision check — carries both terminating results and accumulated hits. */
export interface PlayerCollisionOutcome {
  /** Non-null if the projectile should stop (shatter, convert to pickup, etc.). */
  result: ProjectileUpdateResult | null;
  /** Hits accumulated during this check (meaningful when result is null — projectile survives). */
  hits: ProjectileHit[];
}

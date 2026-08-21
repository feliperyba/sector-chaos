import {
  TileType,
  COMBAT,
  COLLISION,
  projectileTileCollisionScratch,
  weaponRegistry,
} from '@sector-battle/shared';
import { Projectile } from '../entities/index.ts';
import { Position } from '../value-objects/index.ts';
import type { ProjectileCollider } from './ProjectileCollider.ts';
import type {
  ProjectileHit,
  DestructibleHit,
  ProjectileUpdateResult,
  PlayerCollisionOutcome,
} from './ThrowHandlerTypes.ts';
import { PLAYER_HIT_RADIUS } from './ThrowHandlerTypes.ts';

/**
 * Thrown-weapon collision resolution. Entity-hit DETECTION (the former S3
 * destructible scan + S4 player scan) and the tile-grid bundle are delegated
 * to the shared {@linkcode ProjectileCollider}
 * (server-projectile-collider-unify, ticket 20); what remains here is the
 * thrown flight model's bounce physics and hit OUTCOMES — durability,
 * boomerang drop, crate-bounce depletion, reflection off players,
 * stop/shatter/pickup conversion.
 */
export class ThrowHandlerCollision {
  /**
   * Check and resolve tile collision for a projectile that just moved.
   * Returns an update result if the projectile should stop/shatter, or null to continue.
   */
  checkTileCollision(
    projectile: Projectile,
    prevX: number,
    prevY: number,
    collider: ProjectileCollider,
    destructibleHits: DestructibleHit[],
    currentTick: number,
  ): ProjectileUpdateResult | null {
    const hitRadius = COLLISION.THROWN_HITBOX_SIZE / 2;
    const thrownAABB = {
      x: projectile.position.x - hitRadius,
      y: projectile.position.y - hitRadius,
      width: COLLISION.THROWN_HITBOX_SIZE,
      height: COLLISION.THROWN_HITBOX_SIZE,
    };

    if (!collider.tileBlocked(thrownAABB)) return null;
    const collision = projectileTileCollisionScratch;

    if (projectile.bouncesRemaining > 0) {
      if (collision.mtv) {
        projectile.bounce(collision.mtv.x, collision.mtv.y);
      } else {
        projectile.velocityX = -projectile.velocityX;
        projectile.velocityY = -projectile.velocityY;
        projectile.bouncesRemaining--;
        if (projectile.isBoomerang) {
          projectile.isBoomerang = false;
          projectile.isReturning = false;
        }
      }

      projectile.velocityX *= COMBAT.BOUNCE_FACTOR;
      projectile.velocityY *= COMBAT.BOUNCE_FACTOR;

      if (collision.mtv) {
        projectile.position = new Position(
          projectile.position.x + collision.mtv.x * collision.mtv.depth,
          projectile.position.y + collision.mtv.y * collision.mtv.depth,
        );
      } else {
        projectile.position = new Position(prevX, prevY);
      }

      const isDestructibleTile =
        collision.tileType === TileType.DESTRUCTIBLE_WALL ||
        collision.tileType === TileType.DESTRUCTIBLE_BARREL ||
        collision.tileType === TileType.DESTRUCTIBLE_CRATE;

      if (isDestructibleTile) {
        // Former inline tile-AABB destructible scan — now the collider's
        // shared tile-occupancy lookup (same Map order, same first match).
        const destructible = collider.findDestructibleOnTile(
          collision.gridX,
          collision.gridY,
        );
        if (destructible) {
          const weaponDef = weaponRegistry.getDefinition(projectile.weaponType);
          const dmgResult = destructible.takeDamage({
            source: 'thrown',
            rawDamage: weaponDef.baseStats.destructibleDamage,
            currentTick,
          });
          projectile.durability -= 1;
          destructibleHits.push({
            destructibleId: destructible.id,
            destroyed: dmgResult.destroyed,
            shouldExplode: dmgResult.shouldExplode,
          });
        }
      } else {
        projectile.durability -= COMBAT.THROWN_WALL_BOUNCE_DURABILITY;
      }

      if (projectile.durability <= 0) {
        return this.shatterResult(destructibleHits);
      }

      return null; // bounce survived, continue processing
    }

    // No bounces left — stop
    return this.stopProjectile(projectile, destructibleHits);
  }

  /**
   * Check projectile collision against destructible entities.
   * Returns an update result if the projectile should stop/shatter, or null to continue.
   */
  checkDestructibleCollisions(
    projectile: Projectile,
    collider: ProjectileCollider,
    destructibleHits: DestructibleHit[],
    currentTick: number,
  ): ProjectileUpdateResult | null {
    // S3 (former destructible entity scan): first non-destroyed destructible
    // within the thrown hit radius, destructibles-Map order — via the shared
    // collider. Same first-hit-wins semantics as the former full-map walk.
    const destructible = collider.firstThrownDestructibleHit(projectile.position);
    if (destructible) {
      const destId = destructible.id;
      const weaponDef = weaponRegistry.getDefinition(projectile.weaponType);
      const dmgResult = destructible.takeDamage({
        source: 'thrown',
        rawDamage: weaponDef.baseStats.destructibleDamage,
        currentTick,
      });
      projectile.durability -= 1;
      destructibleHits.push({
        destructibleId: destId,
        destroyed: dmgResult.destroyed,
        shouldExplode: dmgResult.shouldExplode,
      });

      const wasBoomerang = projectile.isBoomerang;
      if (projectile.isBoomerang) {
        projectile.isBoomerang = false;
        projectile.isReturning = false;
      }

      if (projectile.durability <= 0) {
        return {
          alive: false,
          hits: [],
          bouncesRemaining: projectile.bouncesRemaining,
          durability: 0,
          convertedToPickup: false,
          pickupPosition: null,
          shattered: true,
          destructibleHits,
        };
      }

      if (wasBoomerang) {
        return {
          alive: false,
          hits: [],
          bouncesRemaining: projectile.bouncesRemaining,
          durability: projectile.durability,
          convertedToPickup: true,
          pickupPosition: { x: projectile.position.x, y: projectile.position.y },
          shattered: false,
          destructibleHits,
        };
      }

      if (destructible.type === 'crate') {
        projectile.bouncesRemaining--;
        if (projectile.bouncesRemaining <= 0) {
          const durabilityLost = projectile.initialDurability - projectile.durability;
          if (durabilityLost === 0 && projectile.initialDurability > 0) {
            projectile.durability -= 1;
          }
          if (projectile.durability <= 0) {
            return {
              alive: false,
              hits: [],
              bouncesRemaining: 0,
              durability: 0,
              convertedToPickup: false,
              pickupPosition: null,
              shattered: true,
              destructibleHits,
            };
          }
          return {
            alive: false,
            hits: [],
            bouncesRemaining: 0,
            durability: projectile.durability,
            convertedToPickup: true,
            pickupPosition: { x: projectile.position.x, y: projectile.position.y },
            shattered: false,
            destructibleHits,
          };
        }
      }
    }

    return null;
  }

  /**
   * Check projectile collision against players.
   * Returns a PlayerCollisionOutcome with either a terminating result or the accumulated hits.
   */
  checkPlayerCollisions(
    projectile: Projectile,
    collider: ProjectileCollider,
    currentTick: number,
    createdAtTick: number,
    destructibleHits: DestructibleHit[],
  ): PlayerCollisionOutcome {
    const hits: ProjectileHit[] = [];

    // S4 (former player entity scan): first player passing the thrown
    // filters (owner immunity window + isActive) within the thrown hit
    // radius, players-Map order — via the shared collider. All scan paths
    // were first-hit-wins (every in-radius branch terminated the loop).
    const player = collider.firstThrownPlayerHit(
      projectile.position,
      projectile.ownerId,
      currentTick,
      createdAtTick,
    );
    if (!player) {
      return { result: null, hits };
    }
    const playerId = player.id;

    projectile.durability -= 1;

    const dx = projectile.position.x - player.movement.position.x;
    const dy = projectile.position.y - player.movement.position.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      const dot = projectile.velocityX * nx + projectile.velocityY * ny;
      projectile.velocityX -= 2 * dot * nx;
      projectile.velocityY -= 2 * dot * ny;
      projectile.position = new Position(
        player.movement.position.x + nx * (PLAYER_HIT_RADIUS + 5),
        player.movement.position.y + ny * (PLAYER_HIT_RADIUS + 5),
      );
    } else {
      projectile.velocityX = -projectile.velocityX;
      projectile.velocityY = -projectile.velocityY;
    }
    projectile.velocityX *= COMBAT.BOUNCE_FACTOR;
    projectile.velocityY *= COMBAT.BOUNCE_FACTOR;

    const wasBoomerang = projectile.isBoomerang;
    if (projectile.isBoomerang) {
      projectile.isBoomerang = false;
      projectile.isReturning = false;
    }

    if (player.isInvulnerable(currentTick)) {
      projectile.bouncesRemaining--;
      if (projectile.durability <= 0) {
        return {
          result: {
            alive: false,
            hits: [],
            bouncesRemaining: projectile.bouncesRemaining,
            durability: 0,
            convertedToPickup: false,
            pickupPosition: null,
            shattered: true,
            destructibleHits,
          },
          hits: [],
        };
      }
      if (projectile.bouncesRemaining <= 0) {
        return {
          result: {
            alive: false,
            hits: [],
            bouncesRemaining: 0,
            durability: projectile.durability,
            convertedToPickup: true,
            pickupPosition: { x: projectile.position.x, y: projectile.position.y },
            shattered: false,
            destructibleHits,
          },
          hits: [],
        };
      }
      return { result: null, hits };
    }

    hits.push({ playerId, damage: projectile.damage });

    if (projectile.durability <= 0) {
      return {
        result: {
          alive: false,
          hits,
          bouncesRemaining: projectile.bouncesRemaining,
          durability: 0,
          convertedToPickup: false,
          pickupPosition: null,
          shattered: true,
          destructibleHits,
        },
        hits,
      };
    }

    if (wasBoomerang) {
      return {
        result: {
          alive: false,
          hits,
          bouncesRemaining: projectile.bouncesRemaining,
          durability: projectile.durability,
          convertedToPickup: true,
          pickupPosition: { x: projectile.position.x, y: projectile.position.y },
          shattered: false,
          destructibleHits,
        },
        hits,
      };
    }

    return { result: null, hits };
  }

  stopProjectile(
    projectile: Projectile,
    destructibleHits: DestructibleHit[] = [],
  ): ProjectileUpdateResult {
    const durabilityLost = projectile.initialDurability - projectile.durability;
    if (durabilityLost === 0 && projectile.initialDurability > 0) {
      projectile.durability -= 1;
    }

    if (projectile.durability <= 0) {
      return this.shatterResult(destructibleHits);
    }

    return {
      alive: false,
      hits: [],
      bouncesRemaining: projectile.bouncesRemaining,
      durability: projectile.durability,
      convertedToPickup: true,
      pickupPosition: { x: projectile.position.x, y: projectile.position.y },
      shattered: false,
      destructibleHits,
    };
  }

  shatterResult(destructibleHits: DestructibleHit[] = []): ProjectileUpdateResult {
    return {
      alive: false,
      hits: [],
      bouncesRemaining: 0,
      durability: 0,
      convertedToPickup: false,
      pickupPosition: null,
      shattered: true,
      destructibleHits,
    };
  }
}

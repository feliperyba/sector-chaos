import type { Projectile } from '../entities/index.ts';
import type { ProjectileCollider } from './ProjectileCollider.ts';
import type { ProjectileUpdateResult, DestructibleHit } from './ThrowHandlerTypes.ts';
import { PLAYER_HIT_RADIUS } from './ThrowHandlerTypes.ts';
import { ThrowHandlerCollision } from './ThrowHandlerCollision.ts';

/**
 * Thrown-weapon flight simulation: range/return transitions, boomerang
 * homing, and the per-step collision sequence (tile → destructibles →
 * players). Entity-hit detection is delegated to the shared
 * {@linkcode ProjectileCollider} (server-projectile-collider-unify, ticket
 * 20); this module owns what genuinely differs — the bounce/boomerang flight
 * model and its OUTCOMES (stop/shatter/pickup conversion).
 */
export class ThrowHandlerSimulation {
  private collision = new ThrowHandlerCollision();

  updateProjectile(
    projectile: Projectile,
    collider: ProjectileCollider,
    dt: number,
    currentTick: number,
    createdAtTick: number,
  ): ProjectileUpdateResult {
    // --- Boomerang return phase ---
    if (projectile.isBoomerang && projectile.isReturning) {
      return this.updateBoomerangReturn(projectile, collider, dt, currentTick);
    }

    // --- Main flight phase ---
    const prevX = projectile.position.x;
    const prevY = projectile.position.y;

    const speed = Math.sqrt(
      projectile.velocityX * projectile.velocityX + projectile.velocityY * projectile.velocityY,
    );
    projectile.distanceTraveled += speed * dt;

    // Range check — boomerang starts returning, others stop
    if (projectile.maxRange > 0 && projectile.distanceTraveled >= projectile.maxRange) {
      if (projectile.isBoomerang && !projectile.isReturning) {
        projectile.isReturning = true;
        return {
          alive: true,
          hits: [],
          bouncesRemaining: projectile.bouncesRemaining,
          durability: projectile.durability,
          convertedToPickup: false,
          pickupPosition: null,
          shattered: false,
          destructibleHits: [],
        };
      }
      return this.collision.stopProjectile(projectile);
    }

    projectile.update(dt);

    const destructibleHits: DestructibleHit[] = [];

    // Tile collision
    const tileResult = this.collision.checkTileCollision(
      projectile,
      prevX,
      prevY,
      collider,
      destructibleHits,
      currentTick,
    );
    if (tileResult) return tileResult;

    // Destructible entity collision
    const destResult = this.collision.checkDestructibleCollisions(
      projectile,
      collider,
      destructibleHits,
      currentTick,
    );
    if (destResult) return destResult;

    // Player collision
    const playerOutcome = this.collision.checkPlayerCollisions(
      projectile,
      collider,
      currentTick,
      createdAtTick,
      destructibleHits,
    );
    if (playerOutcome.result) return playerOutcome.result;

    // Still alive — use hits from player outcome
    return {
      alive: true,
      hits: playerOutcome.hits,
      bouncesRemaining: projectile.bouncesRemaining,
      durability: projectile.durability,
      convertedToPickup: false,
      pickupPosition: null,
      shattered: false,
      destructibleHits,
    };
  }

  private updateBoomerangReturn(
    projectile: Projectile,
    collider: ProjectileCollider,
    dt: number,
    currentTick: number,
  ): ProjectileUpdateResult {
    const thrower = collider.getPlayer(projectile.ownerId);
    if (!thrower || !thrower.isActive) {
      return {
        alive: false,
        hits: [],
        bouncesRemaining: projectile.bouncesRemaining,
        durability: projectile.durability,
        convertedToPickup: true,
        pickupPosition: { x: projectile.position.x, y: projectile.position.y },
        shattered: false,
        destructibleHits: [],
      };
    }

    if (currentTick >= projectile.boomerangTimeoutTick) {
      return {
        alive: false,
        hits: [],
        bouncesRemaining: projectile.bouncesRemaining,
        durability: projectile.durability,
        convertedToPickup: true,
        pickupPosition: { x: projectile.position.x, y: projectile.position.y },
        shattered: false,
        destructibleHits: [],
      };
    }

    const dx = thrower.movement.position.x - projectile.position.x;
    const dy = thrower.movement.position.y - projectile.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= PLAYER_HIT_RADIUS) {
      return {
        alive: false,
        hits: [],
        bouncesRemaining: projectile.bouncesRemaining,
        durability: projectile.durability,
        convertedToPickup: false,
        pickupPosition: null,
        shattered: false,
        destructibleHits: [],
        boomerangCaught: true,
        returnTargetId: projectile.ownerId,
        originalSlot: projectile.originalSlot,
      };
    }

    const speed = Math.sqrt(projectile.velocityX ** 2 + projectile.velocityY ** 2);
    if (dist > 0 && speed > 0) {
      projectile.velocityX = (dx / dist) * speed;
      projectile.velocityY = (dy / dist) * speed;
    }

    projectile.update(dt);
    projectile.distanceTraveled += speed * dt;

    return {
      alive: true,
      hits: [],
      bouncesRemaining: projectile.bouncesRemaining,
      durability: projectile.durability,
      convertedToPickup: false,
      pickupPosition: null,
      shattered: false,
      destructibleHits: [],
    };
  }
}

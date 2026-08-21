import {
  WeaponType,
  TileType,
  PLAYER,
  COLLISION,
  projectileTileCollisionScratch,
  weaponRegistry,
} from '@sector-battle/shared';

import { Projectile } from '../entities/index.ts';
import { Position } from '../value-objects/index.ts';
import { ProjectileCollider } from './ProjectileCollider.ts';

export interface RangedFireResult {
  projectile: Projectile | null;
  consumed: boolean;
}

export interface ArrowUpdateResult {
  alive: boolean;
  hit: boolean;
  hitPlayerId: string | null;
  distanceTraveled: number;
  exceededRange: boolean;
  destructibleHit: { id: string; destroyed: boolean; shouldExplode: boolean } | null;
}

const ARROW_HITBOX_HALF = COLLISION.ARROW_HITBOX_WIDTH / 2;

/**
 * Arrow (ranged) flight model. Entity-hit detection — the former S1 (vs
 * destructibles) and S2 (vs players) scans — and the tile-collision grid
 * bundle are delegated to the shared {@linkcode ProjectileCollider}
 * (server-projectile-collider-unify, ticket 20); what remains here is the
 * arrow's own flight: straight-line motion, swept-substep tile resolution,
 * and the hit OUTCOMES (range expiry, destructible damage, first player hit).
 */
export class RangedHandler {
  fire(
    playerId: string,
    playerPosition: Position,
    weaponType: WeaponType,
    damage: number,
    knockback: number,
    maxRange: number,
    aimAngle: number,
    idGenerator: { next(): string },
    projectileSpeed: number,
  ): RangedFireResult {
    if (Number.isNaN(aimAngle)) {
      return { projectile: null, consumed: false };
    }

    const vx = Math.cos(aimAngle) * projectileSpeed;
    const vy = Math.sin(aimAngle) * projectileSpeed;
    const edgeOffset = PLAYER.HITBOX_WIDTH / 2;
    const spawnPos = new Position(
      playerPosition.x + Math.cos(aimAngle) * edgeOffset,
      playerPosition.y + Math.sin(aimAngle) * edgeOffset,
    );

    const projectile = new Projectile(
      idGenerator.next(),
      playerId,
      spawnPos,
      vx,
      vy,
      damage,
      -1,
      weaponType,
      0,
      maxRange,
      'arrow',
      false,
      null,
      0,
      -1,
      knockback,
    );

    return { projectile, consumed: true };
  }

  updateArrow(
    projectile: Projectile,
    collider: ProjectileCollider,
    dt: number,
    distanceTraveled: number,
    maxRange: number,
    /**
     * Juice-pass-1 ticket 05 — the tick the arrow lands on; stamps a primed
     * barrel's fuse expiry at the takeDamage choke point. Defaults to 0 for
     * the pre-ticket unit-test call sites (they never run the fuse step).
     */
    currentTick: number = 0,
  ): ArrowUpdateResult {
    const arrowDef = weaponRegistry.getDefinition(projectile.weaponType);
    const arrowDestructibleDamage = arrowDef.baseStats.destructibleDamage;

    const prevX = projectile.position.x;
    const prevY = projectile.position.y;

    projectile.update(dt);

    const speed = Math.sqrt(
      projectile.velocityX * projectile.velocityX + projectile.velocityY * projectile.velocityY,
    );
    const newDistance = distanceTraveled + speed * dt;

    if (newDistance >= maxRange) {
      return {
        alive: false,
        hit: false,
        hitPlayerId: null,
        distanceTraveled: newDistance,
        exceededRange: true,
        destructibleHit: null,
      };
    }

    // S1 (former destructible entity scan): first destructible within the
    // arrow hit radius, destructibles-Map order — via the shared collider.
    const destructible = collider.firstArrowDestructibleHit(projectile.position);
    if (destructible) {
      const dmgResult = destructible.takeDamage({
        source: 'arrow',
        rawDamage: arrowDestructibleDamage,
        currentTick,
      });
      return {
        alive: false,
        hit: false,
        hitPlayerId: null,
        distanceTraveled: newDistance,
        exceededRange: false,
        destructibleHit: {
          id: destructible.id,
          destroyed: dmgResult.destroyed,
          shouldExplode: dmgResult.shouldExplode,
        },
      };
    }

    const newX = projectile.position.x;
    const newY = projectile.position.y;
    const moveDx = newX - prevX;
    const moveDy = newY - prevY;
    const moveDist = Math.sqrt(moveDx * moveDx + moveDy * moveDy);

    if (moveDist > 0) {
      const dirX = moveDx / moveDist;
      const dirY = moveDy / moveDist;
      const steps = Math.ceil(moveDist / ARROW_HITBOX_HALF);
      const stepDist = moveDist / steps;

      for (let s = 1; s <= steps; s++) {
        const sx = prevX + dirX * stepDist * s;
        const sy = prevY + dirY * stepDist * s;

        const arrowAABB = {
          x: sx - ARROW_HITBOX_HALF,
          y: sy - ARROW_HITBOX_HALF,
          width: ARROW_HITBOX_HALF * 2,
          height: ARROW_HITBOX_HALF * 2,
        };

        if (!collider.tileBlocked(arrowAABB)) continue;
        const collision = projectileTileCollisionScratch;

        if (
          collision.tileType === TileType.DESTRUCTIBLE_BARREL ||
          collision.tileType === TileType.DESTRUCTIBLE_WALL ||
          collision.tileType === TileType.DESTRUCTIBLE_CRATE
        ) {
          // Former inline tile-AABB destructible scan — now the collider's
          // shared tile-occupancy lookup (same Map order, same first match).
          const tileDestructible = collider.findDestructibleOnTile(
            collision.gridX,
            collision.gridY,
          );
          if (tileDestructible) {
            const dmgResult = tileDestructible.takeDamage({
              source: 'arrow',
              rawDamage: arrowDestructibleDamage,
              currentTick,
            });
            return {
              alive: false,
              hit: false,
              hitPlayerId: null,
              distanceTraveled: newDistance,
              exceededRange: false,
              destructibleHit: {
                id: tileDestructible.id,
                destroyed: dmgResult.destroyed,
                shouldExplode: dmgResult.shouldExplode,
              },
            };
          }
        }

        if (collision.mtv) {
          projectile.position = new Position(
            sx + collision.mtv.x * collision.mtv.depth,
            sy + collision.mtv.y * collision.mtv.depth,
          );
        } else {
          projectile.position = new Position(sx - dirX * stepDist, sy - dirY * stepDist);
        }
        return {
          alive: false,
          hit: false,
          hitPlayerId: null,
          distanceTraveled: newDistance,
          exceededRange: false,
          destructibleHit: null,
        };
      }
    }

    // S2 (former player entity scan): first player other than the owner
    // within the arrow hit radius — corpses included (no isActive filter,
    // arrows stop on corpses) — via the shared collider.
    const player = collider.firstArrowPlayerHit(projectile.position, projectile.ownerId);
    if (player) {
      return {
        alive: false,
        hit: true,
        hitPlayerId: player.id,
        distanceTraveled: newDistance,
        exceededRange: false,
        destructibleHit: null,
      };
    }

    return {
      alive: true,
      hit: false,
      hitPlayerId: null,
      distanceTraveled: newDistance,
      exceededRange: false,
      destructibleHit: null,
    };
  }
}

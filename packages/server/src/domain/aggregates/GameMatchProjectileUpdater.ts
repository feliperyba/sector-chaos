import {
  DamageType,
  weaponRegistry,
  WeaponType,
  WeaponTier,
  BOOMERANG,
  type ObjectPool,
} from '@sector-battle/shared';
import type { Projectile } from '../entities/Projectile.ts';
import type { Player } from '../entities/Player.ts';
import type { GameEvent } from '../events/index.ts';
import type { ThrowHandler } from '../handlers/ThrowHandler.ts';
import type { RangedHandler } from '../handlers/RangedHandler.ts';
import type { ProjectileCollider } from '../handlers/ProjectileCollider.ts';
import type { DamagePipeline } from '../services/DamagePipeline.ts';

interface ProjectileMeta {
  createdAtTick: number;
  distanceTraveled: number;
  embeddedTick: number;
}

export interface ProjectileUpdateContext {
  projectiles: Map<string, Projectile>;
  projectileMeta: Map<string, ProjectileMeta>;
  players: Map<string, Player>;
  throwHandler: ThrowHandler;
  rangedHandler: RangedHandler;
  /**
   * server-projectile-collider-unify (ticket 20): the shared projectile
   * hit-test surface both flight models delegate to. Encapsulates the former
   * per-call parameter bundles — the whole players/destructibles maps, the
   * tile grid + tileSize, the tile-collider data, and the per-tick domain
   * spatial index (read live through getters, so no refresh needed).
   * `players` also stays a direct ctx field: damage application and cleanup
   * use it outside any hit scan.
   */
  projectileCollider: ProjectileCollider;
  damagePipeline: DamagePipeline;
  projectilePool: ObjectPool<Projectile>;
  /**
   * server-projectile-scratch-hoist: reusable per-tick scratch for the dead-id
   * bookkeeping, owned by the per-match context (cleared at the top of every
   * `updateProjectiles` call, consumed synchronously within it — never
   * retained past the call, and the update is non-reentrant). Replaces the
   * former per-tick `string[]` + `Set` allocations.
   */
  deadProjectiles: string[];
  deadSet: Set<string>;
  tick: number;
  getAlivePlayerCount: () => number;
  onConvertToPickup?: (projectile: Projectile, position: { x: number; y: number }) => void;
  onBoomerangReturn?: (
    weaponType: WeaponType,
    durability: number,
    targetPlayerId: string,
    originalSlot: number,
    tier: WeaponTier,
  ) => void;
  destroyDestructible?: (id: string) => GameEvent[];
  /**
   * perf-arc-neo ticket 08 — static-row sync gate: called when a projectile
   * hit a destructible this tick (`destructibleHits`/`destructibleHit` carry
   * the takeDamage outcome; destroyed ones also funnel through
   * `destroyDestructible`). Wired by updateProjectilesAction to bump
   * `GameMatch.destructibleVersion` — surviving hp/primed changes would
   * otherwise never re-project onto the wire.
   */
  onDestructiblesMutated?: () => void;
}

/**
 * Named aliases of the two optional projectile-update callbacks (derived from
 * {@linkcode ProjectileUpdateContext} so they can never drift from it). Extracted
 * from GameMatch.updateProjectiles's inline parameter types (F8 file-length
 * extraction — the LightingPipelineTypes.ts precedent). Type-level only.
 */
export type ProjectileConvertCallback = NonNullable<ProjectileUpdateContext['onConvertToPickup']>;
export type BoomerangReturnCallback = NonNullable<ProjectileUpdateContext['onBoomerangReturn']>;

export function updateProjectiles(ctx: ProjectileUpdateContext, dt: number): GameEvent[] {
  const events: GameEvent[] = [];
  // server-projectile-scratch-hoist: cleared at top, filled during the update
  // below — same values, same order as the former per-tick locals.
  const deadProjectiles = ctx.deadProjectiles;
  deadProjectiles.length = 0;
  const deadSet = ctx.deadSet;
  deadSet.clear();

  for (const [projId, projectile] of ctx.projectiles) {
    let meta = ctx.projectileMeta.get(projId);
    if (!meta) {
      meta = { createdAtTick: ctx.tick, distanceTraveled: 0, embeddedTick: 0 };
      ctx.projectileMeta.set(projId, meta);
    }

    if (projectile.bouncesRemaining >= 0) {
      const prevBounces = projectile.bouncesRemaining;
      const result = ctx.throwHandler.updateProjectile(
        projectile,
        ctx.projectileCollider,
        dt,
        ctx.tick,
        meta.createdAtTick,
      );
      if (result.alive && result.bouncesRemaining < prevBounces) {
        events.push({
          type: 'ProjectileBounced',
          tick: ctx.tick,
          timestamp: Date.now(),
          projectileId: projId,
          x: projectile.position.x,
          y: projectile.position.y,
          remainingBounces: result.bouncesRemaining,
        });
      }
      for (const hit of result.hits) {
        const target = ctx.players.get(hit.playerId);
        if (target) {
          events.push(...applyProjectileDamage(ctx, target, projectile, hit.playerId, hit.damage));
        }
      }
      // ticket 08 — any recorded hit means takeDamage ran on a destructible
      // (surviving hp/primed changes have no other re-projection trigger).
      if (result.destructibleHits.length > 0) ctx.onDestructiblesMutated?.();
      for (const dHit of result.destructibleHits) {
        if (dHit.destroyed && ctx.destroyDestructible) {
          events.push(...ctx.destroyDestructible(dHit.destructibleId));
        }
      }
      if (result.boomerangCaught && result.returnTargetId) {
        projectile.durability -= BOOMERANG.RETURN_DURABILITY_COST;
        if (projectile.durability <= 0) {
          events.push({
            type: 'WeaponShattered',
            tick: ctx.tick,
            timestamp: Date.now(),
            projectileId: projId,
            weaponType: projectile.weaponType,
            x: projectile.position.x,
            y: projectile.position.y,
          });
        } else {
          ctx.onBoomerangReturn?.(
            projectile.weaponType,
            projectile.durability,
            result.returnTargetId,
            result.originalSlot ?? -1,
            projectile.tier,
          );
        }
        deadProjectiles.push(projId);
        deadSet.add(projId);
      } else if (!result.alive) {
        deadProjectiles.push(projId);
        deadSet.add(projId);
        if (result.shattered) {
          events.push({
            type: 'WeaponShattered',
            tick: ctx.tick,
            timestamp: Date.now(),
            projectileId: projId,
            weaponType: projectile.weaponType,
            x: projectile.position.x,
            y: projectile.position.y,
          });
        } else if (result.convertedToPickup && result.pickupPosition && ctx.onConvertToPickup) {
          ctx.onConvertToPickup(projectile, result.pickupPosition);
        }
      }
    } else {
      const definition = weaponRegistry.getDefinition(projectile.weaponType);
      const maxRange = definition?.baseStats.range ?? 500;
      const result = ctx.rangedHandler.updateArrow(
        projectile,
        ctx.projectileCollider,
        dt,
        meta.distanceTraveled,
        maxRange,
        ctx.tick,
      );
      meta.distanceTraveled = result.distanceTraveled;
      if (!result.alive) {
        deadProjectiles.push(projId);
        deadSet.add(projId);
        if (result.hit && result.hitPlayerId) {
          const target = ctx.players.get(result.hitPlayerId);
          if (target) {
            events.push(
              ...applyProjectileDamage(
                ctx,
                target,
                projectile,
                result.hitPlayerId,
                projectile.damage,
              ),
            );
          }
        }
        if (result.destructibleHit) {
          // ticket 08 — takeDamage ran (see the ctx member's doc).
          ctx.onDestructiblesMutated?.();
          if (result.destructibleHit.destroyed && ctx.destroyDestructible) {
            events.push(...ctx.destroyDestructible(result.destructibleHit.id));
          }
        }
      }
    }
  }

  resolveProjectileCollisions(ctx, deadProjectiles, deadSet);

  cleanupProjectiles(ctx, deadProjectiles);
  return events;
}

/**
 * Reusable PARALLEL scratch buffers for the projectile-pair collision scan.
 * The prior implementation pushed a fresh `[id, projectile]` 2-tuple per
 * projectile per tick into the reused outer array. These two arrays are
 * cleared and repopulated in the SAME forEach order each call — the pair
 * walk visits (i, j) in exactly the order the tuple array did — with zero
 * allocation after the first tick that reaches a given high-water mark.
 * Tracked here at module scope because `resolveProjectileCollisions` is a
 * stateless free function (no `this` to hang the pool on), matching the
 * InputBuffer/scratch idiom used elsewhere.
 */
const collisionIdsScratch: string[] = [];
const collisionProjScratch: Projectile[] = [];

function resolveProjectileCollisions(
  ctx: ProjectileUpdateContext,
  deadProjectiles: string[],
  deadSet: Set<string>,
): void {
  const ids = collisionIdsScratch;
  const projs = collisionProjScratch;
  ids.length = 0;
  projs.length = 0;
  ctx.projectiles.forEach((proj, id) => {
    ids.push(id);
    projs.push(proj);
  });
  const hitDist = 32;
  const hitDistSq = hitDist * hitDist;

  for (let i = 0; i < ids.length; i++) {
    const idA = ids[i]!;
    const projA = projs[i]!;
    if (deadSet.has(idA)) continue;

    for (let j = i + 1; j < ids.length; j++) {
      const idB = ids[j]!;
      const projB = projs[j]!;
      if (deadSet.has(idB)) continue;

      const dx = projA.position.x - projB.position.x;
      const dy = projA.position.y - projB.position.y;
      if (dx * dx + dy * dy < hitDistSq) {
        const bothArrows = projA.projectileType === 'arrow' && projB.projectileType === 'arrow';
        if (bothArrows) {
          continue;
        }

        const thrownArrow =
          projA.projectileType === 'thrown' && projB.projectileType === 'arrow'
            ? { thrown: projA, thrownId: idA, arrow: projB, arrowId: idB }
            : projA.projectileType === 'arrow' && projB.projectileType === 'thrown'
              ? { thrown: projB, thrownId: idB, arrow: projA, arrowId: idA }
              : null;

        if (thrownArrow) {
          deadSet.add(thrownArrow.arrowId);
          deadProjectiles.push(thrownArrow.arrowId);
          continue;
        }

        deadSet.add(idA);
        deadSet.add(idB);
        deadProjectiles.push(idA, idB);

        const midX = (projA.position.x + projB.position.x) / 2;
        const midY = (projA.position.y + projB.position.y) / 2;

        if (ctx.onConvertToPickup) {
          ctx.onConvertToPickup(projA, { x: midX, y: midY });
          ctx.onConvertToPickup(projB, { x: midX, y: midY });
        }

        break;
      }
    }
  }
}

function applyProjectileDamage(
  ctx: ProjectileUpdateContext,
  target: Player,
  projectile: Projectile,
  hitPlayerId: string,
  damage: number,
): GameEvent[] {
  const isThrown = projectile.bouncesRemaining >= 0;
  const damageType = isThrown ? DamageType.THROWN_HIT : DamageType.RANGED_HIT;

  return ctx.damagePipeline.processAttack(
    {
      attackerId: projectile.ownerId,
      weaponType: projectile.weaponType,
      damage,
      knockbackForce: projectile.knockback,
      damageType,
      hitTargetIds: [hitPlayerId],
      attackAngle: Math.atan2(projectile.velocityY, projectile.velocityX),
      sourcePosition: { x: projectile.position.x, y: projectile.position.y },
      currentTick: ctx.tick,
      tickRate: 60,
      alivePlayerCount: ctx.getAlivePlayerCount(),
    },
    (id) => ctx.players.get(id),
  );
}

function cleanupProjectiles(ctx: ProjectileUpdateContext, deadIds: string[]): void {
  for (const id of deadIds) {
    const p = ctx.projectiles.get(id);
    if (p) {
      if (p.bouncesRemaining >= 0) {
        const owner = ctx.players.get(p.ownerId);
        if (owner) owner.combat.removeThrowInFlight(id);
      }
      ctx.projectilePool.release(p);
    }
    ctx.projectiles.delete(id);
    ctx.projectileMeta.delete(id);
  }
}

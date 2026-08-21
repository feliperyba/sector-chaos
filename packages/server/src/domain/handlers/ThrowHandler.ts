import {
  WeaponType,
  WeaponTier,
  PLAYER,
  COMBAT,
  weaponRegistry,
} from '@sector-battle/shared';
import { Projectile } from '../entities/index.ts';
import { Position } from '../value-objects/index.ts';
import type { ProjectileCollider } from './ProjectileCollider.ts';
import type { ThrowResult, ProjectileUpdateResult } from './ThrowHandlerTypes.ts';
import { ThrowHandlerSimulation } from './ThrowHandlerSimulation.ts';

export type {
  ThrowResult,
  ProjectileHit,
  DestructibleHit,
  ProjectileUpdateResult,
} from './ThrowHandlerTypes.ts';

/**
 * Thrown-weapon flight model entry point. Entity-hit detection and the tile
 * grid bundle are delegated to the shared {@linkcode ProjectileCollider}
 * (server-projectile-collider-unify, ticket 20) — `throw` spawns, and
 * `updateProjectile` forwards to the simulation's bounce/boomerang physics.
 */
export class ThrowHandler {
  private simulation = new ThrowHandlerSimulation();

  throw(
    playerId: string,
    playerPosition: Position,
    weaponType: WeaponType,
    damage: number,
    knockback: number,
    bounces: number,
    facingAngle: number,
    throwSpeed: number,
    maxRange: number,
    idGenerator: { next(): string },
    durability: number,
    currentTick: number = 0,
    originalSlot: number = -1,
    tier: WeaponTier = WeaponTier.COMMON,
  ): ThrowResult {
    const vx = Math.cos(facingAngle) * throwSpeed * COMBAT.THROW_SPEED_MULTIPLIER;
    const vy = Math.sin(facingAngle) * throwSpeed * COMBAT.THROW_SPEED_MULTIPLIER;
    const edgeOffset = PLAYER.HITBOX_WIDTH / 2;
    const spawnPos = new Position(
      playerPosition.x + Math.cos(facingAngle) * edgeOffset,
      playerPosition.y + Math.sin(facingAngle) * edgeOffset,
    );

    const definition = weaponRegistry.getDefinition(weaponType);
    const isBoomerang = definition?.baseStats.isBoomerang === true;
    const boomerangTimeoutTick = isBoomerang ? currentTick + Math.ceil(3 * 60) : 0;

    const projectile = new Projectile(
      idGenerator.next(),
      playerId,
      spawnPos,
      vx,
      vy,
      damage,
      bounces,
      weaponType,
      durability,
      maxRange,
      'thrown',
      isBoomerang,
      isBoomerang ? playerId : null,
      boomerangTimeoutTick,
      originalSlot,
      knockback,
      tier,
    );

    return { projectile, consumed: true };
  }

  updateProjectile(
    projectile: Projectile,
    collider: ProjectileCollider,
    dt: number,
    currentTick: number,
    createdAtTick: number,
  ): ProjectileUpdateResult {
    return this.simulation.updateProjectile(
      projectile,
      collider,
      dt,
      currentTick,
      createdAtTick,
    );
  }
}

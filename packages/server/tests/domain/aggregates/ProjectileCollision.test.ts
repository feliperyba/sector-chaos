import { describe, it, expect, vi } from 'vitest';
import { WeaponType, TileType, ObjectPool } from '@sector-battle/shared';
import {
  updateProjectiles,
  type ProjectileUpdateContext,
} from '../../../src/domain/aggregates/GameMatchProjectileUpdater.ts';
import { Projectile } from '../../../src/domain/entities/Projectile.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { ThrowHandler } from '../../../src/domain/handlers/ThrowHandler.ts';
import { RangedHandler } from '../../../src/domain/handlers/RangedHandler.ts';
import { ProjectileCollider } from '../../../src/domain/handlers/ProjectileCollider.ts';
import { ShieldHandler } from '../../../src/domain/handlers/ShieldHandler.ts';
import { DamagePipeline } from '../../../src/domain/services/DamagePipeline.ts';
import type { PlayerConfig } from '@sector-battle/shared';

function createDefaultConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 10,
    dashCooldown: 60,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: 24,
    hitboxHeight: 24,
    ...overrides,
  };
}

function createPlayer(id: string, x: number, y: number): Player {
  return new Player(id, `player_${id}`, new Position(x, y), createDefaultConfig());
}

function createEmptyGrid(width = 10, height = 10): TileType[][] {
  return Array.from({ length: height }, () => Array(width).fill(TileType.EMPTY));
}

const throwHandler = new ThrowHandler();
const rangedHandler = new RangedHandler();
const damagePipeline = new DamagePipeline(new ShieldHandler());

function createPool(): ObjectPool<Projectile> {
  return new ObjectPool<Projectile>(
    () => new Projectile('', '', new Position(0, 0), 0, 0, 0, 0, WeaponType.FISTS),
    () => {},
  );
}

function createThrownProjectile(id: string, ownerId: string, x: number, y: number): Projectile {
  return new Projectile(
    id,
    ownerId,
    new Position(x, y),
    500,
    0,
    30,
    1,
    WeaponType.DAGGER,
    50,
    800,
    'thrown',
  );
}

function createArrowProjectile(id: string, ownerId: string, x: number, y: number): Projectile {
  return new Projectile(
    id,
    ownerId,
    new Position(x, y),
    600,
    0,
    25,
    -1,
    WeaponType.SHORT_BOW,
    0,
    500,
    'arrow',
  );
}

function buildContext(overrides: Partial<ProjectileUpdateContext> = {}): ProjectileUpdateContext {
  // server-projectile-collider-unify: the (destructibles, grid, tileWidth)
  // bundle is encapsulated by the shared ProjectileCollider; the overridden
  // players map is hoisted so ctx and collider reference the same instance.
  const players = overrides.players ?? new Map<string, Player>();
  return {
    projectiles: new Map(),
    projectileMeta: new Map(),
    players,
    throwHandler,
    rangedHandler,
    projectileCollider: new ProjectileCollider({
      players,
      destructibles: new Map(),
      grid: createEmptyGrid(),
      tileSize: 48,
    }),
    damagePipeline,
    projectilePool: createPool(),
    deadProjectiles: [],
    deadSet: new Set<string>(),
    tick: 50,
    getAlivePlayerCount: () => 1,
    ...overrides,
  };
}

describe('resolveProjectileCollisions — projectile type rules', () => {
  it('arrow vs arrow: both pass through (no collision)', () => {
    const arrowA = createArrowProjectile('a1', 'p1', 100, 100);
    const arrowB = createArrowProjectile('a2', 'p2', 110, 100);
    const projectiles = new Map([
      ['a1', arrowA],
      ['a2', arrowB],
    ]);
    const convertSpy = vi.fn();

    const ctx = buildContext({ projectiles, onConvertToPickup: convertSpy });
    const events = updateProjectiles(ctx, 1 / 60);

    expect(ctx.projectiles.has('a1')).toBe(true);
    expect(ctx.projectiles.has('a2')).toBe(true);
    expect(convertSpy).not.toHaveBeenCalled();
  });

  it('thrown vs arrow: arrow destroyed, thrown continues', () => {
    const thrown = createThrownProjectile('t1', 'p1', 100, 100);
    const arrow = createArrowProjectile('a1', 'p2', 105, 100);
    const projectiles = new Map([
      ['t1', thrown],
      ['a1', arrow],
    ]);
    const convertSpy = vi.fn();

    const ctx = buildContext({ projectiles, onConvertToPickup: convertSpy });
    updateProjectiles(ctx, 1 / 60);

    expect(ctx.projectiles.has('t1')).toBe(true);
    expect(ctx.projectiles.has('a1')).toBe(false);
    expect(convertSpy).not.toHaveBeenCalled();
  });

  it('arrow vs thrown: arrow destroyed, thrown continues (reverse order)', () => {
    const arrow = createArrowProjectile('a1', 'p1', 100, 100);
    const thrown = createThrownProjectile('t1', 'p2', 105, 100);
    const projectiles = new Map([
      ['a1', arrow],
      ['t1', thrown],
    ]);
    const convertSpy = vi.fn();

    const ctx = buildContext({ projectiles, onConvertToPickup: convertSpy });
    updateProjectiles(ctx, 1 / 60);

    expect(ctx.projectiles.has('t1')).toBe(true);
    expect(ctx.projectiles.has('a1')).toBe(false);
    expect(convertSpy).not.toHaveBeenCalled();
  });

  it('thrown vs thrown: both die and convert to pickup', () => {
    const thrownA = createThrownProjectile('t1', 'p1', 100, 100);
    const thrownB = createThrownProjectile('t2', 'p2', 105, 100);
    const projectiles = new Map([
      ['t1', thrownA],
      ['t2', thrownB],
    ]);
    const convertSpy = vi.fn();

    const ctx = buildContext({ projectiles, onConvertToPickup: convertSpy });
    updateProjectiles(ctx, 1 / 60);

    expect(ctx.projectiles.has('t1')).toBe(false);
    expect(ctx.projectiles.has('t2')).toBe(false);
    expect(convertSpy).toHaveBeenCalledTimes(2);
  });
});

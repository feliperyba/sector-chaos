import { WeaponType, TileType, ObjectPool, PLAYER } from '@sector-battle/shared';
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

function createReturningBoomerang(
  id: string,
  ownerId: string,
  projX: number,
  projY: number,
  durability: number,
  originalSlot: number = 1,
): Projectile {
  const proj = new Projectile(
    id,
    ownerId,
    new Position(projX, projY),
    100,
    0,
    15,
    0,
    WeaponType.SHIELD,
    durability,
    800,
    'thrown',
    true,
    ownerId,
    200,
    originalSlot,
  );
  proj.isReturning = true;
  return proj;
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

describe('Boomerang Return Durability', () => {
  it('deducts 1 durability on successful return', () => {
    const thrower = createPlayer('thrower', 300, 300);
    const proj = createReturningBoomerang('p1', 'thrower', 305, 300, 5);
    const projectiles = new Map([['p1', proj]]);
    let returnedWeaponType: WeaponType | undefined;
    let returnedDurability: number | undefined;
    let returnedPlayerId: string | undefined;
    let returnedSlot: number | undefined;

    const ctx = buildContext({
      projectiles,
      players: new Map([['thrower', thrower]]),
      onBoomerangReturn: (weaponType, durability, targetPlayerId, originalSlot) => {
        returnedWeaponType = weaponType;
        returnedDurability = durability;
        returnedPlayerId = targetPlayerId;
        returnedSlot = originalSlot;
      },
    });

    const events = updateProjectiles(ctx, 1 / 60);

    expect(returnedDurability).toBe(4);
    expect(returnedWeaponType).toBe(WeaponType.SHIELD);
    expect(returnedPlayerId).toBe('thrower');
    expect(returnedSlot).toBe(1);
    expect(events).toHaveLength(0);
    expect(projectiles.has('p1')).toBe(false);
  });

  it('emits WeaponShattered when durability reaches 0 on return', () => {
    const thrower = createPlayer('thrower', 300, 300);
    const proj = createReturningBoomerang('p1', 'thrower', 305, 300, 1);
    const projectiles = new Map([['p1', proj]]);
    let returnCalled = false;

    const ctx = buildContext({
      projectiles,
      players: new Map([['thrower', thrower]]),
      onBoomerangReturn: () => {
        returnCalled = true;
      },
    });

    const events = updateProjectiles(ctx, 1 / 60);

    expect(returnCalled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('WeaponShattered');
    expect(events[0]!.projectileId).toBe('p1');
    expect(events[0]!.x).toBe(proj.position.x);
    expect(events[0]!.y).toBe(proj.position.y);
    expect(projectiles.has('p1')).toBe(false);
  });

  it('deducts 1 durability from shield with 2 remaining', () => {
    const thrower = createPlayer('thrower', 300, 300);
    const proj = createReturningBoomerang('p1', 'thrower', 305, 300, 2);
    const projectiles = new Map([['p1', proj]]);
    let returnedDurability: number | undefined;

    const ctx = buildContext({
      projectiles,
      players: new Map([['thrower', thrower]]),
      onBoomerangReturn: (_wt, durability) => {
        returnedDurability = durability;
      },
    });

    updateProjectiles(ctx, 1 / 60);

    expect(returnedDurability).toBe(1);
  });

  it('does not emit WeaponShattered when durability remains above 0', () => {
    const thrower = createPlayer('thrower', 300, 300);
    const proj = createReturningBoomerang('p1', 'thrower', 305, 300, 5);
    const projectiles = new Map([['p1', proj]]);

    const ctx = buildContext({
      projectiles,
      players: new Map([['thrower', thrower]]),
      onBoomerangReturn: () => {},
    });

    const events = updateProjectiles(ctx, 1 / 60);

    const shatteredEvents = events.filter((e) => e.type === 'WeaponShattered');
    expect(shatteredEvents).toHaveLength(0);
  });

  it('passes originalSlot through on return', () => {
    const thrower = createPlayer('thrower', 300, 300);
    const proj = createReturningBoomerang('p1', 'thrower', 305, 300, 5, 2);
    const projectiles = new Map([['p1', proj]]);
    let returnedSlot: number | undefined;

    const ctx = buildContext({
      projectiles,
      players: new Map([['thrower', thrower]]),
      onBoomerangReturn: (_wt, _dur, _pid, originalSlot) => {
        returnedSlot = originalSlot;
      },
    });

    updateProjectiles(ctx, 1 / 60);

    expect(returnedSlot).toBe(2);
  });
});

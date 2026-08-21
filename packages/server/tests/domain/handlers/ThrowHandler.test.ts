import { ThrowHandler } from '../../../src/domain/handlers/ThrowHandler.ts';
import { ProjectileCollider } from '../../../src/domain/handlers/ProjectileCollider.ts';
import { Projectile } from '../../../src/domain/entities/Projectile.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import { WeaponType, TileType, COMBAT } from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';

const TILE_SIZE = 64;

/**
 * server-projectile-collider-unify: updateProjectile takes the shared
 * ProjectileCollider instead of the (grid, tileSize, players, destructibles)
 * parameter bundle. Same maps/grid per test, no spatial index (the collider's
 * collect* fallback = the old full-map scan).
 */
function makeCollider(
  grid: TileType[][],
  players: Map<string, Player> = new Map(),
  destructibles: Map<string, Destructible> = new Map(),
): ProjectileCollider {
  return new ProjectileCollider({ players, destructibles, grid, tileSize: TILE_SIZE });
}

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

function createEmptyGrid(cols: number = 10, rows: number = 10): TileType[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(TileType.EMPTY));
}

function createWallGrid(
  wallGridX: number,
  wallGridY: number,
  tileType: TileType = TileType.INDESTRUCTIBLE_WALL,
  cols: number = 10,
  rows: number = 10,
): TileType[][] {
  const grid = createEmptyGrid(cols, rows);
  grid[wallGridY]![wallGridX] = tileType;
  return grid;
}

function createThrownProjectile(
  overrides: Partial<{
    id: string;
    ownerId: string;
    position: Position;
    vx: number;
    vy: number;
    damage: number;
    bounces: number;
    weaponType: WeaponType;
    durability: number;
    maxRange: number;
    isBoomerang: boolean;
    returnTargetId: string | null;
    boomerangTimeoutTick: number;
    originalSlot: number;
  }> = {},
): Projectile {
  return new Projectile(
    overrides.id ?? 'thrown-1',
    overrides.ownerId ?? 'p1',
    overrides.position ?? new Position(100, 100),
    overrides.vx ?? 400,
    overrides.vy ?? 0,
    overrides.damage ?? 20,
    overrides.bounces ?? 3,
    overrides.weaponType ?? WeaponType.THROWING_AXE,
    overrides.durability ?? 5,
    overrides.maxRange ?? 1500,
    'thrown',
    overrides.isBoomerang ?? false,
    overrides.returnTargetId ?? null,
    overrides.boomerangTimeoutTick ?? 0,
    overrides.originalSlot ?? -1,
  );
}

const handler = new ThrowHandler();

describe('ThrowHandler', () => {
  describe('throw', () => {
    it('creates projectile with correct velocity', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        0,
        400,
        1500,
        idGen,
        5,
        0,
        0,
      );

      expect(result.consumed).toBe(true);
      expect(result.projectile).not.toBeNull();
      // ThrowHandler applies COMBAT.THROW_SPEED_MULTIPLIER to the base throw
      // speed (400 here). Assert against the constant so a balance tweak to
      // the multiplier doesn't silently break this test.
      expect(result.projectile!.velocityX).toBe(400 * COMBAT.THROW_SPEED_MULTIPLIER);
      expect(result.projectile!.velocityY).toBe(0);
      expect(result.projectile!.ownerId).toBe('p1');
      expect(result.projectile!.damage).toBe(20);
    });

    it('creates projectile with facing angle', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        Math.PI / 2,
        400,
        1500,
        idGen,
        5,
        0,
        0,
      );

      expect(result.projectile!.velocityY).toBeCloseTo(400 * COMBAT.THROW_SPEED_MULTIPLIER);
      expect(result.projectile!.velocityX).toBeCloseTo(0);
    });

    it('stores durability and bounces', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        0,
        400,
        1500,
        idGen,
        5,
        0,
        0,
      );

      expect(result.projectile!.durability).toBe(5);
      expect(result.projectile!.initialDurability).toBe(5);
      expect(result.projectile!.bouncesRemaining).toBe(3);
    });

    it('stores originalSlot', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        0,
        400,
        1500,
        idGen,
        5,
        0,
        2,
      );

      expect(result.projectile!.originalSlot).toBe(2);
    });

    it('boomerang weapon sets properties', () => {
      const idGen = { next: () => 'thrown-1' };
      const currentTick = 10;
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.SMALL_SHIELD,
        15,
        10,
        0,
        0,
        400,
        800,
        idGen,
        15,
        currentTick,
        1,
      );

      expect(result.projectile!.isBoomerang).toBe(true);
      expect(result.projectile!.returnTargetId).toBe('p1');
      expect(result.projectile!.boomerangTimeoutTick).toBe(currentTick + 180);
    });

    it('non-boomerang weapon', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        0,
        400,
        1500,
        idGen,
        5,
        0,
        0,
      );

      expect(result.projectile!.isBoomerang).toBe(false);
      expect(result.projectile!.returnTargetId).toBeNull();
      expect(result.projectile!.boomerangTimeoutTick).toBe(0);
    });

    it('uses idGenerator for projectile id', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        0,
        400,
        1500,
        idGen,
        5,
        0,
        0,
      );

      expect(result.projectile!.id).toBe('thrown-1');
    });

    it('projectile type is thrown', () => {
      const idGen = { next: () => 'thrown-1' };
      const result = handler.throw(
        'p1',
        new Position(100, 100),
        WeaponType.THROWING_AXE,
        20,
        10,
        3,
        0,
        400,
        1500,
        idGen,
        5,
        0,
        0,
      );

      expect(result.projectile!.projectileType).toBe('thrown');
    });
  });

  describe('updateProjectile', () => {
    it('moves forward when no obstacles', () => {
      const proj = createThrownProjectile({
        position: new Position(100, 100),
        vx: 400,
        vy: 0,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        1 / 60,
        10,
        0,
      );

      expect(result.alive).toBe(true);
      expect(result.hits.length).toBe(0);
      expect(result.durability).toBe(5);
    });

    it('wall bounce reflects X velocity', () => {
      const startX = 2 * TILE_SIZE + 24;
      const startY = 5 * TILE_SIZE + 24;
      const proj = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createWallGrid(3, 5);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.1,
        10,
        0,
      );

      expect(result.alive).toBe(true);
      expect(proj.velocityX).toBeCloseTo(-400 * COMBAT.BOUNCE_FACTOR);
      expect(proj.velocityY).toBe(0);
    });

    it('wall bounce reflects Y velocity', () => {
      const startX = 5 * TILE_SIZE + 24;
      const startY = 2 * TILE_SIZE + 24;
      const proj = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 0,
        vy: 400,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createWallGrid(5, 3);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.1,
        10,
        0,
      );

      expect(result.alive).toBe(true);
      expect(proj.velocityY).toBeCloseTo(-400 * COMBAT.BOUNCE_FACTOR);
      expect(proj.velocityX).toBe(0);
    });

    it('wall bounce reduces durability for non-destructible tiles', () => {
      const startX = 2 * TILE_SIZE + 24;
      const startY = 5 * TILE_SIZE + 24;
      const proj = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createWallGrid(3, 5, TileType.INDESTRUCTIBLE_WALL);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.1,
        10,
        0,
      );

      expect(result.durability).toBe(5 - COMBAT.THROWN_WALL_BOUNCE_DURABILITY);
    });

    it('wall bounce does NOT reduce durability for destructible tiles', () => {
      const startX = 2 * TILE_SIZE + 24;
      const startY = 5 * TILE_SIZE + 24;

      const gridWall = createWallGrid(3, 5, TileType.DESTRUCTIBLE_WALL);
      const projWall = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const resultWall = handler.updateProjectile(
        projWall,
        makeCollider(gridWall, new Map(), new Map()),
        0.1,
        10,
        0,
      );
      expect(resultWall.durability).toBe(5);

      const gridBarrel = createWallGrid(3, 5, TileType.DESTRUCTIBLE_BARREL);
      const projBarrel = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const resultBarrel = handler.updateProjectile(
        projBarrel,
        makeCollider(gridBarrel, new Map(), new Map()),
        0.1,
        10,
        0,
      );
      expect(resultBarrel.durability).toBe(5);

      const gridCrate = createWallGrid(3, 5, TileType.DESTRUCTIBLE_CRATE);
      const projCrate = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const resultCrate = handler.updateProjectile(
        projCrate,
        makeCollider(gridCrate, new Map(), new Map()),
        0.1,
        10,
        0,
      );
      expect(resultCrate.durability).toBe(5);
    });

    it('no bounces remaining → pickup', () => {
      const startX = 2 * TILE_SIZE + 24;
      const startY = 5 * TILE_SIZE + 24;
      const proj = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 0,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createWallGrid(3, 5);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.1,
        10,
        0,
      );

      expect(result.alive).toBe(false);
      expect(result.convertedToPickup).toBe(true);
      expect(result.pickupPosition).not.toBeNull();
    });

    it('shatter at 0 durability from wall bounce', () => {
      const startX = 2 * TILE_SIZE + 24;
      const startY = 5 * TILE_SIZE + 24;
      const proj = createThrownProjectile({
        position: new Position(startX, startY),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 1,
        maxRange: 1500,
      });
      const grid = createWallGrid(3, 5);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.1,
        10,
        0,
      );

      expect(result.shattered).toBe(true);
      expect(result.convertedToPickup).toBe(false);
    });

    it('hits player within 32px radius', () => {
      const proj = createThrownProjectile({
        ownerId: 'p1',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        damage: 20,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const target = createPlayer('target', 200, 100);
      players.set('target', target);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        10,
        0,
      );

      expect(result.alive).toBe(true);
      expect(result.hits.length).toBe(1);
      expect(result.hits[0]!.playerId).toBe('target');
      expect(result.hits[0]!.damage).toBe(20);
      expect(result.durability).toBe(4);
    });

    it('source immune for 6 ticks', () => {
      const proj = createThrownProjectile({
        ownerId: 'owner',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const owner = createPlayer('owner', 200, 100);
      players.set('owner', owner);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        5,
        0,
      );

      expect(result.hits.length).toBe(0);
      expect(result.alive).toBe(true);
    });

    it('source takes damage after immunity expires', () => {
      const proj = createThrownProjectile({
        ownerId: 'owner',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        damage: 20,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const owner = createPlayer('owner', 200, 100);
      players.set('owner', owner);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        12,
        0,
      );

      expect(result.hits.length).toBe(1);
      expect(result.hits[0]!.damage).toBe(20);
    });

    it('source immune but dead → skipped', () => {
      const proj = createThrownProjectile({
        ownerId: 'owner',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const owner = createPlayer('owner', 200, 100);
      owner.takeDamage(100, 0, true);
      players.set('owner', owner);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        7,
        0,
      );

      expect(result.hits.length).toBe(0);
      expect(result.alive).toBe(true);
    });

    it('invulnerable player: no damage, bounces decremented', () => {
      const proj = createThrownProjectile({
        ownerId: 'p1',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const target = createPlayer('target', 200, 100);
      target.activateBarrier(10, 60);
      players.set('target', target);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        10,
        0,
      );

      expect(result.hits.length).toBe(0);
      expect(result.bouncesRemaining).toBe(2);
      expect(proj.velocityX).toBeLessThan(0);
    });

    it('invulnerable player at 0 bounces: pickup', () => {
      const proj = createThrownProjectile({
        ownerId: 'p1',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        bounces: 1,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const target = createPlayer('target', 200, 100);
      target.activateBarrier(10, 60);
      players.set('target', target);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        10,
        0,
      );

      expect(result.convertedToPickup).toBe(true);
    });

    it('player hit shatters at 0 durability', () => {
      const proj = createThrownProjectile({
        ownerId: 'p1',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        damage: 20,
        bounces: 3,
        durability: 1,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const target = createPlayer('target', 200, 100);
      players.set('target', target);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        10,
        0,
      );

      expect(result.shattered).toBe(true);
      expect(result.hits.length).toBe(1);
    });

    it('player hit reflects velocity', () => {
      const proj = createThrownProjectile({
        ownerId: 'p1',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 1500,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const target = createPlayer('target', 200, 100);
      players.set('target', target);

      handler.updateProjectile(proj, makeCollider(grid, players, new Map()), 1 / 60, 10, 0);

      expect(proj.velocityX).toBeCloseTo(-400 * COMBAT.BOUNCE_FACTOR);
      expect(proj.velocityY).toBe(0);
    });

    it('destructible hit deals 1 damage', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('crate1', 'crate', new Position(240, 200));
      destructibles.set('crate1', crate);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      expect(result.destructibleHits.length).toBe(1);
      expect(result.destructibleHits[0]!.destructibleId).toBe('crate1');
      expect(result.durability).toBe(4);
    });

    it('destructible hit barrel: first hit primes (flat 1 HP), does not explode', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const barrel = Destructible.create('barrel1', 'barrel', new Position(240, 200));
      destructibles.set('barrel1', barrel);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      // Juice-pass-1 ticket 05: barrel 2 HP, thrown hit = exactly 1 damage
      // regardless of the weapon's destructibleDamage — survives, primes.
      expect(result.destructibleHits[0]!.shouldExplode).toBe(false);
      expect(result.destructibleHits[0]!.destroyed).toBe(false);
      expect(barrel.hp).toBe(1);
      expect(barrel.primed).toBe(true);
    });

    it('destructible hit destroys crate', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('crate1', 'crate', new Position(240, 200));
      destructibles.set('crate1', crate);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      expect(result.destructibleHits[0]!.destroyed).toBe(true);
    });

    it('crate hit decrements bounces', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('crate1', 'crate', new Position(240, 200));
      destructibles.set('crate1', crate);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      expect(result.bouncesRemaining).toBe(2);
    });

    it('crate hit at last bounce → pickup', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 1,
        durability: 5,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('crate1', 'crate', new Position(240, 200));
      destructibles.set('crate1', crate);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      expect(result.convertedToPickup).toBe(true);
    });

    it('crate hit at last bounce, 0 durability → shatter', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 1,
        durability: 1,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('crate1', 'crate', new Position(240, 200));
      destructibles.set('crate1', crate);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      expect(result.shattered).toBe(true);
    });

    it('boomerang returning steers toward thrower', () => {
      const proj = createThrownProjectile({
        ownerId: 'thrower',
        position: new Position(400, 200),
        vx: -400,
        vy: 0,
        bounces: 0,
        isBoomerang: true,
        returnTargetId: 'thrower',
        boomerangTimeoutTick: 200,
        maxRange: 800,
      });
      proj.isReturning = true;
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const thrower = createPlayer('thrower', 300, 100);
      players.set('thrower', thrower);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        50,
        40,
      );

      expect(result.alive).toBe(true);
      expect(proj.velocityX).toBeLessThan(0);
      expect(proj.velocityY).toBeLessThan(0);
    });

    it('boomerang caught at PLAYER_HIT_RADIUS', () => {
      const throwerX = 300;
      const throwerY = 100;
      const proj = createThrownProjectile({
        ownerId: 'thrower',
        position: new Position(throwerX + 5, throwerY),
        vx: 100,
        vy: 0,
        bounces: 0,
        isBoomerang: true,
        returnTargetId: 'thrower',
        boomerangTimeoutTick: 200,
        originalSlot: 2,
        maxRange: 800,
      });
      proj.isReturning = true;
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const thrower = createPlayer('thrower', throwerX, throwerY);
      players.set('thrower', thrower);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        50,
        40,
      );

      expect(result.alive).toBe(false);
      expect(result.boomerangCaught).toBe(true);
      expect(result.returnTargetId).toBe('thrower');
      expect(result.originalSlot).toBe(2);
    });

    it('boomerang returning, thrower dead → pickup', () => {
      const throwerX = 300;
      const throwerY = 100;
      const proj = createThrownProjectile({
        ownerId: 'thrower',
        position: new Position(throwerX + 100, throwerY),
        vx: -400,
        vy: 0,
        bounces: 0,
        isBoomerang: true,
        returnTargetId: 'thrower',
        boomerangTimeoutTick: 200,
        durability: 5,
        maxRange: 800,
      });
      proj.isReturning = true;
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        50,
        40,
      );

      expect(result.convertedToPickup).toBe(true);
      expect(result.pickupPosition).not.toBeNull();
    });

    it('boomerang timeout → pickup', () => {
      const throwerX = 300;
      const throwerY = 100;
      const proj = createThrownProjectile({
        ownerId: 'thrower',
        position: new Position(throwerX + 200, throwerY),
        vx: -400,
        vy: 0,
        bounces: 0,
        isBoomerang: true,
        returnTargetId: 'thrower',
        boomerangTimeoutTick: 100,
        durability: 5,
        maxRange: 800,
      });
      proj.isReturning = true;
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const thrower = createPlayer('thrower', throwerX, throwerY);
      players.set('thrower', thrower);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        150,
        40,
      );

      expect(result.convertedToPickup).toBe(true);
    });

    it('boomerang max range triggers return', () => {
      const proj = createThrownProjectile({
        ownerId: 'thrower',
        position: new Position(100, 100),
        vx: 400,
        vy: 0,
        bounces: 0,
        isBoomerang: true,
        returnTargetId: 'thrower',
        boomerangTimeoutTick: 200,
        maxRange: 50,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const thrower = createPlayer('thrower', 100, 100);
      players.set('thrower', thrower);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        0.5,
        10,
        0,
      );

      expect(result.alive).toBe(true);
      expect(proj.isReturning).toBe(true);
    });

    it('non-boomerang max range → stop → pickup', () => {
      const proj = createThrownProjectile({
        position: new Position(100, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 50,
      });
      const grid = createEmptyGrid();

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.5,
        10,
        0,
      );

      expect(result.convertedToPickup).toBe(true);
    });

    it('stop penalty: extra durability loss when untouched', () => {
      const proj = createThrownProjectile({
        position: new Position(100, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 50,
      });
      const grid = createEmptyGrid();

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.5,
        10,
        0,
      );

      expect(result.durability).toBe(4);
      expect(result.convertedToPickup).toBe(true);
    });

    it('stop penalty: no penalty when already damaged', () => {
      const proj = createThrownProjectile({
        position: new Position(100, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        maxRange: 50,
      });
      proj.durability = 3;
      const grid = createEmptyGrid();

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.5,
        10,
        0,
      );

      expect(result.durability).toBe(3);
      expect(result.convertedToPickup).toBe(true);
    });

    it('stop at 0 durability after penalty → shatter', () => {
      const proj = createThrownProjectile({
        position: new Position(100, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 1,
        maxRange: 50,
      });
      const grid = createEmptyGrid();

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.5,
        10,
        0,
      );

      expect(result.shattered).toBe(true);
    });

    it('boomerang hits destructible → loses boomerang property → pickup', () => {
      const proj = createThrownProjectile({
        position: new Position(200, 200),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        isBoomerang: true,
        returnTargetId: 'p1',
        boomerangTimeoutTick: 200,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('crate1', 'crate', new Position(240, 200));
      destructibles.set('crate1', crate);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.1,
        10,
        0,
      );

      expect(proj.isBoomerang).toBe(false);
      expect(result.convertedToPickup).toBe(true);
    });

    it('boomerang hits player → loses boomerang → pickup', () => {
      const proj = createThrownProjectile({
        ownerId: 'p1',
        position: new Position(190, 100),
        vx: 400,
        vy: 0,
        bounces: 3,
        durability: 5,
        isBoomerang: true,
        returnTargetId: 'p1',
        boomerangTimeoutTick: 200,
        maxRange: 800,
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const target = createPlayer('target', 200, 100);
      players.set('target', target);

      const result = handler.updateProjectile(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        10,
        0,
      );

      expect(result.convertedToPickup).toBe(true);
    });
  });
});

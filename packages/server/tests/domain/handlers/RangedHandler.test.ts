import { RangedHandler } from '../../../src/domain/handlers/RangedHandler.ts';
import { ProjectileCollider } from '../../../src/domain/handlers/ProjectileCollider.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import { Projectile } from '../../../src/domain/entities/Projectile.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { WeaponType, TileType, COMBAT } from '@sector-battle/shared';
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

function createArrowProjectile(
  overrides: Partial<{
    id: string;
    ownerId: string;
    position: Position;
    vx: number;
    vy: number;
    damage: number;
    maxRange: number;
  }> = {},
): Projectile {
  return new Projectile(
    overrides.id ?? 'arrow-1',
    overrides.ownerId ?? 'p1',
    overrides.position ?? new Position(100, 100),
    overrides.vx ?? 600,
    overrides.vy ?? 0,
    overrides.damage ?? 15,
    -1,
    WeaponType.SHORT_BOW,
    0,
    overrides.maxRange ?? 1000,
    'arrow',
  );
}

/**
 * server-projectile-collider-unify: updateArrow takes the shared
 * ProjectileCollider instead of the (grid, tileSize, players, destructibles)
 * parameter bundle. Same maps/grid per test, no spatial index (the
 * collider's collect* fallback = the old full-map scan).
 */
function makeCollider(
  grid: TileType[][],
  players: Map<string, Player> = new Map(),
  destructibles: Map<string, Destructible> = new Map(),
): ProjectileCollider {
  return new ProjectileCollider({ players, destructibles, grid, tileSize: 64 });
}

const handler = new RangedHandler();

describe('RangedHandler', () => {
  describe('fire', () => {
    it('creates projectile with correct velocity', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-1' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 500, 0, idGen, 2000);

      expect(result.consumed).toBe(true);
      expect(result.projectile).not.toBeNull();
      expect(result.projectile!.velocityX).toBeCloseTo(2000);
      expect(result.projectile!.velocityY).toBeCloseTo(0);
      expect(result.projectile!.ownerId).toBe('p1');
      expect(result.projectile!.damage).toBe(15);
      expect(result.projectile!.position.x).toBe(100 + 48);
      expect(result.projectile!.position.y).toBe(100);
    });

    it('creates projectile at 45-degree angle', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-2' };
      const result = handler.fire(
        'p1',
        pos,
        WeaponType.SHORT_BOW,
        15,
        5,
        500,
        Math.PI / 4,
        idGen,
        2000,
      );

      expect(result.projectile).not.toBeNull();
      expect(result.projectile!.velocityX).toBeCloseTo(2000 * Math.cos(Math.PI / 4));
      expect(result.projectile!.velocityY).toBeCloseTo(2000 * Math.sin(Math.PI / 4));
    });

    it('returns null when aimAngle is NaN', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-3' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 500, NaN, idGen, 2000);

      expect(result).toEqual({ projectile: null, consumed: false });
    });

    it('creates arrow type projectile', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-4' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 500, 0, idGen, 2000);

      expect(result.projectile!.projectileType).toBe('arrow');
    });

    it('sets projectile durability to 0', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-5' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 500, 0, idGen, 2000);

      expect(result.projectile!.durability).toBe(0);
    });

    it('sets projectile bounces to -1', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-6' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 500, 0, idGen, 2000);

      expect(result.projectile!.bouncesRemaining).toBe(-1);
    });

    it('uses idGenerator for projectile id', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-1' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 500, 0, idGen, 2000);

      expect(result.projectile!.id).toBe('arrow-1');
    });

    it('respects maxRange parameter', () => {
      const pos = new Position(100, 100);
      const idGen = { next: () => 'arrow-7' };
      const result = handler.fire('p1', pos, WeaponType.SHORT_BOW, 15, 5, 300, 0, idGen, 2000);

      expect(result.projectile!.maxRange).toBe(300);
    });
  });

  describe('updateArrow', () => {
    it('moves forward alive when no obstacles', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, new Map(), new Map()),
        1 / 60,
        0,
        1000,
      );

      expect(result.alive).toBe(true);
      expect(result.hit).toBe(false);
      expect(result.distanceTraveled).toBeCloseTo(10);
    });

    it('hits player within HITBOX_RADIUS', () => {
      const proj = createArrowProjectile({ position: new Position(190, 100) });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      players.set('p2', createPlayer('p2', 200, 100));

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        0,
        1000,
      );

      expect(result.alive).toBe(false);
      expect(result.hit).toBe(true);
      expect(result.hitPlayerId).toBe('p2');
    });

    it('skips owner player', () => {
      const proj = createArrowProjectile({
        position: new Position(190, 100),
        ownerId: 'p1',
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      players.set('p1', createPlayer('p1', 200, 100));

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        0,
        1000,
      );

      expect(result.alive).toBe(true);
    });

    it('skips dead players', () => {
      const proj = createArrowProjectile({
        position: new Position(190, 100),
        ownerId: 'p1',
      });
      const grid = createEmptyGrid();
      const players = new Map<string, Player>();
      const deadPlayer = createPlayer('p2', 200, 100);
      deadPlayer.takeDamage(100, 0, true);
      players.set('p2', deadPlayer);

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, players, new Map()),
        1 / 60,
        0,
        1000,
      );

      expect(result.alive).toBe(false);
      expect(result.hit).toBe(true);
      expect(result.hitPlayerId).toBe('p2');
    });

    it('hits wall and disappears', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();
      grid[1][2] = TileType.INDESTRUCTIBLE_WALL;

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, new Map(), new Map()),
        0.2,
        0,
        1000,
      );

      expect(result.alive).toBe(false);
      expect(result.hit).toBe(false);
      expect(result.destructibleHit).toBeNull();
    });

    it('detects destructible hit before wall check', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();
      grid[1][2] = TileType.INDESTRUCTIBLE_WALL;
      const destructibles = new Map<string, Destructible>();
      destructibles.set('d1', Destructible.create('d1', 'crate', new Position(220, 100)));

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, new Map(), destructibles),
        0.2,
        0,
        1000,
      );

      expect(result.alive).toBe(false);
      expect(result.destructibleHit).not.toBeNull();
      expect(result.destructibleHit!.id).toBe('d1');
    });

    it('destructible hit returns destroyed flag', () => {
      const grid = createEmptyGrid();

      const proj1 = createArrowProjectile();
      const destructibles1 = new Map<string, Destructible>();
      destructibles1.set('crate1', Destructible.create('crate1', 'crate', new Position(110, 100)));

      const result1 = handler.updateArrow(
        proj1,
        makeCollider(grid, new Map(), destructibles1),
        1 / 60,
        0,
        1000,
      );
      expect(result1.destructibleHit!.destroyed).toBe(true);

      const proj2 = createArrowProjectile({ id: 'arrow-2' });
      const destructibles2 = new Map<string, Destructible>();
      destructibles2.set(
        'barrel1',
        Destructible.create('barrel1', 'barrel', new Position(110, 100)),
      );

      const result2 = handler.updateArrow(
        proj2,
        makeCollider(grid, new Map(), destructibles2),
        1 / 60,
        0,
        1000,
      );
      expect(result2.destructibleHit!.destroyed).toBe(false);
    });

    it('destructible hit returns shouldExplode for barrel', () => {
      const grid = createEmptyGrid();

      const proj1 = createArrowProjectile();
      const destructibles1 = new Map<string, Destructible>();
      const barrel = Destructible.create('barrel1', 'barrel', new Position(110, 100));
      barrel.takeDamage({ source: 'arrow', rawDamage: 1 });
      destructibles1.set('barrel1', barrel);

      const result1 = handler.updateArrow(
        proj1,
        makeCollider(grid, new Map(), destructibles1),
        1 / 60,
        0,
        1000,
      );
      expect(result1.destructibleHit!.shouldExplode).toBe(true);

      const proj2 = createArrowProjectile({ id: 'arrow-2b' });
      const destructibles2 = new Map<string, Destructible>();
      destructibles2.set('crate1', Destructible.create('crate1', 'crate', new Position(110, 100)));

      const result2 = handler.updateArrow(
        proj2,
        makeCollider(grid, new Map(), destructibles2),
        1 / 60,
        0,
        1000,
      );
      expect(result2.destructibleHit!.shouldExplode).toBe(false);
    });

    it('range exceeded', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, new Map(), new Map()),
        1 / 60,
        0,
        5,
      );

      expect(result.alive).toBe(false);
      expect(result.exceededRange).toBe(true);
    });

    it('accumulates distanceTraveled', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, new Map(), new Map()),
        1 / 60,
        50,
        1000,
      );

      expect(result.distanceTraveled).toBeCloseTo(60);
    });

    it('priority: destructible > wall > player > range', () => {
      const grid = createEmptyGrid();
      grid[1][2] = TileType.INDESTRUCTIBLE_WALL;
      const players = new Map<string, Player>();
      players.set('p2', createPlayer('p2', 220, 100));
      const destructibles = new Map<string, Destructible>();
      destructibles.set('d1', Destructible.create('d1', 'crate', new Position(220, 100)));

      const proj1 = createArrowProjectile();
      const r1 = handler.updateArrow(
        proj1,
        makeCollider(grid, players, destructibles),
        0.2,
        0,
        1000,
      );
      expect(r1.destructibleHit).not.toBeNull();

      const proj2 = createArrowProjectile({ id: 'arrow-p2' });
      const r2 = handler.updateArrow(proj2, makeCollider(grid, players, new Map()), 0.2, 0, 1000);
      expect(r2.alive).toBe(false);
      expect(r2.hit).toBe(false);
      expect(r2.destructibleHit).toBeNull();

      const proj3 = createArrowProjectile({ id: 'arrow-p3' });
      const r3 = handler.updateArrow(
        proj3,
        makeCollider(createEmptyGrid(), players, new Map()),
        0.2,
        0,
        1000,
      );
      expect(r3.hit).toBe(true);
      expect(r3.hitPlayerId).toBe('p2');

      const proj4 = createArrowProjectile({ id: 'arrow-p4' });
      const r4 = handler.updateArrow(
        proj4,
        makeCollider(createEmptyGrid(), new Map(), new Map()),
        0.2,
        0,
        5,
      );
      expect(r4.exceededRange).toBe(true);
    });

    it('wall hit snaps projectile position', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();
      grid[1][2] = TileType.INDESTRUCTIBLE_WALL;

      handler.updateArrow(proj, makeCollider(grid, new Map(), new Map()), 0.2, 0, 1000);

      expect(proj.position.x).toBe(120);
      expect(proj.position.y).toBe(100);
    });

    it('isSolidTile checks all solid types', () => {
      const solidTypes: TileType[] = [
        TileType.INDESTRUCTIBLE_WALL,
        TileType.DESTRUCTIBLE_WALL,
        TileType.DESTRUCTIBLE_BARREL,
        TileType.INDESTRUCTIBLE_CRATE,
        TileType.CHEST,
      ];

      for (const tileType of solidTypes) {
        const proj = createArrowProjectile({ id: `solid-${tileType}` });
        const grid = createEmptyGrid();
        grid[1][2] = tileType;

        const result = handler.updateArrow(
          proj,
          makeCollider(grid, new Map(), new Map()),
          0.2,
          0,
          1000,
      );

        expect(result.alive).toBe(false);
      }

      const nonSolidTypes: TileType[] = [TileType.EMPTY, TileType.EXIT];

      for (const tileType of nonSolidTypes) {
        const proj = createArrowProjectile({ id: `nsolid-${tileType}` });
        const grid = createEmptyGrid();
        grid[1][2] = tileType;

        const result = handler.updateArrow(
          proj,
          makeCollider(grid, new Map(), new Map()),
          0.2,
          0,
          1000,
      );

        expect(result.alive).toBe(true);
      }
    });

    it('skips destroyed destructibles', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();
      const destructibles = new Map<string, Destructible>();
      const crate = Destructible.create('d1', 'crate', new Position(110, 100));
      crate.takeDamage({ source: 'melee', rawDamage: 2 });
      destructibles.set('d1', crate);

      const result = handler.updateArrow(
        proj,
        makeCollider(grid, new Map(), destructibles),
        1 / 60,
        0,
        1000,
      );

      expect(result.alive).toBe(true);
    });

    it('no movement when dt = 0', () => {
      const proj = createArrowProjectile();
      const grid = createEmptyGrid();

      const result = handler.updateArrow(proj, makeCollider(grid, new Map(), new Map()), 0, 0, 1000);

      expect(result.alive).toBe(true);
    });
  });
});

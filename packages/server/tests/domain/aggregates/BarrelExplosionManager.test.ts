import { describe, it, expect, vi } from 'vitest';
import {
  TileType,
  IdGenerator,
  DamageType,
  EntityType,
  BARREL,
  PlayerStatus,
  type GameConfig,
} from '@sector-battle/shared';
import { BarrelExplosionManager } from '../../../src/domain/aggregates/BarrelExplosionManager.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Destructible, type DestructibleType } from '../../../src/domain/entities/Destructible.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import type { DamagePipeline } from '../../../src/domain/services/DamagePipeline.ts';
import type { DomainEvent } from '../../../src/domain/events/index.ts';

function makeGrid(rows: number, cols: number, fill: TileType): TileType[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(fill) as TileType[]);
}

function createTestConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 2.0,
      dashDuration: 0.5,
      dashCooldown: 3.0,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 96,
      hitboxHeight: 96,
    },
    weapons: [],
    zone: {
      totalDuration: 36000,
      transitionDuration: 1800,
      tickInterval: 30,
      warningTime: 1800,
      phases: [],
    },
    match: {
      targetDuration: 36000,
      maxPlayers: 16,
      minPlayers: 2,
      countdownDuration: 300,
      overtimeStart: 36000,
    },
    map: {
      tileWidth: 64,
      tileHeight: 64,
      arenaWidth: 640,
      arenaHeight: 640,
      sectorSize: 320,
      corridorWidth: 2,
      destructibleDensity: 0.3,
      chestDensity: 0.1,
      exitCount: 1,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 300,
      bounceFactor: 0.5,
      maxBounces: 3,
      projectileSpeed: 400,
      friendlyFire: true,
    },
    network: {
      tickRate: 60,
      patchRate: 50,
      maxLatency: 200,
      inputBufferSize: 120,
      snapshotInterval: 0,
    },
    ...overrides,
  };
}

function createMockDamagePipeline(overrides: Partial<DamagePipeline> = {}): DamagePipeline {
  return {
    processAttack: vi.fn(() => []),
    processDamage: vi.fn(() => ({ events: [], killed: false, damageApplied: 10 })),
    checkPlayersInExplosion: vi.fn(() => []),
    ...overrides,
  } as unknown as DamagePipeline;
}

interface TestContext {
  players: Map<string, Player>;
  explosions: Map<string, unknown>;
  destructibles: Map<string, Destructible>;
  grid: TileType[][];
  events: DomainEvent[];
  config: GameConfig;
  idGenerator: IdGenerator;
  damagePipeline: DamagePipeline;
  siegeWallManager: { hasSiegeWall(gridX: number, gridY: number): boolean };
  getAlivePlayerCount(): number;
}

function createBarrelContext(overrides: Partial<TestContext> = {}): TestContext {
  const grid = makeGrid(10, 10, TileType.EMPTY);
  const config = createTestConfig();
  const players = new Map<string, Player>();
  const explosions = new Map<string, unknown>();
  const destructibles = new Map<string, Destructible>();
  const events: DomainEvent[] = [];
  return {
    players,
    explosions,
    destructibles,
    grid,
    events,
    config,
    idGenerator: new IdGenerator('test'),
    damagePipeline: createMockDamagePipeline(),
    siegeWallManager: { hasSiegeWall: () => false },
    getAlivePlayerCount: () => [...players.values()].filter((p) => p.isActive).length,
    ...overrides,
  };
}

function createPlayerAt(id: string, gx: number, gy: number, config: GameConfig): Player {
  const tw = config.map.tileWidth;
  const th = config.map.tileHeight;
  const player = new Player(
    id,
    `Player-${id}`,
    new Position(gx * tw + tw / 2, gy * th + th / 2),
    config.player,
  );
  player.statusEffects.status = PlayerStatus.ALIVE;
  return player;
}

function createDestructibleAt(
  id: string,
  type: DestructibleType,
  gx: number,
  gy: number,
  config: GameConfig,
): Destructible {
  const tw = config.map.tileWidth;
  const th = config.map.tileHeight;
  return Destructible.create(id, type, new Position(gx * tw + tw / 2, gy * th + th / 2));
}

describe('BarrelExplosionManager', () => {
  const config = createTestConfig();
  const tw = config.map.tileWidth;
  const th = config.map.tileHeight;

  describe('resolveExplosion', () => {
    it('destroys 8 adjacent destructibles via 8 rays', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const destructibles = new Map<string, Destructible>();

      const adjacentPositions = [
        [6, 5],
        [4, 5],
        [5, 6],
        [5, 4],
        [6, 6],
        [4, 6],
        [6, 4],
        [4, 4],
      ];

      for (let i = 0; i < adjacentPositions.length; i++) {
        const [gx, gy] = adjacentPositions[i]!;
        const d = createDestructibleAt(`d-${i}`, 'crate', gx, gy, config);
        destructibles.set(d.id, d);
      }

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const destroyedEvents = events.filter((e) => e.type === 'DestructibleDestroyed') as Extract<
        DomainEvent,
        { type: 'DestructibleDestroyed' }
      >[];
      expect(destroyedEvents.length).toBe(8);

      for (const [gx, gy] of adjacentPositions) {
        expect(destroyedEvents.some((e) => e.gridX === gx && e.gridY === gy)).toBe(true);
      }
    });

    it('emits BarrelExploded event with correct data', () => {
      const ctx = createBarrelContext({ config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const barrelEvent = events.find((e) => e.type === 'BarrelExploded') as
        | Extract<DomainEvent, { type: 'BarrelExploded' }>
        | undefined;
      expect(barrelEvent).toBeDefined();
      expect(barrelEvent!.radius).toBe(BARREL.EXPLOSION_RADIUS);
      expect(barrelEvent!.damage).toBe(BARREL.EXPLOSION_DAMAGE);
    });

    it('creates Explosion entity at origin', () => {
      const ctx = createBarrelContext({ config });
      const manager = new BarrelExplosionManager(ctx);

      manager.resolveExplosion(5, 5, 'test', 0);

      expect(ctx.explosions.size).toBe(1);
    });

    it('stops ray at INDESTRUCTIBLE_WALL', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      grid[5]![7] = TileType.INDESTRUCTIBLE_WALL;

      const crateBefore = createDestructibleAt('crate-before', 'crate', 6, 5, config);
      const crateAfter = createDestructibleAt('crate-after', 'crate', 8, 5, config);
      const destructibles = new Map([
        [crateBefore.id, crateBefore],
        [crateAfter.id, crateAfter],
      ]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const destroyedPositions = events
        .filter((e) => e.type === 'DestructibleDestroyed')
        .map((e) => ({
          x: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridX,
          y: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridY,
        }));

      expect(destroyedPositions.some((p) => p.x === 6 && p.y === 5)).toBe(true);
      expect(destroyedPositions.some((p) => p.x === 8 && p.y === 5)).toBe(false);
    });

    it('stops ray at INDESTRUCTIBLE_CRATE', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      grid[5]![7] = TileType.INDESTRUCTIBLE_CRATE;

      const crateBefore = createDestructibleAt('crate-before', 'crate', 6, 5, config);
      const crateAfter = createDestructibleAt('crate-after', 'crate', 8, 5, config);
      const destructibles = new Map([
        [crateBefore.id, crateBefore],
        [crateAfter.id, crateAfter],
      ]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const destroyedPositions = events
        .filter((e) => e.type === 'DestructibleDestroyed')
        .map((e) => ({
          x: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridX,
          y: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridY,
        }));

      expect(destroyedPositions.some((p) => p.x === 6 && p.y === 5)).toBe(true);
      expect(destroyedPositions.some((p) => p.x === 8 && p.y === 5)).toBe(false);
    });

    it('stops ray at active siege wall', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);

      const crateBefore = createDestructibleAt('crate-before', 'crate', 6, 5, config);
      const crateAfter = createDestructibleAt('crate-after', 'crate', 8, 5, config);
      const destructibles = new Map([
        [crateBefore.id, crateBefore],
        [crateAfter.id, crateAfter],
      ]);

      const ctx = createBarrelContext({
        grid,
        destructibles,
        config,
        siegeWallManager: {
          hasSiegeWall: (gx: number, gy: number) => gx === 7 && gy === 5,
        },
      });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const destroyedPositions = events
        .filter((e) => e.type === 'DestructibleDestroyed')
        .map((e) => ({
          x: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridX,
          y: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridY,
        }));

      expect(destroyedPositions.some((p) => p.x === 6 && p.y === 5)).toBe(true);
      expect(destroyedPositions.some((p) => p.x === 8 && p.y === 5)).toBe(false);
    });

    it('stops ray at destructible wall — wall destroyed, tiles behind safe', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      grid[5]![6] = TileType.DESTRUCTIBLE_WALL;

      const wallDest = createDestructibleAt('wall-1', 'wall', 6, 5, config);
      const crateBeyond = createDestructibleAt('crate-beyond', 'crate', 7, 5, config);
      const destructibles = new Map([
        [wallDest.id, wallDest],
        [crateBeyond.id, crateBeyond],
      ]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const destroyedPositions = events
        .filter((e) => e.type === 'DestructibleDestroyed')
        .map((e) => ({
          x: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridX,
          y: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridY,
        }));

      expect(destroyedPositions.some((p) => p.x === 6 && p.y === 5)).toBe(true);
      expect(destroyedPositions.some((p) => p.x === 7 && p.y === 5)).toBe(false);
      expect(grid[5]![6]).toBe(TileType.EMPTY);
    });

    it('destroys barrel and triggers recursive explosion instantly', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const barrel = createDestructibleAt('barrel-1', 'barrel', 6, 5, config);
      const destructibles = new Map([[barrel.id, barrel]]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const barrelEvents = events.filter((e) => e.type === 'BarrelExploded');
      expect(barrelEvents.length).toBe(2);
      expect(barrel.isDestroyed).toBe(true);
      expect(ctx.explosions.size).toBe(2);
    });

    it('respects maxRayDistance — ray stops at max tile range', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const destructibles = new Map<string, Destructible>();

      for (let x = 6; x <= 16; x++) {
        const d = createDestructibleAt(`d-${x}`, 'crate', x, 5, config);
        destructibles.set(d.id, d);
      }

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const eastXPositions = events
        .filter((e) => e.type === 'DestructibleDestroyed')
        .map((e) => ({
          x: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridX,
          y: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridY,
        }))
        .filter((p) => p.y === 5 && p.x >= 6);

      expect(eastXPositions.length).toBe(1);
      expect(eastXPositions[0]!.x).toBe(6);
    });

    it('damages player on ray path', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const player = createPlayerAt('p1', 6, 5, config);
      const players = new Map([[player.id, player]]);

      const damagePipeline = createMockDamagePipeline({
        processDamage: vi.fn(() => ({
          events: [
            {
              type: 'PlayerDamaged',
              tick: 0,
              timestamp: Date.now(),
              playerId: 'p1',
              damage: BARREL.EXPLOSION_DAMAGE,
              sourceId: 'test',
              damageType: DamageType.BARREL_EXPLOSION,
              killed: false,
            },
          ],
          killed: false,
          damageApplied: BARREL.EXPLOSION_DAMAGE,
        })),
      });

      const ctx = createBarrelContext({ grid, players, config, damagePipeline });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const dmgEvent = events.find((e) => e.type === 'PlayerDamaged') as
        | Extract<DomainEvent, { type: 'PlayerDamaged' }>
        | undefined;
      expect(dmgEvent).toBeDefined();
      expect(dmgEvent!.playerId).toBe('p1');
      expect(dmgEvent!.damage).toBe(BARREL.EXPLOSION_DAMAGE);
    });

    it('does not damage player off ray path (between rays)', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const player = createPlayerAt('p1', 7, 6, config);
      const players = new Map([[player.id, player]]);

      const called = { count: 0 };
      const damagePipeline = createMockDamagePipeline({
        processDamage: vi.fn(() => {
          called.count++;
          return { events: [], killed: false, damageApplied: 0 };
        }),
      });

      const ctx = createBarrelContext({ grid, players, config, damagePipeline });
      const manager = new BarrelExplosionManager(ctx);

      manager.resolveExplosion(5, 5, 'test', 0);

      expect(called.count).toBe(0);
    });

    it('kills player on ray path', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const player = createPlayerAt('p1', 6, 5, config);
      const players = new Map([[player.id, player]]);

      const damagePipeline = createMockDamagePipeline({
        processDamage: vi.fn(() => ({
          events: [
            {
              type: 'PlayerDamaged',
              tick: 0,
              timestamp: Date.now(),
              playerId: 'p1',
              damage: BARREL.EXPLOSION_DAMAGE,
              sourceId: 'test',
              damageType: DamageType.BARREL_EXPLOSION,
              killed: true,
            },
            {
              type: 'PlayerEliminated',
              tick: 0,
              timestamp: Date.now(),
              playerId: 'p1',
              killedBy: 'test',
              cause: 'barrel_explosion',
            },
          ],
          killed: true,
          damageApplied: BARREL.EXPLOSION_DAMAGE,
        })),
      });

      const ctx = createBarrelContext({ grid, players, config, damagePipeline });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const elimEvent = events.find((e) => e.type === 'PlayerEliminated') as
        | Extract<DomainEvent, { type: 'PlayerEliminated' }>
        | undefined;
      expect(elimEvent).toBeDefined();
      expect(elimEvent!.cause).toBe('barrel_explosion');
    });

    it('does not double-damage same player from same explosion', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const player = createPlayerAt('p1', 6, 5, config);
      const players = new Map([[player.id, player]]);

      const callCount = { value: 0 };
      const damagePipeline = createMockDamagePipeline({
        processDamage: vi.fn(() => {
          callCount.value++;
          return {
            events: [
              {
                type: 'PlayerDamaged',
                tick: 0,
                timestamp: Date.now(),
                playerId: 'p1',
                damage: BARREL.EXPLOSION_DAMAGE,
                sourceId: 'test',
                damageType: DamageType.BARREL_EXPLOSION,
                killed: false,
              },
            ],
            killed: false,
            damageApplied: BARREL.EXPLOSION_DAMAGE,
          };
        }),
      });

      const ctx = createBarrelContext({ grid, players, config, damagePipeline });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const playerDamaged = events.filter(
        (e) =>
          e.type === 'PlayerDamaged' &&
          (e as Extract<DomainEvent, { type: 'PlayerDamaged' }>).playerId === 'p1',
      );
      expect(playerDamaged.length).toBe(1);
    });

    it('does not damage invulnerable player', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const player = createPlayerAt('p1', 6, 5, config);
      const players = new Map([[player.id, player]]);

      const damagePipeline = createMockDamagePipeline({
        processDamage: vi.fn(() => ({ events: [], killed: false, damageApplied: 0 })),
      });

      const ctx = createBarrelContext({ grid, players, config, damagePipeline });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const dmgEvent = events.find((e) => e.type === 'PlayerDamaged');
      expect(dmgEvent).toBeUndefined();
    });

    it('processes multiple rays independently', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const crateEast = createDestructibleAt('crate-e', 'crate', 7, 5, config);
      const crateSouth = createDestructibleAt('crate-s', 'crate', 5, 7, config);
      const destructibles = new Map([
        [crateEast.id, crateEast],
        [crateSouth.id, crateSouth],
      ]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const destroyedPositions = events
        .filter((e) => e.type === 'DestructibleDestroyed')
        .map((e) => ({
          x: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridX,
          y: (e as Extract<DomainEvent, { type: 'DestructibleDestroyed' }>).gridY,
        }));

      expect(destroyedPositions.some((p) => p.x === 7 && p.y === 5)).toBe(true);
      expect(destroyedPositions.some((p) => p.x === 5 && p.y === 7)).toBe(true);
    });

    it('destroys destructible wall entity and clears grid tile', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      grid[3]![5] = TileType.DESTRUCTIBLE_WALL;

      const wall = createDestructibleAt('wall-1', 'wall', 5, 3, config);
      const destructibles = new Map([[wall.id, wall]]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 0, 'source', 0);

      expect(grid[3]![5]).toBe(TileType.EMPTY);
      const destroyed = events.find((e) => e.type === 'DestructibleDestroyed') as
        | Extract<DomainEvent, { type: 'DestructibleDestroyed' }>
        | undefined;
      expect(destroyed).toBeDefined();
      expect(destroyed!.gridX).toBe(5);
      expect(destroyed!.gridY).toBe(3);
    });

    it('enforces safety cap of MAX_EXPLOSIONS_PER_RESOLUTION', () => {
      const bigConfig = createTestConfig();
      const grid = makeGrid(30, 30, TileType.EMPTY);
      const destructibles = new Map<string, Destructible>();

      for (let i = 0; i < 25; i++) {
        const barrel = createDestructibleAt(`b-${i}`, 'barrel', i + 2, 5, bigConfig);
        destructibles.set(barrel.id, barrel);
      }

      const ctx = createBarrelContext({ grid, destructibles, config: bigConfig });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(1, 5, 'test', 0);

      const barrelExploded = events.filter((e) => e.type === 'BarrelExploded');
      expect(barrelExploded.length).toBeLessThanOrEqual(BARREL.MAX_EXPLOSIONS_PER_RESOLUTION);
    });

    it('three barrels in line all resolve in single call', () => {
      const grid = makeGrid(20, 20, TileType.EMPTY);
      const barrel1 = createDestructibleAt('b1', 'barrel', 6, 5, config);
      const barrel2 = createDestructibleAt('b2', 'barrel', 8, 5, config);
      const destructibles = new Map([
        [barrel1.id, barrel1],
        [barrel2.id, barrel2],
      ]);

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(5, 5, 'test', 0);

      const barrelEvents = events.filter((e) => e.type === 'BarrelExploded');
      expect(barrelEvents.length).toBe(3);
      expect(barrel1.isDestroyed).toBe(true);
      expect(barrel2.isDestroyed).toBe(true);
    });

    it('calls loot callback for destroyed crates', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const crate = createDestructibleAt('crate-1', 'crate', 6, 5, config);
      const destructibles = new Map([[crate.id, crate]]);

      let lootCalled = false;
      const ctx = createBarrelContext({
        grid,
        destructibles,
        config,
        onDestructibleDestroyedByExplosion: () => {
          lootCalled = true;
          return null;
        },
      } as Partial<TestContext>);
      const manager = new BarrelExplosionManager(ctx as TestContext);

      manager.resolveExplosion(5, 5, 'test', 0);

      expect(lootCalled).toBe(true);
    });

    it('does not call loot callback for destroyed barrels', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const barrel = createDestructibleAt('barrel-1', 'barrel', 6, 5, config);
      const destructibles = new Map([[barrel.id, barrel]]);

      let lootCalled = false;
      const ctx = createBarrelContext({
        grid,
        destructibles,
        config,
        onDestructibleDestroyedByExplosion: () => {
          lootCalled = true;
          return null;
        },
      } as Partial<TestContext>);
      const manager = new BarrelExplosionManager(ctx as TestContext);

      manager.resolveExplosion(5, 5, 'test', 0);

      expect(lootCalled).toBe(false);
    });

    it('barrel on ray path at depth 19 still explodes', () => {
      const grid = makeGrid(30, 30, TileType.EMPTY);
      const destructibles = new Map<string, Destructible>();

      for (let i = 0; i < 19; i++) {
        const barrel = createDestructibleAt(`b-${i}`, 'barrel', i + 2, 5, config);
        destructibles.set(barrel.id, barrel);
      }

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(1, 5, 'test', 0);

      const barrelExploded = events.filter((e) => e.type === 'BarrelExploded');
      expect(barrelExploded.length).toBeGreaterThanOrEqual(19);
    });

    it('barrel beyond safety cap dies silently', () => {
      const grid = makeGrid(50, 50, TileType.EMPTY);
      const destructibles = new Map<string, Destructible>();

      for (let i = 0; i < 25; i++) {
        const barrel = createDestructibleAt(`b-${i}`, 'barrel', i + 2, 5, config);
        destructibles.set(barrel.id, barrel);
      }

      const ctx = createBarrelContext({ grid, destructibles, config });
      const manager = new BarrelExplosionManager(ctx);

      const events = manager.resolveExplosion(1, 5, 'test', 0);

      const barrelExploded = events.filter((e) => e.type === 'BarrelExploded');
      const destroyed = events.filter((e) => e.type === 'DestructibleDestroyed');

      expect(barrelExploded.length).toBe(BARREL.MAX_EXPLOSIONS_PER_RESOLUTION);
      expect(destroyed.length).toBeGreaterThanOrEqual(BARREL.MAX_EXPLOSIONS_PER_RESOLUTION);
      expect(destroyed.length).toBeLessThanOrEqual(25);
    });
  });
});

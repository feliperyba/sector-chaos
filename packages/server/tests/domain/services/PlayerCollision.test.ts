import {
  TileType,
  PLAYER,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { CollisionService } from '../../../src/domain/services/CollisionService.ts';
import { MovementService } from '../../../src/domain/services/MovementService.ts';
import { Player } from '../../../src/domain/entities/index.ts';
import { Position, Direction } from '../../../src/domain/value-objects/index.ts';

const TILE_SIZE = 48;

function createDefaultPlayerConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 10,
    dashCooldown: 60,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: PLAYER.HITBOX_WIDTH,
    hitboxHeight: PLAYER.HITBOX_HEIGHT,
    ...overrides,
  };
}

function createDefaultGameConfig(overrides?: Partial<GameConfig>): GameConfig {
  return {
    player: createDefaultPlayerConfig(),
    weapons: [],
    zone: {
      phases: [],
      totalDuration: 300,
      transitionDuration: 900,
      tickInterval: 60,
      warningTime: 300,
    },
    match: {
      targetDuration: 18000,
      maxPlayers: 64,
      minPlayers: 2,
      countdownDuration: 180,
      overtimeStart: 27000,
    },
    map: {
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      arenaWidth: 15,
      arenaHeight: 15,
      sectorSize: 5,
      corridorWidth: 1,
      destructibleDensity: 0.3,
      chestDensity: 0.05,
      exitCount: 2,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 5,
      bounceFactor: 0.8,
      maxBounces: 3,
      projectileSpeed: 300,
      friendlyFire: false,
    },
    network: {
      tickRate: 60,
      patchRate: 20,
      maxLatency: 500,
      inputBufferSize: 60,
      snapshotInterval: 3,
    },
    ...overrides,
  };
}

function createEmptyGrid(width: number, height: number): TileType[][] {
  return Array.from({ length: height }, () => Array(width).fill(TileType.EMPTY));
}

function createService(
  maxSpeed: number = PLAYER.BASE_SPEED,
  tileSize: number = TILE_SIZE,
): MovementService {
  const collisionService = new CollisionService(tileSize);
  return new MovementService(collisionService, maxSpeed, tileSize);
}

describe('PlayerCollision', () => {
  describe('resolvePlayerCollision', () => {
    it('pushes moving player away from other player on overlap', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200, 200), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;
      p1.statusEffects.clearStatus(1);
      p1.statusEffects.setStatus(1);
      p2.statusEffects.clearStatus(1);
      p2.statusEffects.setStatus(1);

      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p2),
        new Position(200, 200),
        0,
      );
      const distance = resolved.distanceTo(p2.movement.position);
      expect(distance).toBeGreaterThan(0);
    });

    it('does not resolve collision when moving player is dashing', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200, 200), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;
      p1.startDash();
      p1.movement.isDashing = true;

      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p2),
        new Position(200, 200),
        0,
      );
      expect(resolved.x).toBe(200);
      expect(resolved.y).toBe(200);
    });

    it('skips self-collision', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);

      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p1),
        new Position(200, 200),
        0,
      );
      expect(resolved.x).toBe(200);
      expect(resolved.y).toBe(200);
    });

    it('skips inactive and non-death-collision players', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200, 200), config);
      p1.spawnTick = -9999;
      p2.die();

      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p2),
        new Position(200, 200),
        1000,
      );
      expect(resolved.x).toBe(200);
      expect(resolved.y).toBe(200);
    });

    it('resolves with dead player during death animation window', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200, 200), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;
      p1.statusEffects.clearStatus(1);
      p1.statusEffects.setStatus(1);
      p2.dieWithTick(0);

      const deathAnimTicks = Math.round(PLAYER.DASH_DURATION * 60);
      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p2),
        new Position(200, 200),
        deathAnimTicks - 1,
      );
      const distance = resolved.distanceTo(p2.movement.position);
      expect(distance).toBeGreaterThan(0);
    });

    it('does not resolve with dead player after death animation window', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200, 200), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;
      p2.dieWithTick(0);

      const deathAnimTicks = Math.round(PLAYER.DASH_DURATION * 60);
      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p2),
        new Position(200, 200),
        deathAnimTicks + 100,
      );
      expect(resolved.x).toBe(200);
      expect(resolved.y).toBe(200);
    });

    it('resolves collision along X axis when players overlap horizontally', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const overlap = 10;
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player(
        'p2',
        'Bob',
        new Position(200 + PLAYER.HITBOX_WIDTH - overlap, 200),
        config,
      );
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;

      const resolved = service.resolvePlayerCollision(p1, (cb) => cb(p2), p1.movement.position, 0);
      expect(resolved.x).toBeLessThan(p1.movement.position.x);
    });

    it('resolves collision along Y axis when players overlap vertically', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const overlap = 10;
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player(
        'p2',
        'Bob',
        new Position(200, 200 + PLAYER.HITBOX_HEIGHT - overlap),
        config,
      );
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;

      const resolved = service.resolvePlayerCollision(p1, (cb) => cb(p2), p1.movement.position, 0);
      expect(resolved.y).toBeLessThan(p1.movement.position.y);
    });

    it('resolves with multiple players', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const p1 = new Player('p1', 'Alice', new Position(400, 400), config);
      const p2 = new Player('p2', 'Bob', new Position(400, 400), config);
      const p3 = new Player('p3', 'Charlie', new Position(400, 400), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;
      p3.spawnTick = -9999;

      const resolved = service.resolvePlayerCollision(
        p1,
        (cb) => {
          cb(p2);
          cb(p3);
        },
        new Position(400, 400),
        0,
      );
      const dist2 = resolved.distanceTo(p2.movement.position);
      expect(dist2).toBeGreaterThan(0);
    });
  });

  describe('resolveDashEndOverlap', () => {
    it('pushes dashing player back along last movement direction', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const grid = createEmptyGrid(15, 15);
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200, 200), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;
      p1.movement.lastMoveDirection = Direction.RIGHT;

      const resolved = service.resolveDashEndOverlap(p1, (cb) => cb(p2), grid);
      expect(resolved.x).toBeLessThan(p1.movement.position.x);
    });

    it('returns same position when no overlap exists', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const grid = createEmptyGrid(15, 15);
      const p1 = new Player('p1', 'Alice', new Position(200, 200), config);
      const p2 = new Player('p2', 'Bob', new Position(200 + PLAYER.HITBOX_WIDTH * 2, 200), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;

      const resolved = service.resolveDashEndOverlap(p1, (cb) => cb(p2), grid);
      expect(resolved.x).toBe(p1.movement.position.x);
      expect(resolved.y).toBe(p1.movement.position.y);
    });
  });

  describe('two players moving toward each other', () => {
    it('push-apart resolves without overlap', () => {
      const service = createService();
      const config = createDefaultPlayerConfig();
      const grid = createEmptyGrid(15, 15);

      const p1 = new Player('p1', 'Alice', new Position(200, 300), config);
      const p2 = new Player('p2', 'Bob', new Position(300, 300), config);
      p1.spawnTick = -9999;
      p2.spawnTick = -9999;

      const resolved1 = service.resolvePlayerCollision(p1, (cb) => cb(p2), p1.movement.position, 0);
      // CONSUMING-PATTERN CONTRACT: zero-alloc scratch return is invalidated by
      // the next call — capture to locals before the second resolution.
      const r1x = resolved1.x;
      const r1y = resolved1.y;
      const resolved2 = service.resolvePlayerCollision(p2, (cb) => cb(p1), p2.movement.position, 0);

      const aabb1 = {
        x: r1x - PLAYER.HITBOX_WIDTH / 2,
        y: r1y - PLAYER.HITBOX_HEIGHT / 2,
        width: PLAYER.HITBOX_WIDTH,
        height: PLAYER.HITBOX_HEIGHT,
      };
      const aabb2 = {
        x: resolved2.x - PLAYER.HITBOX_WIDTH / 2,
        y: resolved2.y - PLAYER.HITBOX_HEIGHT / 2,
        width: PLAYER.HITBOX_WIDTH,
        height: PLAYER.HITBOX_HEIGHT,
      };
      expect(
        aabb1.x + aabb1.width <= aabb2.x ||
          aabb2.x + aabb2.width <= aabb1.x ||
          aabb1.y + aabb1.height <= aabb2.y ||
          aabb2.y + aabb2.height <= aabb1.y,
      ).toBe(true);
    });
  });
});

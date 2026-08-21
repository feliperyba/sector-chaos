import { PLAYER, COMBAT, TileType, PlayerStatus } from '@sector-battle/shared';
import type { PlayerConfig } from '@sector-battle/shared';
import { MovementService } from '../../../src/domain/services/MovementService.ts';
import { CollisionService } from '../../../src/domain/services/CollisionService.ts';
import { Player } from '../../../src/domain/entities/Player.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { Direction } from '../../../src/domain/value-objects/Direction.ts';

const TILE_SIZE = 128;

function createDefaultConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 2,
    dashDuration: 10,
    dashCooldown: 60,
    baseHealth: 100,
    maxHealth: 100,
    inventorySize: 4,
    hitboxWidth: 96,
    hitboxHeight: 96,
    ...overrides,
  };
}

function createPlayer(id: string, x: number, y: number, overrides?: Partial<PlayerConfig>): Player {
  const player = new Player(id, `Player_${id}`, new Position(x, y), createDefaultConfig(overrides));
  player.spawnTick = -9999;
  player.statusEffects.freshSpawnExpiryTick = -9999;
  player.statusEffects.status = PlayerStatus.ALIVE;
  return player;
}

function makeGrid(
  rows: number,
  cols: number,
  fill: TileType,
  overrides?: Array<{ x: number; y: number; tile: TileType }>,
): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: TileType[] = [];
    for (let c = 0; c < cols; c++) row.push(fill);
    grid.push(row);
  }
  if (overrides) for (const o of overrides) grid[o.y]![o.x] = o.tile;
  return grid;
}

function createService(maxSpeed: number = 400): MovementService {
  const collisionService = new CollisionService(TILE_SIZE);
  return new MovementService(collisionService, maxSpeed, TILE_SIZE);
}

describe('MovementService', () => {
  describe('validateAndMove — basic movement', () => {
    const grid = makeGrid(10, 10, TileType.EMPTY);
    const dt = 1 / 60;

    it('move right (1,0): correctedPosition.x > 256, moved === true, collisionOccurred === false', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const result = service.validateAndMove(player, 1, 0, dt, grid);
      expect(result.correctedPosition.x).toBeGreaterThan(256);
      expect(result.moved).toBe(true);
      expect(result.collisionOccurred).toBe(false);
    });

    it('move left (-1,0): correctedPosition.x < 256', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const result = service.validateAndMove(player, -1, 0, dt, grid);
      expect(result.correctedPosition.x).toBeLessThan(256);
    });

    it('move up (0,-1): correctedPosition.y < 256', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const result = service.validateAndMove(player, 0, -1, dt, grid);
      expect(result.correctedPosition.y).toBeLessThan(256);
    });

    it('move down (0,1): correctedPosition.y > 256', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const result = service.validateAndMove(player, 0, 1, dt, grid);
      expect(result.correctedPosition.y).toBeGreaterThan(256);
    });

    it('diagonal (1,1) normalized: both x and y change, distance matches speed * dt', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      // Movement uses frame-rate-independent acceleration; warm up velocity to steady state
      for (let i = 0; i < 15; i++) {
        const warm = service.validateAndMove(player, 1, 1, dt, grid);
        // RETAIN → copy: correctedPosition is zero-alloc scratch invalidated by
        // the next validateAndMove call (mirrors production movePlayerAction's
        // copy-on-retain).
        player.movement.position = warm.correctedPosition.clone();
      }
      const result = service.validateAndMove(player, 1, 1, dt, grid);
      expect(result.moved).toBe(true);
      expect(result.correctedPosition.x).toBeGreaterThan(player.movement.position.x);
      expect(result.correctedPosition.y).toBeGreaterThan(player.movement.position.y);
      const distance = player.movement.position.distanceTo(result.correctedPosition);
      expect(distance).toBeCloseTo(player.movement.speed.value * dt, 1);
    });

    it('zero input (0,0): moved === false, position unchanged', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const result = service.validateAndMove(player, 0, 0, dt, grid);
      expect(result.moved).toBe(false);
      expect(result.correctedPosition.x).toBe(256);
      expect(result.correctedPosition.y).toBe(256);
    });
  });

  describe('validateAndMove — speed validation rejects teleport', () => {
    it('rejects movement when distance exceeds maxSpeed * dt * 1.1, position unchanged', () => {
      const service = createService(1);
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const player = createPlayer('p1', 0, 0);
      const result = service.validateAndMove(player, 1, 0, 1 / 60, grid);
      expect(result.moved).toBe(false);
      expect(result.correctedPosition.x).toBe(0);
      expect(result.correctedPosition.y).toBe(0);
    });
  });

  describe('validateAndMove — stagger penalty (COMBAT.STAGGER_MOVE_SPEED_PENALTY, 0.75 of speed)', () => {
    it('applies the stagger speed penalty when staggered', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const player = createPlayer('p1', 256, 256);
      player.startStagger(2000, 60);
      const dt = 1 / 60;
      // Movement uses frame-rate-independent acceleration; warm up velocity to steady state
      for (let i = 0; i < 15; i++) {
        const warm = service.validateAndMove(player, 1, 0, dt, grid);
        // RETAIN → copy (scratch result invalidated by the next call).
        player.movement.position = warm.correctedPosition.clone();
      }
      const before = player.movement.position.x;
      const result = service.validateAndMove(player, 1, 0, dt, grid);
      expect(result.moved).toBe(true);
      const distanceTraveled = result.correctedPosition.x - before;
      expect(distanceTraveled).toBeCloseTo(
        player.movement.speed.value * COMBAT.STAGGER_MOVE_SPEED_PENALTY * dt,
        1,
      );
    });
  });

  describe('validateAndMove — wall collision resolved', () => {
    it('pushes player back from wall and sets collisionOccurred', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY, [
        { x: 3, y: 2, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const player = createPlayer('p1', 384, 256);
      const result = service.validateAndMove(player, 1, 0, 1 / 60, grid);
      expect(result.collisionOccurred).toBe(true);
    });
  });

  describe('validateAndMove — clamp to map bounds', () => {
    it('clamps player so entity center >= halfSize when moving toward left/top edge', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const player = createPlayer('p1', PLAYER.HITBOX_WIDTH / 2 + 1, PLAYER.HITBOX_HEIGHT / 2 + 1);
      const result = service.validateAndMove(player, -1, -1, 1, grid);
      expect(result.correctedPosition.x).toBeGreaterThanOrEqual(PLAYER.HITBOX_WIDTH / 2);
      expect(result.correctedPosition.y).toBeGreaterThanOrEqual(PLAYER.HITBOX_HEIGHT / 2);
    });

    it('clamps player so entity center <= mapDim - halfSize when moving toward right/bottom edge', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const mapDim = 10 * TILE_SIZE;
      const player = createPlayer(
        'p1',
        mapDim - PLAYER.HITBOX_WIDTH / 2 - 1,
        mapDim - PLAYER.HITBOX_HEIGHT / 2 - 1,
      );
      const result = service.validateAndMove(player, 1, 1, 1, grid);
      expect(result.correctedPosition.x).toBeLessThanOrEqual(mapDim - PLAYER.HITBOX_WIDTH / 2);
      expect(result.correctedPosition.y).toBeLessThanOrEqual(mapDim - PLAYER.HITBOX_HEIGHT / 2);
    });
  });

  describe('validateSpeed — within limit', () => {
    it('returns true when distance within maxSpeed * dt * 1.1', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const dt = 1 / 60;
      const distance = PLAYER.BASE_SPEED * dt;
      const newPosition = new Position(256 + distance, 256);
      expect(service.validateSpeed(player, newPosition, dt)).toBe(true);
    });
  });

  describe('validateSpeed — exceeds limit', () => {
    it('returns false when distance > maxSpeed * dt * 1.1', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const dt = 1 / 60;
      const newPosition = new Position(256 + 10, 256);
      expect(service.validateSpeed(player, newPosition, dt)).toBe(false);
    });
  });

  describe('validateSpeed — exactly at limit', () => {
    it('returns true when distance === maxSpeed * dt * 1.1', () => {
      const service = createService();
      const player = createPlayer('p1', 256, 256);
      const dt = 1 / 60;
      const maxDistance = 400 * dt * 1.1;
      const newPosition = new Position(256 + maxDistance, 256);
      expect(service.validateSpeed(player, newPosition, dt)).toBe(true);
    });
  });

  describe('clampToBounds — center position', () => {
    it('returns unchanged position when within bounds', () => {
      const service = createService();
      const result = service.clampToBounds(new Position(50, 50), 96, 1280, 1280);
      expect(result.x).toBe(50);
      expect(result.y).toBe(50);
    });
  });

  describe('clampToBounds — left/top clamp', () => {
    it('clamps to halfSize = 48', () => {
      const service = createService();
      const result = service.clampToBounds(new Position(10, 10), 96, 1280, 1280);
      expect(result.x).toBe(48);
      expect(result.y).toBe(48);
    });
  });

  describe('clampToBounds — right/bottom clamp', () => {
    it('clamps to mapDim - halfSize = 1232', () => {
      const service = createService();
      const result = service.clampToBounds(new Position(1270, 1270), 96, 1280, 1280);
      expect(result.x).toBe(1232);
      expect(result.y).toBe(1232);
    });
  });

  describe('clampToBounds — exact boundary', () => {
    it('does not clamp when position is exactly at boundary', () => {
      const service = createService();
      const result = service.clampToBounds(new Position(48, 48), 96, 1280, 1280);
      expect(result.x).toBe(48);
      expect(result.y).toBe(48);
    });
  });

  describe('resolvePlayerCollision — two players overlapping', () => {
    it('pushes moving player away along dominant MTV axis', () => {
      const service = createService();
      const moving = createPlayer('p1', 256, 256);
      const other = createPlayer('p2', 260, 256);
      const resolvedPos = new Position(256, 256);
      const result = service.resolvePlayerCollision(moving, (cb) => cb(other), resolvedPos, 0);
      expect(result.x < 256 || result.x > 264).toBe(true);
    });
  });

  describe('resolvePlayerCollision — no overlap', () => {
    it('returns resolvedPos unchanged when players do not overlap', () => {
      const service = createService();
      const moving = createPlayer('p1', 256, 256);
      const other = createPlayer('p2', 500, 500);
      const resolvedPos = new Position(256, 256);
      const result = service.resolvePlayerCollision(moving, (cb) => cb(other), resolvedPos, 0);
      expect(result.x).toBe(256);
      expect(result.y).toBe(256);
    });
  });

  describe('resolvePlayerCollision — skips dashing moving player', () => {
    it('returns resolvedPos unchanged when moving player is dashing', () => {
      const service = createService();
      const moving = createPlayer('p1', 256, 256);
      moving.movement.isDashing = true;
      const other = createPlayer('p2', 260, 256);
      const resolvedPos = new Position(256, 256);
      const result = service.resolvePlayerCollision(moving, (cb) => cb(other), resolvedPos, 0);
      expect(result.x).toBe(256);
      expect(result.y).toBe(256);
    });
  });

  describe('resolvePlayerCollision — skips dashing other player', () => {
    it('skips collision resolution for dashing other player', () => {
      const service = createService();
      const moving = createPlayer('p1', 256, 256);
      const other = createPlayer('p2', 260, 256);
      other.movement.isDashing = true;
      const resolvedPos = new Position(256, 256);
      const result = service.resolvePlayerCollision(moving, (cb) => cb(other), resolvedPos, 0);
      expect(result.x).toBe(256);
      expect(result.y).toBe(256);
    });
  });

  describe('resolvePlayerCollision — skips inactive other player without death collision', () => {
    it('skips inactive player that has no death collision', () => {
      const service = createService();
      const moving = createPlayer('p1', 256, 256);
      const other = createPlayer('p2', 260, 256);
      other.statusEffects.status = PlayerStatus.SPECTATING;
      other.statusEffects.deathTick = -1;
      const resolvedPos = new Position(256, 256);
      const result = service.resolvePlayerCollision(moving, (cb) => cb(other), resolvedPos, 0);
      expect(result.x).toBe(256);
      expect(result.y).toBe(256);
    });
  });

  describe('resolvePlayerCollision — includes inactive other with death collision', () => {
    it('resolves collision for inactive player with active death collision', () => {
      const service = createService();
      const moving = createPlayer('p1', 256, 256);
      const other = createPlayer('p2', 260, 256);
      other.dieWithTick(0);
      const resolvedPos = new Position(256, 256);
      const result = service.resolvePlayerCollision(moving, (cb) => cb(other), resolvedPos, 1);
      expect(result.x < 256 || result.x > 264).toBe(true);
    });
  });

  describe('resolvePlayerCollision — deterministic order by player ID', () => {
    it('produces same result regardless of input order', () => {
      const service = createService();
      const moving = createPlayer('p1', 300, 256);
      const b1 = createPlayer('b1', 260, 256);
      const a2 = createPlayer('a2', 270, 256);
      const resolvedPos = new Position(300, 256);
      const result1 = service.resolvePlayerCollision(
        moving,
        (cb) => {
          cb(b1);
          cb(a2);
        },
        resolvedPos,
        0,
      );
      // CONSUMING-PATTERN CONTRACT: resolvePlayerCollision returns zero-alloc
      // scratch invalidated by the next call — capture to locals BEFORE any
      // further service call when the values must survive.
      const r1x = result1.x;
      const r1y = result1.y;
      const result2 = service.resolvePlayerCollision(
        moving,
        (cb) => {
          cb(a2);
          cb(b1);
        },
        resolvedPos,
        0,
      );
      expect(r1x).toBeCloseTo(result2.x, 10);
      expect(r1y).toBeCloseTo(result2.y, 10);
    });
  });

  describe('resolveDashEndOverlap — overlapping after dash', () => {
    it('pushes dashing player backward along dash direction', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const dashing = createPlayer('p1', 256, 256);
      dashing.movement.lastMoveDirection = Direction.RIGHT;
      dashing.movement.isDashing = true;
      const other = createPlayer('p2', 270, 256);
      const result = service.resolveDashEndOverlap(dashing, (cb) => cb(other), grid);
      expect(result.x).toBeLessThan(256);
    });
  });

  describe('resolveDashEndOverlap — no overlap', () => {
    it('returns original position when no player overlap', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const dashing = createPlayer('p1', 256, 256);
      dashing.movement.lastMoveDirection = Direction.RIGHT;
      const other = createPlayer('p2', 500, 500);
      const result = service.resolveDashEndOverlap(dashing, (cb) => cb(other), grid);
      expect(result.x).toBe(256);
      expect(result.y).toBe(256);
    });
  });

  describe('resolveDashEndOverlap — tile collision on push-back', () => {
    it('resolves tile collision when push-back lands in wall', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY, [
        { x: 0, y: 1, tile: TileType.INDESTRUCTIBLE_WALL },
      ]);
      const dashing = createPlayer('p1', 200, 200);
      dashing.movement.lastMoveDirection = Direction.RIGHT;
      dashing.movement.isDashing = true;
      const other = createPlayer('p2', 210, 200);
      const result = service.resolveDashEndOverlap(dashing, (cb) => cb(other), grid);
      const collisionCheck = new CollisionService(TILE_SIZE);
      const resultAABB = {
        x: result.x - PLAYER.HITBOX_WIDTH / 2,
        y: result.y - PLAYER.HITBOX_HEIGHT / 2,
        width: PLAYER.HITBOX_WIDTH,
        height: PLAYER.HITBOX_HEIGHT,
      };
      const tileResolved = collisionCheck.resolveTileCollision(resultAABB, grid);
      expect(tileResolved.x).toBe(resultAABB.x);
      expect(tileResolved.y).toBe(resultAABB.y);
    });
  });

  // server-movement-scratch-aabb: the three hot-path methods return shared
  // zero-alloc scratch objects. This block PINS the synchronous-consumption
  // contract so a future caller that retains a result across another service
  // call fails HERE with a clear message instead of corrupting match state.
  describe('scratch-return consuming-pattern contract (server-movement-scratch-aabb)', () => {
    it('validateAndMove result is invalidated by the next validateAndMove call', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const player = createPlayer('p1', 256, 256);
      const dt = 1 / 60;

      const result1 = service.validateAndMove(player, 1, 0, dt, grid);
      // Synchronous consumption: capture values (or clone) before any further call.
      const r1x = result1.correctedPosition.x;
      const r1y = result1.correctedPosition.y;
      const r1moved = result1.moved;
      player.movement.position = result1.correctedPosition.clone();

      const result2 = service.validateAndMove(player, 0, -1, dt, grid);
      // Same scratch object is reused — retained references observe call 2.
      expect(result1).toBe(result2);
      expect(r1x).toBeGreaterThan(256);
      expect(r1y).toBe(256);
      expect(r1moved).toBe(true);
      // result1's fields now describe call 2 (moving -y): y diverges from the
      // captured r1y — proof that retention across calls is invalid.
      expect(result1.correctedPosition.y).toBeLessThan(r1y);
    });

    it('resolvePlayerCollision result is invalidated by the next resolvePlayerCollision call', () => {
      const service = createService();
      const p1 = createPlayer('p1', 256, 256);
      const p2 = createPlayer('p2', 260, 256);
      const resolved1 = service.resolvePlayerCollision(
        p1,
        (cb) => cb(p2),
        new Position(256, 256),
        10,
      );
      const r1x = resolved1.x;
      const r1y = resolved1.y;
      const p3 = createPlayer('p3', 400, 400);
      const resolved2 = service.resolvePlayerCollision(
        p3,
        (cb) => cb(p1),
        new Position(400, 400),
        11,
      );
      expect(resolved1).toBe(resolved2);
      expect(r1x).not.toBe(400);
      expect(r1y).not.toBe(400);
      // The shared object now carries call 2's unresolved position.
      expect(resolved1.x).toBe(400);
      expect(resolved1.y).toBe(400);
    });

    it('resolveDashEndOverlap result is invalidated by the next resolveDashEndOverlap call', () => {
      const service = createService();
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const dashing1 = createPlayer('d1', 256, 256);
      dashing1.movement.lastMoveDirection = Direction.RIGHT;
      dashing1.movement.isDashing = true;
      const other1 = createPlayer('o1', 270, 256);
      const result1 = service.resolveDashEndOverlap(dashing1, (cb) => cb(other1), grid);
      const r1x = result1.x;
      expect(r1x).toBeLessThan(256);

      const dashing2 = createPlayer('d2', 512, 512);
      dashing2.movement.lastMoveDirection = Direction.RIGHT;
      dashing2.movement.isDashing = true;
      const result2 = service.resolveDashEndOverlap(dashing2, (cb) => cb(other1), grid);
      expect(result1).toBe(result2);
      // Shared object now carries call 2's (unresolved — no overlap) position.
      expect(result1.x).toBe(512);
      expect(result2.x).toBe(512);
    });
  });
});

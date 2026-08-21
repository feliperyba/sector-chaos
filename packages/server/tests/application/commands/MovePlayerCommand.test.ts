import {
  PlayerStatus,
  TileType,
  PLAYER,
  SeededRNG,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import {
  MovePlayerCommand,
  type MovePlayerInput,
} from '../../../src/application/commands/index.ts';
import { CollisionService } from '../../../src/domain/services/CollisionService.ts';
import { MovementService } from '../../../src/domain/services/MovementService.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../src/domain/aggregates/createMatchServices.ts';

function createDefaultPlayerConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
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
      tileWidth: 32,
      tileHeight: 32,
      arenaWidth: 30,
      arenaHeight: 30,
      sectorSize: 10,
      corridorWidth: 2,
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

function createSpawnPoints(count: number): SpawnPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: 64 + (i % 8) * 128,
    y: 64 + Math.floor(i / 8) * 128,
    sectorCoord: { row: 0, col: 0 },
    priority: 0,
  }));
}

function createEmptyGrid(width: number, height: number): TileType[][] {
  return Array.from({ length: height }, () => Array(width).fill(TileType.EMPTY));
}

function createMatch(
  configOverrides?: Partial<GameConfig>,
  grid?: TileType[][],
  spawnPoints?: SpawnPoint[],
): GameMatch {
  const cfg = createDefaultGameConfig(configOverrides);
  const g = grid ?? createEmptyGrid(30, 30);
  const sp = spawnPoints ?? createSpawnPoints(8);
  const services = createMatchServices(cfg);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('test-match', cfg, g, sp, services, pools, lootRng);
}

function createMovementService(tileSize: number = 32): MovementService {
  const collisionService = new CollisionService(tileSize);
  return new MovementService(collisionService, PLAYER.BASE_SPEED, tileSize);
}

describe('MovePlayerCommand', () => {
  it('moves player UP successfully in empty space', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    const originalY = player.movement.position.y;
    const command = new MovePlayerCommand(match, createMovementService());
    const input: MovePlayerInput = { playerId: 'p1', dx: 0, dy: -1, tick: 0 };
    const result = command.execute(input);
    expect(result.success).toBe(true);
    expect(player.movement.position.y).toBeLessThan(originalY);
  });

  it('fails for dead player', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    player.die();
    const command = new MovePlayerCommand(match, createMovementService());
    const input: MovePlayerInput = { playerId: 'p1', dx: 0, dy: -1, tick: 0 };
    const result = command.execute(input);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Player not alive');
  });

  it('fails for unknown player', () => {
    const match = createMatch();
    const command = new MovePlayerCommand(match, createMovementService());
    const input: MovePlayerInput = { playerId: 'unknown', dx: 0, dy: -1, tick: 0 };
    const result = command.execute(input);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Player not found');
  });

  it('alive player moves, dead player is rejected', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    const command = new MovePlayerCommand(match, createMovementService());

    const aliveResult = command.execute({
      playerId: 'p1',
      dx: 1,
      dy: 0,
      tick: 1,
    });
    expect(aliveResult.success).toBe(true);

    player.die();
    const deadResult = command.execute({ playerId: 'p1', dx: 1, dy: 0, tick: 2 });
    expect(deadResult.success).toBe(false);
    expect(deadResult.error).toBe('Player not alive');
  });

  it('fails for staggered player', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.STAGGERED;
    const command = new MovePlayerCommand(match, createMovementService());
    const input: MovePlayerInput = { playerId: 'p1', dx: 0, dy: -1, tick: 0 };
    const result = command.execute(input);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Player not alive');
  });

  it('wall collision produces corrected position (wall sliding)', () => {
    const grid = createEmptyGrid(30, 30);
    const tileSize = 32;
    const spawnGridX = 4;
    const spawnGridY = 2;
    grid[spawnGridY - 1][spawnGridX] = TileType.INDESTRUCTIBLE_WALL;
    const spawnPoints: SpawnPoint[] = [
      {
        x: spawnGridX * tileSize + tileSize / 2,
        y: spawnGridY * tileSize + tileSize / 2,
        sectorCoord: { row: 0, col: 0 },
        priority: 0,
      },
    ];
    const match = createMatch({}, grid, spawnPoints);
    const player = match.addPlayer('p1', 'Alice');
    const command = new MovePlayerCommand(match, createMovementService(tileSize));
    const input: MovePlayerInput = { playerId: 'p1', dx: 0, dy: -1, tick: 0 };
    const result = command.execute(input);
    expect(result.success).toBe(true);
    expect(player.movement.position.y).toBeGreaterThanOrEqual(spawnPoints[0].y - 1);
  });
});

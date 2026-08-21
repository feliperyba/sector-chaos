import {
  Direction as DirectionEnum,
  TileType,
  PLAYER,
  InputAction,
  SeededRNG,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { logger } from '@sector-battle/shared';
import { GameMatch } from '../../src/domain/aggregates/GameMatch.ts';
import { CollisionService } from '../../src/domain/services/CollisionService.ts';
import { MovementService } from '../../src/domain/services/MovementService.ts';
import { GameSimulation } from '../../src/application/simulation/GameSimulation.ts';
import type { QueuedInput } from '../../src/application/simulation/InputQueue.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../src/domain/aggregates/createMatchServices.ts';

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

function createDefaultGameConfig(): GameConfig {
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
  };
}

function createEmptyGrid(width: number, height: number): TileType[][] {
  return Array.from({ length: height }, () => Array(width).fill(TileType.EMPTY));
}

function createTestSimulation(playerCount: number): GameSimulation {
  const config = createDefaultGameConfig();
  const grid = createEmptyGrid(15, 15);
  const spawnPoints: SpawnPoint[] = Array.from({ length: playerCount }, (_, i) => ({
    x: TILE_SIZE * (2 + (i % 5) * 2) + TILE_SIZE / 2,
    y: TILE_SIZE * (2 + Math.floor(i / 5) * 2) + TILE_SIZE / 2,
    sectorCoord: { row: 0, col: 0 },
    priority: 0,
  }));
  const services = createMatchServices(config);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  const match = new GameMatch('bench-match', config, grid, spawnPoints, services, pools, lootRng);
  for (let i = 0; i < playerCount; i++) {
    match.addPlayer(`p${i}`, `Player${i}`);
  }
  const collisionService = new CollisionService(TILE_SIZE);
  const movementService = new MovementService(collisionService, PLAYER.BASE_SPEED, TILE_SIZE);
  const simulation = new GameSimulation(match, movementService);
  simulation.start();
  return simulation;
}

function enqueueMoveInputs(simulation: GameSimulation, playerCount: number): void {
  const directions = [
    DirectionEnum.UP,
    DirectionEnum.RIGHT,
    DirectionEnum.DOWN,
    DirectionEnum.LEFT,
  ];
  const tick = simulation.currentTick;
  for (let i = 0; i < playerCount; i++) {
    const input: QueuedInput = {
      playerId: `p${i}`,
      action: InputAction.MOVE,
      data: { playerId: `p${i}`, direction: directions[i % 4], tick },
      clientTick: tick,
      serverTick: tick,
      receivedAt: Date.now(),
    };
    simulation.processInput(input);
  }
}

describe('Full Physics Performance', () => {
  it('processes physics step under 0.5ms with 4 players', () => {
    const playerCount = 4;
    const simulation = createTestSimulation(playerCount);

    enqueueMoveInputs(simulation, playerCount);

    for (let i = 0; i < 100; i++) {
      simulation.update(1000 / 60);
      if (i % 10 === 0) {
        enqueueMoveInputs(simulation, playerCount);
      }
    }

    const start = performance.now();
    for (let i = 0; i < 600; i++) {
      if (i % 10 === 0) {
        enqueueMoveInputs(simulation, playerCount);
      }
      simulation.update(1000 / 60);
    }
    const elapsed = performance.now() - start;

    const avgStepMs = elapsed / 600;
    logger.info(`4 players avg step: ${avgStepMs.toFixed(3)}ms`);
    expect(avgStepMs).toBeLessThan(0.5);
  });

  it('handles 10 players under 1ms', () => {
    const playerCount = 10;
    const simulation = createTestSimulation(playerCount);

    enqueueMoveInputs(simulation, playerCount);

    for (let i = 0; i < 100; i++) {
      simulation.update(1000 / 60);
      if (i % 10 === 0) {
        enqueueMoveInputs(simulation, playerCount);
      }
    }

    const start = performance.now();
    for (let i = 0; i < 600; i++) {
      if (i % 10 === 0) {
        enqueueMoveInputs(simulation, playerCount);
      }
      simulation.update(1000 / 60);
    }
    const elapsed = performance.now() - start;

    const avgStepMs = elapsed / 600;
    logger.info(`10 players avg step: ${avgStepMs.toFixed(3)}ms`);
    expect(avgStepMs).toBeLessThan(1);
  });
});

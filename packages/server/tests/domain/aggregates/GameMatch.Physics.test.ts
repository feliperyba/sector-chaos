import {
  TileType,
  SeededRNG,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
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

describe('GameMatch Physics Integration', () => {
  describe('barrel explosion', () => {
    it('triggers barrel explosion and creates explosion entity', () => {
      const grid = createEmptyGrid(30, 30);
      const match = createMatch(undefined, grid);
      match.addPlayer('p1', 'Alice');
      match.triggerBarrelExplosion(5, 5, 3, 50, 'barrel');
      const state = match.getState();
      expect(state.explosions.size).toBeGreaterThanOrEqual(1);
    });

    it('produces no damage events when no players in range', () => {
      const grid = createEmptyGrid(30, 30);
      const match = createMatch(undefined, grid);
      const events = match.triggerBarrelExplosion(5, 5, 1, 50, 'barrel');
      // BarrelExploded is always emitted as metadata; no damage events when no players in range
      const damageEvents = events.filter((e) => e.type !== 'BarrelExploded');
      expect(damageEvents).toHaveLength(0);
    });
  });
});

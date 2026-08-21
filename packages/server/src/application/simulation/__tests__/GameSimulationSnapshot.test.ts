import { describe, it, expect } from 'vitest';
import {
  PLAYER,
  SeededRNG,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameSimulation, type SnapshotSink } from '../index.ts';
import { CollisionService } from '../../../domain/services/CollisionService.ts';
import { MovementService } from '../../../domain/services/MovementService.ts';
import { GameMatch } from '../../../domain/aggregates/GameMatch.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../domain/aggregates/createMatchServices.ts';
import { TileType } from '@sector-battle/shared';

/**
 * Characterization tests for the snapshot-sink contract introduced by ticket
 * #24 (finishes the #12 attach-runtime pattern). The sink fires EVERY tick at
 * step11_Snapshot; the batching (syncTickCounter / syncEveryN) lives INSIDE
 * the sink body in GameRoomLifecycle, not in the simulation. These tests pin
 * that contract: a sink attached via {@link GameSimulation.attachSnapshotSink}
 * is notified once per simulated tick, a null sink is safe, and a sink
 * attached post-construction only sees subsequent ticks.
 */

const TICK_DT_MS = (1 / 60) * 1000 + 0.01; // ~16.67ms, advances exactly one step per update()

function createDefaultPlayerConfig(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    baseSpeed: 200,
    dashSpeedMultiplier: 1.3,
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

function createMatch(): GameMatch {
  const cfg = createDefaultGameConfig();
  const g = createEmptyGrid(30, 30);
  const sp = createSpawnPoints(8);
  const services = createMatchServices(cfg);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('test-match', cfg, g, sp, services, pools, lootRng);
}

function createMovementService(tileSize: number = 32): MovementService {
  const collisionService = new CollisionService(tileSize);
  return new MovementService(collisionService, PLAYER.BASE_SPEED, tileSize);
}

function createSimulation(): GameSimulation {
  return new GameSimulation(createMatch(), createMovementService());
}

describe('GameSimulation snapshot sink (ticket #24)', () => {
  it('invokes the sink once per simulated tick (fires every tick, not every N)', () => {
    const sim = createSimulation();
    let calls = 0;
    const sink: SnapshotSink = {
      onSnapshotTick: () => {
        calls++;
      },
    };
    sim.attachSnapshotSink(sink);
    sim.start();

    const N = 5;
    for (let i = 0; i < N; i++) {
      sim.update(TICK_DT_MS);
    }

    expect(calls).toBe(N);
    expect(sim.currentTick).toBe(N);
  });

  it('is safe to run with no sink attached (null sink, no throw)', () => {
    const sim = createSimulation();
    // Deliberately do NOT attach a sink.
    sim.start();

    expect(() => {
      const N = 5;
      for (let i = 0; i < N; i++) {
        sim.update(TICK_DT_MS);
      }
    }).not.toThrow();
    expect(sim.currentTick).toBe(5);
  });

  it('only counts ticks after the sink is attached post-construction', () => {
    const sim = createSimulation();
    let calls = 0;
    sim.start();

    // One tick before any sink is attached — must not notify.
    sim.update(TICK_DT_MS);
    expect(calls).toBe(0);

    const sink: SnapshotSink = {
      onSnapshotTick: () => {
        calls++;
      },
    };
    sim.attachSnapshotSink(sink);

    // One tick after attach — must notify exactly once.
    sim.update(TICK_DT_MS);
    expect(calls).toBe(1);
  });
});

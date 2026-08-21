import { describe, it, expect, vi } from 'vitest';
import { TileType, IdGenerator, type GameConfig } from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../src/domain/aggregates/createMatchServices.ts';
import { SeededRNG } from '@sector-battle/shared';
import { BarrelExplosionManager } from '../../../src/domain/aggregates/BarrelExplosionManager.ts';
import { Destructible, type DestructibleType } from '../../../src/domain/entities/Destructible.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import type { DamagePipeline } from '../../../src/domain/services/DamagePipeline.ts';

function createEmptyGrid(width: number, height: number): TileType[][] {
  return Array.from({ length: height }, () => Array(width).fill(TileType.EMPTY));
}

function createDefaultGameConfig(): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 2,
      dashDuration: 10,
      dashCooldown: 60,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 24,
      hitboxHeight: 24,
    },
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
  };
}

function createTestMatch(): GameMatch {
  const cfg = createDefaultGameConfig();
  const grid = createEmptyGrid(30, 30);
  const spawns = Array.from({ length: 8 }, (_, i) => ({
    x: 64 + (i % 8) * 128,
    y: 64 + Math.floor(i / 8) * 128,
    sectorCoord: { row: 0, col: 0 },
    priority: 0,
  }));
  const services = createMatchServices(cfg);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('test-match', cfg, grid, spawns, services, pools, lootRng);
}

describe('GameMatch grid dirty flag', () => {
  it('consumeGridDirty returns false when no mutations occurred', () => {
    const match = createTestMatch();
    expect(match.consumeGridDirty()).toBe(false);
  });

  it('setTileAt sets the dirty flag', () => {
    const match = createTestMatch();
    match.setTileAt(5, 5, TileType.DESTRUCTIBLE_WALL);
    expect(match.consumeGridDirty()).toBe(true);
  });

  it('consumeGridDirty resets the flag (returns true then false)', () => {
    const match = createTestMatch();
    match.setTileAt(5, 5, TileType.DESTRUCTIBLE_WALL);
    expect(match.consumeGridDirty()).toBe(true);
    expect(match.consumeGridDirty()).toBe(false);
  });

  it('multiple setTileAt calls batch into one dirty signal', () => {
    const match = createTestMatch();
    match.setTileAt(1, 1, TileType.DESTRUCTIBLE_WALL);
    match.setTileAt(2, 2, TileType.DESTRUCTIBLE_WALL);
    match.setTileAt(3, 3, TileType.DESTRUCTIBLE_WALL);
    expect(match.consumeGridDirty()).toBe(true);
    expect(match.consumeGridDirty()).toBe(false);
  });

  it('markGridDirty sets the flag directly', () => {
    const match = createTestMatch();
    match.markGridDirty();
    expect(match.consumeGridDirty()).toBe(true);
    expect(match.consumeGridDirty()).toBe(false);
  });

  it('markGridDirty + setTileAt batch into one signal', () => {
    const match = createTestMatch();
    match.markGridDirty();
    match.setTileAt(1, 1, TileType.EMPTY);
    match.markGridDirty();
    expect(match.consumeGridDirty()).toBe(true);
    expect(match.consumeGridDirty()).toBe(false);
  });
});

function makeGrid(rows: number, cols: number, fill: TileType): TileType[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(fill) as TileType[]);
}

function createMockDamagePipeline(): DamagePipeline {
  return {
    processAttack: vi.fn(() => []),
    processDamage: vi.fn(() => ({ events: [], killed: false, damageApplied: 10 })),
    checkPlayersInExplosion: vi.fn(() => []),
  } as unknown as DamagePipeline;
}

function createDestructibleAt(
  id: string,
  type: DestructibleType,
  gx: number,
  gy: number,
  tileWidth: number,
  tileHeight: number,
): Destructible {
  return Destructible.create(
    id,
    type,
    new Position(gx * tileWidth + tileWidth / 2, gy * tileHeight + tileHeight / 2),
  );
}

describe('BarrelExplosionManager markGridDirty callback', () => {
  const config = createDefaultGameConfig();
  const tw = config.map.tileWidth;
  const th = config.map.tileHeight;

  it('calls markGridDirty once after resolveExplosion', () => {
    const markGridDirty = vi.fn();
    const grid = makeGrid(10, 10, TileType.EMPTY);
    const ctx = {
      players: new Map(),
      explosions: new Map(),
      destructibles: new Map<string, Destructible>(),
      grid,
      config,
      idGenerator: new IdGenerator('test'),
      damagePipeline: createMockDamagePipeline(),
      siegeWallManager: { hasSiegeWall: () => false },
      getAlivePlayerCount: () => 0,
      markGridDirty,
    };
    const manager = new BarrelExplosionManager(ctx);

    manager.resolveExplosion(5, 5, 'test', 0);

    expect(markGridDirty).toHaveBeenCalledTimes(1);
  });

  it('calls markGridDirty once even with chain reactions (batch boundary)', () => {
    const markGridDirty = vi.fn();
    const grid = makeGrid(10, 10, TileType.EMPTY);
    const destructibles = new Map<string, Destructible>();

    const adjacent = [
      [6, 5],
      [4, 5],
      [5, 6],
      [5, 4],
      [6, 6],
      [4, 6],
      [6, 4],
      [4, 4],
    ];
    for (let i = 0; i < adjacent.length; i++) {
      const [gx, gy] = adjacent[i]!;
      const d = createDestructibleAt(`d-${i}`, 'barrel', gx, gy, tw, th);
      destructibles.set(d.id, d);
      grid[gy]![gx] = TileType.DESTRUCTIBLE_BARREL;
    }

    const ctx = {
      players: new Map(),
      explosions: new Map(),
      destructibles,
      grid,
      config,
      idGenerator: new IdGenerator('test'),
      damagePipeline: createMockDamagePipeline(),
      siegeWallManager: { hasSiegeWall: () => false },
      getAlivePlayerCount: () => 0,
      markGridDirty,
    };
    const manager = new BarrelExplosionManager(ctx);

    manager.resolveExplosion(5, 5, 'test', 0);

    expect(markGridDirty).toHaveBeenCalledTimes(1);
  });

  it('does not call markGridDirty when callback is absent', () => {
    const grid = makeGrid(10, 10, TileType.EMPTY);
    const ctx = {
      players: new Map(),
      explosions: new Map(),
      destructibles: new Map<string, Destructible>(),
      grid,
      config,
      idGenerator: new IdGenerator('test'),
      damagePipeline: createMockDamagePipeline(),
      siegeWallManager: { hasSiegeWall: () => false },
      getAlivePlayerCount: () => 0,
    };
    const manager = new BarrelExplosionManager(ctx);

    expect(() => manager.resolveExplosion(5, 5, 'test', 0)).not.toThrow();
  });
});

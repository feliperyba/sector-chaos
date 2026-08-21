import { describe, it, expect } from 'vitest';
import { BarrelExplosionManager } from '../aggregates/BarrelExplosionManager.ts';
import { Destructible } from '../entities/Destructible.ts';
import { Position } from '../value-objects/Position.ts';
import { TileType, BARREL, IdGenerator } from '@sector-battle/shared';
import { DamagePipeline } from '../services/DamagePipeline.ts';
import type { GameConfig } from '@sector-battle/shared';
import { Explosion } from '../entities/Explosion.ts';
import { DomainSpatialIndex } from '../aggregates/DomainSpatialIndex.ts';
import type { GameMatch } from '../aggregates/GameMatch.ts';

function createEmptyGrid(w: number, h: number): TileType[][] {
  return Array.from({ length: h }, () => Array(w).fill(TileType.EMPTY));
}

function createMockConfig(): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 3,
      dashDuration: 10,
      dashCooldown: 120,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 24,
      hitboxHeight: 24,
    },
    zone: {
      phases: [],
      totalDuration: 300000,
      transitionDuration: 30000,
      tickInterval: 60,
      warningTime: 5000,
    },
    match: {
      targetDuration: 180000,
      maxPlayers: 4,
      minPlayers: 2,
      countdownDuration: 5000,
      overtimeStart: 240000,
    },
    map: {
      tileWidth: 128,
      tileHeight: 128,
      arenaWidth: 80,
      arenaHeight: 80,
      sectorSize: 4,
      corridorWidth: 3,
      destructibleDensity: 0.25,
      chestDensity: 0.1,
      exitCount: 1,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 200,
      bounceFactor: 0.5,
      maxBounces: 3,
      friendlyFire: true,
    },
    network: {
      tickRate: 60,
      patchRate: 20,
      maxLatency: 200,
      inputBufferSize: 10,
      snapshotInterval: 3,
    },
  };
}

function createMockDamagePipeline(): DamagePipeline {
  const shieldHandler = {
    processIncomingDamage: () => ({ blocked: false, shieldBroken: false }),
  } as unknown as import('../handlers/ShieldHandler.ts').ShieldHandler;
  return new DamagePipeline(shieldHandler);
}

function createManager(
  grid: TileType[][],
  destructibles: Map<string, Destructible>,
  getSpatialIndex?: () => DomainSpatialIndex | null,
): BarrelExplosionManager {
  const config = createMockConfig();
  const explosions = new Map<string, Explosion>();
  return new BarrelExplosionManager({
    players: new Map(),
    explosions,
    destructibles,
    grid,
    config,
    idGenerator: new IdGenerator('test'),
    damagePipeline: createMockDamagePipeline(),
    siegeWallManager: { hasSiegeWall: () => false },
    getAlivePlayerCount: () => 0,
    getSpatialIndex,
  });
}

/**
 * server-barrel-spatial-query (ticket 19): indexed-path chain fixture. A
 * source explosion at (2,2) chains X(3,3) → Z(4,4); Z's (-1,-1) ray then
 * walks BACK through X's cell — X is destroyed/deleted mid-chain but still a
 * STALE entry in the pre-built index (built before the chain, never rebuilt
 * mid-chain — exactly production's step2 snapshot), so this layout forces the
 * recursion-consistency mechanism (live `isDestroyed` re-check on indexed
 * candidates) to fire or the ray would stop/re-process at X's ghost. W(1,1)
 * sits behind X on the same diagonal.
 */
function buildChainFixture(): {
  grid: TileType[][];
  destructibles: Map<string, Destructible>;
} {
  const grid = createEmptyGrid(10, 10);
  const destructibles = new Map<string, Destructible>();
  const x = Destructible.create('X', 'barrel', new Position(3 * 128 + 64, 3 * 128 + 64));
  const z = Destructible.create('Z', 'barrel', new Position(4 * 128 + 64, 4 * 128 + 64));
  const w = Destructible.create('W', 'crate', new Position(1 * 128 + 64, 1 * 128 + 64));
  destructibles.set(x.id, x);
  destructibles.set(z.id, z);
  destructibles.set(w.id, w);
  grid[3]![3] = TileType.DESTRUCTIBLE_BARREL;
  grid[4]![4] = TileType.DESTRUCTIBLE_BARREL;
  grid[1]![1] = TileType.DESTRUCTIBLE_CRATE;
  return { grid, destructibles };
}

describe('BarrelSystem', () => {
  it('TestBarrelHp_twoHits: barrel survives first hit and is destroyed on second hit', () => {
    const barrel = Destructible.create('b1', 'barrel', new Position(128, 128));
    expect(barrel.hp).toBe(2);

    const r1 = barrel.takeDamage({ source: 'melee', rawDamage: 2, currentTick: 100 });
    expect(r1.destroyed).toBe(false);
    expect(barrel.hp).toBe(1);

    const r2 = barrel.takeDamage({ source: 'melee', rawDamage: 2, currentTick: 101 });
    expect(r2.destroyed).toBe(true);
    expect(r2.shouldExplode).toBe(true);
    expect(barrel.hp).toBe(0);
  });

  it('TestSafetyCap_20: recursive barrel resolution caps at MAX_EXPLOSIONS_PER_RESOLUTION', () => {
    const grid = createEmptyGrid(30, 30);
    const destructibles = new Map<string, Destructible>();

    for (let i = 0; i < 25; i++) {
      const barrel = Destructible.create(
        `b-${i}`,
        'barrel',
        new Position((i + 2) * 128 + 64, 5 * 128 + 64),
      );
      destructibles.set(`b-${i}`, barrel);
      grid[5]![i + 2] = TileType.DESTRUCTIBLE_BARREL;
    }

    const manager = createManager(grid, destructibles);
    const events = manager.resolveExplosion(1, 5, 'test', 0);

    const barrelExploded = events.filter((e) => e.type === 'BarrelExploded');
    expect(barrelExploded.length).toBeLessThanOrEqual(BARREL.MAX_EXPLOSIONS_PER_RESOLUTION);
  });

  it('TestInstantResolution: all barrel explosions resolve in single call with no deferred processing', () => {
    const grid = createEmptyGrid(10, 10);
    grid[5]![4] = TileType.DESTRUCTIBLE_BARREL;
    grid[5]![3] = TileType.DESTRUCTIBLE_BARREL;
    const destructibles = new Map<string, Destructible>();
    const barrel1 = Destructible.create('b1', 'barrel', new Position(4 * 128 + 64, 5 * 128 + 64));
    const barrel2 = Destructible.create('b2', 'barrel', new Position(3 * 128 + 64, 5 * 128 + 64));
    destructibles.set('b1', barrel1);
    destructibles.set('b2', barrel2);

    const manager = createManager(grid, destructibles);
    const events = manager.resolveExplosion(5, 5, 'test', 0);

    const barrelExploded = events.filter((e) => e.type === 'BarrelExploded');
    expect(barrelExploded.length).toBeGreaterThanOrEqual(2);
    expect(barrel1.isDestroyed).toBe(true);
    expect(barrel2.isDestroyed).toBe(true);
    expect(destructibles.has('b1')).toBe(false);
    expect(destructibles.has('b2')).toBe(false);
  });

  it('TestIndexedPath: chain through a STALE spatial index is identical to the fallback; a mid-chain destroyed barrel is never re-processed', () => {
    // Fallback side (no index — exact pre-ticket-19 linear semantics).
    const fallback = buildChainFixture();
    const fallbackEvents = createManager(fallback.grid, fallback.destructibles).resolveExplosion(
      2,
      2,
      'test',
      0,
    );

    // Indexed side: index built BEFORE the chain and never rebuilt during it —
    // the production staleness (step2 snapshot vs mid-chain deletions).
    const indexed = buildChainFixture();
    const index = new DomainSpatialIndex(10 * 128, 10 * 128);
    index.rebuildFrom(
      // rebuildFrom only reads players/destructibles/tick — structural stand-in.
      { players: new Map(), destructibles: indexed.destructibles, tick: 0 } as unknown as GameMatch,
    );
    const indexedEvents = createManager(
      indexed.grid,
      indexed.destructibles,
      () => index,
    ).resolveExplosion(2, 2, 'test', 0);

    // Event signature sequences (type + event/destructible id) identical.
    const signature = (events: typeof fallbackEvents) =>
      events.map((e, i) => `${e.type}:${'id' in e ? e.id : i}`);
    expect(signature(indexedEvents)).toEqual(signature(fallbackEvents));

    // Recursion consistency on the indexed side: every barrel explodes exactly
    // once and every destructible emits exactly ONE DestructibleDestroyed —
    // Z's ray walked back through X's stale cell without stopping on or
    // re-damaging the ghost (a missing isDestroyed re-check would surface as
    // a duplicate X destruction event via Destructible.takeDamage's
    // already-destroyed path).
    const exploded = indexedEvents.filter((e) => e.type === 'BarrelExploded');
    expect(exploded.length).toBe(3); // source (2,2) + X + Z
    const destroyedIds = indexedEvents
      .filter((e) => e.type === 'DestructibleDestroyed')
      .map((e) => e.id)
      .sort();
    expect(destroyedIds).toEqual(['W', 'X', 'Z']);
    expect(indexed.destructibles.size).toBe(0);
    expect(indexed.grid[3]![3]).toBe(TileType.EMPTY);
    expect(indexed.grid[4]![4]).toBe(TileType.EMPTY);
    expect(indexed.grid[1]![1]).toBe(TileType.EMPTY);
  });
});

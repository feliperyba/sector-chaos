import {
  WeaponType,
  TileType,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
  WeaponTier,
  DURABILITY_BY_TIER,
  weaponRegistry,
  SeededRNG,
} from '@sector-battle/shared';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { Projectile } from '../../../src/domain/entities/Projectile.ts';
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

function createEmptyGrid(width = 30, height = 30): TileType[][] {
  return Array.from({ length: height }, () => Array(width).fill(TileType.EMPTY));
}

function createMatch(): GameMatch {
  const cfg = createDefaultGameConfig();
  const grid = createEmptyGrid();
  const spawns = createSpawnPoints(8);
  const services = createMatchServices(cfg);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('test-match', cfg, grid, spawns, services, pools, lootRng);
}

function createBoomerangProjectile(
  id: string,
  ownerId: string,
  x: number,
  y: number,
  durability: number,
): Projectile {
  return new Projectile(
    id,
    ownerId,
    new Position(x, y),
    100,
    0,
    15,
    0,
    WeaponType.SMALL_SHIELD,
    durability,
    800,
    'thrown',
    true,
    ownerId,
    200,
    1,
  );
}

function createThrownProjectile(id: string, ownerId: string, x: number, y: number): Projectile {
  return new Projectile(
    id,
    ownerId,
    new Position(x, y),
    200,
    0,
    25,
    2,
    WeaponType.THROWING_AXE,
    3,
    400,
    'thrown',
    false,
    null,
    0,
    1,
  );
}

describe('Boomerang Thrower Death', () => {
  it('drops boomerang at current position when thrower dies', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Thrower');
    match.addPlayer('p2', 'Other');

    const proj = createBoomerangProjectile('bp1', 'p1', 200, 300, 8);
    match.addProjectile(proj);
    player.combat.addThrowInFlight('bp1');

    match.dropBoomerangsForDeadPlayer('p1');

    const pickup = match.getWeaponPickupAt(200, 300, 1);
    expect(pickup).toBeDefined();
    expect(pickup!.weapon.type).toBe(WeaponType.SMALL_SHIELD);
    expect(match.getState().projectiles.has('bp1')).toBe(false);
    expect(player.combat.throwsInFlight.size).toBe(0);
  });

  it('non-boomerang projectiles continue after thrower death', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Thrower');
    match.addPlayer('p2', 'Other');

    const axeProj = createThrownProjectile('tp1', 'p1', 150, 250);
    match.addProjectile(axeProj);
    player.combat.addThrowInFlight('tp1');

    match.dropBoomerangsForDeadPlayer('p1');

    const state = match.getState();
    expect(state.projectiles.has('tp1')).toBe(true);
    expect(state.projectiles.get('tp1')!.ownerId).toBe('p1');
    expect(player.combat.throwsInFlight.size).toBe(0);
  });

  it('dropped shield has correct remaining durability', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Thrower');
    match.addPlayer('p2', 'Other');

    const remainingDurability = 7;
    const proj = createBoomerangProjectile('bp1', 'p1', 100, 200, remainingDurability);
    match.addProjectile(proj);
    player.combat.addThrowInFlight('bp1');

    match.dropBoomerangsForDeadPlayer('p1');

    const definition = weaponRegistry.getDefinition(WeaponType.SMALL_SHIELD);
    const tier = definition.tier ?? WeaponTier.COMMON;
    const maxAmmo = DURABILITY_BY_TIER[tier];
    const pickup = match.getWeaponPickupAt(100, 200, 1);
    expect(pickup).toBeDefined();
    expect(pickup!.weapon.ammo).toBe(remainingDurability);
    expect(pickup!.weapon.maxAmmo).toBe(maxAmmo);
  });

  it('handles player with no throws in flight', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Thrower');

    match.dropBoomerangsForDeadPlayer('p1');

    expect(player.combat.throwsInFlight.size).toBe(0);
  });

  it('handles mix of boomerang and non-boomerang projectiles', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Thrower');
    match.addPlayer('p2', 'Other');

    const boomerang = createBoomerangProjectile('bp1', 'p1', 100, 100, 5);
    const axe = createThrownProjectile('tp1', 'p1', 200, 200);
    match.addProjectile(boomerang);
    match.addProjectile(axe);
    player.combat.addThrowInFlight('bp1');
    player.combat.addThrowInFlight('tp1');

    match.dropBoomerangsForDeadPlayer('p1');

    const state = match.getState();
    expect(state.projectiles.has('bp1')).toBe(false);
    expect(state.projectiles.has('tp1')).toBe(true);
    expect(match.getWeaponPickupAt(100, 100, 1)).toBeDefined();
    expect(player.combat.throwsInFlight.size).toBe(0);
  });
});

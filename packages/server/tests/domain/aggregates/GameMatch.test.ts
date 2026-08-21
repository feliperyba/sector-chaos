import { describe, it, expect } from 'vitest';
import {
  TileType,
  MatchPhase,
  PlayerStatus,
  PLAYER,
  WeaponType,
  WeaponTier,
  ChestRarity,
  TrapType,
  SeededRNG,
} from '@sector-battle/shared';
import type { GameConfig, SpawnPoint } from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { OpenChestCommand } from '../../../src/application/commands/OpenChestCommand.ts';
import { Projectile } from '../../../src/domain/entities/Projectile.ts';
import { PowerUp } from '../../../src/domain/entities/PowerUp.ts';
import { Trap } from '../../../src/domain/entities/Trap.ts';
import { Chest } from '../../../src/domain/entities/Chest.ts';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import { Exit } from '../../../src/domain/entities/Exit.ts';
import { Explosion } from '../../../src/domain/entities/Explosion.ts';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { GridCoord } from '../../../src/domain/value-objects/GridCoord.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../src/domain/aggregates/createMatchServices.ts';

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

const defaultSpawnPoints: SpawnPoint[] = [
  { x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 0 },
  { x: 128, y: 128, sectorCoord: { row: 0, col: 0 }, priority: 1 },
];

function createMatch(
  overrides: { grid?: TileType[][]; spawnPoints?: SpawnPoint[]; config?: Partial<GameConfig> } = {},
): GameMatch {
  const grid = overrides.grid ?? makeGrid(10, 10, TileType.EMPTY);
  const spawnPoints = overrides.spawnPoints ?? defaultSpawnPoints;
  const config = createTestConfig(overrides.config);
  const services = createMatchServices(config);
  const pools = createMatchPools();
  const lootRng = new SeededRNG(12345);
  return new GameMatch('test-match', config, grid, spawnPoints, services, pools, lootRng);
}

describe('GameMatch', () => {
  describe('Constructor', () => {
    it('initializes with correct properties', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const match = createMatch({ grid });
      expect(match.matchId).toBe('test-match');
      expect(match.mapWidth).toBe(10);
      expect(match.mapHeight).toBe(10);
      expect(match.currentTick).toBe(0);
      expect(match.currentPhase).toBe(MatchPhase.WAITING);
    });

    it('handles empty grid (0 rows) without crash', () => {
      const grid: TileType[][] = [];
      const match = createMatch({ grid });
      expect(match.mapWidth).toBe(0);
      expect(match.mapHeight).toBe(0);
    });

    it('creates default services when none provided', () => {
      const match = createMatch();
      expect(match.getDamagePipeline()).toBeDefined();
    });
  });

  describe('Entity Management - Players', () => {
    it('addPlayer assigns spawn point and returns Player', () => {
      const match = createMatch();
      const p1 = match.addPlayer('p1', 'Alice');
      expect(p1.id).toBe('p1');
      expect(p1.name).toBe('Alice');
      expect(p1.movement.position.x).toBe(64);
      expect(p1.movement.position.y).toBe(64);
      expect(match.playersCount).toBe(1);

      const p2 = match.addPlayer('p2', 'Bob');
      expect(p2.movement.position.x).toBe(128);
      expect(p2.movement.position.y).toBe(128);
      expect(match.playersCount).toBe(2);
    });

    it('addPlayer wraps spawn points round-robin', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.addPlayer('p2', 'Bob');
      const p3 = match.addPlayer('p3', 'Charlie');
      expect(p3.movement.position.x).toBe(64);
      expect(p3.movement.position.y).toBe(64);
    });

    it('addPlayer sets survivalStartTick and spawnTick', () => {
      const match = createMatch();
      for (let i = 0; i < 5; i++) match.advanceTick();
      const player = match.addPlayer('p1', 'Alice');
      expect(player.survivalStartTick).toBe(5);
      expect(player.spawnTick).toBe(5);
    });

    it('addPlayer sets freshSpawnExpiryTick', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      const expected = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      expect(player.statusEffects.freshSpawnExpiryTick).toBe(expected);
    });

    it('removePlayer marks dead and disconnected', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.removePlayer('p1');
      const player = match.getPlayer('p1');
      expect(player!.connected).toBe(false);
      expect(player!.statusEffects.status).toBe(PlayerStatus.DEAD);
      expect(match.getPlayers()).toHaveLength(1);
      expect(match.alivePlayerCount).toBe(0);
    });

    it('removePlayer with unknown player does not crash', () => {
      const match = createMatch();
      expect(() => match.removePlayer('unknown')).not.toThrow();
    });

    it('getPlayer returns player by id', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      expect(match.getPlayer('p1')).toBeDefined();
      expect(match.getPlayer('p1')!.id).toBe('p1');
      expect(match.getPlayer('unknown')).toBeUndefined();
    });

    it('forEachAlivePlayer visits active only', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.addPlayer('p2', 'Bob');
      match.removePlayer('p1');
      const visited: string[] = [];
      match.forEachAlivePlayer((p) => {
        visited.push(p.id);
      });
      expect(visited).toHaveLength(1);
      expect(visited[0]).toBe('p2');
    });

    it('getAlivePlayerCount counts active players', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.addPlayer('p2', 'Bob');
      match.addPlayer('p3', 'Charlie');
      match.removePlayer('p1');
      expect(match.getAlivePlayerCount()).toBe(2);
    });
  });

  describe('Entity Management - Projectiles', () => {
    it('addProjectile adds to internal map with meta', () => {
      const match = createMatch();
      const proj = new Projectile(
        'proj-1',
        'p1',
        new Position(64, 64),
        100,
        0,
        10,
        3,
        WeaponType.DAGGER,
        5,
        500,
      );
      match.addProjectile(proj);
      const state = match.getState();
      expect(state.projectiles.has('proj-1')).toBe(true);
    });

    it('removeProjectile removes and releases to pool', () => {
      const match = createMatch();
      const proj = new Projectile(
        'proj-1',
        'p1',
        new Position(64, 64),
        100,
        0,
        10,
        3,
        WeaponType.DAGGER,
        5,
        500,
      );
      match.addProjectile(proj);
      match.removeProjectile('proj-1');
      const state = match.getState();
      expect(state.projectiles.has('proj-1')).toBe(false);
    });
  });

  describe('Entity Management - Explosions, PowerUps, Traps, Chests, Destructibles', () => {
    it('addExplosion / addPowerUp / addTrap / addChest / addDestructible / addExit', () => {
      const match = createMatch();
      const explosion = new Explosion(
        'ex-1',
        'p1',
        new Position(64, 64),
        new GridCoord(1, 1),
        [],
        50,
        10,
      );
      match.addExplosion(explosion);

      const powerUp = PowerUp.create('pu-1', 'health_pack', new Position(64, 64), 0);
      match.addPowerUp(powerUp);

      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(128, 128));
      match.addTrap(trap);

      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(192, 192));
      match.addChest(chest);

      const destructible = Destructible.create('d-1', 'crate', new Position(256, 256));
      match.addDestructible(destructible);

      const exit = new Exit('exit-1', new Position(320, 320), new GridCoord(5, 5), 0);
      match.addExit(exit);

      const state = match.getState();
      expect(state.explosions.has('ex-1')).toBe(true);
      expect(state.powerUps.has('pu-1')).toBe(true);
      expect(state.traps.has('trap-1')).toBe(true);
      expect(state.chests.has('chest-1')).toBe(true);
      expect(state.destructibles.has('d-1')).toBe(true);
      expect(state.exits.has('exit-1')).toBe(true);
    });

    it('addWeaponPickup creates and stores WeaponPickup', () => {
      const match = createMatch();
      const weapon = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', weapon, new Position(64, 64));
      const state = match.getState();
      expect(state.weaponPickups.has('wp-1')).toBe(true);
    });
  });

  describe('Entity Management - Removal', () => {
    it('removeWeaponPickup deletes from map', () => {
      const match = createMatch();
      const weapon = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', weapon, new Position(128, 128));
      match.removeWeaponPickup('wp-1');
      expect(match.findWeaponPickupAtTile(2, 2)).toBeNull();
    });

    it('removeChestById / removePowerUpById / removeTrapById', () => {
      const match = createMatch();

      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(128, 128));
      match.addChest(chest);
      match.removeChestById('chest-1');
      expect(match.getState().chests.has('chest-1')).toBe(false);

      const pu = PowerUp.create('pu-1', 'health_pack', new Position(128, 128), 0);
      match.addPowerUp(pu);
      match.removePowerUpById('pu-1');
      expect(match.getState().powerUps.has('pu-1')).toBe(false);

      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(128, 128));
      match.addTrap(trap);
      match.removeTrapById('trap-1');
      expect(match.getState().traps.has('trap-1')).toBe(false);
    });
  });

  describe('Grid Access', () => {
    it('getTileAt returns tile at coordinates', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY, [
        { x: 2, y: 3, tile: TileType.DESTRUCTIBLE_WALL },
      ]);
      const match = createMatch({ grid });
      expect(match.getTileAt(2, 3)).toBe(TileType.DESTRUCTIBLE_WALL);
    });

    it('getTileAt returns INDESTRUCTIBLE_WALL for out of bounds', () => {
      const match = createMatch();
      expect(match.getTileAt(-1, 0)).toBe(TileType.INDESTRUCTIBLE_WALL);
      expect(match.getTileAt(0, 100)).toBe(TileType.INDESTRUCTIBLE_WALL);
    });

    it('setTileAt modifies grid in place', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY, [
        { x: 2, y: 3, tile: TileType.DESTRUCTIBLE_WALL },
      ]);
      const match = createMatch({ grid });
      match.setTileAt(2, 3, TileType.EMPTY);
      expect(match.getTileAt(2, 3)).toBe(TileType.EMPTY);
    });

    it('setTileAt out of bounds is no-op', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const match = createMatch({ grid });
      expect(() => match.setTileAt(-1, -1, TileType.EMPTY)).not.toThrow();
    });

    it('getGrid returns reference to internal grid', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const match = createMatch({ grid });
      expect(match.getGrid()).toBe(grid);
    });

    it('isTileBlocked returns true for blocked tile types', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY);
      const match = createMatch({ grid });

      grid[0]![0] = TileType.INDESTRUCTIBLE_WALL;
      expect(match.isTileBlocked(0, 0)).toBe(true);

      grid[0]![1] = TileType.DESTRUCTIBLE_WALL;
      expect(match.isTileBlocked(1, 0)).toBe(true);

      grid[0]![2] = TileType.DESTRUCTIBLE_BARREL;
      expect(match.isTileBlocked(2, 0)).toBe(true);

      grid[0]![3] = TileType.INDESTRUCTIBLE_CRATE;
      expect(match.isTileBlocked(3, 0)).toBe(true);

      grid[0]![4] = TileType.DESTRUCTIBLE_CRATE;
      expect(match.isTileBlocked(4, 0)).toBe(true);

      grid[0]![5] = TileType.CHEST;
      expect(match.isTileBlocked(5, 0)).toBe(true);

      grid[0]![6] = TileType.DOOR_CLOSED;
      expect(match.isTileBlocked(6, 0)).toBe(true);
    });

    it('isTileBlocked returns false for EMPTY and EXIT', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY, [{ x: 0, y: 1, tile: TileType.EXIT }]);
      const match = createMatch({ grid });
      expect(match.isTileBlocked(0, 0)).toBe(false);
      expect(match.isTileBlocked(0, 1)).toBe(false);
    });

    it('isTileBlocked returns true for out of bounds', () => {
      const match = createMatch();
      expect(match.isTileBlocked(-1, 0)).toBe(true);
      expect(match.isTileBlocked(0, -1)).toBe(true);
      expect(match.isTileBlocked(100, 0)).toBe(true);
      expect(match.isTileBlocked(0, 100)).toBe(true);
    });

    it('worldToGrid converts world coordinates to grid', () => {
      const match = createMatch();
      const result = match.worldToGrid(100, 200);
      expect(result.gridX).toBe(1);
      expect(result.gridY).toBe(3);
    });
  });

  describe('Entity Lookup by Position', () => {
    it('findDestructibleAtTile finds destructible at grid coords', () => {
      const match = createMatch();
      const d = Destructible.create('d-1', 'crate', new Position(128, 128));
      match.addDestructible(d);
      expect(match.findDestructibleAtTile(2, 2)).toBe('d-1');
    });

    it('findDestructibleAtTile returns null when none found', () => {
      const match = createMatch();
      expect(match.findDestructibleAtTile(2, 2)).toBeNull();
    });

    it('findChestAtTile returns id when entity at matching position', () => {
      const match = createMatch();
      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(128, 128));
      match.addChest(chest);
      expect(match.findChestAtTile(2, 2)).toBe('chest-1');
      expect(match.findChestAtTile(0, 0)).toBeNull();
    });

    it('findWeaponPickupAtTile skips inactive entities', () => {
      const match = createMatch();
      const weapon = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', weapon, new Position(128, 128));
      expect(match.findWeaponPickupAtTile(2, 2)).toBe('wp-1');

      const pickup = match.getState().weaponPickups.get('wp-1')!;
      pickup.deactivate();
      expect(match.findWeaponPickupAtTile(2, 2)).toBeNull();
    });

    it('findPowerUpAtTile skips inactive entities', () => {
      const match = createMatch();
      const pu = PowerUp.create('pu-1', 'health_pack', new Position(128, 128), 0);
      match.addPowerUp(pu);
      expect(match.findPowerUpAtTile(2, 2)).toBe('pu-1');

      pu.deactivate();
      expect(match.findPowerUpAtTile(2, 2)).toBeNull();
    });

    it('findTrapAtTile finds trap even after triggering', () => {
      const match = createMatch();
      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(128, 128));
      match.addTrap(trap);
      expect(match.findTrapAtTile(2, 2)).toBe('trap-1');

      trap.trigger(0, 'p1');
      expect(match.findTrapAtTile(2, 2)).toBe('trap-1');
    });
  });

  describe('Weapon Pickup Queries', () => {
    it('getWeaponPickupAt finds nearest active pickup within range', () => {
      const match = createMatch();
      const w1 = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      const w2 = new WeaponEntity('w-2', WeaponType.SHORT_SWORD, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', w1, new Position(64, 64));
      match.addWeaponPickup('wp-2', w2, new Position(100, 100));

      const result = match.getWeaponPickupAt(66, 66, 50);
      expect(result).toBeDefined();
      expect(result!.id).toBe('wp-1');
    });

    it('getWeaponPickupAt returns undefined when none in range', () => {
      const match = createMatch();
      const w1 = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', w1, new Position(500, 500));
      expect(match.getWeaponPickupAt(66, 66, 50)).toBeUndefined();
    });

    it('getInteractablesInRange returns closed chests and active weapon pickups', () => {
      const match = createMatch();
      const playerPos = new Position(64, 64);

      const closedChest = Chest.create('chest-1', ChestRarity.COMMON, new Position(80, 80));
      match.addChest(closedChest);

      const weapon = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', weapon, new Position(70, 70));

      const interactables = match.getInteractablesInRange(playerPos, 200);
      expect(interactables.some((i) => i.type === 'chest' && i.id === 'chest-1')).toBe(true);
      expect(interactables.some((i) => i.type === 'weapon_pickup' && i.id === 'wp-1')).toBe(true);
    });

    it('getInteractablesInRange excludes open chests and inactive pickups', () => {
      const match = createMatch();
      const playerPos = new Position(64, 64);

      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(80, 80));
      chest.startOpening('p1', 20, new Position(64, 64));
      match.addChest(chest);

      const weapon = new WeaponEntity('w-1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup('wp-1', weapon, new Position(70, 70));
      match.getState().weaponPickups.get('wp-1')!.deactivate();

      const interactables = match.getInteractablesInRange(playerPos, 200);
      expect(interactables.every((i) => i.id !== 'chest-1')).toBe(true);
      expect(interactables.every((i) => i.id !== 'wp-1')).toBe(true);
    });
  });

  describe('Event Accumulation', () => {
    it('drainEvents returns accumulated events and clears', () => {
      const match = createMatch();
      const e1 = { type: 'Test1', tick: 0, timestamp: 0 };
      const e2 = { type: 'Test2', tick: 0, timestamp: 0 };
      match.emitEvent(e1);
      match.emitEvent(e2);
      const drained = match.drainEvents();
      expect(drained).toHaveLength(2);
      expect(drained).toContainEqual(e1);
      expect(drained).toContainEqual(e2);
      expect(match.drainEvents()).toEqual([]);
    });

    it('movePlayer updates position and emits no event', () => {
      const match = createMatch();
      const p1 = match.addPlayer('p1', 'Alice');
      match.movePlayer('p1', new Position(100, 200));
      expect(p1.movement.position.x).toBe(100);
      expect(p1.movement.position.y).toBe(200);
      expect(match.drainEvents()).toEqual([]);
    });

    it('destroyDestructible (barrel) pushes BarrelExploded and DestructibleDestroyed', () => {
      const grid = makeGrid(10, 10, TileType.EMPTY, [
        { x: 2, y: 2, tile: TileType.DESTRUCTIBLE_BARREL },
      ]);
      const match = createMatch({ grid });
      const barrel = Destructible.create('barrel-1', 'barrel', new Position(128, 128));
      match.addDestructible(barrel);
      match.destroyDestructible('barrel-1');
      const events = match.drainEvents();
      expect(events.some((e) => e.type === 'BarrelExploded')).toBe(true);
      expect(events.some((e) => e.type === 'DestructibleDestroyed')).toBe(true);
    });

    it('destroyDestructible (non-barrel) pushes DestructibleDestroyed only', () => {
      const match = createMatch();
      const crate = Destructible.create('crate-1', 'crate', new Position(128, 128));
      match.addDestructible(crate);
      match.destroyDestructible('crate-1');
      const events = match.drainEvents();
      expect(events.some((e) => e.type === 'DestructibleDestroyed')).toBe(true);
      expect(events.some((e) => e.type === 'BarrelExploded')).toBe(false);
    });
  });

  describe('Tick Advancement', () => {
    it('advanceTick increments tick and matchTime', () => {
      const match = createMatch();
      expect(match.currentTick).toBe(0);
      expect(match.matchTime).toBe(0);
      match.advanceTick();
      expect(match.currentTick).toBe(1);
      expect(match.matchTime).toBe(1);
    });

    it('nextId generates unique IDs', () => {
      const match = createMatch();
      expect(match.nextId()).toBe('match-1');
      expect(match.nextId()).toBe('match-2');
    });
  });

  describe('Trap Management', () => {
    it('checkTrapReveals reveals traps near alive players', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      const player = match.getPlayer('p1')!;
      player.movement.position = new Position(130, 130);
      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(128, 128));
      match.addTrap(trap);
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(true);
    });

    it('checkTrapReveals does not reveal distant traps', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(500, 500));
      match.addTrap(trap);
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(false);
    });

    it('getActiveTraps returns all traps regardless of trigger state', () => {
      const match = createMatch();
      const trap1 = Trap.create('trap-1', TrapType.SPIKE, new Position(128, 128));
      const trap2 = Trap.create('trap-2', TrapType.FIRE, new Position(256, 256));
      match.addTrap(trap1);
      match.addTrap(trap2);
      trap1.trigger(0, 'p1');
      expect(match.getActiveTraps()).toHaveLength(2);
    });
  });

  describe('Chest Management', () => {
    it('cancelChestOpeningForPlayer interrupts opening chests', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(64, 64));
      match.addChest(chest);
      const result = new OpenChestCommand(match).execute({
        playerId: 'p1',
        chestId: 'chest-1',
        tick: 0,
      });
      expect(result.success).toBe(true);
      expect(chest.state).toBe('opening');
      match.cancelChestOpeningForPlayer('p1');
      expect(chest.state).toBe('closed');
    });

    it('server-chest-cancel-index: cancel releases only the cancelling player chests', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.addPlayer('p2', 'Bob');
      const chestA = Chest.create('chest-a', ChestRarity.COMMON, new Position(64, 64));
      const chestB = Chest.create('chest-b', ChestRarity.RARE, new Position(128, 128));
      match.addChest(chestA);
      match.addChest(chestB);
      const command = new OpenChestCommand(match);
      expect(command.execute({ playerId: 'p1', chestId: 'chest-a', tick: 0 }).success).toBe(true);
      expect(command.execute({ playerId: 'p2', chestId: 'chest-b', tick: 0 }).success).toBe(true);

      match.cancelChestOpeningForPlayer('p1');

      expect(chestA.state).toBe('closed');
      expect(chestA.openingPlayerId).toBeNull();
      expect(chestB.state).toBe('opening');
      expect(chestB.openingPlayerId).toBe('p2');
    });

    it('server-chest-cancel-index: cancel for a player with no opening chest is a no-op', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.addPlayer('p2', 'Bob');
      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(128, 128));
      match.addChest(chest);
      expect(
        new OpenChestCommand(match).execute({ playerId: 'p2', chestId: 'chest-1', tick: 0 })
          .success,
      ).toBe(true);

      match.cancelChestOpeningForPlayer('p1');

      expect(chest.state).toBe('opening');
    });

    it('server-chest-cancel-index: re-opening after cancel registers and cancels again', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      const chest = Chest.create('chest-1', ChestRarity.COMMON, new Position(64, 64));
      match.addChest(chest);
      const command = new OpenChestCommand(match);
      expect(command.execute({ playerId: 'p1', chestId: 'chest-1', tick: 0 }).success).toBe(true);
      match.cancelChestOpeningForPlayer('p1');
      expect(chest.state).toBe('closed');

      expect(command.execute({ playerId: 'p1', chestId: 'chest-1', tick: 1 }).success).toBe(true);
      match.cancelChestOpeningForPlayer('p1');
      expect(chest.state).toBe('closed');
    });

    it('getChests returns all chests', () => {
      const match = createMatch();
      match.addChest(Chest.create('chest-1', ChestRarity.COMMON, new Position(64, 64)));
      match.addChest(Chest.create('chest-2', ChestRarity.RARE, new Position(128, 128)));
      match.addChest(Chest.create('chest-3', ChestRarity.EPIC, new Position(192, 192)));
      expect(match.getChests()).toHaveLength(3);
    });
  });

  describe('State Query', () => {
    it('getState returns all collections and state', () => {
      const match = createMatch();
      const state = match.getState();
      expect(state.players).toBeInstanceOf(Map);
      expect(state.projectiles).toBeInstanceOf(Map);
      expect(state.powerUps).toBeInstanceOf(Map);
      expect(state.traps).toBeInstanceOf(Map);
      expect(state.chests).toBeInstanceOf(Map);
      expect(state.destructibles).toBeInstanceOf(Map);
      expect(state.weaponPickups).toBeInstanceOf(Map);
      expect(state.exits).toBeInstanceOf(Map);
      expect(state.explosions).toBeInstanceOf(Map);
      expect(state.tick).toBe(0);
      expect(state.phase).toBe(MatchPhase.WAITING);
      expect(state.zone).toBeDefined();
      expect(state.grid).toBeDefined();
      expect(state.matchTime).toBe(0);
      expect('lastProcessedInput' in state).toBe(true);
    });

    it('getState returns live references', () => {
      const match = createMatch();
      const state = match.getState();
      match.addPlayer('p1', 'Alice');
      expect(state.players.has('p1')).toBe(true);
    });

    it('getCollisionService / getDamagePipeline return service instances', () => {
      const match = createMatch();
      expect(match.getCollisionService()).toBeDefined();
      expect(match.getDamagePipeline()).toBeDefined();
    });
  });

  describe('Zone Damage', () => {
    it('applyZoneDamage applies damage to player', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      const spawnInvTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      for (let i = 0; i <= spawnInvTicks; i++) match.advanceTick();
      const result = match.applyZoneDamage('p1', 10);
      expect(result.damageApplied).toBe(10);
      expect(result.killed).toBe(false);
    });

    it('applyZoneDamage returns zero for dead player', () => {
      const match = createMatch();
      match.addPlayer('p1', 'Alice');
      match.removePlayer('p1');
      const result = match.applyZoneDamage('p1', 10);
      expect(result.killed).toBe(false);
      expect(result.damageApplied).toBe(0);
    });

    it('applyZoneDamage returns zero for unknown player', () => {
      const match = createMatch();
      const result = match.applyZoneDamage('unknown', 10);
      expect(result.killed).toBe(false);
      expect(result.damageApplied).toBe(0);
    });
  });
});

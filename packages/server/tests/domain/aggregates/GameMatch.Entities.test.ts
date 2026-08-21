import {
  TileType,
  WeaponType,
  SeededRNG,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { Position, GridCoord } from '../../../src/domain/value-objects/index.ts';
import { Destructible } from '../../../src/domain/entities/index.ts';
import { Projectile } from '../../../src/domain/entities/index.ts';
import { Explosion } from '../../../src/domain/entities/index.ts';
import { Trap } from '../../../src/domain/entities/index.ts';
import { TrapType } from '@sector-battle/shared';
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

describe('GameMatch', () => {
  describe('destroyDestructible', () => {
    it('removes destructible and returns event', () => {
      const match = createMatch();
      const destructible = Destructible.create('d1', 'crate', new Position(160, 160));
      match.addDestructible(destructible);
      const events = match.destroyDestructible('d1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('DestructibleDestroyed');
      expect(events[0].id).toBe('d1');
      expect(events[0].destructibleType).toBe('crate');
      expect(events[0].position).toEqual({ x: 160, y: 160 });
    });

    it('returns empty for unknown id', () => {
      const match = createMatch();
      expect(match.destroyDestructible('unknown')).toEqual([]);
    });
  });

  describe('addProjectile / removeProjectile', () => {
    it('manage projectile collection', () => {
      const match = createMatch();
      const projectile = new Projectile(
        'pr1',
        'p1',
        new Position(0, 0),
        100,
        100,
        10,
        3,
        WeaponType.DAGGER,
      );
      match.addProjectile(projectile);
      expect(match.getState().projectiles.has('pr1')).toBe(true);
      match.removeProjectile('pr1');
      expect(match.getState().projectiles.has('pr1')).toBe(false);
    });
  });

  describe('addExplosion', () => {
    it('manages explosion collection', () => {
      const match = createMatch();
      const explosion = new Explosion(
        'e1',
        'p1',
        new Position(0, 0),
        new GridCoord(1, 1),
        [new GridCoord(1, 1)],
        10,
        5,
      );
      match.addExplosion(explosion);
      expect(match.getState().explosions.has('e1')).toBe(true);
      match.addExplosion(explosion);
      expect(match.getState().explosions.has('e1')).toBe(true);
    });
  });

  describe('checkTrapReveals', () => {
    it('reveals trap when player is within 2 tiles', () => {
      const match = createMatch();
      const trap = Trap.create('trap1', TrapType.SPIKE, new Position(0, 0));
      match.addTrap(trap);
      match.addPlayer('p1', 'Player1');
      const player = match.getPlayer('p1');
      if (player) {
        player.movement.position = new Position(50, 50);
      }
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(true);
    });

    it('does not reveal trap when player is beyond 2 tiles', () => {
      const match = createMatch();
      const trap = Trap.create('trap1', TrapType.SPIKE, new Position(0, 0));
      match.addTrap(trap);
      match.addPlayer('p1', 'Player1');
      const player = match.getPlayer('p1');
      if (player) {
        player.movement.position = new Position(200, 200);
      }
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(false);
    });

    it('stays revealed permanently after reveal', () => {
      const match = createMatch();
      const trap = Trap.create('trap1', TrapType.SPIKE, new Position(0, 0));
      match.addTrap(trap);
      match.addPlayer('p1', 'Player1');
      const player = match.getPlayer('p1');
      if (player) {
        player.movement.position = new Position(50, 50);
      }
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(true);
      if (player) {
        player.movement.position = new Position(500, 500);
      }
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(true);
    });

    it('skips already revealed traps', () => {
      const match = createMatch();
      const trap = Trap.create('trap1', TrapType.SPIKE, new Position(0, 0));
      trap.reveal();
      match.addTrap(trap);
      match.addPlayer('p1', 'Player1');
      const player = match.getPlayer('p1');
      if (player) {
        player.movement.position = new Position(10, 10);
      }
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(true);
    });

    it('reveals trap when any of multiple players is within range', () => {
      const match = createMatch();
      const trap = Trap.create('trap1', TrapType.SPIKE, new Position(0, 0));
      match.addTrap(trap);
      match.addPlayer('p1', 'Player1');
      match.addPlayer('p2', 'Player2');
      const p1 = match.getPlayer('p1');
      const p2 = match.getPlayer('p2');
      if (p1) p1.movement.position = new Position(200, 200);
      if (p2) p2.movement.position = new Position(30, 30);
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(true);
    });

    it('does not reveal trap when no players exist', () => {
      const match = createMatch();
      const trap = Trap.create('trap1', TrapType.SPIKE, new Position(0, 0));
      match.addTrap(trap);
      match.checkTrapReveals();
      expect(trap.isRevealed).toBe(false);
    });
  });
});

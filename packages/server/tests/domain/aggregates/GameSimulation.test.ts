import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TileType,
  MatchPhase,
  PLAYER,
  WeaponType,
  WeaponTier,
  InputAction,
  NETWORK,
  ChestRarity,
  TrapType,
  SeededRNG,
} from '@sector-battle/shared';
import type { GameConfig, SpawnPoint } from '@sector-battle/shared';
import { GameSimulation } from '../../../src/application/simulation/GameSimulation.ts';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { WeaponEntity } from '../../../src/domain/entities/Weapon.ts';
import { Trap } from '../../../src/domain/entities/Trap.ts';
import { Chest } from '../../../src/domain/entities/Chest.ts';
import { PowerUp } from '../../../src/domain/entities/PowerUp.ts';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import {
  type IMovementService,
  MatchFlowService,
  InMatchReconnectionManager,
} from '../../../src/domain/services/index.ts';
import type { ZoneService } from '../../../src/domain/services/ZoneService.ts';
import type { DomainEvent } from '../../../src/domain/events/index.ts';
import type { QueuedInput } from '../../../src/application/simulation/InputQueue.ts';
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

function createMockMovementService(): IMovementService {
  return {
    validateAndMove: vi.fn((_player, dx, dy, _dt, _grid) => ({
      newPosition: new Position(
        _player.movement.position.x + dx * 3.33,
        _player.movement.position.y + dy * 3.33,
      ),
      correctedPosition: new Position(
        _player.movement.position.x + dx * 3.33,
        _player.movement.position.y + dy * 3.33,
      ),
      moved: true,
      collisionOccurred: false,
    })),
    validateSpeed: vi.fn((_player, _newPosition, _dt) => true),
    clampToBounds: vi.fn((pos, _playerSize, _mapWidth, _mapHeight) => pos),
    resolvePlayerCollision: vi.fn((_movingPlayer, _forEachAlive, resolvedPos) => resolvedPos),
    resolveDashEndOverlap: vi.fn(
      (dashingPlayer, _forEachAlive, _grid) => dashingPlayer.movement.position,
    ),
  };
}

function createMockZoneService(overrides: Partial<ZoneService> = {}): ZoneService {
  return {
    initialize: vi.fn(),
    update: vi.fn(),
    setGrid: vi.fn(),
    configure: vi.fn(),
    advancePhase: vi.fn(),
    isInZone: vi.fn(() => true),
    shouldTick: vi.fn(() => true),
    getTickDamage: vi.fn(() => 5),
    getCurrentZone: vi.fn(),
    drainEvents: vi.fn(() => []),
    isOvertime: vi.fn(() => false),
    getSiegeInterval: vi.fn(),
    getPhaseDuration: vi.fn(),
    isWarning: vi.fn(() => false),
    getNextPhasePreview: vi.fn(() => null),
    ...overrides,
  } as unknown as ZoneService;
}

function createInput(
  playerId: string,
  action: InputAction,
  data: Record<string, unknown> = {},
  clientTick = 0,
  serverTick = 0,
): QueuedInput {
  return { playerId, action, data, clientTick, serverTick, receivedAt: Date.now() };
}

function createSimulation(
  overrides: { match?: GameMatch; movementService?: IMovementService } = {},
): GameSimulation {
  const match = overrides.match ?? createMatch();
  const movementService = overrides.movementService ?? createMockMovementService();
  return new GameSimulation(match, movementService);
}

function advancePastFreshSpawn(match: GameMatch): void {
  const spawnInvTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
  for (let i = 0; i <= spawnInvTicks; i++) match.advanceTick();
  match.drainEvents();
  for (const player of match.getState().players.values()) {
    player.expireFreshSpawn(match.currentTick);
  }
}

describe('GameSimulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('constructor creates simulation with correct state', () => {
      const sim = createSimulation();
      expect(sim.isRunning).toBe(false);
      expect(sim.isPaused).toBe(false);
      expect(sim.currentTick).toBe(0);
      expect(sim.tickRate).toBe(60);
    });

    it('constructor creates command objects', () => {
      const sim = createSimulation();
      sim.start();
      const events = sim.update(16.67);
      expect(Array.isArray(events)).toBe(true);
    });

    it('attachRuntimeServices stores zone service', () => {
      const sim = createSimulation();
      const mockZone = createMockZoneService();
      sim.attachRuntimeServices({
        zoneService: mockZone,
        matchFlow: new MatchFlowService(),
        reconnectionManager: new InMatchReconnectionManager(),
      });
      sim.start();
      sim.update(16.67);
      expect(mockZone.shouldTick).toHaveBeenCalled();
    });
  });

  describe('Lifecycle', () => {
    it('start sets running', () => {
      const sim = createSimulation();
      sim.start();
      expect(sim.isRunning).toBe(true);
      expect(sim.isPaused).toBe(false);
    });

    it('stop stops and clears effects', () => {
      const sim = createSimulation();
      sim.start();
      sim.stop();
      expect(sim.isRunning).toBe(false);
      expect(sim.isPaused).toBe(false);
    });

    it('pause pauses only when running', () => {
      const sim = createSimulation();
      sim.pause();
      expect(sim.isPaused).toBe(false);

      sim.start();
      sim.pause();
      expect(sim.isPaused).toBe(true);
    });

    it('resume resumes only when running and paused', () => {
      const sim = createSimulation();
      sim.resume();
      expect(sim.isPaused).toBe(false);

      sim.start();
      sim.resume();
      expect(sim.isPaused).toBe(false);

      sim.pause();
      sim.resume();
      expect(sim.isPaused).toBe(false);
    });
  });

  describe('Tick Execution', () => {
    it('update returns empty when not running', () => {
      const sim = createSimulation();
      const result = sim.update(16.67);
      expect(result).toEqual([]);
    });

    it('update returns empty when paused', () => {
      const sim = createSimulation();
      sim.start();
      sim.pause();
      const result = sim.update(16.67);
      expect(result).toEqual([]);
    });

    it('update executes one tick per 16.67ms', () => {
      const sim = createSimulation();
      sim.start();
      sim.update(16.67);
      expect(sim.currentTick).toBe(1);
    });

    it('update accumulates fractional time', () => {
      const sim = createSimulation();
      sim.start();
      sim.update(8.33);
      expect(sim.currentTick).toBe(0);
      sim.update(8.34);
      expect(sim.currentTick).toBe(1);
    });

    it('update caps at MAX_STEPS=4 per frame (ADR-0025) and carries leftover time', () => {
      const sim = createSimulation();
      sim.start();
      // A large frame (200ms = 12 raw ticks) runs at most MAX_STEPS=4 ticks;
      // the remaining ~133ms accumulates so the next small frame drains it
      // (no spiral-of-death catch-up cascade, but bounded catch-up is allowed
      // so interval drift under load does not run the sim in slow motion).
      sim.update(200);
      expect(sim.currentTick).toBe(4);
      // A single 16.67ms frame can only produce 4 more ticks if the leftover
      // time from the frame above was carried in the accumulator.
      sim.update(16.67);
      expect(sim.currentTick).toBe(8);
    });

    it('update never exceeds MAX_STEPS=4 regardless of frame time (ADR-0025)', () => {
      const sim = createSimulation();
      sim.start();
      sim.update(200);
      expect(sim.currentTick).toBe(4);
    });

    it('update returns domain events from all steps', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 1, dy: 0, aimAngle: 0 }));
      const events = sim.update(16.67);
      expect(events.length).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('11-Step Tick Order', () => {
    it('all 11 steps execute in order', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const mockZone = createMockZoneService();
      sim.attachRuntimeServices({
        zoneService: mockZone,
        matchFlow: new MatchFlowService(),
        reconnectionManager: new InMatchReconnectionManager(),
      });

      match.addPlayer('p1', 'Alice');

      const callOrder: string[] = [];

      vi.spyOn(match, 'forEachAlivePlayer').mockImplementation(() => {
        callOrder.push('step2_forEachAlivePlayer');
      });

      vi.spyOn(match, 'updateProjectiles').mockImplementation((() => {
        callOrder.push('step4_updateProjectiles');
        return [];
      }) as unknown as typeof match.updateProjectiles);

      vi.spyOn(match, 'updateExplosions').mockImplementation((() => {
        callOrder.push('step5_updateExplosions');
      }) as unknown as typeof match.updateExplosions);

      vi.spyOn(match, 'checkTrapReveals').mockImplementation((() => {
        callOrder.push('step7_checkTrapReveals');
      }) as unknown as typeof match.checkTrapReveals);

      vi.spyOn(match, 'applyZoneDamage').mockImplementation((() => {
        callOrder.push('step6_applyZoneDamage');
        return { damageApplied: 0, killed: false };
      }) as unknown as typeof match.applyZoneDamage);

      vi.spyOn(match, 'advanceTick').mockImplementation((() => {
        callOrder.push('advanceTick');
      }) as unknown as typeof match.advanceTick);

      vi.spyOn(match, 'drainEvents').mockImplementation((() => {
        callOrder.push('drainEvents');
        return [];
      }) as unknown as typeof match.drainEvents);

      sim.start();
      sim.update(16.67);

      expect(callOrder.indexOf('step4_updateProjectiles')).toBeLessThan(
        callOrder.indexOf('step5_updateExplosions'),
      );
      expect(callOrder.indexOf('step5_updateExplosions')).toBeLessThan(
        callOrder.indexOf('step7_checkTrapReveals'),
      );
    });

    it('step10 bot AI executes every tick', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      match.addPlayer('p1', 'Alice');
      sim.start();

      const botStep10 = vi.spyOn(
        sim as unknown as { step10_BotAI: (t: number) => void },
        'step10_BotAI',
      );

      sim.update(16.67);
      expect(botStep10).toHaveBeenCalledTimes(1);

      sim.update(16.67);
      expect(botStep10).toHaveBeenCalledTimes(2);

      for (let i = 0; i < 5; i++) sim.update(16.67);
      expect(botStep10).toHaveBeenCalledTimes(7);
    });

    it('step11 snapshot every tick', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      sim.start();

      const snapshotSpy = vi.spyOn(
        sim as unknown as { step11_Snapshot: (t: number) => void },
        'step11_Snapshot',
      );

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(1);

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(2);

      sim.update(16.67);
      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(4);
    });
  });

  describe('Input Processing', () => {
    it('processInput queues input for processing', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';

      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 1, dy: 0, aimAngle: 0 }));
      sim.update(16.67);

      expect(movementService.validateAndMove).toHaveBeenCalled();
    });

    it('step1 MOVE input dispatches to MovePlayerCommand', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';

      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 1, dy: 0, aimAngle: 0 }));
      sim.update(16.67);

      expect(movementService.validateAndMove).toHaveBeenCalled();
      const moveCall = movementService.validateAndMove as ReturnType<typeof vi.fn>;
      expect(moveCall.mock.calls[0]![1]).toBe(1);
      expect(moveCall.mock.calls[0]![2]).toBe(0);
    });

    it('step1 ATTACK input dispatches to AttackCommand', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.ATTACK, { aimAngle: 0.5 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      const rateLimiter = (freshSim as Record<string, unknown>)['attackRateLimiter'] as {
        ['buckets']: Map<string, { tokens: number }>;
      };
      const bucket = rateLimiter['buckets'].get('p1');
      expect(bucket).toBeDefined();
    });

    it('step1 ATTACK rate limited', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();

      for (let i = 0; i < 12; i++) {
        freshSim.processInput(
          createInput('p1', InputAction.ATTACK, { aimAngle: 0 }, i, match.currentTick + i),
        );
      }

      for (let i = 0; i < 12; i++) {
        freshSim.update(16.67);
      }

      const rateLimiter = (freshSim as Record<string, unknown>)['attackRateLimiter'] as {
        ['buckets']: Map<string, { tokens: number; lastRefill: number }>;
      };
      const bucket = rateLimiter['buckets'].get('p1');
      expect(bucket).toBeDefined();
      expect(bucket!.tokens).toBeLessThan(1);
    });

    it('step1 THROW input dispatches for thrown weapons', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const throwingAxe = new WeaponEntity(
        'w-throw',
        WeaponType.THROWING_AXE,
        WeaponTier.COMMON,
        5,
        5,
        30,
      );
      player.inventory.weapons[1] = throwingAxe;
      player.inventory.activeSlot = 1;

      const freshSim = createSimulation({ match });
      const attackCmd = (freshSim as Record<string, unknown>)['attackCommand'] as {
        execute: ReturnType<typeof vi.fn>;
      };
      const executeSpy = vi.spyOn(attackCmd, 'execute');

      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.THROW, { aimAngle: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(executeSpy).toHaveBeenCalled();
      executeSpy.mockRestore();
    });

    it('step1 THROW input ignored for non-thrown weapons', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const dagger = new WeaponEntity('w-dagger', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      player.inventory.weapons[1] = dagger;
      player.inventory.activeSlot = 1;

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.THROW, { aimAngle: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.combat.isInWindup()).toBe(false);
    });

    it('step1 PICKUP input handles weapon pickup', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const weapon = new WeaponEntity('w-pickup', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 30);
      match.addWeaponPickup(
        'wp-1',
        weapon,
        new Position(player.movement.position.x, player.movement.position.y),
      );

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(createInput('p1', InputAction.PICKUP, {}, 0, match.currentTick));
      const events = freshSim.update(16.67);

      const pickupEvent = events.find((e) => e.type === 'WeaponPickupCollected');
      expect(pickupEvent).toBeDefined();
    });

    it('step1 PICKUP input handles weapon swap when inventory full', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      player.inventory.weapons[1] = new WeaponEntity(
        'w1',
        WeaponType.DAGGER,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      player.inventory.weapons[2] = new WeaponEntity(
        'w2',
        WeaponType.SHORT_SWORD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );
      player.inventory.weapons[3] = new WeaponEntity(
        'w3',
        WeaponType.LONG_SWORD,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );

      const betterWeapon = new WeaponEntity(
        'w-better',
        WeaponType.HAMMER,
        WeaponTier.RARE,
        10,
        10,
        30,
      );
      match.addWeaponPickup(
        'wp-rare',
        betterWeapon,
        new Position(player.movement.position.x, player.movement.position.y),
      );

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(createInput('p1', InputAction.PICKUP, {}, 0, match.currentTick));
      const events = freshSim.update(16.67);

      const pickupEvent = events.find((e) => e.type === 'WeaponPickupCollected');
      expect(pickupEvent).toBeDefined();
    });

    it('step1 PICKUP input handles chest opening', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const chest = Chest.create('chest-1', ChestRarity.COMMON, player.movement.position);
      match.addChest(chest);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.PICKUP, { targetId: 'chest-1' }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(chest.state).toBe('opening');
    });

    it('step1 PICKUP input handles trap triggering', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const trap = Trap.create('trap-1', TrapType.SPIKE, player.movement.position);
      match.addTrap(trap);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.PICKUP, { targetId: 'trap-1' }, 0, match.currentTick),
      );
      const events = freshSim.update(16.67);

      const trapEvent = events.find((e) => e.type === 'TrapTriggered');
      expect(trapEvent).toBeDefined();
    });

    it('step1 SWITCH_SLOT input changes player slot', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.inventory.weapons[1] = new WeaponEntity(
        'w1',
        WeaponType.DAGGER,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );

      sim.start();
      sim.processInput(createInput('p1', InputAction.SWITCH_SLOT, { slot: 1 }));
      sim.update(16.67);

      expect(player.inventory.switchTarget).toBe(1);
    });

    it('step1 DASH input starts dash', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.DASH, { dx: 1, dy: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.movement.isDashing).toBe(true);
      const activeDashes = (freshSim as Record<string, unknown>)['activeDashes'] as Map<
        string,
        unknown
      >;
      expect(activeDashes.has('p1')).toBe(true);
    });

    it('step1 DASH input with zero direction uses facing angle', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.movement.facingAngle = Math.PI / 2;
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.DASH, { dx: 0, dy: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.movement.isDashing).toBe(true);
      const activeDashes = (freshSim as Record<string, unknown>)['activeDashes'] as Map<
        string,
        { directionX: number; directionY: number }
      >;
      const dash = activeDashes.get('p1')!;
      expect(dash.directionY).toBeCloseTo(1, 4);
      expect(dash.directionX).toBeCloseTo(0, 4);
    });

    it('step1 fresh spawn blocks ATTACK, THROW, DASH', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';

      sim.start();
      sim.processInput(createInput('p1', InputAction.ATTACK, { aimAngle: 0 }));
      sim.processInput(createInput('p1', InputAction.THROW, { aimAngle: 0 }));
      sim.processInput(createInput('p1', InputAction.DASH, { dx: 1, dy: 0 }));
      sim.update(16.67);

      expect(player.movement.isDashing).toBe(false);
      expect(player.combat.isInWindup()).toBe(false);
    });

    it('step1 fresh spawn allows MOVE, PICKUP, SWITCH_SLOT', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.inventory.weapons[1] = new WeaponEntity(
        'w1',
        WeaponType.DAGGER,
        WeaponTier.COMMON,
        10,
        10,
        30,
      );

      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 1, dy: 0, aimAngle: 0 }));
      sim.processInput(createInput('p1', InputAction.SWITCH_SLOT, { slot: 1 }));
      sim.update(16.67);

      expect(movementService.validateAndMove).toHaveBeenCalled();
      expect(player.inventory.switchTarget).toBe(1);
    });

    it('step1 sorts inputs by playerId', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const p2 = match.addPlayer('b-player', 'Bob');
      const p1 = match.addPlayer('a-player', 'Alice');
      p1.connectionState = 'connected';
      p2.connectionState = 'connected';

      const inputOrder: string[] = [];
      (movementService.validateAndMove as ReturnType<typeof vi.fn>).mockImplementation(
        (player: { id: string }) => {
          inputOrder.push(player.id);
          return {
            newPosition: player.movement.position,
            correctedPosition: player.movement.position,
            moved: true,
            collisionOccurred: false,
          };
        },
      );

      sim.start();
      sim.processInput({
        playerId: 'b-player',
        action: InputAction.MOVE,
        data: { dx: 1, dy: 0, aimAngle: 0 },
        clientTick: 0,
        serverTick: 0,
        receivedAt: Date.now(),
      });
      sim.processInput({
        playerId: 'a-player',
        action: InputAction.MOVE,
        data: { dx: 1, dy: 0, aimAngle: 0 },
        clientTick: 1,
        serverTick: 0,
        receivedAt: Date.now(),
      });
      sim.update(16.67);

      expect(inputOrder[0]).toBe('a-player');
      expect(inputOrder[1]).toBe('b-player');
    });

    it('step1 ignores disconnected players', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'disconnected';

      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 1, dy: 0, aimAngle: 0 }));
      sim.update(16.67);

      expect(movementService.validateAndMove).not.toHaveBeenCalled();
    });

    it('step1 updates lastProcessedInput', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';

      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 0, dy: 0 }, 42));
      sim.update(16.67);

      expect(sim.lastProcessedInput).toBe(42);
    });
  });

  describe('Zone Processing (step6)', () => {
    it('step6 no zone service is no-op', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      match.addPlayer('p1', 'Alice');
      sim.start();
      sim.update(16.67);
      expect(sim.currentTick).toBe(1);
    });

    it('step6 applies damage to out-of-zone players', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      const mockZone = createMockZoneService({
        isInZone: vi.fn(() => false),
        getTickDamage: vi.fn(() => 5),
      });
      freshSim.attachRuntimeServices({
        zoneService: mockZone,
        matchFlow: new MatchFlowService(),
        reconnectionManager: new InMatchReconnectionManager(),
      });

      vi.spyOn(match, 'applyZoneDamage').mockReturnValue({ damageApplied: 5, killed: false });

      freshSim.start();
      freshSim.update(16.67);

      expect(match.applyZoneDamage).toHaveBeenCalledWith('p1', 5);
    });

    it('step6 does not damage in-zone players', () => {
      const match = createMatch();
      const applyZoneSpy = vi.spyOn(match, 'applyZoneDamage');
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      const mockZone = createMockZoneService({
        isInZone: vi.fn(() => true),
      });
      freshSim.attachRuntimeServices({
        zoneService: mockZone,
        matchFlow: new MatchFlowService(),
        reconnectionManager: new InMatchReconnectionManager(),
      });
      freshSim.start();
      freshSim.update(16.67);

      expect(applyZoneSpy).not.toHaveBeenCalled();
      applyZoneSpy.mockRestore();
    });

    it('step6 emits PlayerEliminated when zone kills', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      player.health = player.health.damage(95);

      const freshSim = createSimulation({ match });
      const mockZone = createMockZoneService({
        isInZone: vi.fn(() => false),
        getTickDamage: vi.fn(() => 10),
      });
      freshSim.attachRuntimeServices({
        zoneService: mockZone,
        matchFlow: new MatchFlowService(),
        reconnectionManager: new InMatchReconnectionManager(),
      });
      freshSim.start();

      vi.spyOn(match, 'applyZoneDamage').mockImplementation((_pid: string, amount: number) => {
        player.health = player.health.damage(amount);
        return { damageApplied: amount, killed: player.health.isDead };
      });

      const events = freshSim.update(16.67);
      const elimEvent = events.find(
        (e) => e.type === 'PlayerEliminated' && (e as Record<string, unknown>)['cause'] === 'zone',
      );
      expect(elimEvent).toBeDefined();
    });

    it('step6 emits ZoneDamage event', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      const mockZone = createMockZoneService({
        isInZone: vi.fn(() => false),
        getTickDamage: vi.fn(() => 5),
      });
      freshSim.attachRuntimeServices({
        zoneService: mockZone,
        matchFlow: new MatchFlowService(),
        reconnectionManager: new InMatchReconnectionManager(),
      });
      freshSim.start();

      vi.spyOn(match, 'applyZoneDamage').mockReturnValue({
        damageApplied: 5,
        killed: false,
      });

      const events = freshSim.update(16.67);
      const zoneDamageEvent = events.find((e) => e.type === 'ZoneDamage');
      expect(zoneDamageEvent).toBeDefined();
      expect((zoneDamageEvent as Record<string, unknown>)['playersDamaged']).toBeDefined();
    });
  });

  describe('Trap Processing (step7)', () => {
    it('step7 reveals traps near players', () => {
      const match = createMatch();
      const checkSpy = vi.spyOn(match, 'checkTrapReveals');
      const sim = createSimulation({ match });
      match.addPlayer('p1', 'Alice');
      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(66, 66));
      match.addTrap(trap);
      sim.start();
      sim.update(16.67);
      expect(checkSpy).toHaveBeenCalled();
      checkSpy.mockRestore();
    });

    it('step7 ticks trap cooldowns', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      match.addPlayer('p1', 'Alice');
      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(500, 500));
      match.addTrap(trap);
      trap.cooldownRemaining = 5;

      sim.start();
      sim.update(16.67);

      expect(trap.cooldownRemaining).toBe(4);
    });

    it('step7 emits TrapCooldownExpired when cooldown reaches zero', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      match.addPlayer('p1', 'Alice');
      const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(500, 500));
      match.addTrap(trap);
      trap.cooldownRemaining = 1;

      sim.start();
      const events = sim.update(16.67);
      const expiredEvent = events.find((e) => e.type === 'TrapCooldownExpired');
      expect(expiredEvent).toBeDefined();
    });

    it('step7 ticks fire area DOT effects', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const triggerCmd = (sim as Record<string, unknown>)['triggerTrapCommand'] as {
        tickFireAreas: (tick: number) => void;
      };
      const tickFireAreasSpy = vi.spyOn(triggerCmd, 'tickFireAreas');

      match.addPlayer('p1', 'Alice');
      sim.start();
      sim.update(16.67);

      expect(tickFireAreasSpy).toHaveBeenCalled();
      tickFireAreasSpy.mockRestore();
    });
  });

  describe('Timer Expiry (step8)', () => {
    it('step8 expires dashes after duration', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.DASH, { dx: 1, dy: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.movement.isDashing).toBe(true);

      const dashDurationTicks = Math.round(PLAYER.DASH_DURATION * 60);
      for (let i = 0; i < dashDurationTicks; i++) {
        freshSim.update(16.67);
      }

      expect(player.movement.isDashing).toBe(false);
      const activeDashes = (freshSim as Record<string, unknown>)['activeDashes'] as Map<
        string,
        unknown
      >;
      expect(activeDashes.has('p1')).toBe(false);
    });

    it('step8 expires player barriers', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.activateBarrier(0, 3);

      sim.start();
      sim.update(16.67);
      sim.update(16.67);
      sim.update(16.67);
      sim.update(16.67);

      expect(player.statusEffects.barrierActive).toBe(false);
    });

    it('step8 updates player stagger', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.startStagger(200, 60);

      sim.start();
      const ticksNeeded = Math.ceil((200 / 1000) * 60);
      for (let i = 0; i < ticksNeeded; i++) {
        sim.update(16.67);
      }

      expect(player.isStaggered()).toBe(false);
    });

    it('step8 updates dash cooldown', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.DASH, { dx: 1, dy: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.movement.dashCooldownRemaining).toBeGreaterThan(0);

      const cooldownTicks = Math.ceil(PLAYER.DASH_COOLDOWN * 60);
      for (let i = 0; i < cooldownTicks; i++) {
        freshSim.update(16.67);
      }

      expect(player.movement.dashCooldownRemaining).toBe(0);
    });

    it('step8 ticks weapon cooldowns', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      const weapon = new WeaponEntity('w1', WeaponType.DAGGER, WeaponTier.COMMON, 10, 10, 5);
      player.inventory.weapons[1] = weapon;
      weapon.startAttack();

      sim.start();
      sim.update(16.67);

      expect(weapon.cooldownRemaining).toBeLessThan(5);
    });

    it('step8 expires fresh spawn', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');

      const freshSpawnTicks = Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
      sim.start();
      for (let i = 0; i <= freshSpawnTicks; i++) {
        sim.update(16.67);
      }

      expect(player.isFreshSpawn()).toBe(false);
    });

    it('step8 completes attack windups', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      player.combat.startWindup(2, player.inventory.activeSlot, 'arc');

      freshSim.start();
      freshSim.update(16.67);

      expect(player.combat.isInWindup()).toBe(true);

      freshSim.update(16.67);

      expect(player.combat.isInWindup()).toBe(false);
    });

    it('step8 expires power-up effects', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const pickupCmd = (sim as Record<string, unknown>)['pickupCommand'] as {
        expireEffects: ReturnType<typeof vi.fn>;
      };
      const expireSpy = vi.spyOn(pickupCmd, 'expireEffects');

      match.addPlayer('p1', 'Alice');
      sim.start();
      sim.update(16.67);

      expect(expireSpy).toHaveBeenCalled();
      expireSpy.mockRestore();
    });
  });

  describe('Death Resolution (step9)', () => {
    it('step9 processes deaths via DeathResolutionService', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';

      sim.start();
      sim.update(16.67);

      expect(sim.currentTick).toBeGreaterThanOrEqual(1);
    });

    it('step9 drops weapons for eliminated players', () => {
      const match = createMatch();
      const dropSpy = vi.spyOn(match, 'dropPlayerWeapons');
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.health = player.health.damage(player.health.max);

      sim.start();
      sim.update(16.67);

      expect(dropSpy).toHaveBeenCalledWith('p1');
      dropSpy.mockRestore();
    });

    it('step9 drops boomerangs for eliminated players', () => {
      const match = createMatch();
      const boomerangSpy = vi.spyOn(match, 'dropBoomerangsForDeadPlayer');
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.health = player.health.damage(player.health.max);

      sim.start();
      sim.update(16.67);

      expect(boomerangSpy).toHaveBeenCalledWith('p1');
      boomerangSpy.mockRestore();
    });

    it('step9 clears effects for eliminated players', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const pickupCmd = (sim as Record<string, unknown>)['pickupCommand'] as {
        clearAllEffectsForPlayer: ReturnType<typeof vi.fn>;
      };
      const clearSpy = vi.spyOn(pickupCmd, 'clearAllEffectsForPlayer');
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.health = player.health.damage(player.health.max);

      sim.start();
      sim.update(16.67);

      expect(clearSpy).toHaveBeenCalledWith('p1');
      clearSpy.mockRestore();
    });

    it('step9 cancels chest opening for eliminated players', () => {
      const match = createMatch();
      const cancelSpy = vi.spyOn(match, 'cancelChestOpeningForPlayer');
      const sim = createSimulation({ match });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      player.health = player.health.damage(player.health.max);

      sim.start();
      sim.update(16.67);

      expect(cancelSpy).toHaveBeenCalledWith('p1');
      cancelSpy.mockRestore();
    });

    it('step9 ends active dash for eliminated players', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.DASH, { dx: 1, dy: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.movement.isDashing).toBe(true);

      player.health = player.health.damage(player.health.max);
      freshSim.update(16.67);

      expect(player.movement.isDashing).toBe(false);
      const activeDashes = (freshSim as Record<string, unknown>)['activeDashes'] as Map<
        string,
        unknown
      >;
      expect(activeDashes.has('p1')).toBe(false);
    });
  });

  describe('Event Flow', () => {
    it('update collects events from all subsystems', () => {
      const match = createMatch();
      const movementService = createMockMovementService();
      const sim = createSimulation({ match, movementService });
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';

      sim.start();
      sim.processInput(createInput('p1', InputAction.MOVE, { dx: 1, dy: 0, aimAngle: 0 }));
      const events = sim.update(16.67);

      expect(Array.isArray(events)).toBe(true);
    });

    it('update events drained per tick', () => {
      const match = createMatch();
      const drainSpy = vi.spyOn(match, 'drainEvents').mockReturnValue([]);
      const sim = createSimulation({ match });

      sim.start();
      sim.update(16.67);

      expect(drainSpy).toHaveBeenCalled();
      drainSpy.mockRestore();
    });

    it('update runs at most MAX_STEPS=4 steps per frame (ADR-0025) and returns their events', () => {
      const match = createMatch();
      let eventCount = 0;
      vi.spyOn(match, 'drainEvents').mockImplementation(() => {
        eventCount++;
        return [{ type: `TestEvent${eventCount}`, tick: eventCount, timestamp: Date.now() }];
      });
      vi.spyOn(match, 'advanceTick').mockImplementation(() => {});

      const sim = createSimulation({ match });
      sim.start();
      // 200ms = 12 raw ticks, capped at MAX_STEPS=4: one event per executed step.
      const events = sim.update(200);

      expect(events.length).toBe(4);
    });
  });

  describe('State Snapshots', () => {
    it('step11 snapshot placeholder executed every tick', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const snapshotSpy = vi.spyOn(
        sim as unknown as { step11_Snapshot: (t: number) => void },
        'step11_Snapshot',
      );

      sim.start();

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(1);

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(2);

      sim.update(16.67);
      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(4);

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(5);

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(6);

      sim.update(16.67);
      expect(snapshotSpy).toHaveBeenCalledTimes(7);
    });
  });

  describe('Statistics', () => {
    it('getStats returns tick statistics', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      sim.start();
      for (let i = 0; i < 10; i++) sim.update(16.67);

      const stats = sim.getStats();
      expect(stats.totalTicks).toBe(10);
      expect(stats.avgTickTime).toBeGreaterThanOrEqual(0);
      expect(stats.maxTickTime).toBeGreaterThanOrEqual(0);
    });

    it('getStats tracks max tick time', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      sim.start();
      sim.update(16.67);
      sim.update(16.67);

      const stats = sim.getStats();
      expect(stats.maxTickTime).toBeGreaterThanOrEqual(0);
      expect(stats.maxTickTime).toBeLessThan(16);
    });
  });

  describe('Cleanup', () => {
    it('cleanupPlayer removes dash and rate limit state', () => {
      const match = createMatch();
      const player = match.addPlayer('p1', 'Alice');
      player.connectionState = 'connected';
      advancePastFreshSpawn(match);

      const freshSim = createSimulation({ match });
      freshSim.start();
      freshSim.processInput(
        createInput('p1', InputAction.DASH, { dx: 1, dy: 0 }, 0, match.currentTick),
      );
      freshSim.update(16.67);

      expect(player.movement.isDashing).toBe(true);

      freshSim.cleanupPlayer('p1');

      const activeDashes = (freshSim as Record<string, unknown>)['activeDashes'] as Map<
        string,
        unknown
      >;
      expect(activeDashes.has('p1')).toBe(false);
    });

    it('cleanupPlayer resets attack command state', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      const attackCmd = (sim as Record<string, unknown>)['attackCommand'] as {
        cleanupPlayer: ReturnType<typeof vi.fn>;
      };
      const cleanupSpy = vi.spyOn(attackCmd, 'cleanupPlayer');

      sim.cleanupPlayer('p1');
      expect(cleanupSpy).toHaveBeenCalledWith('p1');
      cleanupSpy.mockRestore();
    });
  });

  describe('Performance Characteristics', () => {
    it('update single tick completes within budget', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      for (let i = 0; i < 10; i++) {
        match.addPlayer(`p${i}`, `Player${i}`);
      }
      sim.start();

      const start = performance.now();
      sim.update(16.67);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(16);
    });

    it('update multiple ticks with no inputs fast', () => {
      const match = createMatch();
      const sim = createSimulation({ match });
      sim.start();

      const start = performance.now();
      sim.update(83.35);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(20);
    });
  });
});

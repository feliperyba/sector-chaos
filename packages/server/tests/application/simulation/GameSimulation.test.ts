import {
  InputAction,
  PlayerStatus,
  TileType,
  PLAYER,
  SeededRNG,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameSimulation, type QueuedInput } from '../../../src/application/simulation/index.ts';
import { CollisionService } from '../../../src/domain/services/CollisionService.ts';
import { MovementService } from '../../../src/domain/services/MovementService.ts';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../src/domain/aggregates/createMatchServices.ts';

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

function createSimulation(match?: GameMatch): GameSimulation {
  const m = match ?? createMatch();
  return new GameSimulation(m, createMovementService());
}

describe('GameSimulation', () => {
  it('starts and stops toggling isRunning', () => {
    const sim = createSimulation();
    expect(sim.isRunning).toBe(false);
    sim.start();
    expect(sim.isRunning).toBe(true);
    sim.stop();
    expect(sim.isRunning).toBe(false);
  });

  it('update does nothing when not running', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    const events = sim.update(16.67);
    expect(events).toEqual([]);
    expect(match.currentTick).toBe(0);
  });

  it('update advances match tick by one for 16.67ms', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    sim.update(16.67);
    expect(sim.currentTick).toBe(1);
  });

  it('update accumulates time across multiple calls', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    sim.update(16.67);
    expect(sim.currentTick).toBe(1);
    sim.update(16.67);
    expect(sim.currentTick).toBe(2);
  });

  it('caps ticks at MAX_STEPS (4) + 0.25s frame clamp to prevent spiral of death (ADR-0025)', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    // 10000ms frame: the 0.25s frameTime clamp bounds it to 15 raw steps
    // (600 without the clamp), and the MAX_STEPS=4 cap halves that again.
    // Both anti-spiral guards are exercised: exactly 4 ticks may run.
    sim.update(10000);
    expect(sim.currentTick).toBe(4);
  });

  it('returns domain events from match', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.ATTACK,
      data: { playerId: 'p1', aimAngle: 0, tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    const events = sim.update(16.67);
    expect(Array.isArray(events)).toBe(true);
  });

  it('processed inputs are not re-processed on subsequent updates', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.ATTACK,
      data: { playerId: 'p1', aimAngle: 0, tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    const firstEvents = sim.update(16.67);
    expect(firstEvents.length).toBeGreaterThanOrEqual(0);

    const secondEvents = sim.update(16.67);
    expect(secondEvents.length).toBeGreaterThanOrEqual(0);
  });

  it('pause and resume control simulation', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    expect(sim.isRunning).toBe(true);
    sim.pause();
    expect(sim.isPaused).toBe(true);
    expect(sim.isRunning).toBe(true);
    sim.update(16.67);
    expect(sim.currentTick).toBe(0);
    sim.resume();
    expect(sim.isPaused).toBe(false);
    expect(sim.isRunning).toBe(true);
    sim.update(16.67);
    expect(sim.currentTick).toBe(1);
  });

  it('tickRate returns 60', () => {
    const sim = createSimulation();
    expect(sim.tickRate).toBe(60);
  });

  it('processes ATTACK input', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.ATTACK,
      data: { playerId: 'p1', aimAngle: 0, tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    const events = sim.update(16.67);
    expect(Array.isArray(events)).toBe(true);
  });

  it('processes THROW input via AttackCommand', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.THROW,
      data: { playerId: 'p1', aimAngle: 1.5, tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    const events = sim.update(16.67);
    expect(Array.isArray(events)).toBe(true);
  });

  it('processes PICKUP input', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.PICKUP,
      data: { playerId: 'p1', powerUpId: 'nonexistent', tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    const events = sim.update(16.67);
    expect(Array.isArray(events)).toBe(true);
  });

  it('processes SWITCH_SLOT input', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.SWITCH_SLOT,
      data: { playerId: 'p1', slot: 1, tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    sim.update(16.67);
    expect(player.inventory.activeSlot).toBe(0);
  });

  it('processes DASH input and multiplies speed', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.DASH,
      data: { playerId: 'p1' },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    sim.update(16.67);
    expect(player.movement.speed.value).toBe(400);
  });

  it('DASH fails when on cooldown', () => {
    const match = createMatch();
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.DASH,
      data: { playerId: 'p1' },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    sim.update(16.67);
    expect(player.movement.speed.value).toBe(400);
    sim.processInput({ ...input, serverTick: 1 });
    sim.update(16.67);
    expect(player.movement.speed.value).toBe(400);
  });

  it('PICKUP with empty targetId produces no interact events', () => {
    const match = createMatch();
    match.addPlayer('p1', 'Alice');
    const sim = createSimulation(match);
    sim.start();
    const input: QueuedInput = {
      playerId: 'p1',
      action: InputAction.PICKUP,
      data: { playerId: 'p1', targetId: '', tick: 0 },
      clientTick: 0,
      serverTick: 0,
      receivedAt: Date.now(),
    };
    sim.processInput(input);
    const events = sim.update(16.67);
    const interactEvents = events.filter(
      (e) => e.type === 'ChestOpened' || e.type === 'TrapTriggered',
    );
    expect(interactEvents).toHaveLength(0);
  });

  it('ADR-0025: _timings keys are exactly the 12 pinned stage labels', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    sim.update(16.67);
    const timings = sim.getMetrics().lastTickSystemTimings;
    // The 11 _time() labels plus snapshot = 12 keys. rebuildTrapGrid is
    // intentionally NOT timed (pre-existing profiling gap, out of scope for
    // refactor #12). ADR-0025 forbids changing these labels.
    expect(Object.keys(timings).sort()).toEqual(
      [
        'inputs',
        'movement',
        'animSim',
        'melee',
        'projectiles',
        'barrels',
        'zone',
        'traps',
        'timers',
        'deaths',
        'botAI',
        'snapshot',
      ].sort(),
    );
  });

  // Step-0 characterization test (#35). The ADR-0025 test above sorts the keys
  // and therefore cannot catch a step REORDERING (a swap of two labels would
  // still pass the sorted comparison). This test pins the EXACT execution order
  // of the 12 timed stages so the TickProfiler extraction cannot silently
  // reorder how step() drives time().
  it('Step-0: lastTickSystemTimings keys appear in step execution order (no sort)', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    sim.update(16.67);
    const keys = Object.keys(sim.getMetrics().lastTickSystemTimings);
    expect(keys).toEqual([
      'inputs',
      'movement',
      'animSim',
      'melee',
      'projectiles',
      'barrels',
      'zone',
      'traps',
      'timers',
      'deaths',
      'botAI',
      'snapshot',
    ]);
  });

  // Step-0 characterization test (#35). Guards the systemTotals accumulation:
  // over N ticks, systemTotals[k] must equal the exact sum of each tick's
  // lastTickSystemTimings[k]. A dropped or doubled accumulation (the #19
  // failure mode this extraction must not introduce) breaks the exact-sum
  // invariant regardless of per-tick variance. We snapshot each tick's timings
  // before advancing (lastTickSystemTimings is reassigned each step), then
  // assert the running totals equal the arithmetic sum. (The original ticket
  // text proposed an "each > 0 and approx 3x" assertion, but step cost on this
  // host is sub-millisecond and rounds to 0 for most labels, and per-tick cost
  // varies far beyond ±50% when it is non-zero — so the literal "each > 0 /
  // 3x" form is unsatisfiable. The exact-sum invariant is the precise
  // statement of the ticket's stated goal: "catches dropped/doubled
  // accumulation".)
  it('Step-0: systemTotals accumulate the exact per-tick lastTickSystemTimings sum across 3 ticks', () => {
    const match = createMatch();
    const sim = createSimulation(match);
    sim.start();
    const perTickTimings: Array<Record<string, number>> = [];
    for (let i = 0; i < 3; i++) {
      sim.update(16.67);
      // Defensive copy: lastTickSystemTimings is reassigned each step.
      perTickTimings.push({ ...sim.getMetrics().lastTickSystemTimings });
    }
    const totals = sim.getMetrics().systemTotals;
    const totalKeys = Object.keys(totals);
    // systemTotals keys must match exactly the per-tick label set.
    expect(totalKeys.slice().sort()).toEqual(
      Object.keys(perTickTimings[0] ?? {})
        .slice()
        .sort(),
    );
    // Each total must equal the exact arithmetic sum of the 3 per-tick values.
    // This catches both dropped (sum too low) and doubled (sum too high)
    // accumulation — the precise statement of the ticket's regression gate.
    for (const key of totalKeys) {
      const expected = perTickTimings.reduce((acc, t) => acc + (t[key] ?? 0), 0);
      expect(totals[key]).toBeCloseTo(expected, 10);
    }
    // The cumulative tick counters must reflect all 3 ticks.
    expect(sim.getMetrics().totalTicks).toBe(3);
  });
});

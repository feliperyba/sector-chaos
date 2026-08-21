import {
  PLAYER,
  PlayerStatus,
  SeededRNG,
  TileType,
  TrapType,
  type GameConfig,
  type PlayerConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { describe, expect, it } from 'vitest';
import { PickupPowerUpCommand } from '../../../src/application/commands/PickupPowerUpCommand.ts';
import { TriggerTrapCommand } from '../../../src/application/commands/TriggerTrapCommand.ts';
import {
  checkPowerUpWalkOverSim,
  checkTrapWalkOverSim,
  rebuildTrapGridSim,
  rebuildPowerUpGridSim,
  type WalkoverContext,
} from '../../../src/application/simulation/GameSimulationWalkovers.ts';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import {
  createMatchPools,
  createMatchServices,
} from '../../../src/domain/aggregates/createMatchServices.ts';
import { PowerUp } from '../../../src/domain/entities/PowerUp.ts';
import { Trap } from '../../../src/domain/entities/Trap.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';

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
    x: 64 + (i % 8) * 512,
    y: 64 + Math.floor(i / 8) * 512,
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
  return new GameMatch('walkover-match', cfg, g, sp, services, pools, lootRng);
}

/**
 * Build a WalkoverContext the same way GameSimulation's constructor does —
 * a fresh trapCells map + pool, plus the real commands wired to the match.
 * This characterizes the walkover helpers' behavior against the same data
 * shape the production sim feeds them.
 */
function createWalkoverContext(match: GameMatch): WalkoverContext {
  return {
    match,
    trapCells: new Map<number, string[]>(),
    trapCellPool: [] as string[][],
    powerUpCells: new Map<number, string[]>(),
    powerUpCellPool: [] as string[][],
    triggerTrapCommand: new TriggerTrapCommand(match),
    pickupCommand: new PickupPowerUpCommand(match),
  };
}

describe('GameSimulationWalkovers (characterization)', () => {
  it('player at trap center triggers the trap on the next tick', () => {
    const match = createMatch();
    const ctx = createWalkoverContext(match);
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    match.addTrap(trap);
    // Snap player onto the trap; rebuild grid so the trap cell is current.
    player.movement.position = new Position(100, 100);
    rebuildTrapGridSim(ctx);
    checkTrapWalkOverSim(ctx, 'p1');
    const events = match.drainEvents();
    expect(events.some((e) => e.type === 'TrapTriggered')).toBe(true);
  });

  it('player outside trap radius does NOT trigger the trap', () => {
    const match = createMatch();
    const ctx = createWalkoverContext(match);
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    match.addTrap(trap);
    // SPIKE trigger radius is 128; place player at 1000,1000 (well outside).
    player.movement.position = new Position(1000, 1000);
    rebuildTrapGridSim(ctx);
    checkTrapWalkOverSim(ctx, 'p1');
    const events = match.drainEvents();
    expect(events.some((e) => e.type === 'TrapTriggered')).toBe(false);
  });

  it('trap on cooldown does NOT trigger again', () => {
    const match = createMatch();
    const ctx = createWalkoverContext(match);
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    match.addTrap(trap);
    player.movement.position = new Position(100, 100);
    rebuildTrapGridSim(ctx);
    // First trigger — should fire.
    checkTrapWalkOverSim(ctx, 'p1');
    const firstEvents = match.drainEvents();
    expect(firstEvents.some((e) => e.type === 'TrapTriggered')).toBe(true);
    // Second call same tick — trap should now be on cooldown (60 ticks).
    checkTrapWalkOverSim(ctx, 'p1');
    const secondEvents = match.drainEvents();
    expect(secondEvents.some((e) => e.type === 'TrapTriggered')).toBe(false);
  });

  it('player at powerup position picks it up', () => {
    const match = createMatch();
    const ctx = createWalkoverContext(match);
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const pu = PowerUp.create('pu-1', 'speed_boost', new Position(100, 100), 0);
    match.addPowerUp(pu);
    player.movement.position = new Position(100, 100);
    rebuildPowerUpGridSim(ctx);
    checkPowerUpWalkOverSim(ctx, 'p1');
    const events = match.drainEvents();
    expect(events.some((e) => e.type === 'PowerUpCollected')).toBe(true);
  });

  it('rebuildTrapGridSim runs each tick so a moved trap is detected at its new cell', () => {
    const match = createMatch();
    const ctx = createWalkoverContext(match);
    const player = match.addPlayer('p1', 'Alice');
    player.statusEffects.status = PlayerStatus.ALIVE;
    const trap = Trap.create('trap-1', TrapType.SPIKE, new Position(100, 100));
    match.addTrap(trap);
    // Tick 0: trap at (100,100); player stands on it → trigger.
    player.movement.position = new Position(100, 100);
    rebuildTrapGridSim(ctx);
    checkTrapWalkOverSim(ctx, 'p1');
    const tick0Events = match.drainEvents();
    expect(tick0Events.some((e) => e.type === 'TrapTriggered')).toBe(true);

    // Tick 1: move trap to a far cell, advance the match tick, rebuild grid.
    // After a 60-tick cooldown the trap can trigger again. step7_ProcessTraps
    // normally decrements cooldownRemaining by 1 each tick; we replicate that
    // here so the trap is eligible to fire again at its new position.
    for (let i = 0; i < 60; i++) {
      match.advanceTick();
      trap.tickCooldown(1);
    }
    trap.position = new Position(2000, 2000);
    player.movement.position = new Position(2000, 2000);
    rebuildTrapGridSim(ctx);
    checkTrapWalkOverSim(ctx, 'p1');
    const tick61Events = match.drainEvents();
    expect(tick61Events.some((e) => e.type === 'TrapTriggered')).toBe(true);
  });
});

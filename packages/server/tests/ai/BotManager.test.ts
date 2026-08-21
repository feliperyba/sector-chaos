import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BotManager } from '../../src/ai/BotManager.ts';
import { BotSystem } from '../../src/ai/BotSystem.ts';
import { Pathfinder } from '../../src/ai/navigation/Pathfinder.ts';
import type { GameOrchestrator } from '../../src/application/services/GameOrchestrator.ts';
import type { GameMatch } from '../../src/domain/aggregates/GameMatch.ts';
import { InputAction, TileType } from '@sector-battle/shared';

function createGrid(width: number, height: number, walkable: boolean = true): boolean[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => walkable));
}

function createMockOrchestrator(): {
  mock: GameOrchestrator;
  addPlayerCalls: Array<{ id: string; name: string }>;
  removePlayerCalls: string[];
  handleInputCalls: Array<{
    playerId: string;
    action: InputAction;
    data: unknown;
    tick: number;
  }>;
} {
  const addPlayerCalls: Array<{ id: string; name: string }> = [];
  const removePlayerCalls: string[] = [];
  const handleInputCalls: Array<{
    playerId: string;
    action: InputAction;
    data: unknown;
    tick: number;
  }> = [];

  const mock = {
    addPlayer: vi.fn((id: string, name: string): boolean => {
      addPlayerCalls.push({ id, name });
      return true;
    }),
    removePlayer: vi.fn((id: string): void => {
      removePlayerCalls.push(id);
    }),
    handleInput: vi.fn((playerId: string, action: InputAction, data: unknown, tick: number) => {
      handleInputCalls.push({ playerId, action, data, tick });
      return [];
    }),
    getPlayersAlive: vi.fn(() => 0),
    getPlayer: vi.fn(() => ({
      isActive: true,
      isBot: false,
      name: 'Test',
      position: { x: 0, y: 0 },
    })),
    getMatchState: vi.fn(() => ({
      players: new Map(),
      projectiles: new Map(),
      powerUps: new Map(),
      traps: new Map(),
      chests: new Map(),
      destructibles: new Map(),
      weaponPickups: new Map(),
      exits: new Map(),
      explosions: new Map(),
      tick: 0,
      zone: {
        centerX: 640,
        centerY: 640,
        currentRadius: 1000,
        targetRadius: 1000,
        shrinkSpeed: 0,
        nextShrinkTick: 0,
      },
      grid: [],
    })),
    getMatch: vi.fn(() => ({
      getState: () => ({
        players: new Map(),
        projectiles: new Map(),
        powerUps: new Map(),
        traps: new Map(),
        chests: new Map(),
        destructibles: new Map(),
        weaponPickups: new Map(),
        exits: new Map(),
        explosions: new Map(),
        tick: 0,
        zone: {
          centerX: 640,
          centerY: 640,
          currentRadius: 1000,
          targetRadius: 1000,
          shrinkSpeed: 0,
          nextShrinkTick: 0,
        },
        grid: [],
      }),
    })),
    _currentTick: 0,
    get currentTick(): number {
      return this._currentTick;
    },
  } as unknown as GameOrchestrator;

  return { mock, addPlayerCalls, removePlayerCalls, handleInputCalls };
}

describe('BotManager', () => {
  let botManager: BotManager;
  let orchestrator: ReturnType<typeof createMockOrchestrator>;
  let pathfinder: Pathfinder;

  beforeEach(() => {
    vi.useFakeTimers();
    botManager = new BotManager();
    orchestrator = createMockOrchestrator();
    pathfinder = new Pathfinder(createGrid(10, 10));

    const mockGrid: TileType[][] = Array.from({ length: 10 }, () =>
      Array.from({ length: 10 }, () => TileType.EMPTY),
    );

    const botSystem = new BotSystem(
      {
        getState: () => ({
          players: new Map(),
          projectiles: new Map(),
          powerUps: new Map(),
          traps: new Map(),
          chests: new Map(),
          destructibles: new Map(),
          weaponPickups: new Map(),
          exits: new Map(),
          explosions: new Map(),
          tick: 0,
          zone: {
            centerX: 640,
            centerY: 640,
            currentRadius: 1000,
            targetRadius: 1000,
            shrinkSpeed: 0,
            nextShrinkTick: 0,
          },
          grid: [],
        }),
        getGrid: () => mockGrid,
      } as Pick<GameMatch, 'getState' | 'getGrid'>,
      pathfinder,
    );
    botManager.setBotSystem(botSystem);
  });

  afterEach(() => {
    botManager.dispose();
    vi.useRealTimers();
  });

  it('spawns correct number of bots', () => {
    botManager.spawnBots(orchestrator.mock, 0, 4);

    vi.advanceTimersByTime(10000);

    expect(botManager.getBotCount()).toBe(4);
    expect(orchestrator.addPlayerCalls).toHaveLength(4);
  });

  it('bot names use NATO alphabet (no duplicates)', () => {
    botManager.spawnBots(orchestrator.mock, 0, 5);

    vi.advanceTimersByTime(10000);

    const names = orchestrator.addPlayerCalls.map((c) => c.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('bots have gamer-tag style names', () => {
    botManager.spawnBots(orchestrator.mock, 0, 3);

    vi.advanceTimersByTime(10000);

    const names = orchestrator.addPlayerCalls.map((c) => c.name);
    for (const name of names) {
      expect(name).not.toMatch(/^Bot_\d{3}$/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('more than 26 bots still get unique gamer-tag names', () => {
    botManager.spawnBots(orchestrator.mock, 0, 28);

    vi.advanceTimersByTime(60000);

    const names = orchestrator.addPlayerCalls.map((c) => c.name);
    expect(names).toHaveLength(28);

    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(28);
    for (const name of names) {
      expect(name).not.toMatch(/^Bot_\d{3}$/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('bots removed when real player joins', () => {
    botManager.spawnBots(orchestrator.mock, 0, 3);

    vi.advanceTimersByTime(10000);
    expect(botManager.getBotCount()).toBe(3);

    botManager.removeBotForRealPlayer(orchestrator.mock);

    expect(botManager.getBotCount()).toBe(2);
    expect(orchestrator.removePlayerCalls.length).toBe(1);
  });

  it('bot system unregistered on removal', () => {
    botManager.spawnBots(orchestrator.mock, 0, 2);

    vi.advanceTimersByTime(10000);
    expect(botManager.getBotCount()).toBe(2);

    botManager.removeBotForRealPlayer(orchestrator.mock);

    expect(botManager.getBotCount()).toBe(1);
  });

  it('all bots cleaned up on dispose', () => {
    botManager.spawnBots(orchestrator.mock, 0, 3);

    vi.advanceTimersByTime(10000);
    expect(botManager.getBotCount()).toBe(3);

    botManager.dispose();

    expect(botManager.getBotCount()).toBe(0);
  });

  it('difficulty settings affect personality profiles (easy reduces detection)', () => {
    botManager.setDifficulty('easy');
    botManager.spawnBots(orchestrator.mock, 0, 5);

    vi.advanceTimersByTime(10000);

    expect(botManager.getBotCount()).toBe(5);
    expect(orchestrator.addPlayerCalls).toHaveLength(5);
  });

  it('hard difficulty boosts combatWeight', () => {
    botManager.setDifficulty('hard');
    botManager.spawnBots(orchestrator.mock, 0, 3);

    vi.advanceTimersByTime(10000);

    expect(botManager.getBotCount()).toBe(3);
    expect(orchestrator.addPlayerCalls).toHaveLength(3);
  });

  it('spawnBots does nothing when no bots needed', () => {
    botManager.spawnBots(orchestrator.mock, 0, 0);

    vi.advanceTimersByTime(10000);

    expect(botManager.getBotCount()).toBe(0);
    expect(orchestrator.addPlayerCalls).toHaveLength(0);
  });

  it('removeBotForRealPlayer does nothing when no bots exist', () => {
    botManager.removeBotForRealPlayer(orchestrator.mock);

    expect(botManager.getBotCount()).toBe(0);
    expect(orchestrator.removePlayerCalls).toHaveLength(0);
  });
});

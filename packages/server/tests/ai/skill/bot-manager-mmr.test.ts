import { describe, it, expect, beforeEach } from 'vitest';
import { BotManager } from '../../../src/ai/BotManager.ts';
import { BotSystem } from '../../../src/ai/BotSystem.ts';
import { Pathfinder } from '../../../src/ai/navigation/Pathfinder.ts';
import type { GameOrchestrator } from '../../../src/application/services/GameOrchestrator.ts';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { TileType } from '@sector-battle/shared';
import {
  installSeededSimRandom,
  uninstallSeededSimRandom,
} from '../../../src/domain/shared/SimRandom.ts';

/**
 * bot-ai-v2 ticket 08 (DEC-009.1) — the BotManager finally READS the stored
 * lobby averageMmr (AUDIT §9.13): per-bot weighted difficulty assignment on
 * the room's seeded stream, the no-MMR default (room-wide fallback), and
 * same-seed determinism of the assignment sequence.
 */

function createGrid(width: number, height: number): boolean[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => true));
}

function createMockOrchestrator(): GameOrchestrator {
  const emptyState = () => ({
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
  });
  return {
    addPlayer: () => true,
    removePlayer: () => undefined,
    getPlayer: () => ({ isActive: true, isBot: false, name: 'T', position: { x: 0, y: 0 } }),
    getMatchState: emptyState as unknown as GameOrchestrator['getMatchState'],
    getMatch: () => emptyState() as unknown as GameMatch,
  } as unknown as GameOrchestrator;
}

function createBotSystem(): BotSystem {
  const mockGrid: TileType[][] = Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => TileType.EMPTY),
  );
  const emptyMatch = {
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
  };
  return new BotSystem(emptyMatch as unknown as GameMatch, new Pathfinder(createGrid(10, 10)));
}

/** Spawn N bots synchronously and return the per-bot assigned difficulties
 *  (read off the registered personality profiles — the spawn-time label). */
function spawnAndCollect(mmr: number | undefined, n: number): string[] {
  const manager = new BotManager();
  const system = createBotSystem();
  manager.setBotSystem(system);
  manager.setAverageMmr(mmr);
  const spawned = manager.spawnAllBotsSync(createMockOrchestrator(), n, 1700000000000);
  expect(spawned).toBe(n);
  const labels = [...system.profiles.values()].map((p) => p.difficulty as string);
  manager.dispose();
  return labels;
}

describe('BotManager MMR → per-bot difficulty wiring (GDD §14.6)', () => {
  beforeEach(() => {
    uninstallSeededSimRandom();
  });

  it('no MMR data: every bot receives the room-wide fallback difficulty (all-normal default)', () => {
    // GameRoomLifecycle defaults botDifficulty to 'normal' — the GDD default.
    const manager = new BotManager();
    const system = createBotSystem();
    manager.setBotSystem(system);
    manager.setDifficulty('normal');
    manager.setAverageMmr(undefined);
    manager.spawnAllBotsSync(createMockOrchestrator(), 12, 1700000000000);
    for (const p of system.profiles.values()) {
      expect(p.difficulty).toBe('normal');
    }
    manager.dispose();
  });

  it('zero MMR (Matchmaker default) is also the no-data path', () => {
    const labels = spawnAndCollect(0, 8);
    for (const d of labels) expect(d).toBe('medium'); // BotManager's default
  });

  it('low-MMR lobby assigns only easy/medium/hard with an easy-dominant mix', () => {
    installSeededSimRandom(4242);
    const labels = spawnAndCollect(800, 60);
    const counts = new Map<string, number>();
    for (const d of labels) counts.set(d, (counts.get(d) ?? 0) + 1);
    // Only the GDD's three levels ever appear from an MMR band.
    for (const d of labels) expect(['easy', 'medium', 'hard']).toContain(d);
    // 60 draws from 70/20/10: easy must dominate (expected 42, ±8 margin).
    expect(counts.get('easy') ?? 0).toBeGreaterThan(30);
    expect(counts.get('hard') ?? 0).toBeLessThanOrEqual(15);
  });

  it('high-MMR lobby is hard-dominant', () => {
    installSeededSimRandom(4242);
    const labels = spawnAndCollect(2500, 60);
    const counts = new Map<string, number>();
    for (const d of labels) counts.set(d, (counts.get(d) ?? 0) + 1);
    expect(counts.get('hard') ?? 0).toBeGreaterThan(30);
    expect(counts.get('easy') ?? 0).toBeLessThanOrEqual(15);
  });

  it('the room-wide setter remains the explicit fallback (difficulty forwarded)', () => {
    const manager = new BotManager();
    const system = createBotSystem();
    manager.setBotSystem(system);
    manager.setDifficulty('elite');
    expect(system.defaultDifficulty).toBe('elite');
    manager.setAverageMmr(undefined);
    manager.spawnAllBotsSync(createMockOrchestrator(), 4, 1700000000000);
    for (const p of system.profiles.values()) expect(p.difficulty).toBe('elite');
    manager.dispose();
  });

  it('same seed → identical assignment sequence (determinism on the room stream)', () => {
    installSeededSimRandom(99);
    const first = spawnAndCollect(1500, 40);
    installSeededSimRandom(99);
    const second = spawnAndCollect(1500, 40);
    expect(second).toEqual(first);
    // And the mid-band mix is medium-dominant (expected 60% ± 10pp of 40).
    const medium = first.filter((d) => d === 'medium').length;
    expect(medium).toBeGreaterThan(18);
    uninstallSeededSimRandom();
  });
});

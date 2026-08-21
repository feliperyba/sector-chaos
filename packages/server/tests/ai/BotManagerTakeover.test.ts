import { describe, it, expect } from 'vitest';
import { BotManager } from '../../src/ai/BotManager.ts';
import { BotSystem } from '../../src/ai/BotSystem.ts';
import { Pathfinder } from '../../src/ai/navigation/Pathfinder.ts';
import type { GameOrchestrator } from '../../src/application/services/GameOrchestrator.ts';
import { createTestMatch } from '../helpers/createTestMatch.ts';

/**
 * Risk X1 closure: the AFK-reclaim path (BotManager.takeoverPlayer) is the only
 * bot-spawn route the benchmark does NOT exercise (the benchmark uses
 * spawnAllBotsSync exclusively). After ADR-0036 deleted the legacy fallback
 * branch and added the invariant throw at tickBot entry, this test pins that
 * takeoverPlayer populates the profile/selector maps such that a tick through
 * tickBot does NOT throw.
 *
 * The structural-invariant argument (ADR-0036) says registerBot populates all
 * three maps atomically; takeoverPlayer calls registerBot; therefore tickBot
 * cannot throw. If a future change to registerBot (or takeoverPlayer) stopped
 * populating `selectors`, this test would fail with the invariant throw —
 * that's the failure mode this test guards against.
 */
describe('BotManager.takeoverPlayer invariant (ADR-0036 / Risk X1)', () => {
  it('takeoverPlayer → botSystem.tick() does not throw (AFK reclaim populates selectors)', () => {
    // 1. Real match + real player. We need the world snapshot to actually
    //    contain the player so tickBot runs (the tick loop early-returns for
    //    players not in the snapshot).
    const match = createTestMatch();
    const pathfinder = new Pathfinder(
      Array.from({ length: 30 }, () => Array.from({ length: 30 }, () => true)),
    );
    const botSystem = new BotSystem(match, pathfinder);

    const playerId = 'afk-player-1';
    match.addPlayer(playerId, 'AFK Player');
    const player = match.getPlayer(playerId);
    expect(player).toBeDefined();
    expect(player!.isActive).toBe(true);

    // 2. Build a BotManager + wire it to the BotSystem.
    const botManager = new BotManager();
    botManager.setBotSystem(botSystem);

    // Minimal orchestrator stub — takeoverPlayer reads getPlayer() and sets
    // isBot. We point getPlayer at the real match's player so takeoverPlayer
    // mutates the same Player the snapshot will read next tick.
    const orchestrator = {
      getPlayer: (id: string) => match.getPlayer(id),
    } as unknown as GameOrchestrator;

    // 3. Reclaim the AFK player as a bot.
    expect(() => botManager.takeoverPlayer(orchestrator, playerId)).not.toThrow();
    // takeoverPlayer must have flipped isBot so the snapshot counts this player
    // in aliveBotCount and routes them through tickBot.
    expect(player!.isBot).toBe(true);
    // registerBot must have populated all three maps atomically.
    expect(botSystem.bots.has(playerId)).toBe(true);
    expect(botSystem.profiles.has(playerId)).toBe(true);
    expect(botSystem.selectors.has(playerId)).toBe(true);

    // 4. Drive one tick. The invariant throw at tickBot entry must NOT fire —
    //    the profile+selector are present. This is the assertion that closes
    //    Risk X1: if registerBot ever stopped populating `selectors`, this
    //    would throw "BotSystem invariant violated: bot ... has no
    //    profile/selector — registerBot must have been bypassed".
    expect(() => botSystem.tick(1)).not.toThrow();
  });

  it('manual registerBot (lighter alternative) → tick does not throw', () => {
    // The griller suggested this lighter alternative if takeoverPlayer is hard
    // to isolate. It exercises the SAME invariant (registerBot populates
    // selectors → tickBot's guard does not fire). Kept as a second case so the
    // invariant is pinned even if the takeoverPlayer path is later refactored.
    const match = createTestMatch();
    const grid = match.getGrid();
    const pathfinder = new Pathfinder(
      Array.from({ length: grid.length }, (_, r) =>
        Array.from({ length: grid[0]!.length }, () => true),
      ),
    );
    const botSystem = new BotSystem(match, pathfinder);

    const playerId = 'manual-bot-1';
    match.addPlayer(playerId, 'Manual Bot');
    const player = match.getPlayer(playerId);
    expect(player).toBeDefined();
    player!.isBot = true;

    expect(() => botSystem.registerBot(playerId)).not.toThrow();
    expect(botSystem.selectors.has(playerId)).toBe(true);
    expect(botSystem.profiles.has(playerId)).toBe(true);

    expect(() => botSystem.tick(1)).not.toThrow();
  });
});

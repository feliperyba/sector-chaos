import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { BARREL, distance, GRID, TileType } from '@sector-battle/shared';
import { createTestServer, cleanup } from '../../helpers/test-server.ts';
import { createGameRoom } from '../../helpers/game-room-helper.ts';
import type { GameStateSchema } from '../../../src/infrastructure/schemas/GameStateSchema.ts';
import { GameRoom } from '../../../src/room/GameRoom.ts';
import type { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import { Position } from '../../../src/domain/value-objects/index.ts';
import { STIMULUS_HEARING_RADII } from '../../../src/ai/stimulus/StimulusConfig.ts';
import type { BotSystem } from '../../../src/ai/BotSystem.ts';

/**
 * Room-level stimulus wiring proof (bot-ai-v2 ticket 03 / DEC-002): drive a
 * REAL barrel explosion through the REAL room + orchestrator event stream and
 * assert that exactly the bots within the explosion hearing radius received
 * the stimulus — domain event → orchestrator aggregation → StimulusRouter
 * fan-out → per-bot bounded queue, end to end. Also pins the fight-memory
 * migration: the explosion folds into the shared hotspot (bb.hotspot's
 * carrier) with no polling writer involved.
 */

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await cleanup(server);
});

function getMatch(room: Room<{ state: GameStateSchema }>): GameMatch {
  const gameRoom = room as unknown as GameRoom;
  return gameRoom.getOrchestrator().getMatch();
}

function getBotSystem(room: Room<{ state: GameStateSchema }>): BotSystem {
  const gameRoom = room as unknown as GameRoom;
  const botSystem = gameRoom.getOrchestrator().getBotSystem();
  if (!botSystem) throw new Error('BotSystem not wired to the orchestrator');
  return botSystem;
}

/**
 * BotManager trickles bots in via clock.setInterval over ~5s of REAL time
 * (AGENTS.md known gotchas) — poll the player count, same as the benchmark
 * harness's waitForBots.
 */
async function waitForBots(match: GameMatch, target: number, timeoutMs: number): Promise<number> {
  const start = Date.now();
  let count = match.players.size;
  while (count < target && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = match.players.size;
  }
  return count;
}

describe('Stimulus system room wiring (explosion fan-out, DEC-002)', () => {
  it('a barrel explosion delivers explosion stimuli to exactly the bots within the hearing radius', async () => {
    const BOT_COUNT = 4;
    const { room, helper } = await createGameRoom(server, {
      botFillTo: BOT_COUNT,
      seed: 12345,
      matchId: `stimulus-${Date.now()}`,
    });
    const match = getMatch(room);

    // 1. Wait for the trickle spawner, then activate the match (spawn-timing
    //    workaround — helper.forceActive also disables the last-standing end
    //    condition so the match cannot end mid-scenario).
    const spawned = await waitForBots(match, BOT_COUNT, 12_000);
    expect(spawned).toBe(BOT_COUNT);
    helper.forceActive();
    await helper.advanceTicks(2);

    const botIds = [...match.players.keys()].filter((id) => id.startsWith('bot_'));
    expect(botIds).toHaveLength(BOT_COUNT);

    // 2. Stage a deterministic layout: clear a generous area at the map
    //    center (no walls to collide with, no destructibles to chain, no
    //    loot to chase), then teleport the bots to controlled radii around
    //    the explosion point. Pairwise distances are all >= ~1400px —
    //    outside perception (1000px) — so no bot fights another during the
    //    scenario. Placements vs the 1400px explosion radius (margins >=
    //    150px absorb the few px of drift over the 2 settled ticks):
    //    A/B at 1000px (hear), D at 1250px (hear), C at 1800px (silent).
    const grid = match.getGrid();
    const cx = Math.floor(grid[0]!.length / 2);
    const cy = Math.floor(grid.length / 2);
    for (let dy = -16; dy <= 16; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        grid[cy + dy]![cx + dx] = TileType.EMPTY;
      }
    }
    const state = match.getState();
    state.traps.clear();
    state.destructibles.clear();
    state.chests.clear();
    state.weaponPickups.clear();
    state.powerUps.clear();
    state.explosions.clear();
    state.projectiles.clear();

    const tw = GRID.TILE_SIZE;
    const originX = (cx + 0.5) * tw;
    const originY = (cy + 0.5) * tw;
    const offsets: Array<[number, number]> = [
      [1000, 0], // bot A — hears
      [0, 1000], // bot B — hears
      [0, -1800], // bot C — silent control
      [-1250, 0], // bot D — hears
    ];
    const placement = new Map<string, [number, number]>();
    botIds.forEach((id, i) => {
      const [ox, oy] = offsets[i % offsets.length]!;
      placement.set(id, [ox, oy]);
      match.movePlayer(id, new Position(originX + ox, originY + oy));
    });
    // Settle one tick so the WorldSnapshot (the router's radius-query source)
    // syncs to the teleported positions.
    await helper.advanceTicks(1);

    // 3. Detonate a barrel at the origin via the REAL domain action and feed
    //    its events into the match collector — the next orchestrator.update
    //    drains them into the aggregated stream, which the stimulus tap reads.
    const explosionTick = match.currentTick;
    const events = match.triggerBarrelExplosion(
      cx,
      cy,
      BARREL.EXPLOSION_RADIUS,
      BARREL.EXPLOSION_DAMAGE,
      'stimulus-room-test',
      explosionTick,
    );
    expect(events.some((e) => e.type === 'BarrelExploded')).toBe(true);
    for (const e of events) match.emitEvent(e);
    await helper.advanceTicks(1);

    // 4. Assert per-bot delivery: a bot received the explosion stimulus iff
    //    its (post-tick) position is within the hearing radius.
    const botSystem = getBotSystem(room);
    for (const [id, [ox, oy]] of placement) {
      const player = match.getPlayer(id);
      expect(player, `bot ${id} must still exist`).not.toBeNull();
      const px = player!.movement.position.x;
      const py = player!.movement.position.y;
      const dist = distance(px, py, originX, originY);
      const queue = botSystem.stimulusRouter.getState(id)?.queue.entries ?? [];
      const received = queue.some((s) => s.type === 'explosion' && s.tick === explosionTick);
      expect(received, `bot at ${ox},${oy} (dist ${dist.toFixed(0)})`).toBe(
        dist <= STIMULUS_HEARING_RADII.explosion,
      );
    }

    // Explicit placement intent (redundant with the radius derivation above,
    // kept as documentation): A/B/D heard, the 1800px control did not.
    const heard = (index: number) => {
      const id = botIds[index]!;
      return (botSystem.stimulusRouter.getState(id)?.queue.entries ?? []).some(
        (s) => s.type === 'explosion' && s.tick === explosionTick,
      );
    };
    expect(heard(0)).toBe(true); // 1000px
    expect(heard(1)).toBe(true); // 1000px
    expect(heard(2)).toBe(false); // 1800px — outside the radius
    expect(heard(3)).toBe(true); // 1250px

    // 5. Fight-memory migration (the retired hotspot's successor): the routed
    //    explosion folded into the shared fight memory the HUNT bots read.
    const summary = botSystem.getStimulusDeliverySummary();
    expect(summary.routedByType.explosion).toBeGreaterThanOrEqual(1);
    expect(summary.deliveredByType.explosion).toBeGreaterThanOrEqual(3);
    expect(summary.fightMemoryWrites).toBeGreaterThanOrEqual(1);
    expect(botSystem.combatHotspot.tick).toBe(explosionTick);
    expect(
      distance(botSystem.combatHotspot.x, botSystem.combatHotspot.y, originX, originY),
    ).toBeLessThan(1);
  }, 30_000);
});

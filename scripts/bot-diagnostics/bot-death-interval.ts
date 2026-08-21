/**
 * Death Interval Diagnostic — measures time between bot deaths
 * to understand weapon recycling rate.
 *
 * Usage: npx tsx packages/server/tests/integration/bot-ai/bot-death-interval.ts [rounds]
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { GameRoom } from '../../packages/server/src/rooms/GameRoom';

const ROUNDS = parseInt(process.argv[2] || '10');
const WARMUP_TICKS = 450;
const MEASURE_TICKS = 900;
const TICK_INTERVAL = 3;
const TOTAL_TICKS = WARMUP_TICKS + MEASURE_TICKS;

function forceActivePhase(room: any): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const match = orch.match as any;
  match._phase = 2;
  orch.simulation.paused = false;
}

interface DeathEvent {
  tick: number;
  botId: string;
  weaponCount: number;
}

async function main() {
  const server = await createTestServer();

  try {
    const allDeaths: DeathEvent[] = [];
    const survivalTimes: number[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      const { room, helper } = await createGameRoom(server, {
        botFillTo: 4,
        mapType: 'demo' as any,
      });
      const client = await connectClient(server, room, { name: `W${round}` });
      await room.waitForNextPatch();

      await helper.advanceTicks(WARMUP_TICKS);
      forceActivePhase(room);

      const botDeaths: Map<string, number[]> = new Map();
      const prevAlive: Map<string, boolean> = new Map();

      // Initialize alive status
      const state = room.state as any;
      for (const [pid, player] of state.players.entries()) {
        prevAlive.set(pid, player.isAlive?.() ?? true);
      }

      for (let tick = 0; tick < MEASURE_TICKS; tick += TICK_INTERVAL) {
        await helper.advanceTicks(TICK_INTERVAL);

        for (const [pid, player] of state.players?.entries() ?? []) {
          const isAlive = player.isAlive?.() ?? false;
          const wasAlive = prevAlive.get(pid);

          if (wasAlive && !isAlive) {
            const existing = botDeaths.get(pid) || [];
            existing.push(tick);
            botDeaths.set(pid, existing);

            const weapons = player.inventory?.weapons || [];
            const weaponCount = weapons.filter((w: any) => w && w.type !== 0).length;
            allDeaths.push({ tick, botId: pid, weaponCount });
          }
          prevAlive.set(pid, isAlive);
        }
      }

      // Calculate survival times
      for (const [, deathTicks] of botDeaths) {
        for (let i = 1; i < deathTicks.length; i++) {
          survivalTimes.push(deathTicks[i]! - deathTicks[i - 1]!);
        }
      }

      // Just disconnect client, don't call room.leave (it's a Colyseus room, not a helper)
      try {
        (client as any).leave?.();
      } catch {}
    }

    // Report
    console.log('=== Death Interval Diagnostic ===');
    console.log(
      `Rounds: ${ROUNDS}, Measure: ${MEASURE_TICKS} ticks (${(MEASURE_TICKS / 60).toFixed(0)}s)`,
    );
    console.log(`Total deaths: ${allDeaths.length}`);
    console.log(`Deaths per round: ${(allDeaths.length / ROUNDS).toFixed(1)}`);

    if (survivalTimes.length > 0) {
      const avg = survivalTimes.reduce((a, b) => a + b, 0) / survivalTimes.length;
      const sorted = [...survivalTimes].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
      const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
      console.log(
        `Survival interval: avg=${avg.toFixed(0)}t (${(avg / 60).toFixed(1)}s), p50=${p50}t, p90=${p90}t`,
      );
    }

    const weaponsLost = allDeaths.filter((d) => d.weaponCount > 0);
    console.log(
      `Deaths with weapons: ${weaponsLost.length}/${allDeaths.length} (${((weaponsLost.length / Math.max(allDeaths.length, 1)) * 100).toFixed(0)}%)`,
    );
    const avgWeaponsOnDeath =
      allDeaths.reduce((a, d) => a + d.weaponCount, 0) / Math.max(allDeaths.length, 1);
    console.log(`Avg weapons lost per death: ${avgWeaponsOnDeath.toFixed(2)}`);

    if (allDeaths.length > 0) {
      const firstDeathTick = Math.min(...allDeaths.map((d) => d.tick));
      console.log(
        `First death: tick ${firstDeathTick} (${(firstDeathTick / 60).toFixed(1)}s into measurement)`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

main().catch(console.error);

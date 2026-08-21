import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType } from '@sector-battle/shared';
import type { GameMatch } from '../../packages/server/src/domain/aggregates/GameMatch';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';

const WARMUP = 450;
const MEASURE = 1800; // 30s

function forceActive(room: Room<any>) {
  const gr = room as unknown as GameRoom;
  const orch = gr.getOrchestrator() as any;
  const match = (gr.getOrchestrator() as any).match as any;
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.WAITING)
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

interface BotTrace {
  tick: number;
  behavior: string;
  goalType: string;
  goalX: number;
  goalY: number;
  posX: number;
  posY: number;
  weapons: string;
  nearbyItems: number;
  nearbyWeapons: number;
  stuck: boolean;
  demolition: boolean;
  hp: number;
}

async function main() {
  const server: ColyseusTestServer = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 4 });
    const client = await connectClient(server, room, { name: 'trace' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActive(room);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;
    const nav = [...botSystem.bots.values()][0]?.navigation as any;

    if (!botSystem) {
      process.stderr.write('No bot system!\n');
      return;
    }

    // Get all weapon positions on the map
    const items = botSystem.gameStateView.getItems();
    const weaponItems = items.filter((i: any) => i.type === 'weapon');
    process.stderr.write(`\n=== MAP WEAPONS ===\n`);
    process.stderr.write(`Total weapons on map: ${weaponItems.length}\n`);
    for (const w of weaponItems) {
      process.stderr.write(
        `  Weapon at (${w.position.x.toFixed(0)}, ${w.position.y.toFixed(0)}) tier=${w.tier}\n`,
      );
    }

    // Track all bots
    const traces: Map<string, BotTrace[]> = new Map();
    for (const [pid] of botSystem.bots as Map<string, any>) {
      traces.set(pid, []);
    }

    // Sample every 30 ticks (0.5s)
    for (let t = 0; t < MEASURE; t += 30) {
      await helper.advanceTicks(30);
      const tick = WARMUP + t + 30;

      for (const [pid, entry] of botSystem.bots as Map<string, any>) {
        const ctx = entry.context;
        const player = match.players.get(pid);
        if (!player) continue;
        const hp = player.health?.current ?? 0;
        const weapons =
          player.inventory?.weapons
            ?.filter((w: any) => w && w.type !== WeaponType.FISTS)
            .map((w: any) => WeaponType[w.type]) ?? [];
        const nearbyItems = ctx.nearbyItems?.length ?? 0;
        const nearbyWeapons = ctx.nearbyItems?.filter((i: any) => i.type === 'weapon')?.length ?? 0;
        const mg = ctx.movementGoal;
        const isStuck = entry.navigation?.isStuck?.(ctx) ?? false;

        const trace: BotTrace = {
          tick,
          behavior: ctx.lastBehaviorName ?? 'none',
          goalType: mg?.type ?? 'NONE',
          goalX: mg?.target?.x ?? 0,
          goalY: mg?.target?.y ?? 0,
          posX: ctx.position?.x ?? 0,
          posY: ctx.position?.y ?? 0,
          weapons: weapons.join(','),
          nearbyItems,
          nearbyWeapons,
          stuck: isStuck,
          demolition: ctx.demolitionState?.active ?? false,
          hp,
        };
        traces.get(pid)!.push(trace);
      }
    }

    // Print summary for each bot
    for (const [pid, traceList] of traces) {
      const botNum = pid.split('_').pop();
      process.stderr.write(`\n=== BOT ${botNum} TRACE ===\n`);

      // Behavior distribution
      const behavCount: Record<string, number> = {};
      for (const t of traceList) {
        behavCount[t.behavior] = (behavCount[t.behavior] ?? 0) + 1;
      }
      process.stderr.write(`Behaviors: ${JSON.stringify(behavCount)}\n`);

      // Weapon acquisition timeline
      const armedTick = traceList.find((t) => t.weapons.length > 0)?.tick ?? 'never';
      process.stderr.write(`Armed at: ${armedTick}\n`);

      // Stuck count
      const stuckCount = traceList.filter((t) => t.stuck).length;
      process.stderr.write(`Stuck samples: ${stuckCount}/${traceList.length}\n`);

      // Demolition count
      const demoCount = traceList.filter((t) => t.demolition).length;
      process.stderr.write(`Demolition samples: ${demoCount}/${traceList.length}\n`);

      // Movement goal distribution
      const goalCount: Record<string, number> = {};
      for (const t of traceList) {
        goalCount[t.goalType] = (goalCount[t.goalType] ?? 0) + 1;
      }
      process.stderr.write(`Goal types: ${JSON.stringify(goalCount)}\n`);

      // Average nearby weapons seen
      const avgNearbyWep = traceList.reduce((s, t) => s + t.nearbyWeapons, 0) / traceList.length;
      process.stderr.write(`Avg nearby weapons: ${avgNearbyWep.toFixed(1)}\n`);

      // Position range (how much did it move?)
      const xs = traceList.map((t) => t.posX);
      const ys = traceList.map((t) => t.posY);
      const xRange = Math.max(...xs) - Math.min(...xs);
      const yRange = Math.max(...ys) - Math.min(...ys);
      process.stderr.write(`Position range: X=${xRange.toFixed(0)} Y=${yRange.toFixed(0)}\n`);
      process.stderr.write(
        `Final pos: (${traceList[traceList.length - 1]!.posX.toFixed(0)}, ${traceList[traceList.length - 1]!.posY.toFixed(0)})\n`,
      );

      // Print first 15 and last 5 traces
      process.stderr.write(`\n--- Timeline (first 15) ---\n`);
      for (const t of traceList.slice(0, 15)) {
        process.stderr.write(
          `  t=${t.tick} behav=${t.behavior} goal=${t.goalType} pos=(${t.posX.toFixed(0)},${t.posY.toFixed(0)}) ` +
            `wep=[${t.weapons}] nWep=${t.nearbyWeapons} stuck=${t.stuck} demo=${t.demolition} hp=${t.hp}\n`,
        );
      }
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n${e.stack}\n`);
  process.exit(1);
});

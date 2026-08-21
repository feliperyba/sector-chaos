// Single-bot execution trace — watches one bot tick by tick
// Uses the working benchmark infrastructure

import { createTestServer, cleanup } from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';

const BENCHMARK_TICKS = 600; // 10 seconds — enough to see weapon acquisition or failure
const NUM_BOTS = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, client } = await createGameRoom(server, {
      mapType: 'demo' as any,
      botFillTo: NUM_BOTS + 1,
    });

    // Force active phase
    const gameRoom = room as any;
    const orch = gameRoom.getOrchestrator();
    const sim = orch.simulation;
    if (sim.gameMatch?.forceActivePhase) {
      sim.gameMatch.forceActivePhase();
    }

    // Wait for bots to spawn and be positioned
    for (let i = 0; i < 800; i++) {
      await room.waitForNextSimulationTick();
    }

    const botSystem = sim.botSystem as any;
    if (!botSystem) {
      console.log('No botSystem');
      return;
    }

    const bots = botSystem.bots as Map<string, any>;
    const entries = [...bots.entries()];
    if (entries.length === 0) {
      console.log('No bot contexts');
      return;
    }

    const [botId, entry] = entries[0]!;
    const ctx = entry.context;

    if (ctx.position.x === 0 && ctx.position.y === 0) {
      console.log('Bot still at origin, waiting more...');
      for (let i = 0; i < 500; i++) {
        await room.waitForNextSimulationTick();
        if (ctx.position.x !== 0 || ctx.position.y !== 0) break;
      }
    }
    console.log(`=== TRACING BOT ${botId} ===`);
    console.log(`Start pos: (${ctx.position.x.toFixed(0)}, ${ctx.position.y.toFixed(0)})`);
    console.log(`Armed: ${ctx.equippedWeapons?.length > 0}`);
    console.log('');

    let prevGoal = '';
    let prevDemo = '';
    let prevBehavior = '';
    let tickCount = 0;
    let lastPos = { x: ctx.position.x, y: ctx.position.y };

    for (let i = 0; i < BENCHMARK_TICKS; i++) {
      await room.waitForNextSimulationTick();
      tickCount++;

      // Only log every 3 ticks (one AI tick)
      if (tickCount % 3 !== 0) continue;

      const pos = ctx.position;
      const dx = pos.x - lastPos.x;
      const dy = pos.y - lastPos.y;
      const moved = Math.sqrt(dx * dx + dy * dy);

      const goal =
        ctx.movementGoal?.type && ctx.movementGoal?.target
          ? `${ctx.movementGoal.type}→(${ctx.movementGoal.target.x.toFixed(0)},${ctx.movementGoal.target.y.toFixed(0)})`
          : ctx.movementGoal?.type || 'NONE';
      const demo = ctx.demolitionState?.active
        ? `DEMOLISH(${ctx.demolitionState.targetId})`
        : 'none';
      const behavior = ctx.getBlackboard?.('lastBehavior') || '?';
      const stuck = entry.navigation?.isStuck?.(ctx) ? 'STUCK' : '';
      const busy = ctx.busyUntilTick > tickCount ? 'BUSY' : '';
      const pathLen = ctx.pathToTarget?.length || 0;
      const nearbyDestr = ctx.nearbyDestructibles?.length || 0;
      const nearbyItems = ctx.nearbyItems?.filter((i: any) => i.type === 'weapon').length || 0;
      const weapons = ctx.equippedWeapons?.length || 0;

      // Only log if something changed
      const state = `${goal}|${demo}|${behavior}|${stuck}|${busy}|p${pathLen}`;
      if (state !== prevGoal || moved > 5 || weapons > 0) {
        console.log(
          `t${tickCount.toString().padStart(4)} pos(${pos.x.toFixed(0).padStart(4)},${pos.y.toFixed(0).padStart(4)}) moved=${moved.toFixed(0).padStart(3)}px ${behavior.padEnd(10)} goal=${goal.padEnd(30)} demo=${demo.padEnd(12)} path=${pathLen} destr=${nearbyDestr} items=${nearbyItems} weps=${weapons} ${stuck} ${busy}`,
        );
        prevGoal = state;
        lastPos = { x: pos.x, y: pos.y };
      }

      if (weapons > 0 && prevBehavior === '') {
        console.log(`\n*** BOT GOT WEAPON at tick ${tickCount} ***\n`);
        prevBehavior = 'ARMED';
      }
    }

    console.log(
      `\nFinal: pos(${ctx.position.x.toFixed(0)},${ctx.position.y.toFixed(0)}) weapons=${ctx.equippedWeapons?.length || 0}`,
    );

    client.leave();
  } finally {
    await cleanup();
  }
}

main().catch(console.error);

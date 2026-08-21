import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { MatchPhase } from '@sector-battle/shared';

const WARMUP_TICKS = 500;
function forceActivePhase(room: any) {
  const orch = room.getOrchestrator?.();
  if (!orch) return;
  const c = orch.matchFlow.getCurrentState().phase;
  if (c === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  room.state.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 2, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'Diag' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP_TICKS);
    forceActivePhase(room);
    await helper.advanceTicks(100);

    const gameRoom = room as any;
    const botSystem = gameRoom.getOrchestrator().simulation.botSystem;
    const bots = botSystem.bots;
    const botIds = [...bots.keys()];
    const entry = bots.get(botIds[1]!)!;
    const ctx = entry.context;

    // Manually tick and check demolition state
    let demolitionCount = 0;
    let pathSetCount = 0;

    console.log('=== EXECUTION LAYER TRACE (500 ticks) ===');
    for (let t = 0; t < 500; t++) {
      // Force context update
      const state = gameRoom.getOrchestrator().match.getState();
      (botSystem as any).updateContext(entry, state);

      const preDemo = ctx.demolitionState.active;
      const prePath = ctx.pathToTarget;

      await helper.advanceTicks(1);

      // Check if demolition was set
      if (ctx.demolitionState.active) {
        demolitionCount++;
        if (demolitionCount <= 5) {
          console.log(
            `T${t}: DEMOLITION! target=(${ctx.demolitionState.targetPosition?.x?.toFixed?.(0)},${ctx.demolitionState.targetPosition?.y?.toFixed?.(0)}) pathLen=${ctx.pathToTarget?.length}`,
          );
        }
      }

      if (ctx.pathToTarget && ctx.pathToTarget.length >= 2) {
        pathSetCount++;
        if (t < 10 || t % 100 === 0) {
          const wp1 = ctx.pathToTarget[1];
          console.log(
            `T${t}: path set, wp1=(${wp1?.x?.toFixed?.(0)},${wp1?.y?.toFixed?.(0)}) pos=(${ctx.position.x?.toFixed?.(0)},${ctx.position.y?.toFixed?.(0)}) beh=${ctx.lastBehaviorName}`,
          );
        }
      }

      if (t % 100 === 0) {
        console.log(
          `T${t}: pos=(${ctx.position.x.toFixed(0)},${ctx.position.y.toFixed(0)}) beh=${ctx.lastBehaviorName} goal=${ctx.movementGoal.type} wpn=${ctx.inventory.weapons.filter((w: any) => w).length}`,
        );
      }
    }

    console.log(`\n=== RESULT ===`);
    console.log(`Demolition ticks: ${demolitionCount}/500`);
    console.log(`Path set ticks: ${pathSetCount}/500`);
    console.log(`Final pos: (${ctx.position.x.toFixed(0)},${ctx.position.y.toFixed(0)})`);
    console.log(`Weapons: ${ctx.inventory.weapons.filter((w: any) => w).length}`);

    // Check destructible count
    const match = gameRoom.getOrchestrator().match;
    const destr = (match as any)._maps?.destructibles;
    const remaining = destr ? [...destr.values()].filter((d: any) => !d.isDestroyed).length : 'N/A';
    console.log(`Remaining destructibles: ${remaining}`);
  } finally {
    await cleanup();
    process.exit(0);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

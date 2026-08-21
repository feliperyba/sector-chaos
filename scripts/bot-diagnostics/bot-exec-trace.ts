/**
 * Execution trace: logs every tick of a single bot's movement/pathfinding execution.
 * Captures the actual inputs generated, path state, and demolition state.
 */
import { createTestServer, cleanup } from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { GameRoom } from '../../packages/server/src/room/GameRoom';

function forceActivePhase(room: any) {
  if (room.state.phase !== 2) room.state.phase = 2;
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 1 });
    await helper.addPlayer('test');

    const gameRoom = room as unknown as GameRoom;
    const orchestrator = gameRoom.getOrchestrator() as any;
    const simulation = orchestrator.simulation as any;

    // Wait for room to initialize and bot to spawn
    for (let i = 0; i < 600; i++) {
      await room.waitForNextSimulationTick();
    }
    forceActivePhase(room);

    const botSystem = simulation.botSystem;
    if (!botSystem) {
      console.log('No botSystem');
      await cleanup(server);
      return;
    }

    const entries = botSystem.bots;
    const entry = entries.values().next().value;
    if (!entry) {
      console.log('No bots');
      await cleanup(server);
      return;
    }

    const botId = entry.playerId;
    const pathfinder = botSystem.pathfinder;
    const dmap = botSystem.execDeps.buildDestructibleMap();

    // Find nearest weapon
    const matchState = simulation.gameMatch.getState();
    let bestWeapon: any = null,
      bestDist = Infinity;
    const botPos = { x: entry.context.position.x, y: entry.context.position.y };
    for (const [id, wp] of matchState.weaponPickups) {
      if (!wp.isActive) continue;
      const d = Math.sqrt((wp.position.x - botPos.x) ** 2 + (wp.position.y - botPos.y) ** 2);
      if (d < bestDist) {
        bestDist = d;
        bestWeapon = wp;
      }
    }

    const wpos = { x: bestWeapon.position.x, y: bestWeapon.position.y };
    const testPath = pathfinder.findPathThroughDestructibles(botPos, wpos, dmap);
    console.log(`BOT ${botId.slice(0, 8)} at (${botPos.x.toFixed(0)},${botPos.y.toFixed(0)})`);
    console.log(
      `Weapon at (${wpos.x.toFixed(0)},${wpos.y.toFixed(0)}) dist=${bestDist.toFixed(0)}`,
    );
    console.log(`DestrPath: ${testPath ? testPath.length + 'wp' : 'NULL'}`);
    if (testPath && testPath.length <= 5) {
      console.log(
        `  ${testPath.map((p: any) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' → ')}`,
      );
    }

    // Trace 200 ticks
    for (let t = 0; t < 200; t++) {
      await room.waitForNextSimulationTick();

      if (t % 5 !== 0) continue;

      const ctx = entry.context;
      const pos = { x: ctx.position.x, y: ctx.position.y };
      const goal = ctx.movementGoal;
      const demo = ctx.demolitionState;
      const path = ctx.pathToTarget;
      const stuck = entry.navigation.isStuck(ctx);
      const beh = ctx.getBlackboard<string>('_lastBehaviorSnapshot') ?? ctx.lastBehaviorName;

      const goalStr =
        goal.type === 'SEEK' && goal.target
          ? `SEEK→(${goal.target.x.toFixed(0)},${goal.target.y.toFixed(0)})`
          : goal.type;

      const demoStr = demo.active ? `demo=${demo.targetId?.slice(0, 6)} hp=${demo.targetHp}` : '';

      const pathStr =
        path && path.length >= 2
          ? `${path.length}wp next=(${path[1].x.toFixed(0)},${path[1].y.toFixed(0)})`
          : (path?.length ?? 0) + 'wp';

      const d2w = Math.sqrt((wpos.x - pos.x) ** 2 + (wpos.y - pos.y) ** 2);

      console.log(
        `t=${t} pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)}) d2w=${d2w.toFixed(0)} beh=${beh} goal=${goalStr} path=${pathStr} stuck=${stuck} ${demoStr}`,
      );
    }

    await cleanup(server);
  } catch (err) {
    console.error(err);
    await cleanup(server);
  }
}

main();

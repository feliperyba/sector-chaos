import { createTestServer, cleanup } from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { GameRoom } from '../../packages/server/src/room/GameRoom';

function forceActivePhase(room: any) {
  const state = room.state;
  if (state.phase !== 2) {
    state.phase = 2;
  }
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 5 });
    await helper.addPlayer('test');
    await helper.advanceTicks(450);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orchestrator = gameRoom.getOrchestrator() as any;
    const simulation = orchestrator.simulation as any;
    const botSystem = simulation.botSystem;
    const pathfinder = botSystem.pathfinder;

    const matchState = simulation.gameMatch.getState();
    const weapons: Array<{ x: number; y: number; id: string }> = [];
    for (const [id, wp] of matchState.weaponPickups) {
      if (wp.isActive) weapons.push({ x: wp.position.x, y: wp.position.y, id });
    }

    const dmap = botSystem.execDeps.buildDestructibleMap();
    let ironCount = 0,
      breakCount = 0;
    for (const [, hp] of dmap) {
      if (hp >= 9999) ironCount++;
      else breakCount++;
    }
    console.log(`Map: ${ironCount} iron, ${breakCount} breakable walls, ${weapons.length} weapons`);

    for (const [id, entry] of botSystem.bots) {
      const pos = { x: entry.context.position.x, y: entry.context.position.y };
      let nearestW = weapons[0],
        nearestDist = Infinity;
      for (const w of weapons) {
        const d = Math.sqrt((w.x - pos.x) ** 2 + (w.y - pos.y) ** 2);
        if (d < nearestDist) {
          nearestDist = d;
          nearestW = w;
        }
      }

      const regularPath = nearestW
        ? pathfinder.findPath(pos, { x: nearestW.x, y: nearestW.y })
        : null;
      const destrPath = nearestW
        ? pathfinder.findPathThroughDestructibles(pos, { x: nearestW.x, y: nearestW.y }, dmap)
        : null;

      const nearD = entry.context.nearbyDestructibles;
      const nearBreak = nearD.filter((d: any) => d.type !== 'iron' && d.hp < 9999);
      const nearIron = nearD.filter((d: any) => d.type === 'iron' || d.hp >= 9999);

      console.log(`BOT ${id.slice(0, 8)} at (${pos.x.toFixed(0)},${pos.y.toFixed(0)})`);
      console.log(`  Near weapon: ${nearestDist.toFixed(0)}px`);
      console.log(`  Regular path: ${regularPath ? regularPath.length + 'wp' : 'NULL'}`);
      console.log(`  Destr path:   ${destrPath ? destrPath.length + 'wp' : 'NULL'}`);
      console.log(`  Nearby: ${nearBreak.length} breakable, ${nearIron.length} iron`);
    }

    await cleanup(server);
  } catch (err) {
    console.error(err);
    await cleanup(server);
  }
}

main();

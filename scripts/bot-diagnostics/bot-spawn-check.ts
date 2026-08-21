import { createTestServer, cleanup } from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { GameRoom } from '../../packages/server/src/room/GameRoom';

function forceActivePhase(room: any) {
  if (room.state.phase !== 2) room.state.phase = 2;
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 0 });
    await helper.addPlayer('test');
    await helper.advanceTicks(10);
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
    console.log(`Weapons on map: ${weapons.length}`);

    const dmap = botSystem.execDeps.buildDestructibleMap();

    const spawns = [
      [960, 832],
      [1856, 832],
      [960, 1856],
      [1856, 1856],
      [1344, 1344],
      [2368, 2368],
      [448, 1344],
      [2368, 1344],
    ];

    let unreachable = 0;
    for (const [sx, sy] of spawns) {
      const pos = { x: sx, y: sy };
      let reachable = false;
      let bestPath: string = '';
      for (const w of weapons) {
        const regular = pathfinder.findPath(pos, { x: w.x, y: w.y });
        const destr = pathfinder.findPathThroughDestructibles(pos, { x: w.x, y: w.y }, dmap);
        if (regular || destr) {
          const method = regular ? 'regular' : 'destr';
          const wp = regular?.length ?? destr?.length ?? 0;
          const d = Math.sqrt((w.x - sx) ** 2 + (w.y - sy) ** 2);
          bestPath += ` (${w.x},${w.y}) d=${d.toFixed(0)} ${method}=${wp}wp`;
          reachable = true;
        }
      }
      if (!reachable) {
        console.log(`SPAWN (${sx},${sy}): *** NO PATH TO ANY WEAPON ***`);
        unreachable++;
      } else {
        console.log(`SPAWN (${sx},${sy}): OK${bestPath.slice(0, 100)}`);
      }
    }
    console.log(`\nReachable: ${spawns.length - unreachable}/${spawns.length}`);

    await cleanup(server);
  } catch (err) {
    console.error(err);
    await cleanup(server);
  }
}

main();

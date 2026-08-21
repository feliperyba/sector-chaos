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

    // Force active phase immediately so weapons exist
    forceActivePhase(room);

    for (let i = 0; i < 500; i++) {
      await room.waitForNextSimulationTick();
    }

    const botSystem = simulation.botSystem;
    if (!botSystem) {
      console.log('No botSystem');
      await cleanup(server);
      return;
    }
    const pathfinder = botSystem.pathfinder;
    const dmap = botSystem.execDeps.buildDestructibleMap();

    // Get weapon positions from room state (schema)
    const weapons: Array<{ x: number; y: number }> = [];
    for (const wp of room.state.weaponPickups.values()) {
      if (wp.isActive) weapons.push({ x: wp.position.x, y: wp.position.y });
    }
    console.log(`Weapons: ${weapons.length}`);

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

    for (const [sx, sy] of spawns) {
      const pos = { x: sx, y: sy };
      let anyReachable = false;
      let bestInfo = '';

      for (const w of weapons) {
        const regular = pathfinder.findPath(pos, w);
        const destr = pathfinder.findPathThroughDestructibles(pos, w, dmap);
        const d = Math.sqrt((w.x - sx) ** 2 + (w.y - sy) ** 2);

        if (regular) {
          bestInfo += ` [r=${regular.length}wp d=${d.toFixed(0)}]`;
          anyReachable = true;
        } else if (destr) {
          bestInfo += ` [d=${destr.length}wp dist=${d.toFixed(0)}]`;
          anyReachable = true;
        }
      }

      console.log(
        `SPAWN (${sx},${sy}): ${anyReachable ? 'OK' : '*** BLOCKED ***'}${bestInfo.slice(0, 200)}`,
      );
    }

    await cleanup(server);
  } catch (err) {
    console.error(err);
    await cleanup(server);
  }
}

main();

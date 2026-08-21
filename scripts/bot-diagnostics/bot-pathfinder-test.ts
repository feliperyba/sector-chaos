/**
 * Destructible pathfinder diagnostic — minimal version.
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { GameRoom } from '../../packages/server/src/room/GameRoom';

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 1 });
    const gameRoom = room as unknown as GameRoom;
    const orchestrator = gameRoom.getOrchestrator() as any;
    const simulation = orchestrator.simulation as any;
    const botSystem = simulation.botSystem;
    const pathfinder = (botSystem as any).pathfinder;

    await helper.addPlayer('test');
    // Wait for bot to spawn — needs ~8 seconds for spawn cycle
    await new Promise((r) => setTimeout(r, 10000));

    const entries = (botSystem as any).bots as Map<string, any>;
    const entry = entries.values().next().value;
    if (!entry) {
      console.log('No bot found');
      await cleanup(server);
      return;
    }

    const botPos = { x: entry.context.position.x, y: entry.context.position.y };
    console.log(`Bot at (${botPos.x.toFixed(0)}, ${botPos.y.toFixed(0)})`);

    // Build destructible map
    const buildDestructibleMap = (botSystem as any).execDeps.buildDestructibleMap;
    const destructibleMap = buildDestructibleMap();
    console.log(`Destructibles on map: ${destructibleMap.size}`);
    for (const [key, hp] of destructibleMap) {
      console.log(`  ${key}: hp=${hp}`);
    }

    // Test path to a few points through walls
    const testTargets = [
      { label: 'top-left weapon', x: 192, y: 192 },
      { label: 'top-right weapon', x: 2368, y: 192 },
      { label: 'center', x: 1408, y: 1408 },
      { label: 'bottom-left', x: 192, y: 2624 },
    ];

    for (const t of testTargets) {
      const regular = pathfinder.findPath(botPos, { x: t.x, y: t.y });
      const through = pathfinder.findPathThroughDestructibles(
        botPos,
        { x: t.x, y: t.y },
        destructibleMap,
      );

      let destrInPath = 0;
      if (through) {
        for (const wp of through) {
          const g = pathfinder.worldToGrid(wp);
          if (destructibleMap.has(`${g.x},${g.y}`)) destrInPath++;
        }
      }

      const dist = Math.sqrt((t.x - botPos.x) ** 2 + (t.y - botPos.y) ** 2);
      console.log(`\n${t.label} (${t.x},${t.y}) dist=${dist.toFixed(0)}`);
      console.log(`  Regular:      ${regular ? regular.length + 'wp' : 'NULL'}`);
      console.log(
        `  ThroughDestr: ${through ? through.length + 'wp (' + destrInPath + ' destructibles)' : 'NULL'}`,
      );
      if (through && through.length <= 4) {
        console.log(
          `  Path: ${through.map((p: any) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' → ')}`,
        );
      }
    }

    await cleanup(server);
  } catch (err) {
    console.error(err);
    await cleanup(server);
  }
}

main();

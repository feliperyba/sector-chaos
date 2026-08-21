import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 4, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'Combat' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const botSystem = orch.simulation.botSystem;

    // Trace context.nearbyPlayers after each scan + behavior result
    for (const [pid, entry] of botSystem.bots) {
      const idx = pid.split('_').pop();
      // Patch perception to log detections
      const origScan = entry.perception.scan.bind(entry.perception);
      entry.perception.scan = function (ctx: any, state: any, pos: any) {
        origScan(ctx, state, pos);
        if (ctx.nearbyPlayers.length > 0) {
          const nearest = ctx.nearbyPlayers[0];
          process.stderr.write(
            `[SEE] Bot${idx} sees Bot${nearest.id.split('_').pop()} at ${Math.round(nearest.distance)}px\n`,
          );
        }
      };

      // Patch the behavior tree root to log results
      const rootNode = entry.tree;
      if (rootNode) {
        const origTick = rootNode.tick.bind(rootNode);
        let tickNum = 0;
        entry.tree = {
          tick: function (ctx: any) {
            tickNum++;
            const status = origTick(ctx);
            if (ctx.nearbyPlayers.length > 0 && tickNum < 200) {
              process.stderr.write(
                `[TREE] Bot${idx} tick=${tickNum} status=${status} behavior=${ctx.lastBehaviorName} nearbyPlayers=${ctx.nearbyPlayers.length}\n`,
              );
            }
            return status;
          },
          reset: () => rootNode.reset(),
        };
      }
    }

    await helper.advanceTicks(300);
  } finally {
    await cleanup(server);
  }
}
main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n`);
  process.exit(1);
});

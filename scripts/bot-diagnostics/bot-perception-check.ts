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
    const client = await connectClient(server, room, { name: 'PCheck' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;

    // Monkey-patch perception.scan to dump nearbyPlayers
    const botSystem = orch.simulation.botSystem;
    for (const [pid, entry] of botSystem.bots) {
      const origScan = entry.perception.scan.bind(entry.perception);
      const idx = pid.split('_').pop();
      let callCount = 0;
      entry.perception.scan = function (ctx: any, state: any, pos: any) {
        origScan(ctx, state, pos);
        callCount++;
        if (callCount % 50 === 1) {
          const np = ctx.nearbyPlayers;
          process.stderr.write(`[BOT${idx}] tick=${callCount} nearbyPlayers=${np.length}`);
          if (np.length > 0) {
            for (const p of np) {
              process.stderr.write(` ${p.id.split('_').pop()}:${Math.round(p.distance)}px`);
            }
          }
          process.stderr.write(
            ` pos=${Math.round(ctx.position.x)},${Math.round(ctx.position.y)}\n`,
          );
        }
      };
    }

    await helper.advanceTicks(600);
  } finally {
    await cleanup(server);
  }
}
main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n`);
  process.exit(1);
});

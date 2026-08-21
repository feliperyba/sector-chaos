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
    const client = await connectClient(server, room, { name: 'Live' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const botSystem = orch.simulation.botSystem;

    // Monkey-patch scan to check what happens during perception
    let patchCount = 0;
    for (const [pid, entry] of botSystem.bots) {
      const origScan = entry.perception.scan.bind(entry.perception);
      const idx = pid.split('_').pop();
      entry.perception.scan = function (ctx: any, state: any, pos: any) {
        origScan(ctx, state, pos);
        patchCount++;
        if (ctx.nearbyPlayers.length > 0 && patchCount < 10) {
          process.stderr.write(`[DETECT] Bot${idx} sees ${ctx.nearbyPlayers.length} players:`);
          for (const p of ctx.nearbyPlayers) {
            process.stderr.write(` ${p.id.split('_').pop()}:${Math.round(p.distance)}px`);
          }
          process.stderr.write(`\n`);
        }
      };
    }

    await helper.advanceTicks(300);
    process.stderr.write(`Total perception scans: ${patchCount}\n`);
    if (patchCount === 0) process.stderr.write('NO SCANS RAN - perception not being called!\n');
  } finally {
    await cleanup(server);
  }
}
main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n`);
  process.exit(1);
});

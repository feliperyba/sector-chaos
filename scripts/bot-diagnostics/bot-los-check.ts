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
    const client = await connectClient(server, room, { name: 'LOS' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const botSystem = orch.simulation.botSystem;
    const pathfinder = botSystem.pathfinder;

    // Check LOS between all bot pairs
    const bots: { idx: string; pos: { x: number; y: number }; detRange: number }[] = [];
    for (const [pid, entry] of botSystem.bots) {
      bots.push({
        idx: pid.split('_').pop()!,
        pos: { x: Math.round(entry.context.position.x), y: Math.round(entry.context.position.y) },
        detRange: entry.perception.getDetectionRange(),
      });
    }

    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        const a = bots[i]!,
          b = bots[j]!;
        const dx = a.pos.x - b.pos.x;
        const dy = a.pos.y - b.pos.y;
        const dist = Math.round(Math.sqrt(dx * dx + dy * dy));
        const los = pathfinder.hasLineOfSightWorld(a.pos, b.pos);
        const effectiveRange = los
          ? Math.max(a.detRange, b.detRange)
          : Math.max(a.detRange, b.detRange) * 0.5;
        const wouldDetect = dist <= effectiveRange;
        process.stderr.write(
          `${a.idx}<>${b.idx}: dist=${dist} los=${los} effRange=${Math.round(effectiveRange)} detect=${wouldDetect}\n`,
        );
      }
    }

    // Also check: what does perception see?
    for (const [pid, entry] of botSystem.bots) {
      const ctx = entry.context;
      process.stderr.write(
        `Bot${pid.split('_').pop()}: nearbyPlayers=${ctx.nearbyPlayers.length} range=${entry.perception.getDetectionRange()}\n`,
      );
    }
  } finally {
    await cleanup(server);
  }
}
main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n`);
  process.exit(1);
});

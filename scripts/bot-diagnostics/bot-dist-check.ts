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
    const client = await connectClient(server, room, { name: 'Dist' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    // Phase should be ACTIVE already after 500 ticks

    for (let t = 0; t < 6; t++) {
      await helper.advanceTicks(100);
      const bots = orch.simulation.botSystem.bots as Map<string, any>;
      const positions: { idx: string; x: number; y: number }[] = [];
      for (const [pid, entry] of bots) {
        positions.push({
          idx: pid.split('_').pop()!,
          x: Math.round(entry.context.position.x),
          y: Math.round(entry.context.position.y),
        });
      }
      const pairs: string[] = [];
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const dx = positions[i].x - positions[j].x;
          const dy = positions[i].y - positions[j].y;
          pairs.push(
            `${positions[i].idx}<>${positions[j].idx}:${Math.round(Math.sqrt(dx * dx + dy * dy))}`,
          );
        }
      }
      process.stderr.write(`t=${(t + 1) * 100} ${pairs.join(' ')}\n`);
    }
  } finally {
    await cleanup(server);
  }
}
main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n`);
  process.exit(1);
});

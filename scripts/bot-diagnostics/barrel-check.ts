// Quick barrel position check
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';

const server = await createTestServer();
const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 2 });
const client = await connectClient(server, room, { name: 'x' } as any);
await room.waitForNextPatch();
await helper.advanceTicks(10);

const match = (room as any).getOrchestrator?.()?.simulation?.match;
const destructibles = match?.getDestructibles?.() ?? [];
console.log('Barrels near weapon room (grid 1-6, 1-5):');
for (const d of destructibles) {
  if (d.type === 'barrel') {
    const gx = Math.floor(d.position.x / 128);
    const gy = Math.floor(d.position.y / 128);
    const nearWeaponRoom = gx <= 8 && gy <= 7;
    console.log(
      `  barrel (${d.position.x},${d.position.y}) grid(${gx},${gy})${nearWeaponRoom ? ' *** NEAR WEAPON ROOM' : ''}`,
    );
  }
}
await cleanup(server);
process.exit(0);

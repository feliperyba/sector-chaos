import { WorldSnapshot } from '../src/ai/WorldSnapshot.ts';
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';

async function main() {
  for (const seed of [555, 777, 999, 12345]) {
    const server = await createTestServer();
    const room = await createRoom(server, { botFillTo: 0, mapType: 'procedural', seed });
    const gameRoom = room as unknown as any;
    const orch = gameRoom.getOrchestrator();
    const match = orch.getMatch();

    const ws = new WorldSnapshot();
    ws.sync(match.getState());
    ws.setMapBounds(10240, 10240);

    const grid = new Array(64).fill(0);
    const cs = 10240 / 8;
    let total = 0;
    ws.forEachActiveDestructible((d: any) => {
      if (d.type === 'barrel') {
        total++;
        const cx = Math.min(7, Math.max(0, Math.floor(d.x / cs)));
        const cy = Math.min(7, Math.max(0, Math.floor(d.y / cs)));
        grid[cy * 8 + cx]++;
      }
    });

    const maxCell = Math.max(...grid);
    const dense = grid.filter((v) => v > 2).length;
    console.log(`Seed ${seed}: ${total} barrels, max/cell=${maxCell}, dense cells(>2)=${dense}`);
    await cleanup(server);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';

async function main() {
  for (const run of [1, 2]) {
    // Virtualize Date.now before spawn (same as harness)
    const seed = 777;
    const seedBaseTime = 1700000000000 + seed * 1000;
    const savedDateNow = globalThis.Date.now;
    globalThis.Date.now = () => seedBaseTime;

    const server = await createTestServer();
    const room = await createRoom(server, { botFillTo: 5, mapType: 'procedural', seed });
    room.autoDispose = false;
    const orch = (room as any).getOrchestrator();
    orch.setLastStandingThreshold(-1);

    // Wait for bots
    await new Promise((r) => setTimeout(r, 3000));

    const players = Array.from(orch.getMatch()?.players?.keys?.() ?? []);
    console.log(`Run ${run} bot IDs: ${players.join(', ')}`);

    globalThis.Date.now = savedDateNow;
    await cleanup(server);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

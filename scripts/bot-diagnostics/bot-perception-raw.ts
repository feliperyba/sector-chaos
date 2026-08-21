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
    const client = await connectClient(server, room, { name: 'Raw' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const match = orch.match;
    const state = match.getState();

    // Check ALL players in state
    process.stderr.write(`=== State players: ${state.players.size} ===\n`);
    for (const [id, p] of state.players) {
      process.stderr.write(
        `  ${id.split('_').pop()}: pos=${Math.round(p.movement.position.x)},${Math.round(p.movement.position.y)} hp=${p.health.current} freshSpawn=${p.isFreshSpawn()}\n`,
      );
    }

    // Check gameState.getPlayers()
    const gameState = orch.simulation.botSystem.gameStateView;
    const players = gameState.getPlayers();
    process.stderr.write(`=== gameState.getPlayers(): ${players.length} ===\n`);
    for (const p of players) {
      process.stderr.write(
        `  ${p.id.split('_').pop()}: pos=${Math.round(p.position.x)},${Math.round(p.position.y)} freshSpawn=${p.isFreshSpawn}\n`,
      );
    }

    // Now check a bot's perception manually
    const botSystem = orch.simulation.botSystem;
    const firstBot = botSystem.bots.values().next().value;
    if (firstBot) {
      const ctx = firstBot.context;
      process.stderr.write(`\n=== Bot0 context ===\n`);
      process.stderr.write(
        `  position: ${Math.round(ctx.position.x)},${Math.round(ctx.position.y)}\n`,
      );
      process.stderr.write(`  nearbyPlayers: ${ctx.nearbyPlayers.length}\n`);
      process.stderr.write(`  detectionRange: ${firstBot.perception.getRange()}\n`);
    }

    // Check match.players
    process.stderr.write(`\n=== match.players: ${match.players.size} ===\n`);
    for (const [id, p] of match.players) {
      process.stderr.write(
        `  ${id.split('_').pop()}: alive=${p.isAlive()} conn=${p.connectionState}\n`,
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

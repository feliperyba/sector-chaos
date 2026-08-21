// Diagnostic: Check spawn locations and terrain around them
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { MatchPhase } from '@sector-battle/shared';

const WARMUP_TICKS = 450;

async function main() {
  const server = await createTestServer();
  const { room } = await createGameRoom(server, { mapType: 'demo', botFillTo: 6 });
  const client = await connectClient(server, room, { name: 'DiagHost' });

  // Force active phase
  const orchestrator = (room as any).getOrchestrator();
  orchestrator.match.setPhase(MatchPhase.ACTIVE);

  // Wait for warmup
  await new Promise<void>((resolve) => {
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
      if (ticks >= WARMUP_TICKS) {
        clearInterval(interval);
        resolve();
      }
    }, 5);
  });

  const sim = orchestrator.simulation;
  const botSystem = sim.botSystem;
  const pf = (botSystem as any)?.pathfinder;

  if (!pf) {
    console.log('No pathfinder');
    process.exit(1);
  }

  const match = orchestrator.match;
  const players = Array.from(match.players.values());
  console.log(`Total players: ${players.length}\n`);

  for (const p of players) {
    const pos = p.movement.position;
    const gx = Math.floor(pos.x / 128);
    const gy = Math.floor(pos.y / 128);
    const isBot = p.isBot ?? false;
    console.log(
      `Player ${p.id.slice(-6)} ${isBot ? 'BOT' : 'HUMAN'}: pos=(${Math.round(pos.x)},${Math.round(pos.y)}) grid=(${gx},${gy})`,
    );

    // 5x5 terrain
    for (let dy = -2; dy <= 2; dy++) {
      let row = '';
      for (let dx = -2; dx <= 2; dx++) {
        row += pf.isWalkable(gx + dx, gy + dy) ? '. ' : '# ';
      }
      console.log(`  y=${gy + dy}: ${row}`);
    }

    // Path to center
    const centerGrid = { x: Math.floor(1408 / 128), y: Math.floor(1408 / 128) };
    const path = pf.findPath({ x: gx, y: gy }, centerGrid);
    console.log(`  Path to center: ${path ? `len=${path.length}` : 'NULL (blocked)'}`);

    // Path to weapon room entry (col 6, row 1-5)
    const entryGrid = { x: 6, y: 3 };
    const wPath = pf.findPath({ x: gx, y: gy }, entryGrid);
    console.log(
      `  Path to weapon entry (6,3): ${wPath ? `len=${wPath.length}` : 'NULL (blocked)'}`,
    );

    // Path through destructibles to weapon room
    const weaponGrid = { x: 2, y: 2 };
    const dPath = pf.findPathThroughDestructibles?.({ x: gx, y: gy }, weaponGrid);
    console.log(
      `  Destructible path to (2,2): ${dPath ? `len=${dPath.length}` : 'NULL or not available'}`,
    );

    console.log();
  }

  await cleanup(server);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

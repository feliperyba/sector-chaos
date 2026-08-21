import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';

const WARMUP_TICKS = 450;

function forceActivePhase(room: any): void {
  const gameRoom = room as unknown as GameRoom;
  const orchestrator = gameRoom.getOrchestrator() as any;
  const simulation = orchestrator.simulation as any;
  const match = simulation.match;
  if (match?.matchFlow) {
    match.matchFlow.transitionTo('countdown');
    match.matchFlow.transitionTo('active');
  }
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 2,
      mapType: 'demo' as any,
    });
    const client = await connectClient(server, room, { name: 'diag' });
    await room.waitForNextPatch();

    await helper.advanceTicks(WARMUP_TICKS);
    forceActivePhase(room);
    await helper.advanceTicks(50);

    const gameRoom = room as unknown as GameRoom;
    const orchestrator = gameRoom.getOrchestrator() as any;
    const simulation = orchestrator.simulation as any;
    const botSystem = simulation.botSystem as any;

    const bots = botSystem.bots as Map<string, any>;
    const entries = [...bots.entries()];
    if (entries.length === 0) {
      console.log('NO BOTS');
      return;
    }

    const [botId, entry] = entries[0];
    const bot = room.state.players.get(botId);
    if (!bot) {
      console.log('NO PLAYER');
      return;
    }

    console.log(`Bot: ${botId} pos=(${bot.x.toFixed(0)},${bot.y.toFixed(0)})`);
    console.log(
      `Override: ${entry.survivalOverrideTicks} Budget: ${entry.totalSurvivalBudgetUsed} CD: ${entry.survivalCooldownTicks}`,
    );

    const threats = entry.threatAssessment;
    const habituated = (threats as any).habituatedPositions;
    console.log(`Habituated: ${habituated?.size ?? 0} positions`);

    // Tick and trace
    console.log('\n=== TRACE ===');
    let lastBehavior = '';

    for (let t = 0; t < 300; t++) {
      await helper.advanceTicks(1);
      const p = room.state.players.get(botId);
      if (!p) {
        console.log('BOT DIED');
        break;
      }

      const e = bots.get(botId);
      if (!e) {
        console.log('BOT GONE');
        break;
      }

      const behavior = e.context?.lastBehaviorName || 'none';
      if (behavior !== lastBehavior || t % 30 === 0) {
        const habSize = (e.threatAssessment as any).habituatedPositions?.size ?? 0;
        console.log(
          `T${500 + t}: ${behavior} override=${e.survivalOverrideTicks} budget=${e.totalSurvivalBudgetUsed} cd=${e.survivalCooldownTicks} hab=${habSize} pos=(${p.x.toFixed(0)},${p.y.toFixed(0)})`,
        );
        lastBehavior = behavior;
      }
    }
  } finally {
    await cleanup();
  }
}

main().catch(console.error);

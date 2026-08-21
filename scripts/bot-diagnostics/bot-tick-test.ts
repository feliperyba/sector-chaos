// Minimal bot tick test
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase } from '@sector-battle/shared';

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 2, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'TickTest' });
    await room.waitForNextPatch();

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;

    // Force active
    if (orch.matchFlow.getCurrentState().phase === MatchPhase.WAITING)
      orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
    if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
      orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
    orch.phase = MatchPhase.ACTIVE;
    match.phase = MatchPhase.ACTIVE;

    console.log(`Phase: ${match.phase}, players: ${match.state.players.size}`);

    const bots = botSystem.bots as Map<string, any>;
    console.log(`Bot count: ${bots.size}`);

    for (const [id, entry] of bots) {
      console.log(
        `Bot ${id}: pos=(${entry.context.position.x.toFixed(0)}, ${entry.context.position.y.toFixed(0)}) tickInterval=${entry.tickInterval}`,
      );
    }

    // Enable telemetry
    botSystem.telemetry = {
      enabled: true,
      records: [] as any[],
      maxRecords: 10000,
      record(r: any) {
        this.records.push(r);
      },
    };

    // Advance and check
    await helper.advanceTicks(30);
    console.log(`After 30 ticks: ${botSystem.telemetry.records.length} telemetry records`);

    // Print first few
    for (const r of botSystem.telemetry.records.slice(0, 5)) {
      console.log(
        `  tick=${r.tick} bot=${r.botId} beh=${r.behavior} items=${r.nearbyItems} goal=${r.movementGoalType}`,
      );
    }

    // Force active again in case it reverted
    orch.phase = MatchPhase.ACTIVE;
    match.phase = MatchPhase.ACTIVE;

    await helper.advanceTicks(100);
    console.log(`After 130 total ticks: ${botSystem.telemetry.records.length} telemetry records`);

    for (const r of botSystem.telemetry.records.slice(-5)) {
      console.log(
        `  tick=${r.tick} bot=${r.botId} beh=${r.behavior} items=${r.nearbyItems} goal=${r.movementGoalType}`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

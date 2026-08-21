// Single-bot demolition pipeline trace
// Spawns 1 bot, logs every goal, path, and demolition event
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase } from '@sector-battle/shared';
import type { Room } from 'colyseus';
import type { GameMatch } from '../../packages/server/src/domain/aggregates/GameMatch';

const server = await createTestServer();
const { room, helper } = await createGameRoom(server, {
  mapType: 'demo',
  botFillTo: 2,
});

// Advance for bot spawns (same as benchmark)
const client = await connectClient(server, room, { name: 'trace' } as any);
await room.waitForNextPatch();
await helper.advanceTicks(450);

// Force active phase
function forceActivePhase(room: Room<any>): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as unknown as {
    matchFlow: { getCurrentState: () => { phase: number }; transitionTo: (p: number) => void };
    phase: number;
  };
  const match = (gameRoom.getOrchestrator() as unknown as { match: GameMatch })
    .match as unknown as { phase: number };
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

forceActivePhase(room);

// Wait for bot spawns
// Already done via helper.advanceTicks above

const sim = (room as unknown as GameRoom).getOrchestrator().simulation as any;
if (!sim) {
  console.error('No simulation');
  process.exit(1);
}

const botSystem = sim.botSystem;
if (!botSystem) {
  console.error('No botSystem');
  process.exit(1);
}

// Find the bot - use botSystem.hasBot fallback
let botId = '';
for (const p of room.state.players.values()) {
  const id = (p as any).id ?? (p as any).sessionId;
  if ((p as any).isBot || botSystem.hasBot(id)) {
    botId = id;
    break;
  }
}
if (!botId) {
  // Debug: list all players
  console.log('All players in state:');
  for (const p of room.state.players.values()) {
    const id = (p as any).id ?? (p as any).sessionId ?? 'no-id';
    console.log(`  id=${id} isBot=${(p as any).isBot} hasBot=${botSystem.hasBot(id)}`);
  }
  console.log('BotSystem contexts:', botSystem.contexts ? [...botSystem.contexts.keys()] : 'none');
  console.error('No bot found after warmup');
  process.exit(1);
}

console.log(`Bot ID: ${botId}`);

// Run 600 ticks, logging every 15 ticks using helper.advanceTicks
for (let batch = 0; batch < 40; batch++) {
  const ctx = botSystem.bots?.get(botId)?.context;
  if (ctx) {
    const goal = ctx.movementGoal;
    const path = ctx.pathToTarget;
    const demo = ctx.demolitionState;
    const pos = ctx.position;
    const weapons = ctx.nearbyItems.filter((it: any) => it.type === 'weapon');

    let pathInfo = 'none';
    if (path && path.length >= 2) {
      const wps = path
        .slice(0, 5)
        .map((p: any) => `(${Math.floor(p.x / 128)},${Math.floor(p.y / 128)})`);
      pathInfo = `len=${path.length} wps=${wps.join(' ')}`;
    }

    console.log(
      `b${batch} pos=(${Math.floor(pos.x)},${Math.floor(pos.y)}) g=${goal.type}` +
        (goal.target
          ? ` tgt=(${Math.floor(goal.target.x / 128)},${Math.floor(goal.target.y / 128)})`
          : '') +
        ` path=${pathInfo}` +
        ` demo=${demo.active ? `(${demo.targetGridX},${demo.targetGridY})h${demo.hitsCompleted}/${demo.totalHitsNeeded}` : 'off'}` +
        ` weps=${weapons.length} busy=${ctx.busyUntilTick > (sim.currentTick ?? 0) ? 'Y' : 'N'}` +
        ` destr=${ctx.nearbyDestructibles.length}`,
    );
  }
  await helper.advanceTicks(15);
}

// Final
const player = room.state.players.get(botId);
if (player) {
  let wcount = 0;
  let realWcount = 0;
  for (const w of (player as any).weapons ?? []) {
    wcount++;
    if (w.weaponType > 0) realWcount++;
  }
  console.log(
    `\nFinal: weaponSlots=${wcount} realWeapons=${realWcount} health=${(player as any).health}`,
  );
}

await cleanup(server);
process.exit(0);

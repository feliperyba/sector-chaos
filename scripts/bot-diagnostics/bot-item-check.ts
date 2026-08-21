/**
 * Quick diagnostic: check how many active weapon pickups exist on the demo map.
 */
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
  const { room, helper } = await createGameRoom(server, {
    matchId: `item-check-${Date.now()}`,
    seed: 42,
    botFillTo: 5,
    mapType: 'demo',
  });
  const client = await connectClient(server, room, { name: 'Checker' });
  await room.waitForNextPatch();
  await helper.advanceTicks(460);

  // Force active
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const matchFlow = orch.matchFlow;
  if (matchFlow.getCurrentState().phase === MatchPhase.WAITING)
    matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  (orch.match as any).phase = MatchPhase.ACTIVE;

  const state = room.state;
  const match = (orch as any).match ?? (orch as any).simulation?.match;
  const matchState = match?.getState?.() ?? match?.state;

  // Check weaponPickups from match state
  let activeWeapons = 0;
  let inactiveWeapons = 0;
  const weaponPickups = matchState?.weaponPickups;
  if (weaponPickups) {
    for (const [id, wp] of weaponPickups) {
      if (wp.isActive) {
        activeWeapons++;
        console.log(
          `  ACTIVE weapon ${id}: pos=(${Math.round(wp.position.x)},${Math.round(wp.position.y)}) type=${wp.weapon?.weaponType ?? wp.weapon?.type} tier=${wp.weapon?.tier}`,
        );
      } else {
        inactiveWeapons++;
      }
    }
  }
  console.log(
    `\nWeapons: ${activeWeapons} active, ${inactiveWeapons} inactive (total: ${activeWeapons + inactiveWeapons})`,
  );

  // Also check chests
  let closedChests = 0;
  const chests = matchState?.chests;
  if (chests) {
    for (const [id, chest] of chests) {
      if (chest.state === 'closed') {
        closedChests++;
        console.log(
          `  CLOSED chest ${id}: pos=(${Math.round(chest.position.x)},${Math.round(chest.position.y)})`,
        );
      }
    }
  }
  console.log(`Chests: ${closedChests} closed`);

  // Check destructibles
  let destructibles = 0;
  const destState = matchState?.destructibles;
  if (destState) {
    for (const [id, d] of destState) {
      destructibles++;
      if (destructibles <= 10) {
        console.log(
          `  Destructible ${id}: pos=(${Math.round(d.position.x)},${Math.round(d.position.y)}) type=${d.type} hp=${d.health}`,
        );
      }
    }
  }
  console.log(`Destructibles: ${destructibles} total`);

  await cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

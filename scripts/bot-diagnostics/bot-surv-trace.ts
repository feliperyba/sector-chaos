// Trace survival override cycle
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType, WeaponTier } from '@sector-battle/shared';
import { WeaponPickup } from '../../packages/server/src/domain/entities/WeaponPickup';
import { WeaponEntity } from '../../packages/server/src/domain/entities/Weapon';
import { Position } from '../../packages/server/src/domain/value-objects/Position';

const WARMUP = 450;
const MEASURE = 100;

function forceActivePhase(room: any): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const match = orch.match as any;
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.WAITING)
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 1, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'SurvTrace' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const bots = botSystem.bots as Map<string, any>;
    const entry = bots.values().next().value!;

    console.log(`survivalOverrideTicks: ${entry.survivalOverrideTicks}`);
    console.log(`survivalCooldownTicks: ${entry.survivalCooldownTicks}`);
    console.log(`tickInterval: ${entry.tickInterval}`);
    console.log(`reactionDelayTicks: ${entry.reactionDelayTicks}`);

    // Trace per-tick for 100 ticks
    for (let t = 0; t < MEASURE; t++) {
      await helper.advanceTicks(1);
      const isThreat = entry.threatAssessment.isImmediateThreat(entry.context);
      console.log(
        `t=${WARMUP + t + 1} override=${entry.survivalOverrideTicks} cooldown=${entry.survivalCooldownTicks} isThreat=${isThreat} behavior=${entry.context.lastBehaviorName} goal=${entry.context.movementGoal.type}`,
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

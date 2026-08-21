// Loot movement trace — track movement goal lifecycle
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
    const { room, helper } = await createGameRoom(server, { botFillTo: 2, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'MoveTrace' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;
    const maps = match._maps;

    const bots = botSystem.bots as Map<string, any>;
    const [botId, entry] = bots.entries().next().value!;
    const ctx = entry.context;
    const botPos = { x: ctx.position.x, y: ctx.position.y };

    // Spawn weapon right next to bot (20px)
    const wpos = new Position(botPos.x + 20, botPos.y);
    const w = new WeaponEntity('mv-w-0', WeaponType.SHORT_SWORD, WeaponTier.COMMON, 30, 30, 10);
    const pickup = WeaponPickup.create('mv-wp-0', w, wpos, 0);
    maps.weaponPickups.set(pickup.id, pickup);
    console.log(
      `Bot at (${botPos.x.toFixed(0)}, ${botPos.y.toFixed(0)}) weapon at (${wpos.x.toFixed(0)}, ${wpos.y.toFixed(0)})`,
    );

    // Enable telemetry
    botSystem.telemetry = {
      enabled: true,
      records: [] as any[],
      maxRecords: 10000,
      record(r: any) {
        this.records.push(r);
      },
    };

    // Track movement goal changes tick by tick
    let prevGoal = 'NONE';
    for (let t = 0; t < 100; t++) {
      await helper.advanceTicks(1);
      const goal = ctx.movementGoal;
      const goalStr = `${goal.type}:${goal.target ? `(${goal.target.x.toFixed(0)},${goal.target.y.toFixed(0)})` : '?'}`;

      if (goalStr !== prevGoal) {
        const player = match.state.players.get(botId);
        const pos = player
          ? `(${player.movement.position.x.toFixed(0)}, ${player.movement.position.y.toFixed(0)})`
          : '?';
        const hasArrival = goal.onArrivalAction ? ` arrival=${goal.onArrivalAction.type}` : '';
        console.log(
          `t=${WARMUP + t + 1} GOAL_CHANGED: ${prevGoal} → ${goalStr}${hasArrival} pos=${pos}`,
        );
        prevGoal = goalStr;
      }

      if (!maps.weaponPickups.has('mv-wp-0')) {
        console.log('*** WEAPON PICKED UP ***');
        break;
      }
    }

    // Summary
    const allRecords = botSystem.telemetry.records.filter((r: any) => r.botId === botId);
    const behaviors: Record<string, number> = {};
    for (const r of allRecords) behaviors[r.behavior] = (behaviors[r.behavior] || 0) + 1;
    console.log(`\n=== ${allRecords.length} records. Behaviors: ${JSON.stringify(behaviors)} ===`);
    console.log(`Weapon exists: ${maps.weaponPickups.has('mv-wp-0')}`);
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

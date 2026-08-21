// Movement goal trace via telemetry (pre-reset data)
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
    const client = await connectClient(server, room, { name: 'GoalTrace' });
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
    const w = new WeaponEntity('gt-w-0', WeaponType.SHORT_SWORD, WeaponTier.COMMON, 30, 30, 10);
    const pickup = WeaponPickup.create('gt-wp-0', w, wpos, 0);
    maps.weaponPickups.set(pickup.id, pickup);
    console.log(
      `Bot at (${botPos.x.toFixed(0)}, ${botPos.y.toFixed(0)}) weapon at (${wpos.x.toFixed(0)}, ${wpos.y.toFixed(0)})`,
    );

    // Enable telemetry with position data
    botSystem.telemetry = {
      enabled: true,
      records: [] as any[],
      maxRecords: 10000,
      record(r: any) {
        this.records.push(r);
      },
    };

    // Add movement goal position to telemetry
    const origRecord = botSystem.telemetry.record.bind(botSystem.telemetry);
    botSystem.telemetry.record = function (r: any) {
      // Add movement goal target position
      const goal = entry.context.movementGoal;
      (r as any).goalTarget = goal.target
        ? `(${goal.target.x.toFixed(0)},${goal.target.y.toFixed(0)})`
        : 'none';
      (r as any).goalType = goal.type;
      (r as any).arrivalAction = goal.onArrivalAction?.type ?? 'none';
      origRecord(r);
    };

    // Run for 200 ticks
    await helper.advanceTicks(200);

    // Analyze telemetry
    const records = botSystem.telemetry.records.filter((r: any) => r.botId === botId);
    console.log(`\n${records.length} telemetry records for ${botId}`);

    // Print ALL records with non-NONE goals
    let pickupAttempted = false;
    for (const r of records) {
      if (r.goalType !== 'NONE' || r.behavior !== 'survival') {
        console.log(
          `  tick=${r.tick} beh=${r.behavior} goal=${r.goalType} target=${r.goalTarget} arrival=${r.arrivalAction} items=${r.nearbyItems} pos=(${r.position.x.toFixed(0)},${r.position.y.toFixed(0)})`,
        );
      }
      if (r.arrivalAction === 'pickup') pickupAttempted = true;
    }

    console.log(`\nWeapon exists: ${maps.weaponPickups.has('gt-wp-0')}`);
    console.log(`Pickup attempted: ${pickupAttempted}`);

    // Show goal distribution
    const goals: Record<string, number> = {};
    for (const r of records) goals[r.goalType] = (goals[r.goalType] || 0) + 1;
    console.log(`Goal types: ${JSON.stringify(goals)}`);

    const player = match.state.players.get(botId);
    if (player) {
      const wpns = Array.from((player as any).inventory)
        .map((w: any, i: number) => (w ? `slot${i}` : 'empty'))
        .join(',');
      console.log(`Weapons: ${wpns}`);
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

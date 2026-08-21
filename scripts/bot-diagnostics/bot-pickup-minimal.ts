import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom.ts';
import { WeaponEntity } from '../../packages/server/src/domain/entities/Weapon';
import { WeaponPickup } from '../../packages/server/src/domain/entities/WeaponPickup';
import { WeaponType, MatchPhase } from '@sector-battle/shared';
import type { Room } from '@colyseus/core';

const WARMUP = 450;

function forceActivePhase(room: Room<any>): void {
  const gr = room as unknown as GameRoom;
  const orch = gr.getOrchestrator() as any;
  const match = orch.match as any;
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchMode.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server: any = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 2 });
    const client = await connectClient(server, room, { name: 'TestPlayer' });
    await room.waitForNextPatch();

    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);
    await helper.advanceTicks(60);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.match as any;
    const maps = match._maps;
    const botSystem = orch.simulation?.botSystem;
    if (!botSystem) {
      console.log('FAIL: no botSystem');
      cleanup();
      process.exit(1);
    }

    // Enable telemetry
    (botSystem as any).telemetry = {
      enabled: true,
      records: [] as any[],
      record(d: any) {
        this.records.push(d);
      },
    };

    const entries = (botSystem as any).bots as Map<string, any>;
    const firstBotId = [...entries.keys()][0]!;
    const botPlayer = match.players.get(firstBotId);
    if (!botPlayer) {
      console.log('FAIL: no bot player');
      cleanup();
      process.exit(1);
    }

    const pos = { x: botPlayer.movement.position.x, y: botPlayer.movement.position.y };
    console.log(`Bot ${firstBotId} at (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`);

    const weaponPickups = maps.weaponPickups as Map<string, any>;
    const w = new WeaponEntity('tw1', WeaponType.SHORT_SWORD, 1, 50, 50, 10);
    const pickup = WeaponPickup.create('twp1', w, pos, 0);
    weaponPickups.set(pickup.id, pickup);
    console.log(`Weapon spawned ON bot, active=${pickup.isActive}`);

    await helper.advanceTicks(300);

    let weaponCount = 0;
    for (const slot of botPlayer.inventory) {
      if (slot && slot.type !== 0) weaponCount++;
    }

    // Check telemetry
    const records = (botSystem as any).telemetry.records as any[];
    const botRecords = records.filter((r: any) => r.botId === firstBotId);
    const behaviors = botRecords.map((r: any) => r.behavior);
    const behaviorCounts: Record<string, number> = {};
    for (const b of behaviors) behaviorCounts[b] = (behaviorCounts[b] || 0) + 1;
    const nearbyItemsNonZero = botRecords.filter((r: any) => r.nearbyItems > 0).length;
    const movementGoalSeek = botRecords.filter(
      (r: any) => r.hadMovementGoal && r.movementGoalType === 'SEEK',
    ).length;

    console.log(`\nTelemetry for bot ${firstBotId}:`);
    console.log(`  Total records: ${botRecords.length}`);
    console.log(`  Behavior counts: ${JSON.stringify(behaviorCounts)}`);
    console.log(`  Records with nearbyItems>0: ${nearbyItemsNonZero}`);
    console.log(`  Records with SEEK goal: ${movementGoalSeek}`);
    console.log(`  First 10 behaviors: ${behaviors.slice(0, 10).join(', ')}`);

    const wpAfter = weaponPickups.get('twp1');
    console.log(`\nAfter 300 ticks: weapons=${weaponCount}, wpActive=${wpAfter?.isActive}`);

    if (weaponCount > 0) {
      console.log('PASS: Bot picked up weapon!');
    } else {
      console.log('FAIL: Bot did NOT pick up weapon');
    }
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Loot trace v2 — uses telemetry to get pre-reset data
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
const MEASURE = 200;

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
    const client = await connectClient(server, room, { name: 'TraceBot' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;
    const maps = match._maps;

    // Enable telemetry
    botSystem.telemetry = {
      enabled: true,
      records: [] as any[],
      maxRecords: 10000,
      record(r: any) {
        this.records.push(r);
      },
    };

    const bots = botSystem.bots as Map<string, any>;
    const firstEntry = bots.values().next().value!;
    const botId = bots.keys().next().value!;
    const ctx = firstEntry.context;
    const botPos = { x: ctx.position.x, y: ctx.position.y };
    console.log(`Bot ${botId} at (${botPos.x.toFixed(0)}, ${botPos.y.toFixed(0)})`);

    // Spawn weapon 30px away
    const wpos = new Position(botPos.x + 30, botPos.y);
    const w = new WeaponEntity('trace-w-0', WeaponType.SHORT_SWORD, WeaponTier.COMMON, 30, 30, 10);
    const pickup = WeaponPickup.create('trace-wp-0', w, wpos, 0);
    maps.weaponPickups.set(pickup.id, pickup);
    console.log(`Weapon at (${wpos.x.toFixed(0)}, ${wpos.y.toFixed(0)}) — 30px away`);

    // Tick and read telemetry
    for (let t = 0; t < MEASURE; t += 20) {
      const beforeCount = botSystem.telemetry.records.length;
      await helper.advanceTicks(20);

      // Read new telemetry records
      const records = botSystem.telemetry.records.slice(beforeCount);
      const myRecords = records.filter((r: any) => r.botId === botId);

      if (myRecords.length > 0) {
        // Summarize last record in this batch
        const last = myRecords[myRecords.length - 1];
        console.log(
          `[t=${last.tick}] behavior=${last.behavior} nearbyItems=${last.nearbyItems} nearbyPlayers=${last.nearbyPlayers} hp=${last.health} weapons=${last.weaponsEquipped} goal=${last.movementGoalType}`,
        );
      } else {
        console.log(`[t=${t + 20}] NO telemetry for bot (not ticking)`);
      }

      // Check if weapon still exists
      if (!maps.weaponPickups.has('trace-wp-0')) {
        console.log('WEAPON PICKED UP (removed from map)!');
        break;
      }
      const wp = maps.weaponPickups.get('trace-wp-0');
      if (!wp.isActive) {
        console.log('WEAPON DEACTIVATED!');
        break;
      }
    }

    // Summarize telemetry
    const allRecords = botSystem.telemetry.records.filter((r: any) => r.botId === botId);
    console.log(`\n=== TELEMETRY SUMMARY for ${botId} (${allRecords.length} records) ===`);

    const behaviors: Record<string, number> = {};
    let totalItems = 0;
    let maxItems = 0;
    let ticksWithItems = 0;
    for (const r of allRecords) {
      behaviors[r.behavior] = (behaviors[r.behavior] || 0) + 1;
      totalItems += r.nearbyItems;
      if (r.nearbyItems > maxItems) maxItems = r.nearbyItems;
      if (r.nearbyItems > 0) ticksWithItems++;
    }
    console.log(`Behavior distribution: ${JSON.stringify(behaviors)}`);
    console.log(
      `Nearby items: avg=${(totalItems / allRecords.length).toFixed(1)} max=${maxItems} ticks_with_items=${ticksWithItems}/${allRecords.length}`,
    );
    console.log(
      `Weapon still exists: ${maps.weaponPickups.has('trace-wp-0')} active=${maps.weaponPickups.get('trace-wp-0')?.isActive}`,
    );
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

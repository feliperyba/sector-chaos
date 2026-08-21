// Loot pickup trace — spawn weapon ON the bot, trace pickup attempt
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
const MEASURE = 150;

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
    const client = await connectClient(server, room, { name: 'LootTrace' });
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
    const firstEntry = bots.values().next().value!;
    const botId = bots.keys().next().value!;
    const ctx = firstEntry.context;

    // Enable telemetry
    botSystem.telemetry = {
      enabled: true,
      records: [] as any[],
      maxRecords: 10000,
      record(r: any) {
        this.records.push(r);
      },
    };

    // Spawn weapon 10px from bot (basically on top of them)
    const botPos = { x: ctx.position.x, y: ctx.position.y };
    const wpos = new Position(botPos.x + 10, botPos.y);
    const w = new WeaponEntity('lt-w-0', WeaponType.SHORT_SWORD, WeaponTier.COMMON, 30, 30, 10);
    const pickup = WeaponPickup.create('lt-wp-0', w, wpos, 0);
    maps.weaponPickups.set(pickup.id, pickup);
    console.log(`Bot ${botId} at (${botPos.x.toFixed(0)}, ${botPos.y.toFixed(0)})`);
    console.log(`Weapon at (${wpos.x.toFixed(0)}, ${wpos.y.toFixed(0)}) — 10px away`);

    for (let t = 0; t < MEASURE; t += 10) {
      const beforeCount = botSystem.telemetry.records.length;
      await helper.advanceTicks(10);

      const records = botSystem.telemetry.records.slice(beforeCount);
      const myRecords = records.filter((r: any) => r.botId === botId);

      // Get bot's current position
      const player = (orch.match as any).state.players.get(botId);
      const pos = player
        ? `(${player.movement.position.x.toFixed(0)}, ${player.movement.position.y.toFixed(0)})`
        : '?';
      const weapons = player ? Array.from(player.inventory).filter((w: any) => w).length : '?';

      if (myRecords.length > 0) {
        const last = myRecords[myRecords.length - 1];
        console.log(
          `[t=${last.tick}] beh=${last.behavior} items=${last.nearbyItems} goal=${last.movementGoalType} pos=${pos} weapons=${weapons}`,
        );
      }

      if (!maps.weaponPickups.has('lt-wp-0')) {
        console.log('*** WEAPON PICKED UP (removed from map) ***');
        break;
      }
      const wp = maps.weaponPickups.get('lt-wp-0');
      if (!wp.isActive) {
        console.log('*** WEAPON DEACTIVATED ***');
        break;
      }
    }

    // Final state
    const allRecords = botSystem.telemetry.records.filter((r: any) => r.botId === botId);
    const behaviors: Record<string, number> = {};
    for (const r of allRecords) behaviors[r.behavior] = (behaviors[r.behavior] || 0) + 1;
    console.log(`\n=== SUMMARY (${allRecords.length} records) ===`);
    console.log(`Behaviors: ${JSON.stringify(behaviors)}`);
    console.log(`Weapon exists: ${maps.weaponPickups.has('lt-wp-0')}`);

    const player = (orch.match as any).state.players.get(botId);
    if (player) {
      console.log(
        `Bot weapons: ${Array.from((player as any).inventory)
          .map((w: any, i: number) => (w ? `slot${i}:${w.type}` : 'empty'))
          .join(', ')}`,
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

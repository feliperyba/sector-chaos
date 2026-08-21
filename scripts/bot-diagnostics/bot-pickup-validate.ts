/**
 * Pickup Validation — controlled single-bot weapon pickup test
 * Spawns a bot near a weapon, advances ticks, checks pickup.
 * Repeat N times for statistical confidence.
 *
 * Usage: npx tsx packages/server/tests/integration/bot-ai/bot-pickup-validate.ts [rounds]
 */
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
const MEASURE = 300;

function forceActivePhase(room: any) {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const cur = orch.matchFlow.getCurrentState().phase;
  if (cur === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  orch.match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const rounds = parseInt(process.argv[2] || '10', 10);
  const server = await createTestServer();

  let totalPickups = 0;
  let totalRuns = 0;

  for (let round = 0; round < rounds; round++) {
    const { room, helper } = await createGameRoom(server, { botFillTo: 2, mapType: 'demo' as any });
    // Connect a watcher client
    const client = await connectClient(server, room, { name: 'Watcher' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const match = orch.match as any;
    const state = match.getState();
    const players = state.players;

    // Find the one bot
    let botId = '';
    let botX = 0,
      botY = 0;
    for (const [id, p] of players) {
      if (id.startsWith('bot')) {
        botId = id;
        botX = Math.round(p.movement.position.x);
        botY = Math.round(p.movement.position.y);
        break;
      }
    }

    if (!botId) {
      console.log(`R${round}: NO BOT FOUND`);
      continue;
    }

    // Place weapon 150px from bot (well within detection range)
    const weaponX = botX + 150;
    const weaponY = botY;
    const weapon = new WeaponEntity(
      `val-w-${round}`,
      WeaponType.SHORT_SWORD,
      WeaponTier.COMMON,
      50,
      50,
      10,
    );
    const pickup = WeaponPickup.create(
      `val-wp-${round}`,
      weapon,
      new Position(weaponX, weaponY),
      0,
    );
    const maps = (match as any)._maps;
    if (maps?.weaponPickups) {
      maps.weaponPickups.set(pickup.id, pickup);
    } else {
      state.weaponPickups.set(pickup.id, pickup);
    }

    // Track pickup
    let pickedUp = false;
    let pickupTick = -1;

    for (let t = 0; t < MEASURE; t++) {
      await helper.advanceTicks(1);
      const p = players.get(botId);
      if (!p) break;
      const realWeapons = p.inventory.weapons.filter((w: any) => w && w.type !== WeaponType.FISTS);
      if (realWeapons.length > 0) {
        pickedUp = true;
        pickupTick = t;
        break;
      }
    }

    if (pickedUp) totalPickups++;
    totalRuns++;

    const p = players.get(botId);
    const px = Math.round(p?.movement?.position?.x ?? 0);
    const py = Math.round(p?.movement?.position?.y ?? 0);
    const finalDist = Math.round(Math.sqrt((px - weaponX) ** 2 + (py - weaponY) ** 2));
    console.log(
      `R${round}: bot=${botId.slice(-4)} start=(${botX},${botY}) weapon=(${weaponX},${weaponY}) ${pickedUp ? `PICKUP@t${pickupTick}` : `MISSED dist=${finalDist}`} final=(${px},${py})`,
    );

    // Cleanup
    (room as any).drop?.();
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(
    `Pickups: ${totalPickups}/${totalRuns} (${Math.round((totalPickups / totalRuns) * 100)}%)`,
  );

  await cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

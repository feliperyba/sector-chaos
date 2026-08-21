// Trace looting: spawn ONE weapon next to ONE bot, trace nearbyItems and looting tree
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

    const bots = botSystem.bots as Map<string, any>;
    // Get bot 0 position
    const firstBot = bots.values().next().value!;
    const ctx = firstBot.context;
    const botPos = { x: ctx.position.x, y: ctx.position.y };
    console.log(`Bot 0 at (${botPos.x.toFixed(0)}, ${botPos.y.toFixed(0)})`);

    // Spawn weapon 30px away (well within pickup range)
    const wpos = new Position(botPos.x + 30, botPos.y);
    const w = new WeaponEntity('trace-w-0', WeaponType.SHORT_SWORD, WeaponTier.COMMON, 30, 30, 10);
    const pickup = WeaponPickup.create('trace-wp-0', w, wpos, 0);
    maps.weaponPickups.set(pickup.id, pickup);
    console.log(`Weapon spawned at (${wpos.x.toFixed(0)}, ${wpos.y.toFixed(0)}) — 30px away`);

    // Verify state sees it
    const state = match.getState();
    const stateWP = state.weaponPickups as Map<string, any>;
    console.log(
      `getState().weaponPickups has ${stateWP.size} entries, our weapon active=${stateWP.get('trace-wp-0')?.isActive}`,
    );

    // Tick and trace every 10 ticks
    for (let t = 0; t < MEASURE; t += 10) {
      await helper.advanceTicks(10);
      const c = firstBot.context;

      // Check perception
      const nearbyWeapons = c.nearbyItems.filter((i: any) => i.type === 'weapon');
      const goal = c.movementGoal;
      const hasGoal = goal.type !== 'NONE';
      const dest = c.demolitionState;
      const lastBeh = c.lastBehaviorName;

      // Check entity still exists
      const wpExists = maps.weaponPickups.has('trace-wp-0');
      const wpActive = wpExists ? maps.weaponPickups.get('trace-wp-0').isActive : false;

      console.log(
        `[t=${t + 10}] pos=(${c.position.x.toFixed(0)},${c.position.y.toFixed(0)}) nearbyWeapons=${nearbyWeapons.length} nearbyItems=${c.nearbyItems.length} behavior=${lastBeh} goal=${hasGoal ? goal.type : 'NONE'} demo=${dest.active} weaponExists=${wpExists} weaponActive=${wpActive} hp=${c.health} cmdQueue=${c.commandQueue?.length || 0}`,
      );

      if (nearbyWeapons.length > 0) {
        for (const nw of nearbyWeapons) {
          console.log(
            `  weapon: id=${nw.id} dist=${nw.distance.toFixed(0)} tier=${nw.tier} pos=(${nw.position.x.toFixed(0)},${nw.position.y.toFixed(0)})`,
          );
        }
      }

      // Stop early if weapon picked up
      if (!wpExists || !wpActive) {
        console.log('WEAPON PICKED UP!');
        const weapons = c.inventory.weapons.filter((w: any) => w.type !== 0);
        console.log(
          `Bot now has ${weapons.length} weapons: ${weapons.map((w: any) => w.type).join(',')}`,
        );
        break;
      }
    }

    // Final state
    const c = firstBot.context;
    const weapons = c.inventory.weapons;
    const nonFist = weapons.filter((w: any) => w.type !== 0);
    console.log(
      `\nFinal: ${nonFist.length} weapons, hp=${c.health}, pos=(${c.position.x.toFixed(0)},${c.position.y.toFixed(0)})`,
    );
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

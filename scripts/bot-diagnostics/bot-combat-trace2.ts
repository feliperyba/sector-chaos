import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { WeaponType } from '@sector-battle/shared';

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 4, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'Trace' });
    await room.waitForNextPatch();
    await helper.advanceTicks(500);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const match = orch.match;
    const botSystem = orch.simulation.botSystem;

    // Spawn weapons near spawns
    const weaponPositions = [
      { x: 960, y: 700 },
      { x: 1856, y: 700 },
      { x: 960, y: 1984 },
      { x: 1856, y: 1984 },
      { x: 1344, y: 1200 },
      { x: 1344, y: 1488 },
    ];
    for (let i = 0; i < weaponPositions.length; i++) {
      match.addWeaponPickup(
        `wtest_${i}`,
        { type: WeaponType.SHORT_SWORD, tier: 1, ammo: -1 },
        weaponPositions[i]!,
      );
    }

    // Patch perception to log detections
    for (const [pid, entry] of botSystem.bots) {
      const idx = pid.split('_').pop();
      const origScan = entry.perception.scan.bind(entry.perception);
      entry.perception.scan = function (ctx: any, state: any, pos: any) {
        origScan(ctx, state, pos);
        if (ctx.nearbyPlayers.length > 0) {
          process.stderr.write(
            `[SEE] Bot${idx} sees ${ctx.nearbyPlayers.length} enemies at tick ${ctx.currentTick}\n`,
          );
        }
      };

      // Patch behavior tree
      const origTree = entry.tree;
      const origTick = origTree.tick.bind(origTree);
      entry.tree = {
        tick: function (ctx: any) {
          const status = origTick(ctx);
          if (ctx.nearbyPlayers.length > 0) {
            process.stderr.write(
              `[TREE] Bot${idx} status=${status} behavior=${ctx.lastBehaviorName} armed=${ctx.inventory.weapons.some((w: any) => w.type !== 0)}\n`,
            );
          }
          return status;
        },
        reset: () => origTree.reset(),
      };
    }

    await helper.advanceTicks(600);
  } finally {
    await cleanup(server);
  }
}
main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n`);
  process.exit(1);
});

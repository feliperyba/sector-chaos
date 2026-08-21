// Unarmed bot trace — where do they go and why no weapon?
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType, WeaponTier } from '@sector-battle/shared';

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
    const client = await connectClient(server, room, { name: 'UnarmedTrace' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;
    const maps = match._maps;

    // List all weapon pickups on the map
    console.log('=== Weapon Pickups on Map ===');
    for (const [id, wp] of maps.weaponPickups) {
      if (wp.isActive) {
        console.log(
          `  ${id}: (${wp.position.x.toFixed(0)}, ${wp.position.y.toFixed(0)}) type=${wp.weapon?.type}`,
        );
      }
    }

    // List all chests
    console.log('\n=== Chests on Map ===');
    for (const [id, ch] of maps.chests || []) {
      console.log(
        `  ${id}: (${ch.position?.x?.toFixed(0)}, ${ch.position?.y?.toFixed(0)}) opened=${ch.isOpen}`,
      );
    }

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

    // Print bot starting positions and distance to nearest weapon
    console.log('\n=== Bot Starting Positions ===');
    const weaponPositions: { x: number; y: number }[] = [];
    for (const [id, wp] of maps.weaponPickups) {
      if (wp.isActive) weaponPositions.push({ x: wp.position.x, y: wp.position.y });
    }

    for (const [pid, entry] of bots) {
      const pos = entry.context.position;
      let minDist = Infinity;
      let nearest = 'none';
      for (const wp of weaponPositions) {
        const d = Math.sqrt((pos.x - wp.x) ** 2 + (pos.y - wp.y) ** 2);
        if (d < minDist) {
          minDist = d;
          nearest = `(${wp.x.toFixed(0)},${wp.y.toFixed(0)})`;
        }
      }
      const armed = entry.context.inventory.weapons.some((w: any) => w.type !== 0);
      console.log(
        `  ${pid}: (${pos.x.toFixed(0)},${pos.y.toFixed(0)}) armed=${armed} nearestWeapon=${nearest} dist=${minDist.toFixed(0)}px`,
      );
    }

    // Run 300 ticks
    await helper.advanceTicks(300);

    // Check results
    const records = botSystem.telemetry.records;

    for (const [pid, entry] of bots) {
      const br = records.filter((r: any) => r.botId === pid);
      const pos = entry.context.position;
      const armed = entry.context.inventory.weapons.some((w: any) => w.type !== 0);

      // Trace movement goals
      const goalTypes: Record<string, number> = {};
      const behDist: Record<string, number> = {};
      let prevPos = br[0]?.position;
      for (const r of br) {
        goalTypes[r.movementGoalType] = (goalTypes[r.movementGoalType] || 0) + 1;
        if (prevPos) {
          const d = Math.sqrt((r.position.x - prevPos.x) ** 2 + (r.position.y - prevPos.y) ** 2);
          behDist[r.behavior] = (behDist[r.behavior] || 0) + d;
        }
        prevPos = r.position;
      }

      // Check if bot ever had a SEEK with pickup action
      const pickupGoals = br.filter(
        (r: any) => r.movementGoalType === 'SEEK' && r.behavior === 'looting',
      );

      console.log(`\n=== ${pid} ===`);
      console.log(`  Final pos: (${pos.x.toFixed(0)},${pos.y.toFixed(0)}) armed=${armed}`);
      console.log(`  Goal distribution: ${JSON.stringify(goalTypes)}`);
      console.log(
        `  Distance by behavior: ${Object.entries(behDist)
          .map(([k, v]) => `${k}=${v.toFixed(0)}px`)
          .join(' ')}`,
      );
      console.log(`  Looting SEEK ticks: ${pickupGoals.length}`);
      if (pickupGoals.length > 0) {
        const first = pickupGoals[0];
        const last = pickupGoals[pickupGoals.length - 1];
        console.log(
          `  First loot SEEK: tick=${first.tick} pos=(${first.position.x.toFixed(0)},${first.position.y.toFixed(0)}) goal=(${first.goalTargetX?.toFixed(0) ?? 'N/A'},${first.goalTargetY?.toFixed(0) ?? 'N/A'})`,
        );
      }
    }

    client.leave();
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

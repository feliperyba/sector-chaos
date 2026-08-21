/**
 * Multi-run pipeline diagnostic.
 * Runs 5 rounds, tracks each bot's weapon acquisition success.
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { advanceTicks, waitForPhase } from '../../packages/server/tests/helpers/test-utils';
import { GameRoom } from '../../packages/server/src/room/GameRoom';

async function runRound(roundNum: number) {
  const server = await createTestServer();
  const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 4 });
  const gameRoom = room as unknown as GameRoom;

  await helper.addPlayer('tracker');
  await waitForPhase(room, 2);
  await advanceTicks(room, 500);

  const botSystem =
    (gameRoom as any).simulation?.botSystem ??
    (gameRoom.getOrchestrator() as any).simulation?.botSystem;
  const pathfinder = botSystem.pathfinder;
  const state = room.state;

  const bots: Array<{
    id: string;
    x: number;
    y: number;
    gridX: number;
    gridY: number;
    walkable: boolean;
  }> = [];
  state.players.forEach((p: any, id: string) => {
    if (p.isBot) {
      const g = pathfinder.worldToGrid({ x: p.x, y: p.y });
      const w = pathfinder.isWalkable(g.x, g.y);
      bots.push({ id, x: p.x, y: p.y, gridX: g.x, gridY: g.y, walkable: w });
    }
  });

  // Count weapons
  let weaponCount = 0;
  const wp = (state as any).weaponPickups;
  if (wp) wp.forEach(() => weaponCount++);

  console.log(`\n=== Round ${roundNum}: ${bots.length} bots, ${weaponCount} weapons ===`);

  for (const b of bots) {
    // Find nearest active weapon
    let nearestW: { x: number; y: number } | null = null;
    let nearestD = Infinity;
    wp?.forEach((w: any) => {
      const d = Math.sqrt((b.x - w.x) ** 2 + (b.y - w.y) ** 2);
      if (d < nearestD) {
        nearestD = d;
        nearestW = { x: w.x, y: w.y };
      }
    });

    // Check destructible path
    let destructCount = 0;
    if (nearestW) {
      const dmap = new Map<string, number>();
      const ds = (state as any).destructibles;
      ds?.forEach((d: any) => {
        if (!d.isDestroyed && d.type !== 'iron') {
          const g = pathfinder.worldToGrid({ x: d.x, y: d.y });
          dmap.set(`${g.x},${g.y}`, d.hp * 10);
        }
      });
      const path = pathfinder.findPathThroughDestructibles({ x: b.x, y: b.y }, nearestW, dmap);
      if (path) {
        for (const p of path) {
          const gx = Math.floor(p.x / 128);
          const gy = Math.floor(p.y / 128);
          if (dmap.has(`${gx},${gy}`)) destructCount++;
        }
      }
    }

    const status = b.walkable ? '✅' : '❌ TRAPPED';
    console.log(
      `  ${b.id.slice(-5)} pos=(${b.x.toFixed(0)},${b.y.toFixed(0)}) grid=(${b.gridX},${b.gridY}) ${status} nearestW=${nearestD.toFixed(0)}px wallsToBreak=${destructCount}`,
    );
  }

  // Now run for 3000 ticks and track outcomes
  const botWeapons = new Map<string, number[]>();
  bots.forEach((b) => botWeapons.set(b.id, []));

  const armedAt = new Map<string, number>();

  for (let t = 0; t < 3000; t++) {
    await advanceTicks(room, 1);
    const tick = room.state.tick;

    state.players.forEach((p: any, id: string) => {
      if (!p.isBot) return;
      const ws: number[] = [];
      p.weapons.forEach((w: any) => ws.push(w.type));
      const hasNonFist = ws.some((w) => w !== 0 && w !== undefined);
      if (hasNonFist && !armedAt.has(id)) {
        armedAt.set(id, tick);
      }
    });
  }

  console.log(`  Results after 3000 ticks:`);
  for (const b of bots) {
    const armed = armedAt.has(b.id);
    const when = armed ? `t=${armedAt.get(b.id)}` : 'never';
    const p = state.players.get(b.id) as any;
    const alive = p && p.health > 0;
    console.log(
      `    ${b.id.slice(-5)} armed=${armed} at=${when} alive=${alive} hp=${p?.health ?? 0}`,
    );
  }

  await cleanup(server);
  return bots.filter((b) => armedAt.has(b.id)).length;
}

async function main() {
  let totalArmed = 0;
  let totalBots = 0;
  for (let i = 1; i <= 3; i++) {
    const armed = await runRound(i);
    totalArmed += armed;
    totalBots += 4;
  }
  console.log(`\n\n=== SUMMARY: ${totalArmed}/${totalBots} bots got weapons ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

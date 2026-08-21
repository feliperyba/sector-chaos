/**
 * Pickup trace: logs every arrival/pickup attempt with positions and distances
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';

const server = await createTestServer();
const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 2 });
const client = await connectClient(server, room, { name: 'trace' } as any);
await room.waitForNextPatch();
await helper.advanceTicks(450);

const sim = (room as any).getOrchestrator?.()?.simulation;
const botSystem = sim?.botSystem;
const match = sim?.match;
if (!botSystem || !match) {
  console.error('No botSystem or match');
  process.exit(1);
}

// Get first bot
let botId = '';
for (const [id, entry] of botSystem.bots) {
  botId = id;
  break;
}
if (!botId) {
  console.error('No bots');
  process.exit(1);
}

// Get weapon positions
const wps = [...(match.weaponPickups?.values?.() ?? match.weaponPickups ?? [])];
console.log(`Weapons: ${wps.length}`);
for (const wp of wps.slice(0, 3)) {
  console.log(
    `  ${wp.id} at (${wp.position.x},${wp.position.y}) active=${wp.isActive ?? !wp.isPickedUp}`,
  );
}

// Track bot position and goal every 3 ticks for 1800 ticks
let lastGoalType = '';
let lastDemoActive = false;
for (let i = 0; i < 60; i++) {
  await helper.advanceTicks(30);
  const ctx = botSystem.bots.get(botId)?.context;
  const player = match.players.get(botId);
  if (!ctx || !player) continue;

  const tick = match.tick;
  const goal = ctx.movementGoal;
  const demo = ctx.demolitionState;
  const health = player.health;
  const weapons = (player.inventory?.weapons ?? []).filter(
    (w: any) => w !== null && w !== undefined && w.type > 0,
  ).length;

  // Find nearest weapon
  let nearestWep = null;
  let nearestDist = Infinity;
  for (const wp of wps) {
    if (!wp.isActive && wp.isPickedUp) continue;
    const dx = wp.position.x - ctx.position.x;
    const dy = wp.position.y - ctx.position.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < nearestDist) {
      nearestDist = d;
      nearestWep = wp;
    }
  }

  const goalStr =
    goal.type !== 'NONE' && goal.target
      ? `${goal.type}(${Math.round(goal.target.x)},${Math.round(goal.target.y)})`
      : goal.type !== 'NONE'
        ? goal.type
        : 'none';
  const demoStr = demo.active
    ? `DEMO(${demo.targetGridX},${demo.targetGridY})h${demo.hitsCompleted}/${demo.totalHitsNeeded}`
    : 'off';
  const busyStr = ctx.busyUntilTick > tick ? 'BUSY' : '';

  // Log when near a weapon
  const marker = nearestDist < 100 ? ' *** NEAR WEAPON' : '';
  if (weapons > 0 || marker || demo.active !== lastDemoActive) {
    console.log(
      `t${tick} pos=(${Math.round(ctx.position.x)},${Math.round(ctx.position.y)}) hp=${health} weps=${weapons} goal=${goalStr} demo=${demoStr} ${busyStr} nearWep=${Math.round(nearestDist)}px${marker}`,
    );
  }

  if (weapons > 0) {
    console.log(`*** BOT GOT A WEAPON at tick ${tick}! ***`);
    break;
  }

  lastDemoActive = demo.active;
}

// Final
const finalPlayer = match.players.get(botId);
const finalWeps =
  finalPlayer?.inventory.weapons.filter((w: any) => w !== null && w.type > 0).length ?? 0;
console.log(`\nFinal: realWeapons=${finalWeps} health=${finalPlayer?.health}`);

await cleanup(server);
process.exit(0);

/**
 * Precise weapon pipeline diagnostic v2.
 * Tracks ONE bot tick-by-tick from spawn to weapon.
 * Verifies: pathfinder grid updates, movement commands, demolition progression.
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { advanceTicks, waitForPhase } from '../../packages/server/tests/helpers/test-utils';
import { GameRoom } from '../../packages/server/src/room/GameRoom';

async function main() {
  const server = await createTestServer();
  const { room, helper } = await createGameRoom(server, {
    mapType: 'demo',
    botFillTo: 2,
  });

  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator();

  // Force active phase
  await helper.addPlayer('tracker');
  await waitForPhase(room, 2);

  // Minimal warmup — just enough for bots to register
  await advanceTicks(room, 500);

  const botSystem = (gameRoom as any).simulation?.botSystem ?? (orch as any).simulation?.botSystem;
  if (!botSystem) {
    console.log('ERROR: no botSystem found');
    await cleanup(server);
    return;
  }

  const pathfinder = botSystem.pathfinder;
  const state = room.state;

  // Find all bots
  const bots: string[] = [];
  state.players.forEach((p: any, id: string) => {
    if (p.isBot) bots.push(id);
  });
  console.log(`Bots: ${bots.join(', ')}`);

  // Pick first bot and track it
  const botId = bots[0]!;
  const bot = state.players.get(botId) as any;

  console.log(`\nTracking bot ${botId} at (${bot.x.toFixed(0)}, ${bot.y.toFixed(0)})`);

  // Get weapon positions from map
  const weapons: Array<{ x: number; y: number; id: string }> = [];
  const wp = (state as any).weaponPickups;
  if (wp) {
    wp.forEach((w: any, id: string) => {
      weapons.push({ x: w.x, y: w.y, id });
    });
  }
  const activeWeapons = weapons.length;
  console.log(`Weapon pickups on map: ${weapons.length} (including inactive)`);
  weapons.slice(0, 5).forEach((w) => {
    const full = (state as any).weaponPickups.get(w.id);
    console.log(`  ${w.id}: (${w.x.toFixed(0)}, ${w.y.toFixed(0)}) active=${full?.isActive}`);
  });

  // Find nearest weapon to bot
  let nearestW = weapons[0];
  let nearestD = Infinity;
  for (const w of weapons) {
    const d = Math.sqrt((bot.x - w.x) ** 2 + (bot.y - w.y) ** 2);
    if (d < nearestD) {
      nearestD = d;
      nearestW = w;
    }
  }
  console.log(
    `Nearest weapon: (${nearestW!.x.toFixed(0)}, ${nearestW!.y.toFixed(0)}) dist=${nearestD.toFixed(0)}px`,
  );

  // Check pathfinding to weapon BEFORE any demolition
  const botGrid = pathfinder.worldToGrid({ x: bot.x, y: bot.y });
  const wpGrid = pathfinder.worldToGrid({ x: nearestW!.x, y: nearestW!.y });
  console.log(`\nBot grid: (${botGrid.x}, ${botGrid.y})  Weapon grid: (${wpGrid.x}, ${wpGrid.y})`);
  console.log(`Bot tile walkable: ${pathfinder.isWalkable(botGrid.x, botGrid.y)}`);
  console.log(`Weapon tile walkable: ${pathfinder.isWalkable(wpGrid.x, wpGrid.y)}`);

  // Try pathfinding
  const directPath = pathfinder.findPath(
    { x: bot.x, y: bot.y },
    { x: nearestW!.x, y: nearestW!.y },
  );
  console.log(`Direct path: ${directPath ? directPath.length + ' waypoints' : 'NULL'}`);

  // Try pathfinding through destructibles
  const destructMap = new Map<string, number>();
  const destructibles = (state as any).destructibles;
  if (destructibles) {
    destructibles.forEach((d: any, id: string) => {
      if (!d.isDestroyed && d.type !== 'iron') {
        const g = pathfinder.worldToGrid({ x: d.x, y: d.y });
        destructMap.set(`${g.x},${g.y}`, d.hp * 10);
      }
    });
  }
  console.log(`Destructible tiles in map: ${destructMap.size}`);
  const destructPath = pathfinder.findPathThroughDestructibles(
    { x: bot.x, y: bot.y },
    { x: nearestW!.x, y: nearestW!.y },
    destructMap,
  );
  console.log(`Destructible path: ${destructPath ? destructPath.length + ' waypoints' : 'NULL'}`);
  if (destructPath) {
    destructPath.forEach((p: any, i: number) => {
      const gx = Math.floor(p.x / 128);
      const gy = Math.floor(p.y / 128);
      const hasDest = destructMap.has(`${gx},${gy}`);
      console.log(`  waypoint ${i}: (${gx},${gy}) ${hasDest ? '💥 DESTRUCTIBLE' : 'walkable'}`);
    });
  }

  // Now track the bot for 2000 ticks, logging key events
  console.log(`\n=== Tracking ${botId} for 2000 ticks ===\n`);

  let prevX = bot.x,
    prevY = bot.y;
  let totalMoved = 0;
  let demolitionCount = 0;
  let lastDemoEndTick = -100;
  const destroyedTiles = new Set<string>();

  for (let t = 0; t < 2000; t++) {
    // Check if destructibles changed
    const preDestructCount = destructibles ? destructibles.size : 0;

    await advanceTicks(room, 1);

    const tick = room.state.tick;
    const bx = bot.x,
      by = bot.y;
    const moved = Math.sqrt((bx - prevX) ** 2 + (by - prevY) ** 2);
    totalMoved += moved;

    // Get bot entry for state
    const entry = botSystem.bots?.get(botId) ?? (botSystem as any).bots?.get(botId);
    if (!entry) continue;

    const ctx = entry.context;
    const demoState = ctx.demolitionState;
    const moveGoal = ctx.movementGoal;
    const behaviorName = ctx.lastBehaviorName;

    // Check if any destructible was destroyed this tick
    if (destructibles) {
      destructibles.forEach((d: any, id: string) => {
        const g = pathfinder.worldToGrid({ x: d.x, y: d.y });
        const key = `${g.x},${g.y}`;
        if (d.isDestroyed && !destroyedTiles.has(key)) {
          destroyedTiles.add(key);
          console.log(
            `TICK ${tick}: 💥 DESTROYED ${d.type} at grid (${g.x},${g.y}) world (${d.x.toFixed(0)},${d.y.toFixed(0)})`,
          );
          console.log(`  Grid walkable after destroy: ${pathfinder.isWalkable(g.x, g.y)}`);
          // Verify pathfinder can route through
          const tryPath = pathfinder.findPath({ x: bx, y: by }, { x: nearestW!.x, y: nearestW!.y });
          console.log(`  Path to weapon now: ${tryPath ? tryPath.length + ' waypoints' : 'NULL'}`);
        }
      });
    }

    // Log demolition state changes
    if (demoState.active) {
      if (t === 0 || lastDemoEndTick === tick - 1) {
        // Demolition just started
        console.log(
          `TICK ${tick}: 🔨 DEMOLITION START target=(${demoState.targetPosition?.x?.toFixed(0)},${demoState.targetPosition?.y?.toFixed(0)}) hp=${demoState.targetHp} id=${demoState.targetId?.slice(-5)}`,
        );
        console.log(
          `  Bot pos: (${bx.toFixed(0)},${by.toFixed(0)})  Move goal: ${moveGoal.type}→(${moveGoal.target?.x?.toFixed(0)},${moveGoal.target?.y?.toFixed(0)})`,
        );
      }
    }

    // Log key events every 100 ticks
    if (t % 100 === 0 && t > 0) {
      const path = pathfinder.findPath({ x: bx, y: by }, { x: nearestW!.x, y: nearestW!.y });
      console.log(
        `TICK ${tick}: pos=(${bx.toFixed(0)},${by.toFixed(0)}) moved=${totalMoved.toFixed(0)}px behavior=${behaviorName} demo=${demoState.active} goal=${moveGoal.type}→(${moveGoal.target?.x?.toFixed(0) ?? 'none'},${moveGoal.target?.y?.toFixed(0) ?? 'none'}) path=${path ? path.length + 'wp' : 'NULL'}`,
      );
      totalMoved = 0;
    }

    // Check if bot got a weapon
    const botWeapons = bot.weapons;
    let hasWeapon = false;
    botWeapons.forEach((w: any) => {
      if (w.type !== 0) hasWeapon = true;
    });
    if (hasWeapon) {
      console.log(`\n🎉 BOT GOT WEAPON at tick ${tick}!`);
      botWeapons.forEach((w: any, i: number) => {
        console.log(`  slot ${i}: type=${w.type} tier=${w.tier}`);
      });
      break;
    }

    // Check if bot died
    if (bot.health <= 0) {
      console.log(`\n💀 BOT DIED at tick ${tick}`);
      break;
    }

    prevX = bx;
    prevY = by;
  }

  // Final grid dump around weapon
  console.log(`\n=== Grid around weapon (${wpGrid.x},${wpGrid.y}) ===`);
  for (let dy = -3; dy <= 3; dy++) {
    let row = '';
    for (let dx = -3; dx <= 3; dx++) {
      const gx = wpGrid.x + dx;
      const gy = wpGrid.y + dy;
      const w = pathfinder.isWalkable(gx, gy);
      const d = destroyedTiles.has(`${gx},${gy}`);
      row += d ? '💥' : w ? '·' : '█';
    }
    console.log(`  ${row}`);
  }

  await cleanup(server);
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

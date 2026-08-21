/**
 * Diagnostic: Trace weapon acquisition pipeline for ONE bot
 * Tracks: pathfinding results, isStuck state, movement commands, demolition triggers
 */
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper.js';

const TICKS = 600;
const BOT_IDX = 0;

async function main() {
  const { room } = await createGameRoom({ mapType: 'demo' as any, botFillTo: 2 });
  await room.waitForTicks(450); // warmup

  const state = room.state as any;
  const players = Array.from(state.players.values()) as any[];
  const bot = players[BOT_IDX];
  if (!bot) {
    console.log('No bot found');
    process.exit(1);
  }

  // Inject a test-only hook into Navigation.isStuck
  const orch = (room as any).orchestrator;
  const sim = orch?.simulation;
  const botSystem = sim?.botSystem;

  if (!botSystem) {
    console.log('No botSystem');
    process.exit(1);
  }

  const entries = Array.from(botSystem.bots.values()) as any[];
  const entry = entries[BOT_IDX];
  if (!entry) {
    console.log('No bot entry');
    process.exit(1);
  }

  const nav = entry.navigation;
  const ctx = entry.context;

  // Track key state every 30 ticks
  for (let t = 0; t < TICKS; t += 30) {
    const tick = 450 + t;
    await room.waitForTicks(30);

    const pos = { x: bot.x, y: bot.y };
    const weps = Array.from(bot.weapons.values()).map((w: any) => w.type);
    const armed = weps.some((w: number) => w !== 0);
    const stuck = nav.isStuck(ctx);
    const goal = ctx.movementGoal;
    const path = ctx.pathToTarget;
    const demo = ctx.demolitionState?.active;
    const behavior = ctx.lastBehaviorName;

    // Check what nearbyItems contains
    const weapons = ctx.nearbyItems.filter((i: any) => i.type === 'weapon');
    const closestWeapon =
      weapons.length > 0
        ? weapons.reduce((best: any, w: any) => (w.distance < best.distance ? w : best), weapons[0])
        : null;

    console.log(
      `T${tick} | pos=(${Math.round(pos.x)},${Math.round(pos.y)}) armed=${armed} weps=[${weps}] stuck=${stuck} behavior=${behavior}`,
    );
    console.log(
      `      goal=${goal?.type}→(${Math.round(goal?.target?.x || 0)},${Math.round(goal?.target?.y || 0)}) path=${path?.length || 0}wp demo=${demo}`,
    );
    if (closestWeapon) {
      console.log(
        `      weapon@(${Math.round(closestWeapon.position.x)},${Math.round(closestWeapon.position.y)}) dist=${Math.round(closestWeapon.distance)}`,
      );
    }
    console.log(
      `      pathToTarget: ${path?.length > 0 ? path.map((p: any) => `(${Math.round(p.x)},${Math.round(p.y)})`).join('→') : 'empty'}`,
    );
  }

  await room.disconnect();
  process.exit(0);
}

main().catch(console.error);

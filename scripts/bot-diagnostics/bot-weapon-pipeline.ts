/**
 * Focused diagnostic: trace ONE bot's weapon acquisition pipeline.
 * Answers: Does the bot SEE weapons? Set movement goals? Trigger demolition?
 *         Does punching work? Does the path clear?
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';

const TICKS = 600;
const BOT_ID = 0;

async function main() {
  const { room } = await setupTestRoom({ mapType: 'demo' as any, botFillTo: 2 });

  // Force to active phase
  (room as any).state.phase = 2;
  const sim = (room as any).simulation;
  if (sim) sim.gamePhase = 2;

  // Warm up bots
  for (let i = 0; i < 450; i++) {
    sim?.tick?.();
    await new Promise((r) => setTimeout(r, 0));
  }

  const botSystem = sim?.botSystem;
  if (!botSystem) {
    console.log('ERROR: no botSystem');
    process.exit(1);
  }

  const entries = (botSystem as any).botEntries as Map<string, any>;
  const botEntry = Array.from(entries.values())[BOT_ID];
  if (!botEntry) {
    console.log('ERROR: no bot entry at index', BOT_ID);
    process.exit(1);
  }

  const ctx = botEntry.context;
  const player = botEntry.player;

  console.log('=== BOT WEAPON PIPELINE DIAGNOSTIC ===');
  console.log(`Bot position: (${ctx.position.x.toFixed(0)}, ${ctx.position.y.toFixed(0)})`);
  console.log(`Bot health: ${ctx.health}/${ctx.maxHealth}`);
  console.log(
    `Bot weapons: ${ctx.inventory.weapons.map((w: any) => `slot${w.type !== 0 ? '(type=' + w.type + ',tier=' + w.tier + ')' : '(fists)'}`).join(', ')}`,
  );
  console.log(
    `Movement goal: ${ctx.movementGoal?.type} target=${ctx.movementGoal?.target ? `(${ctx.movementGoal.target.x.toFixed(0)},${ctx.movementGoal.target.y.toFixed(0)})` : 'null'}`,
  );
  console.log(`Demolition state: ${JSON.stringify(ctx.demolitionState)}`);
  console.log(`Path to target: ${ctx.pathToTarget?.length ?? 0} waypoints`);
  if (ctx.pathToTarget?.length > 0) {
    console.log(
      `  Path[0]: (${ctx.pathToTarget[0].x.toFixed(0)}, ${ctx.pathToTarget[0].y.toFixed(0)})`,
    );
    console.log(
      `  Path[last]: (${ctx.pathToTarget[ctx.pathToTarget.length - 1].x.toFixed(0)}, ${ctx.pathToTarget[ctx.pathToTarget.length - 1].y.toFixed(0)})`,
    );
  }
  console.log(`nearbyItems: ${ctx.nearbyItems.length}`);
  ctx.nearbyItems.slice(0, 5).forEach((item: any, i: number) => {
    console.log(
      `  [${i}] ${item.type} tier=${item.tier} dist=${item.distance.toFixed(0)} pos=(${item.position.x.toFixed(0)},${item.position.y.toFixed(0)})`,
    );
  });
  console.log(`nearbyDestructibles: ${ctx.nearbyDestructibles.length}`);
  ctx.nearbyDestructibles.forEach((d: any, i: number) => {
    console.log(
      `  [${i}] ${d.type} hp=${d.hp}/${d.maxHp} dist=${d.distance.toFixed(0)} pos=(${d.position.x.toFixed(0)},${d.position.y.toFixed(0)})`,
    );
  });

  // Track key events during execution
  let weaponCount = ctx.inventory.weapons.filter((w: any) => w.type !== 0).length;
  let demolitionsStarted = 0;
  let demolitionsCompleted = 0;
  let goalsSet = 0;
  let lastBehavior = '';

  console.log('\n=== TICK-BY-TICK TRACE (first 150 ticks) ===');

  for (let t = 0; t < TICKS; t++) {
    const tick = sim.currentTick;
    const prevDemoState = { ...ctx.demolitionState };
    const prevGoalType = ctx.movementGoal?.type;
    const prevWepCount = ctx.inventory.weapons.filter((w: any) => w.type !== 0).length;

    sim.tick();

    const newWepCount = ctx.inventory.weapons.filter((w: any) => w.type !== 0).length;

    // Track behavior
    if (ctx.lastBehaviorName && ctx.lastBehaviorName !== lastBehavior) {
      lastBehavior = ctx.lastBehaviorName;
    }

    // Log important events
    if (t < 150) {
      const events: string[] = [];
      if (ctx.demolitionState.active && !prevDemoState.active) {
        events.push(
          `DEMOLITION_START: target=${ctx.demolitionState.targetId} pos=(${ctx.demolitionState.position?.x?.toFixed(0)},${ctx.demolitionState.position?.y?.toFixed(0)})`,
        );
        demolitionsStarted++;
      }
      if (!ctx.demolitionState.active && prevDemoState.active) {
        events.push('DEMOLITION_COMPLETE');
        demolitionsCompleted++;
      }
      if (ctx.movementGoal?.type === 'SEEK' && prevGoalType !== 'SEEK') {
        events.push(
          `GOAL_SET: seek(${ctx.movementGoal.target?.x?.toFixed(0)},${ctx.movementGoal.target?.y?.toFixed(0)}) radius=${ctx.movementGoal.arrivalRadius}`,
        );
        goalsSet++;
      }
      if (newWepCount > prevWepCount) {
        events.push(`WEAPON_ACQUIRED! count=${newWepCount}`);
      }
      if (ctx.lastBehaviorName !== 'none' && ctx.lastBehaviorName !== lastBehavior) {
        events.push(`BEHAVIOR: ${ctx.lastBehaviorName}`);
      }

      if (events.length > 0) {
        console.log(`[t=${t.toString().padStart(3)}] ${events.join(' | ')}`);
      }
    }
  }

  console.log('\n=== FINAL STATE ===');
  console.log(`Position: (${ctx.position.x.toFixed(0)}, ${ctx.position.y.toFixed(0)})`);
  console.log(
    `Weapons: ${ctx.inventory.weapons.map((w: any) => `type=${w.type},tier=${w.tier}`).join(' | ')}`,
  );
  console.log(`Health: ${ctx.health}/${ctx.maxHealth}`);
  console.log(`Demolitions started: ${demolitionsStarted}, completed: ${demolitionsCompleted}`);
  console.log(`Goals set: ${goalsSet}`);
  console.log(`Movement goal: ${ctx.movementGoal?.type}`);

  // Count weapons still on map
  const match = sim.match;
  const pickups = match?.getWeaponPickups?.();
  console.log(`Weapons on map: ${pickups?.length ?? 'unknown'}`);

  // Check pathfinder grid for weapon accessibility
  const pathfinder = botSystem.navigation?.pathfinder;
  if (pathfinder) {
    const items = ctx.nearbyItems.filter((i) => i.type === 'weapon');
    if (items.length > 0) {
      const weapon = items[0]!;
      const path = pathfinder.findPath(ctx.position, weapon.position);
      const destructMap = sim.buildDestructibleMap?.();
      const pathThruDest = destructMap
        ? pathfinder.findPathThroughDestructibles(ctx.position, weapon.position, destructMap)
        : null;
      console.log(`\nPath to nearest weapon (${weapon.distance.toFixed(0)}px):`);
      console.log(`  Normal path: ${path ? path.length + ' waypoints' : 'NULL (blocked)'}`);
      console.log(
        `  Destructible path: ${pathThruDest ? pathThruDest.length + ' waypoints' : 'NULL'}`,
      );
    }
  }

  await cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

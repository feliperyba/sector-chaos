/**
 * Multi-bot diagnostic: tracks ALL bots over full game session.
 * Reports per-bot: weapons acquired, demolition events, stuck ticks, goals.
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { advanceTicks } from '../../packages/server/tests/helpers/test-utils';

const BOT_COUNT = 5;
const SESSION_TICKS = 3600;

interface BotStat {
  id: string;
  startPos: { x: number; y: number };
  endPos: { x: number; y: number };
  totalMoved: number;
  weaponsGained: number;
  weaponsLost: number;
  demolitionEvents: number;
  stuckTicks: number;
  noneGoalTicks: number;
  seekGoalTicks: number;
  combatGoalTicks: number;
  busyTicks: number;
  survivalTicks: number;
  exploreTicks: number;
  behaviorsUsed: Record<string, number>;
  alive: boolean;
  rawWepEnd: number;
}

const server = await createTestServer();
const { room, helper } = await createGameRoom(server, {
  mapType: 'demo',
  botFillTo: BOT_COUNT + 1,
});

const client = await connectClient(server, room, { name: 'diag' } as any);
await room.waitForNextPatch();
await helper.advanceTicks(450); // warmup for bot spawns

const sim = (room as any).getOrchestrator?.()?.simulation;
if (!sim) {
  console.error('No simulation');
  process.exit(1);
}
const botSystem = sim?.botSystem;
if (!botSystem) {
  console.error('No botSystem');
  process.exit(1);
}

// Collect bot IDs
const botIds: string[] = [];
for (const [id, p] of (room.state as any).players) {
  if (p.isBot) botIds.push(id);
}
console.log(`Bots: ${botIds.length}`);

// Init stats
const stats = new Map<string, BotStat>();
let lastPositions = new Map<string, { x: number; y: number }>();
for (const id of botIds) {
  const entry = botSystem.bots?.get(id);
  const pos = entry?.context?.position ?? { x: 0, y: 0 };
  stats.set(id, {
    id,
    startPos: { ...pos },
    endPos: { ...pos },
    totalMoved: 0,
    weaponsGained: 0,
    weaponsLost: 0,
    demolitionEvents: 0,
    stuckTicks: 0,
    noneGoalTicks: 0,
    seekGoalTicks: 0,
    combatGoalTicks: 0,
    busyTicks: 0,
    survivalTicks: 0,
    exploreTicks: 0,
    behaviorsUsed: {},
    alive: true,
    rawWepEnd: -1,
  });
  lastPositions.set(id, { ...pos });
}

// Track weapon counts per bot
let lastWeaponCounts = new Map<string, number>();
for (const id of botIds) {
  const p = (room.state as any).players.get(id);
  lastWeaponCounts.set(
    id,
    (p?.weapons ?? []).filter((w: any) => w !== null && w !== undefined && w.weaponType > 0).length,
  );
}

// Run session in batches of 60 ticks
const BATCH = 60;
for (let batch = 0; batch < SESSION_TICKS / BATCH; batch++) {
  await helper.advanceTicks(BATCH);
  const tick = sim.currentTick ?? 0;

  for (const id of botIds) {
    const entry = botSystem.bots?.get(id);
    if (!entry) continue;
    const ctx = entry.context;
    const stat = stats.get(id)!;
    const p = (room.state as any).players.get(id);

    // Track movement
    const last = lastPositions.get(id)!;
    const dx = ctx.position.x - last.x;
    const dy = ctx.position.y - last.y;
    const moved = Math.sqrt(dx * dx + dy * dy);
    stat.totalMoved += moved;
    if (moved < 5) stat.stuckTicks += BATCH;
    lastPositions.set(id, { x: ctx.position.x, y: ctx.position.y });

    // Track health
    const health = p?.health ?? 0;
    if (health <= 0 && stat.alive) {
      stat.alive = false;
      console.error(
        `  [tick~${batch * BATCH}] Bot ${id.slice(-4)} DIED at (${Math.round(ctx.position.x)},${Math.round(ctx.position.y)}) health=${health}`,
      );
    }

    // Track goals
    if (ctx.movementGoal.type === 'NONE') stat.noneGoalTicks += BATCH;
    else if (ctx.movementGoal.type === 'SEEK') stat.seekGoalTicks += BATCH;
    else if (ctx.movementGoal.type === 'FLEE') stat.combatGoalTicks += BATCH;

    // Track busy
    if (ctx.busyUntilTick > tick) stat.busyTicks += BATCH;

    // Track demolition
    if (ctx.demolitionState.active) stat.demolitionEvents += BATCH;

    // Track weapon changes
    const wepCount = (p?.weapons ?? []).filter(
      (w: any) => w !== null && w !== undefined && w.weaponType > 0,
    ).length;
    const rawWepCount = p?.weapons?.length ?? -1;
    const lastWep = lastWeaponCounts.get(id) ?? 0;
    if (wepCount > lastWep) stat.weaponsGained += wepCount - lastWep;
    if (wepCount < lastWep) stat.weaponsLost += lastWep - wepCount;
    lastWeaponCounts.set(id, wepCount);

    // Track behavior name
    const bname = ctx.lastBehaviorName ?? 'unknown';
    stat.behaviorsUsed[bname] = (stat.behaviorsUsed[bname] ?? 0) + BATCH;
    if (bname === 'survival') stat.survivalTicks += BATCH;
    if (bname === 'explore' || bname === 'ExploreBehavior') stat.exploreTicks += BATCH;

    stat.endPos = { x: ctx.position.x, y: ctx.position.y };
    stat.alive = p?.health > 0;
    stat.rawWepEnd = rawWepCount;
  }
}

// Report
console.log('\n═══════════════════════════════════════════');
console.log('  MULTI-BOT DIAGNOSTIC REPORT');
console.log('═══════════════════════════════════════════');
for (const [id, s] of stats) {
  const total = SESSION_TICKS;
  const stuckPct = ((s.stuckTicks / total) * 100).toFixed(0);
  const nonePct = ((s.noneGoalTicks / total) * 100).toFixed(0);
  const seekPct = ((s.seekGoalTicks / total) * 100).toFixed(0);
  const busyPct = ((s.busyTicks / total) * 100).toFixed(0);
  const survPct = ((s.survivalTicks / total) * 100).toFixed(0);
  const demoPct = ((s.demolitionEvents / total) * 100).toFixed(0);
  const top3 = Object.entries(s.behaviorsUsed)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}=${((v / total) * 100).toFixed(0)}%`)
    .join(' ');

  console.log(
    `\nBot ${id.slice(-4)}: weps=+${s.weaponsGained}/-${s.weaponsLost} moved=${Math.round(s.totalMoved)}px alive=${s.alive}`,
  );
  console.log(
    `  rawWepEnd=${s.rawWepEnd} start=(${Math.round(s.startPos.x)},${Math.round(s.startPos.y)}) end=(${Math.round(s.endPos.x)},${Math.round(s.endPos.y)})`,
  );
  console.log(
    `  stuck=${stuckPct}% none=${nonePct}% seek=${seekPct}% busy=${busyPct}% survival=${survPct}% demo=${demoPct}%`,
  );
  console.log(`  behaviors: ${top3}`);
}

await cleanup(server);
process.exit(0);

/**
 * Zone-death diagnostic. Runs a fast-forward bot match and captures detailed
 * per-death telemetry for zone deaths: tick, phase, distance-to-center,
 * distance-as-fraction-of-radius, bot state, and the zone radius at death.
 *
 * Usage:
 *   npx tsx scripts/diag-zone-deaths.ts
 *
 * Env (all optional):
 *   BENCH_SEED=12345 BENCH_BOTS=63 BENCH_DURATION=600
 */
import { MatchPhase, NETWORK } from '@sector-battle/shared';
import type { GameRoom } from '../src/room/GameRoom.ts';
import type { GameStateSchema } from '../src/infrastructure/schemas/GameStateSchema.ts';
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';
import type { Room } from 'colyseus';

interface DeathTelemetry {
  tick: number;
  second: number;
  playerId: string;
  cause: string;
  x: number;
  y: number;
  zoneCenterX: number;
  zoneCenterY: number;
  zoneRadius: number;
  distToCenter: number;
  /** distToCenter / zoneRadius. >1.0 = outside the zone. */
  radiusFraction: number;
  phase: number;
  /** How much combat damage the bot took before dying (from match stats). */
  damageTaken: number;
  /** Whether the bot had a real weapon at death. */
  wasArmed: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const realDateNow = Date.now;

async function main() {
  const seed = parseInt(process.env.BENCH_SEED || '12345', 10);
  const bots = parseInt(process.env.BENCH_BOTS || '63', 10);
  const duration = parseInt(process.env.BENCH_DURATION || '600', 10);

  console.log(`\n=== Zone Death Diagnostic ===`);
  console.log(`seed=${seed}, bots=${bots}, duration=${duration}s\n`);

  const server = await createTestServer();

  // Create room with same config as benchmark
  const room: Room<{ state: GameStateSchema }> = await createRoom(server, {
    botFillTo: bots,
    botDifficulty: 'hard',
    mapType: 'procedural',
    seed,
  });
  room.autoDispose = false;

  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;

  // Wait for bots to spawn
  orch.setLastStandingThreshold(-1);
  const spawnStart = realDateNow();
  let count = orch.getMatch()?.players.size ?? 0;
  while (count < bots && realDateNow() - spawnStart < 30000) {
    await sleep(100);
    count = orch.getMatch()?.players.size ?? 0;
  }
  console.log(`Bots spawned: ${count}`);
  orch.setLastStandingThreshold(1);
  orch.start();

  // Virtual clock
  let virtualDate = realDateNow();
  let virtualPerf = virtualDate;
  const savedDateNow = globalThis.Date.now;
  const savedPerfNow = globalThis.performance.now;
  globalThis.Date.now = () => virtualDate;
  try {
    Object.defineProperty(globalThis.performance, 'now', {
      value: () => virtualPerf,
      writable: true,
      configurable: true,
    });
  } catch {
    (globalThis.performance as any).now = () => virtualPerf;
  }

  const totalTicks = Math.ceil(duration * NETWORK.TICK_RATE);
  const deaths: DeathTelemetry[] = [];

  for (let i = 0; i < totalTicks; i++) {
    virtualDate += NETWORK.TICK_INTERVAL;
    virtualPerf += NETWORK.TICK_INTERVAL;

    const tickEvents = orch.update(NETWORK.TICK_INTERVAL) as
      | Array<{ type: string; cause?: string; playerId?: string; x?: number; y?: number }>
      | undefined;

    if (tickEvents) {
      for (const e of tickEvents) {
        if (e.type !== 'PlayerEliminated') continue;

        // Get zone data at this tick
        const zoneData = orch.getZoneData?.();
        const phase = orch.getPhase?.() ?? 0;

        if (e.cause === 'zone_damage' || e.cause === 'zone' || e.cause === 'sudden_death') {
          const zx = zoneData?.centerX ?? 0;
          const zy = zoneData?.centerY ?? 0;
          const zr = zoneData?.currentRadius ?? 0;
          const dx = (e.x ?? 0) - zx;
          const dy = (e.y ?? 0) - zy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Look up player stats to see if they were already damaged by combat
          const player = orch.getMatch?.()?.players?.get(e.playerId ?? '');
          const dmgTaken = player?.damageTaken ?? 0;
          const weapons = player?.inventory?.weapons ?? [];
          const armed = weapons.some((w: any) => w !== null && w?.type !== 'FISTS');
          deaths.push({
            tick: i + 1,
            second: Math.round((i + 1) / NETWORK.TICK_RATE),
            playerId: e.playerId ?? '?',
            cause: e.cause ?? 'zone',
            x: e.x ?? 0,
            y: e.y ?? 0,
            zoneCenterX: zx,
            zoneCenterY: zy,
            zoneRadius: zr,
            distToCenter: Math.round(dist),
            radiusFraction: zr > 0 ? dist / zr : 0,
            phase: zoneData?.phase ?? 0,
            damageTaken: dmgTaken,
            wasArmed: armed,
          });
        }
      }
    }

    if (orch.getPhase() === MatchPhase.FINISHED) break;
  }

  // Restore time
  globalThis.Date.now = savedDateNow;
  try {
    Object.defineProperty(globalThis.performance, 'now', {
      value: savedPerfNow,
      writable: true,
      configurable: true,
    });
  } catch {
    (globalThis.performance as any).now = savedPerfNow;
  }

  await cleanup(server);

  // Analysis
  console.log(`\n=== ${deaths.length} Zone Deaths ===\n`);

  if (deaths.length === 0) {
    console.log('No zone deaths!');
    return;
  }

  // Group by phase
  const byPhase = new Map<number, DeathTelemetry[]>();
  for (const d of deaths) {
    const arr = byPhase.get(d.phase) ?? [];
    arr.push(d);
    byPhase.set(d.phase, arr);
  }

  console.log('Deaths by zone phase:');
  for (const [phase, ds] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    const avgFrac = ds.reduce((s, d) => s + d.radiusFraction, 0) / ds.length;
    const avgDist = ds.reduce((s, d) => s + d.distToCenter, 0) / ds.length;
    const avgRadius = ds.reduce((s, d) => s + d.zoneRadius, 0) / ds.length;
    console.log(
      `  Phase ${phase}: ${ds.length} deaths | avg dist=${Math.round(avgDist)}px ` +
        `avg radius=${Math.round(avgRadius)}px avg fraction=${avgFrac.toFixed(2)}x`,
    );
    // Show tick range
    const ticks = ds.map((d) => d.tick).sort((a, b) => a - b);
    const seconds = ds.map((d) => d.second).sort((a, b) => a - b);
    console.log(
      `    ticks ${ticks[0]}-${ticks[ticks.length - 1]} ` +
        `(seconds ${seconds[0]}-${seconds[seconds.length - 1]})`,
    );
  }

  // Deaths by second (histogram)
  console.log('\nDeaths by second:');
  const bySecond = new Map<number, number>();
  for (const d of deaths) {
    bySecond.set(d.second, (bySecond.get(d.second) ?? 0) + 1);
  }
  for (const [sec, cnt] of [...bySecond.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${sec}s: ${cnt} ${'█'.repeat(cnt)}`);
  }

  // Distance analysis: how far outside the zone were they?
  console.log('\nDistance outside zone at death:');
  const buckets = { '1.0-1.1x': 0, '1.1-1.3x': 0, '1.3-1.5x': 0, '1.5-2.0x': 0, '>2.0x': 0 };
  for (const d of deaths) {
    const f = d.radiusFraction;
    if (f < 1.1) buckets['1.0-1.1x']++;
    else if (f < 1.3) buckets['1.1-1.3x']++;
    else if (f < 1.5) buckets['1.3-1.5x']++;
    else if (f < 2.0) buckets['1.5-2.0x']++;
    else buckets['>2.0x']++;
  }
  for (const [bucket, cnt] of Object.entries(buckets)) {
    console.log(`  ${bucket}: ${cnt}`);
  }

  // Individual death details (first 20)
  console.log('\nIndividual deaths (first 20):');
  console.log(
    '  tick  | sec | ph | dist  | radius | frac | botX | botY | zCX  | zCY  | dmgTaken | armed | player',
  );
  for (const d of deaths.slice(0, 20)) {
    console.log(
      `  ${String(d.tick).padStart(5)} | ${String(d.second).padStart(3)} | ` +
        `${String(d.phase).padStart(2)} | ${String(d.distToCenter).padStart(5)} | ` +
        `${String(Math.round(d.zoneRadius)).padStart(6)} | ${d.radiusFraction.toFixed(2)} | ` +
        `${String(Math.round(d.x)).padStart(4)} | ${String(Math.round(d.y)).padStart(4)} | ` +
        `${String(Math.round(d.zoneCenterX)).padStart(4)} | ${String(Math.round(d.zoneCenterY)).padStart(4)} | ` +
        `${String(d.damageTaken).padStart(8)} | ${d.wasArmed ? 'Y' : 'n'}    | ${d.playerId.slice(-6)}`,
    );
  }

  // Summary: how many zone deaths were combat-softened (high damageTaken)?
  const softenedCount = deaths.filter((d) => d.damageTaken > 50).length;
  const freshCount = deaths.filter((d) => d.damageTaken <= 50).length;
  console.log(
    `\nZone death context: ${softenedCount} already damaged (>50 combat dmg), ${freshCount} fresh (≤50 dmg)`,
  );
  const armedCount = deaths.filter((d) => d.wasArmed).length;
  console.log(`Armed at death: ${armedCount}/${deaths.length}`);
}

main().catch((err) => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});

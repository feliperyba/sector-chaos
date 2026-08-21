/**
 * Weapon Pickup Diagnostic — traces pickup pipeline and death/weapon lifecycle
 * Usage: npx tsx packages/server/tests/integration/bot-ai/bot-pickup-diag.ts
 */
import {
  createTestServer,
  cleanup,
  connectClient,
  type ColyseusTestServer,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType } from '@sector-battle/shared';

const TICK_INTERVAL = 16;
const WARMUP_TICKS = 450;
const MEASURE_TICKS = 900;

function forceActivePhase(room: any): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  orch.match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server: ColyseusTestServer = await createTestServer();

  const { room, helper } = await createGameRoom(server, {
    botFillTo: 4,
    mapType: 'demo' as any,
  });
  const client = await connectClient(server, room, { name: 'Diag0' });
  await room.waitForNextPatch();

  await helper.advanceTicks(WARMUP_TICKS);
  forceActivePhase(room);

  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const simulation = orch.simulation as any;
  const match = orch.match as any;

  // Count initial weapons
  let initialWeaponCount = 0;
  if (match._weaponPickups) {
    match._weaponPickups.forEach(() => initialWeaponCount++);
  }

  console.log(`\n=== WEAPON PICKUP DIAGNOSTIC ===`);
  console.log(`Initial weapons on map: ${initialWeaponCount}`);

  // Track snapshots every 30 ticks
  interface BotSnap {
    id: string;
    weapons: number;
    hp: number;
    x: number;
    y: number;
    behavior: string;
  }
  const snapshots: Array<{ tick: number; bots: BotSnap[]; weaponsOnMap: number }> = [];

  let prevWeaponCounts = new Map<string, number>();
  let prevHp = new Map<number, number>();
  let totalPickups = 0;
  let totalDeaths = 0;
  let totalDrops = 0; // weapon drops from death

  // Initialize tracking
  const initPlayers = (match as any).players;
  if (initPlayers) {
    for (const [id, p] of initPlayers) {
      prevWeaponCounts.set(
        id,
        p.inventory?.weapons?.filter((w: any) => w.type !== WeaponType.FISTS).length ?? 0,
      );
      prevHp.set(id, p.health?.current ?? p.health ?? 100);
    }
  }

  for (let t = 0; t < MEASURE_TICKS; t++) {
    helper.advanceTick();

    const players = (match as any).players;
    if (!players) continue;

    let weaponsOnMap = 0;
    if (match._weaponPickups) {
      match._weaponPickups.forEach(() => weaponsOnMap++);
    }

    for (const [id, p] of players) {
      const realWeapons =
        p.inventory?.weapons?.filter((w: any) => w.type !== WeaponType.FISTS) ?? [];
      const prevCount = prevWeaponCounts.get(id) ?? 0;
      const hp = p.health?.current ?? p.health ?? 100;
      const prevHpVal = prevHp.get(id) ?? 100;

      // Pickup detected
      if (realWeapons.length > prevCount) {
        totalPickups++;
        console.log(
          `  [t=${t}] PICKUP: Bot ${id.slice(-4)} ${prevCount}→${realWeapons.length} weapons pos=(${Math.round(p.movement.position.x)},${Math.round(p.movement.position.y)})`,
        );
      }

      // Weapon lost (not from death — death would drop all)
      if (realWeapons.length < prevCount && hp > 0) {
        totalDrops++;
        console.log(
          `  [t=${t}] DROP: Bot ${id.slice(-4)} ${prevCount}→${realWeapons.length} weapons (alive, hp=${hp})`,
        );
      }

      // Death detected
      if (hp <= 0 && prevHpVal > 0) {
        totalDeaths++;
        const lostWeapons = prevCount;
        console.log(
          `  [t=${t}] DEATH: Bot ${id.slice(-4)} died with ${lostWeapons} weapons pos=(${Math.round(p.movement.position.x)},${Math.round(p.movement.position.y)})`,
        );
      }

      prevWeaponCounts.set(id, realWeapons.length);
      prevHp.set(id, hp);
    }

    // Snapshot every 30 ticks
    if (t % 30 === 0) {
      const bots: BotSnap[] = [];
      for (const [id, p] of players) {
        const realWeapons =
          p.inventory?.weapons?.filter((w: any) => w.type !== WeaponType.FISTS) ?? [];
        const botSystem = simulation.botSystem;
        const behavior = botSystem?._lastBehaviorName?.get(id) ?? 'none';
        bots.push({
          id,
          weapons: realWeapons.length,
          hp: p.health?.current ?? p.health ?? 0,
          x: Math.round(p.movement.position.x),
          y: Math.round(p.movement.position.y),
          behavior,
        });
      }
      snapshots.push({ tick: t, bots, weaponsOnMap });
    }
  }

  // Final summary
  console.log(`\n=== FINAL STATE ===`);
  const finalPlayers = (match as any).players;
  let totalWeaponsHeld = 0;
  let totalBots = 0;
  let aliveBots = 0;

  if (finalPlayers) {
    for (const [id, p] of finalPlayers) {
      const realWeapons =
        p.inventory?.weapons?.filter((w: any) => w.type !== WeaponType.FISTS) ?? [];
      totalWeaponsHeld += realWeapons.length;
      totalBots++;
      const hp = p.health?.current ?? p.health ?? 0;
      if (hp > 0) aliveBots++;
      console.log(
        `  Bot ${id.slice(-4)}: ${realWeapons.length} weapons HP=${hp} pos=(${Math.round(p.movement.position.x)},${Math.round(p.movement.position.y)})`,
      );
    }
  }

  let remainingWeapons = 0;
  if (match._weaponPickups) {
    match._weaponPickups.forEach(() => remainingWeapons++);
  }

  console.log(`\n=== LIFECYCLE ===`);
  console.log(`Bots: ${totalBots} (alive: ${aliveBots})`);
  console.log(`Total pickups: ${totalPickups}`);
  console.log(`Total deaths: ${totalDeaths}`);
  console.log(`Total weapon drops (alive): ${totalDrops}`);
  console.log(`Weapons held: ${totalWeaponsHeld}`);
  console.log(`Weapons on map: ${remainingWeapons}`);
  console.log(`Avg weapons/bot: ${totalBots > 0 ? (totalWeaponsHeld / totalBots).toFixed(2) : 0}`);

  // Timeline
  console.log(`\n=== TIMELINE ===`);
  for (const snap of snapshots) {
    const botStr = snap.bots
      .map((b) => `[${b.weapons}w ${b.hp}hp ${b.behavior?.slice(0, 4)}]`)
      .join(' ');
    console.log(`  t=${String(snap.tick).padStart(4)} map_w=${snap.weaponsOnMap} ${botStr}`);
  }

  await cleanup();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

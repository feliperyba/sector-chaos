import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType } from '@sector-battle/shared';
import type { GameMatch } from '../../packages/server/src/domain/aggregates/GameMatch';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';

const WARMUP = 450;
const MEASURE = 1800; // 30s

function forceActive(room: Room<any>) {
  const gr = room as unknown as GameRoom;
  const orch = gr.getOrchestrator() as any;
  const match = (gr.getOrchestrator() as any).match as any;
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.WAITING)
    orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server: ColyseusTestServer = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 4 });
    const client = await connectClient(server, room, { name: 'diag' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActive(room);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;

    if (!botSystem) {
      process.stderr.write('No bot system!\n');
      return;
    }

    // Track per-player health history
    const hpHistory: Map<string, number[]> = new Map();
    let totalAttacks = 0;
    let totalThrows = 0;
    let kills = 0;
    let lastHps: Map<string, number> = new Map();
    const damageEvents: {
      tick: number;
      attacker?: string;
      victim: string;
      dmg: number;
      fromHp: number;
      toHp: number;
    }[] = [];

    // Init tracking
    for (const [pid] of botSystem.bots as Map<string, any>) {
      const player = match.players.get(pid);
      const hp = player?.health?.current ?? 100;
      hpHistory.set(pid, [hp]);
      lastHps.set(pid, hp);
    }

    // Wrap tick to count actions
    const origTick = botSystem.tick.bind(botSystem);
    botSystem.tick = (tick: number): any => {
      const inputs = origTick(tick);
      if (inputs && Array.isArray(inputs)) {
        for (const inp of inputs) {
          if (inp.action === 1) totalAttacks++;
          if (inp.action === 2) totalThrows++;
        }
      }
      return inputs;
    };

    let prevTick = 0;
    for (let t = 0; t < MEASURE; t += 10) {
      await helper.advanceTicks(10);

      for (const [pid] of botSystem.bots as Map<string, any>) {
        const player = match.players.get(pid);
        if (!player) continue;
        const hp = player.health?.current ?? 0;
        const prevHp = lastHps.get(pid) ?? hp;

        if (hp < prevHp) {
          const dmg = prevHp - hp;
          damageEvents.push({
            tick: prevTick + t,
            victim: pid,
            dmg,
            fromHp: prevHp,
            toHp: hp,
          });
        }

        if (hp <= 0 && prevHp > 0) {
          kills++;
        }

        lastHps.set(pid, hp);
        const hist = hpHistory.get(pid) ?? [];
        hist.push(hp);
        hpHistory.set(pid, hist);
      }
      prevTick = t;
    }

    // Final report
    process.stderr.write('\n=== COMBAT DIAGNOSTIC REPORT ===\n');
    process.stderr.write(`Duration: ${MEASURE / 60}s | Bots: ${botSystem.bots.size}\n`);
    process.stderr.write(`Total Attacks: ${totalAttacks} | Total Throws: ${totalThrows}\n`);
    process.stderr.write(`Total Kills: ${kills}\n`);
    process.stderr.write(`Total Damage Events: ${damageEvents.length}\n`);

    const totalDamage = damageEvents.reduce((s, e) => s + e.dmg, 0);
    process.stderr.write(`Total Damage Dealt: ${totalDamage}\n`);

    if (damageEvents.length > 0) {
      const avgDmg = totalDamage / damageEvents.length;
      process.stderr.write(`Avg Damage/Hit: ${avgDmg.toFixed(1)}\n`);
      process.stderr.write(
        `Damage events per second: ${(damageEvents.length / (MEASURE / 60)).toFixed(1)}\n`,
      );
    }

    process.stderr.write('\n--- Per-Bot Summary ---\n');
    for (const [pid] of botSystem.bots as Map<string, any>) {
      const player = match.players.get(pid);
      const hp = player?.health?.current ?? 0;
      const alive = hp > 0;
      const weapons = player?.inventory?.weapons ?? [];
      const realWeapons = weapons.filter((w: any) => w && w.type !== WeaponType.FISTS);
      const wepTypes = realWeapons.map((w: any) => WeaponType[w.type]);
      const hist = hpHistory.get(pid) ?? [];
      const minHp = Math.min(...hist);
      const dmgTaken = hist[0]! - hp;

      // Count damage events for this bot
      const botDmgEvents = damageEvents.filter((e) => e.victim === pid);
      const botDmgTotal = botDmgEvents.reduce((s, e) => s + e.dmg, 0);

      process.stderr.write(
        `Bot ${pid.split('_').pop()}: hp=${hp} alive=${alive} ` +
          `weapons=[${wepTypes.join(',')}] ` +
          `dmgEvents=${botDmgEvents.length} dmgTaken=${botDmgTotal} minHp=${minHp}\n`,
      );
    }

    // Sample damage events
    if (damageEvents.length > 0) {
      process.stderr.write('\n--- First 20 Damage Events ---\n');
      for (const e of damageEvents.slice(0, 20)) {
        process.stderr.write(
          `  tick ${e.tick}: Bot ${e.victim.split('_').pop()} took ${e.dmg} (${e.fromHp}→${e.toHp})\n`,
        );
      }
    } else {
      process.stderr.write('\n*** ZERO DAMAGE EVENTS — attacks are not connecting! ***\n');
    }

    // Check barrier state — if bots have shields up, that blocks damage
    process.stderr.write('\n--- Barrier Check ---\n');
    for (const [pid] of botSystem.bots as Map<string, any>) {
      const player = match.players.get(pid);
      const barrier =
        (player as any)?.barrierActive ?? (player as any)?.shieldState?.active ?? false;
      const equippedType = player?.inventory?.weapons?.[player.inventory.activeSlot]?.type;
      process.stderr.write(
        `  Bot ${pid.split('_').pop()}: barrier=${barrier} equippedType=${equippedType ? WeaponType[equippedType] : 'none'}\n`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e}\n${e.stack}\n`);
  process.exit(1);
});

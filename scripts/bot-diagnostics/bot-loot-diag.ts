// Bot Looting Diagnostic — spawns items near bots and traces whether they pick them up
// Usage: npx tsx packages/server/tests/integration/bot-ai/bot-loot-diag.ts
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType, WeaponTier } from '@sector-battle/shared';
import { Destructible } from '../../packages/server/src/domain/entities/Destructible';
import { WeaponPickup } from '../../packages/server/src/domain/entities/WeaponPickup';
import { WeaponEntity } from '../../packages/server/src/domain/entities/Weapon';
import { Chest } from '../../packages/server/src/domain/entities/Chest';
import { ChestRarity } from '@sector-battle/shared';
import { Position } from '../../packages/server/src/domain/value-objects/Position';
import * as fs from 'fs';

const WARMUP = 450;
const MEASURE = 300;

function forceActivePhase(room: any): void {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const match = orch.match as any;
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, { botFillTo: 4, mapType: 'demo' as any });
    const client = await connectClient(server, room, { name: 'LootDiag' });
    await room.waitForNextPatch();

    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;
    const maps = match._maps;

    // Get bot positions
    const bots = botSystem.bots as Map<string, any>;
    console.log('\n=== BOT POSITIONS AFTER WARMUP ===');
    const botPositions: Record<string, { x: number; y: number }> = {};
    for (const [pid, entry] of bots) {
      const ctx = entry.context;
      botPositions[pid] = { x: ctx.position.x, y: ctx.position.y };
      console.log(
        `${pid}: (${ctx.position.x.toFixed(0)}, ${ctx.position.y.toFixed(0)}) hp=${ctx.health} weapons=${ctx.inventory.weapons.filter((w: any) => w.type !== 0).length}`,
      );
    }

    // Spawn items VERY CLOSE to each bot (within 100px)
    console.log('\n=== SPAWNING ITEMS NEAR BOTS ===');
    let i = 0;
    for (const [pid] of bots) {
      const pos = botPositions[pid]!;
      // Weapon 50px away
      const wpos = new Position(pos.x + 50, pos.y);
      const w = new WeaponEntity(
        `diag-w-${i}`,
        WeaponType.SHORT_SWORD,
        WeaponTier.COMMON,
        30,
        30,
        10,
      );
      const pickup = WeaponPickup.create(`diag-wp-${i}`, w, wpos, 0);
      maps.weaponPickups.set(pickup.id, pickup);
      console.log(
        `  Bot ${i}: weapon at (${wpos.x.toFixed(0)}, ${wpos.y.toFixed(0)}) — 50px from bot`,
      );

      // Crate 80px away
      const cpos = new Position(pos.x - 60, pos.y);
      const crate = Destructible.create(`diag-crate-${i}`, 'crate', cpos);
      maps.destructibles.set(crate.id, crate);
      console.log(
        `  Bot ${i}: crate at (${cpos.x.toFixed(0)}, ${cpos.y.toFixed(0)}) — 60px from bot`,
      );

      // Chest 100px away
      const chpos = new Position(pos.x, pos.y + 80);
      const chest = Chest.create(`diag-chest-${i}`, ChestRarity.COMMON, chpos);
      maps.chests.set(chest.id, chest);
      console.log(
        `  Bot ${i}: chest at (${chpos.x.toFixed(0)}, ${chpos.y.toFixed(0)}) — 80px from bot`,
      );
      i++;
    }

    // Count before
    const weaponsBefore = countActive(maps.weaponPickups);
    const cratesBefore = countAlive(maps.destructibles, 'crate');
    const chestsBefore = countClosedChests(maps.chests);

    // Tick and trace
    console.log('\n=== TICKING 300 TICKS ===');
    for (let t = 0; t < MEASURE; t += 50) {
      await helper.advanceTicks(50);

      // Log bot states
      for (const [pid, entry] of bots) {
        const ctx = entry.context;
        const weapons = ctx.inventory.weapons.filter((w: any) => w.type !== 0).length;
        const goal = ctx.movementGoal;
        const hasGoal = goal.type !== 'NONE';
        const dest = ctx.demolitionState;
        console.log(
          `  [t=${t + 50}] ${pid.slice(-5)}: pos=(${ctx.position.x.toFixed(0)},${ctx.position.y.toFixed(0)}) hp=${ctx.health} weapons=${weapons} goal=${hasGoal ? goal.type : 'NONE'} demo=${dest.active} behavior=${ctx.lastBehaviorName}`,
        );
      }

      // Count entities
      const weaponsNow = countActive(maps.weaponPickups);
      const cratesNow = countAlive(maps.destructibles, 'crate');
      const chestsNow = countClosedChests(maps.chests);
      console.log(
        `  [t=${t + 50}] ENTITIES: weapons=${weaponsNow} crates=${cratesNow} chests=${chestsNow}`,
      );
    }

    // Final counts
    const weaponsAfter = countActive(maps.weaponPickups);
    const cratesAfter = countAlive(maps.destructibles, 'crate');
    const chestsAfter = countClosedChests(maps.chests);

    console.log('\n=== RESULTS ===');
    console.log(
      `Weapons: ${weaponsBefore} → ${weaponsAfter} (picked up: ${weaponsBefore - weaponsAfter})`,
    );
    console.log(
      `Crates: ${cratesBefore} → ${cratesAfter} (destroyed: ${cratesBefore - cratesAfter})`,
    );
    console.log(`Chests: ${chestsBefore} → ${chestsAfter} (opened: ${chestsBefore - chestsAfter})`);

    // Bot final states
    for (const [pid, entry] of bots) {
      const ctx = entry.context;
      const weapons = ctx.inventory.weapons;
      const nonFist = weapons.filter((w: any) => w.type !== 0);
      console.log(`\n${pid}:`);
      console.log(`  Pos: (${ctx.position.x.toFixed(0)}, ${ctx.position.y.toFixed(0)})`);
      console.log(`  HP: ${ctx.health}`);
      console.log(
        `  Weapons: ${nonFist.length} (types: ${nonFist.map((w: any) => w.type).join(',')})`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

function countAlive(map: Map<string, any>, type: string): number {
  let c = 0;
  for (const [, d] of map) {
    if (!d.isDestroyed && d.type === type) c++;
  }
  return c;
}
function countActive(map: Map<string, any>): number {
  let c = 0;
  for (const [, p] of map) {
    if (p.isActive) c++;
  }
  return c;
}
function countClosedChests(map: Map<string, any>): number {
  let c = 0;
  for (const [, ch] of map) {
    if (ch.state === 'closed') c++;
  }
  return c;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Bot stuck diagnostic — identifies bots that idle excessively
// Usage: npx tsx packages/server/tests/integration/bot-ai/bot-stuck-diag.ts

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
import { Position } from '../../packages/server/src/domain/value-objects/Position';

const WARMUP = 450;
const MEASURE = 300;

const SPAWN_POSITIONS = [
  new Position(640, 640),
  new Position(1920, 640),
  new Position(1200, 1600),
  new Position(2000, 2000),
  new Position(1200, 1000),
  new Position(800, 1800),
];

async function main() {
  const server = await createTestServer();

  for (let run = 0; run < 5; run++) {
    const { room, helper } = await createGameRoom(server, { mapType: 'demo', botFillTo: 4 });

    // Get internals
    const gameRoom = room as unknown as GameRoom;
    const orchestrator = gameRoom.getOrchestrator() as any;

    // Connect 1 human client (bots auto-filled by botFillTo)
    const client = await connectClient(server, room);

    // Force active phase
    const match = orchestrator.match as any;
    const currentState = orchestrator.matchFlow.getCurrentState();
    if (currentState?.phase === 0) orchestrator.matchFlow.transitionTo(1);
    if (orchestrator.matchFlow.getCurrentState()?.phase === 1)
      orchestrator.matchFlow.transitionTo(2);
    orchestrator.phase = MatchPhase.ACTIVE;
    match.phase = MatchPhase.ACTIVE;

    // Wait for initial setup
    await helper.advanceTicks(10);

    // Now access match internals
    const maps = match._maps;
    if (!maps) {
      console.log('Skip run - no maps');
      continue;
    }
    const destructibles = maps.destructibles as Map<string, any>;
    const weaponPickups = maps.weaponPickups as Map<string, any>;

    // Spawn entities
    for (let i = 0; i < SPAWN_POSITIONS.length; i++) {
      const pos = SPAWN_POSITIONS[i]!;
      const crate = Destructible.create(`d-${run}-${i}`, 'crate', pos);
      destructibles.set(crate.id, crate);
    }
    const weaponTypes = [
      WeaponType.SPEAR,
      WeaponType.SHORT_SWORD,
      WeaponType.SHORT_BOW,
      WeaponType.LARGE_AXE,
      WeaponType.DAGGER,
      WeaponType.SMALL_SHIELD,
      WeaponType.CROSSBOW,
      WeaponType.LONG_SWORD,
    ];
    for (let i = 0; i < 12; i++) {
      const pos = SPAWN_POSITIONS[i % SPAWN_POSITIONS.length]!;
      const tier = i < 4 ? WeaponTier.COMMON : i < 8 ? WeaponTier.UNCOMMON : WeaponTier.RARE;
      const w = new WeaponEntity(
        `w-${run}-${i}`,
        weaponTypes[i % weaponTypes.length]!,
        tier,
        50,
        50,
        10,
      );
      const pickup = WeaponPickup.create(`wp-${run}-${i}`, w, pos, 0);
      weaponPickups.set(pickup.id, pickup);
    }

    // Warmup
    await helper.advanceTicks(WARMUP);

    const botSystem = (orchestrator.simulation as any).botSystem;
    if (!botSystem || !botSystem.bots) {
      console.log(`Run ${run + 1}: no botSystem`);
      continue;
    }
    console.log(`Run ${run + 1}: ${botSystem.bots.size} bots registered`);

    // Record spawn positions after warmup
    const spawnPositions: Record<string, { x: number; y: number }> = {};
    const botIds: string[] = [];
    for (const [id, entry] of botSystem.bots) {
      const pos = entry.context.position;
      spawnPositions[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
      botIds.push(id);
    }

    // Measure
    const positions: Record<string, Array<{ x: number; y: number }>> = {};
    const behaviors: Record<string, string[]> = {};
    for (const id of botIds) {
      positions[id] = [];
      behaviors[id] = [];
    }

    for (let t = 0; t < MEASURE; t++) {
      await helper.advanceTicks(1);
      for (const [id, entry] of botSystem.bots) {
        if (!positions[id]) continue;
        const pos = entry.context.position;
        positions[id]!.push({ x: pos.x, y: pos.y });
        behaviors[id]!.push(entry.context.lastBehaviorName || 'none');
      }
    }

    // Analyze stuck bots
    console.log(`\n=== Run ${run + 1} ===`);
    for (const id of botIds) {
      const pos = positions[id];
      const beh = behaviors[id];
      if (!pos || !beh || pos.length === 0) continue;

      const idle = beh.filter((b) => b === 'none').length;
      const totalDist = pos.slice(1).reduce((sum, p, i) => {
        const dx = p.x - pos[i]!.x;
        const dy = p.y - pos[i]!.y;
        return sum + Math.sqrt(dx * dx + dy * dy);
      }, 0);

      if (idle > MEASURE * 0.3 || totalDist < 500) {
        console.log(
          `STUCK Bot ${id.substring(0, 12)}: idle=${idle}/${MEASURE} dist=${totalDist.toFixed(0)}px spawn=(${spawnPositions[id]?.x},${spawnPositions[id]?.y})`,
        );
        for (let t = 0; t < pos.length; t += 50) {
          const p = pos[t]!;
          console.log(`  tick ${t}: (${Math.round(p.x)}, ${Math.round(p.y)}) beh=${beh[t]}`);
        }
      } else {
        console.log(`OK Bot ${id.substring(0, 12)}: idle=${idle} dist=${totalDist.toFixed(0)}px`);
      }
    }
  }

  await cleanup(server);
}

main().catch(console.error);

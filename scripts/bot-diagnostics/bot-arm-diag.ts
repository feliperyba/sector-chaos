// Diagnostic: Why do bots fail to arm? Trace the looting pipeline step by step.
// Usage: npx tsx packages/server/tests/integration/bot-ai/bot-arm-diag.ts

import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase } from '@sector-battle/shared';
import type { GameMatch } from '../../packages/server/src/domain/aggregates/GameMatch';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';

const WARMUP = 450;
const MEASURE = 300;

function forceActivePhase(room: Room<any>) {
  const gameRoom = room as unknown as GameRoom;
  const orch = gameRoom.getOrchestrator() as any;
  const match = (gameRoom.getOrchestrator() as any).match;
  const current = orch.matchFlow.getCurrentState().phase;
  if (current === MatchPhase.WAITING) orch.matchFlow.transitionTo(MatchPhase.COUNTDOWN);
  if (orch.matchFlow.getCurrentState().phase === MatchPhase.COUNTDOWN)
    orch.matchFlow.transitionTo(MatchPhase.ACTIVE);
  orch.phase = MatchPhase.ACTIVE;
  match.phase = MatchPhase.ACTIVE;
}

async function main() {
  const server: ColyseusTestServer = await createTestServer();
  try {
    const { room, helper } = await createGameRoom(server, {
      botFillTo: 4,
      mapType: 'demo' as any,
    });
    const client = await connectClient(server, room, { name: 'Armdiag' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActivePhase(room);

    const gameRoom = room as unknown as GameRoom;
    const orch = gameRoom.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const bots = botSystem.bots as Map<string, any>;

    // Snapshot initial state
    process.stderr.write('\n=== ARMING DIAGNOSTIC ===\n');
    for (const [pid, entry] of bots) {
      const idx = pid.split('_').pop();
      const inv = entry.context.inventory;
      process.stderr.write(
        `Bot ${idx}: pos=(${entry.context.position.x.toFixed(0)},${entry.context.position.y.toFixed(0)}) weps=${inv.weapons.length} activeSlot=${inv.activeSlot}\n`,
      );
    }

    // Tick 100 times, sampling every 10
    for (let i = 0; i < MEASURE; i++) {
      await helper.advanceTicks(1);
      if (i % 50 === 49) {
        process.stderr.write(`\n--- Tick ${i + 1} ---\n`);
        // Count weapons on the map
        const match = orch.match as GameMatch;
        const state = match.getState();
        const items = state.getItems();
        let weaponCount = 0;
        let chestCount = 0;
        for (const item of items) {
          if (item.type === 'weapon') weaponCount++;
          if (item.type === 'chest' || item.type === 'powerup') chestCount++;
        }
        process.stderr.write(`Map items: ${weaponCount} weapons, ${chestCount} chests/powerups\n`);

        for (const [pid, entry] of bots) {
          const idx = pid.split('_').pop();
          const ctx = entry.context;
          const inv = ctx.inventory;
          const wpnCount = inv.weapons.filter((w: any) => w).length;
          const behName = ctx.lastBehaviorName || 'none';
          const goal = ctx.movementGoal;
          const nearItems = ctx.nearbyItems?.length ?? 0;
          const goalType = goal?.type ?? 'none';
          process.stderr.write(
            `Bot ${idx}: hp=${ctx.health} weps=${wpnCount}(slot=${inv.activeSlot}) beh=${behName} goal=${goalType} nearItems=${nearItems} pos=(${ctx.position.x.toFixed(0)},${ctx.position.y.toFixed(0)})\n`,
          );

          // Check bot's perception of items
          if (wpnCount <= 1 && nearItems === 0) {
            const botIdx = parseInt(idx || '0');
            // How far to nearest weapon?
            let minDist = Infinity;
            for (const item of items) {
              if (item.type === 'weapon') {
                const dx = item.position.x - ctx.position.x;
                const dy = item.position.y - ctx.position.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < minDist) minDist = d;
              }
            }
            process.stderr.write(
              `  → nearest weapon: ${minDist.toFixed(0)}px (detection range: ${entry.context.nearbyItems?.length ?? 0} items detected)\n`,
            );
          }
        }
      }
    }

    // Final state
    process.stderr.write('\n=== FINAL STATE ===\n');
    for (const [pid, entry] of bots) {
      const idx = pid.split('_').pop();
      const ctx = entry.context;
      const inv = ctx.inventory;
      const wpnCount = inv.weapons.filter((w: any) => w).length;
      process.stderr.write(
        `Bot ${idx}: weps=${wpnCount} hp=${ctx.health} pos=(${ctx.position.x.toFixed(0)},${ctx.position.y.toFixed(0)})\n`,
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

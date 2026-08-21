import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import { GameRoom } from '../../packages/server/src/room/GameRoom';
import { MatchPhase, WeaponType, InputAction } from '@sector-battle/shared';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';

const WARMUP = 450;
const MEASURE = 3600; // 60s — match benchmark duration

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
    // Use demo map — same as benchmark default
    const { room, helper } = await createGameRoom(server, { botFillTo: 4, mapType: 'demo' });
    const client = await connectClient(server, room, { name: 'trace' });
    await room.waitForNextPatch();
    await helper.advanceTicks(WARMUP);
    forceActive(room);

    const gr = room as unknown as GameRoom;
    const orch = gr.getOrchestrator() as any;
    const sim = orch.simulation as any;
    const botSystem = sim.botSystem as any;
    const match = orch.match as any;

    // Track attacks
    const attackLog: Array<{
      tick: number;
      botId: string;
      aimAngle: number;
      posX: number;
      posY: number;
      slot: number;
    }> = [];
    const originalTick = botSystem.tick.bind(botSystem);
    botSystem.tick = function (tick: number) {
      const inputs = originalTick(tick);
      for (const input of inputs) {
        if (input.action === InputAction.ATTACK) {
          const player = match.players.get(input.playerId);
          if (player) {
            attackLog.push({
              tick,
              botId: input.playerId,
              aimAngle: input.data.aimAngle ?? 0,
              posX: player.movement.position.x,
              posY: player.movement.position.y,
              slot: player.inventory.activeSlot,
            });
          }
        }
      }
      return inputs;
    };

    // Hook Player.takeDamage
    const damageLog: Array<{ tick: number; targetId: string; damage: number; hpAfter: number }> =
      [];
    for (const [pid, player] of match.players) {
      const orig = player.takeDamage.bind(player);
      player.takeDamage = function (amount: number, tick: number, skipInvuln?: boolean) {
        const result = orig(amount, tick, skipInvuln);
        if (amount > 0) {
          damageLog.push({ tick, targetId: pid, damage: amount, hpAfter: player.health.current });
        }
        return result;
      };
    }

    // Run for 60s
    for (let t = 0; t < MEASURE; t += 120) {
      await helper.advanceTicks(120);
    }

    process.stderr.write(`\n=== DEMO MAP COMBAT DIAGNOSTIC ===\n`);
    process.stderr.write(`Total attacks: ${attackLog.length}\n`);
    process.stderr.write(`Total damage events: ${damageLog.length}\n`);
    const totalDamage = damageLog.reduce((s, d) => s + d.damage, 0);
    process.stderr.write(`Total damage: ${totalDamage}\n`);

    const botIds = [...botSystem.bots.keys()];
    for (let i = 0; i < botIds.length; i++) {
      const botId = botIds[i];
      const player = match.players.get(botId);
      if (!player) {
        process.stderr.write(`\nBot ${i}: DEAD\n`);
        continue;
      }
      const weapons =
        player.inventory?.weapons?.filter((w: any) => w).map((w: any) => WeaponType[w.type]) ?? [];
      const hp = player.health?.current ?? 0;
      const botAttacks = attackLog.filter((a) => a.botId === botId);
      const botDamage = damageLog
        .filter((d) => d.targetId === botId)
        .reduce((s, d) => s + d.damage, 0);
      process.stderr.write(
        `\nBot ${i}: hp=${hp} weapons=[${weapons.join(',')}] attacks=${botAttacks.length} dmgTaken=${botDamage}\n`,
      );

      // Show 10 sample attacks with nearest enemy info
      const step = Math.max(1, Math.floor(botAttacks.length / 10));
      for (let j = 0; j < botAttacks.length; j += step) {
        const atk = botAttacks[j]!;
        let nearestDist = Infinity;
        let nearestAngle = 0;
        let nearestId = '';
        for (const [pid, p] of match.players) {
          if (pid === botId || !p.isAlive()) continue;
          const dx = p.movement.position.x - atk.posX;
          const dy = p.movement.position.y - atk.posY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestAngle = Math.atan2(dy, dx);
            nearestId = pid;
          }
        }
        let angleDiff = atk.aimAngle - nearestAngle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        const angleDiffDeg = Math.abs((angleDiff * 180) / Math.PI);
        process.stderr.write(
          `  t=${atk.tick} aim=${atk.aimAngle.toFixed(2)} diff=${angleDiffDeg.toFixed(0)}° ` +
            `dist=${nearestDist.toFixed(0)}px slot=${atk.slot} target=${nearestId.slice(-4)}\n`,
        );
      }
    }

    process.stderr.write(`\n=== DAMAGE EVENTS (first 30) ===\n`);
    for (const d of damageLog.slice(0, 30)) {
      process.stderr.write(
        `  t=${d.tick} target=${d.targetId.slice(-6)} dmg=${d.damage} hpAfter=${d.hpAfter}\n`,
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

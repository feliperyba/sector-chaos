// Movement speed diagnostic — measure actual px/tick movement rate
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';

async function main() {
  const server = await createTestServer();
  try {
    const helper = await createGameRoom({ mapType: 'demo' });
    const room = helper.room as any;
    const client = await connectClient(helper.room);

    await helper.advanceTicks(450);
    helper.room.getOrchestrator().simulation.botSystem.forceActivePhase();
    await helper.advanceTicks(10);

    const botSystem = room.getOrchestrator().simulation.botSystem;
    const telemetry = botSystem.telemetry;

    // Pick first bot and trace position every tick
    const bots = botSystem.bots as Map<string, any>;
    const firstBot = bots.values().next().value;
    if (!firstBot) {
      console.log('No bots');
      return;
    }

    const pid = firstBot.playerId;
    const match = room.getOrchestrator().simulation.match;

    console.log('=== Movement Speed Trace ===');
    console.log('Bot:', pid);

    // Get initial position
    const player = match.state.players.get(pid);
    console.log('Start pos:', player?.position?.x, player?.position?.y);
    console.log('Base speed: 325px/s = 5.4px/tick at 60fps');
    console.log('AI tick interval: 3 (so move command every 3 game ticks)');
    console.log('');

    let prevX = player?.position?.x ?? 0;
    let prevY = player?.position?.y ?? 0;
    let totalDist = 0;
    let moveCommands = 0;

    for (let t = 0; t < 100; t++) {
      await helper.advanceTicks(1);

      const p = match.state.players.get(pid);
      if (!p) continue;

      const dx = p.position.x - prevX;
      const dy = p.position.y - prevY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      totalDist += dist;

      if (dist > 0.1) moveCommands++;

      if (t % 10 === 9) {
        console.log(
          `  t=${t + 450 + 10} pos=(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)}) Δ=${dist.toFixed(1)}px total=${totalDist.toFixed(0)}px`,
        );
      }

      prevX = p.position.x;
      prevY = p.position.y;
    }

    console.log('');
    console.log(`Total distance: ${totalDist.toFixed(0)}px over 100 ticks`);
    console.log(`Average speed: ${(totalDist / 100).toFixed(2)}px/tick`);
    console.log(`Expected: 5.4px/tick (base speed)`);
    console.log(`Move ticks (>0.1px): ${moveCommands}/100`);
    console.log(`Efficiency: ${((moveCommands / 100) * 100).toFixed(0)}% of ticks had movement`);

    // Check: what behavior is the bot running?
    const records = telemetry.getRecords().filter((r) => r.botId === pid);
    const behCounts: Record<string, number> = {};
    for (const r of records) {
      behCounts[r.behaviorName] = (behCounts[r.behaviorName] || 0) + 1;
    }
    console.log(`Behavior distribution:`, JSON.stringify(behCounts));

    // Check: what movement goal does the bot have?
    const lastRec = records[records.length - 1];
    if (lastRec) {
      console.log(
        `Last goal: ${lastRec.movementGoalType} target=(${lastRec.goalTargetX?.toFixed(0)},${lastRec.goalTargetY?.toFixed(0)})`,
      );
    }

    client.leave();
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

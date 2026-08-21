/**
 * Diagnostic: dump actual bot positions at measurement start to check distribution.
 */
import {
  createTestServer,
  cleanup,
  connectClient,
} from '../../packages/server/tests/helpers/test-server';
import { createGameRoom } from '../../packages/server/tests/helpers/game-room-helper';
import type { ColyseusTestServer } from '@colyseus/testing';

async function main() {
  const botCount = 64;
  const seed = 50481;
  const server: ColyseusTestServer = await createTestServer();
  try {
    const { room } = await createGameRoom(server, {
      botFillTo: botCount,
      mapType: undefined, // procedural
      seed,
    });
    const client = await connectClient(server, room, { name: 'SpawnTest' });
    await room.waitForNextPatch();

    // Wait for bots to spawn and match to start
    await new Promise((r) => setTimeout(r, 3000));

    const gameRoom = room as unknown as any;
    const orch = gameRoom.getOrchestrator();
    const match = orch.match;

    // Force active phase (same as benchmark)
    orch.setLastStandingThreshold(-1);
    (orch as any).matchEndedEmitted = false;
    orch.matchFlow.phase = 4; // ACTIVE
    orch.matchFlow.phaseElapsedMs = 0;
    match.forEachAlivePlayer((p: any) => {});

    // Dump all player positions
    const positions: { id: string; x: number; y: number }[] = [];
    match.forEachAlivePlayer((p: any) => {
      positions.push({
        id: p.id,
        x: Math.round(p.movement.position.x),
        y: Math.round(p.movement.position.y),
      });
    });

    const mapSize = 10240;
    const cx = mapSize / 2,
      cy = mapSize / 2;

    // 8x8 grid
    const bins = Array.from({ length: 8 }, () => Array(8).fill(0));
    for (const p of positions) {
      const bx = Math.min(7, Math.floor(p.x / (mapSize / 8)));
      const by = Math.min(7, Math.floor(p.y / (mapSize / 8)));
      bins[by][bx]++;
    }

    console.log(`\n=== ACTUAL BOT POSITIONS (${positions.length} bots) ===`);
    console.log(`8×8 grid (each cell = ${mapSize / 8}px):`);
    for (let r = 0; r < 8; r++) {
      console.log(`  ${bins[r]!.map((c) => String(c).padStart(2)).join(' ')}`);
    }

    // 4×4 sector grid
    const sectorBins = Array.from({ length: 4 }, () => Array(4).fill(0));
    for (const p of positions) {
      const sx = Math.min(3, Math.floor(p.x / (mapSize / 4)));
      const sy = Math.min(3, Math.floor(p.y / (mapSize / 4)));
      sectorBins[sy][sx]++;
    }
    console.log(`\n4×4 sector grid:`);
    for (let r = 0; r < 4; r++) {
      console.log(`  ${sectorBins[r]!.map((c) => String(c).padStart(2)).join(' ')}`);
    }

    // Distance analysis
    const dists = positions.map((p) => Math.round(Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2)));
    dists.sort((a, b) => a - b);
    const inZone = dists.filter((d) => d < 5120).length;
    const nearBorder = positions.filter(
      (p) => p.x < 512 || p.y < 512 || p.x > mapSize - 512 || p.y > mapSize - 512,
    ).length;

    console.log(
      `\nDist from center: min=${dists[0]}px max=${dists[dists.length - 1]}px median=${dists[Math.floor(dists.length / 2)]}px`,
    );
    console.log(`Inside zone radius (5120px): ${inZone}/${positions.length}`);
    console.log(`Within 512px of border: ${nearBorder}/${positions.length}`);

    // Check for clustering — pairs closer than 256px
    let clusterCount = 0;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const d = Math.sqrt(
          (positions[i]!.x - positions[j]!.x) ** 2 + (positions[i]!.y - positions[j]!.y) ** 2,
        );
        if (d < 256) clusterCount++;
      }
    }
    console.log(`\nClusters (pairs < 256px apart): ${clusterCount}`);
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(`FATAL: ${e}\n${e.stack}`);
  process.exit(1);
});

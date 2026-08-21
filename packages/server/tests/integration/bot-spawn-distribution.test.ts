import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { createTestServer, cleanup } from '../helpers/test-server';
import { createGameRoom } from '../helpers/game-room-helper';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema';
import { GameRoom } from '../../src/room/GameRoom';
import { GRID } from '@sector-battle/shared';

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await cleanup(server);
});

const MAP_SIZE = GRID.ARENA_WIDTH * GRID.TILE_SIZE; // 80 * 128 = 10240
const SECTOR_COUNT = GRID.SECTOR_GRID_SIZE * GRID.SECTOR_GRID_SIZE; // 4 * 4 = 16

describe('Bot Spawn Distribution — 64 players, 16 sectors', () => {
  it('all 64 players spawn at unique positions with no clustering', async () => {
    const { room } = await createGameRoom(server, {
      botFillTo: 64,
      seed: 42,
      matchId: `spawn-64-${Date.now()}`,
    });

    // BotManager spreads spawns over 5s (5000ms / count).
    // 64 bots → ~78ms interval. Wait 7s for all to register.
    await new Promise((r) => setTimeout(r, 7000));

    const orch = (room as unknown as GameRoom).getOrchestrator() as any;
    const match = orch.match;

    const positions: { id: string; x: number; y: number }[] = [];
    match.forEachAlivePlayer((p: any) => {
      positions.push({
        id: p.id,
        x: Math.round(p.movement.position.x),
        y: Math.round(p.movement.position.y),
      });
    });

    // Must have all 64 players
    expect(positions.length).toBe(64);

    // ── No duplicate positions ──
    const posKeys = new Set<string>();
    for (const p of positions) {
      const key = `${p.x},${p.y}`;
      expect(posKeys.has(key), `Duplicate position (${key}) for ${p.id}`).toBe(false);
      posKeys.add(key);
    }

    // ── No pairs closer than 256px ──
    let closePairs = 0;
    const closePairDetails: string[] = [];
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[i]!.x - positions[j]!.x;
        const dy = positions[i]!.y - positions[j]!.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 256) {
          closePairs++;
          if (closePairs <= 10) {
            closePairDetails.push(
              `  ${positions[i]!.id}(${positions[i]!.x},${positions[i]!.y}) ↔ ${positions[j]!.id}(${positions[j]!.x},${positions[j]!.y}) = ${dist.toFixed(0)}px`,
            );
          }
        }
      }
    }
    if (closePairDetails.length > 0) {
      console.log(`Close pairs (${closePairs} total, showing first 10):`);
      for (const d of closePairDetails) console.log(d);
    }
    expect(closePairs, `${closePairs} pairs closer than 256px`).toBe(0);

    // ── All 16 sectors occupied ──
    const sectorBins = Array.from({ length: 4 }, () => Array(4).fill(0));
    for (const p of positions) {
      const sx = Math.min(3, Math.floor(p.x / (MAP_SIZE / 4)));
      const sy = Math.min(3, Math.floor(p.y / (MAP_SIZE / 4)));
      sectorBins[sy]![sx]!++;
    }
    const occupiedSectors = sectorBins.flat().filter((c) => c > 0).length;
    expect(occupiedSectors, 'All 16 sectors must be occupied').toBe(SECTOR_COUNT);

    // ── Even distribution: no sector should be empty or overloaded ──
    // 64 / 16 = 4 expected per sector. Allow 1-8 range for jitter.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const count = sectorBins[r]![c]!;
        expect(
          count,
          `Sector [${r},${c}] has ${count} players (expected 1-8)`,
        ).toBeGreaterThanOrEqual(1);
        expect(count, `Sector [${r},${c}] has ${count} players (expected 1-8)`).toBeLessThanOrEqual(
          8,
        );
      }
    }

    console.log('4×4 sector distribution:');
    for (let r = 0; r < 4; r++) {
      console.log(`  [${sectorBins[r]!.map((c) => String(c).padStart(2)).join(' ')}]`);
    }

    room.disconnect();
  }, 30_000);
});

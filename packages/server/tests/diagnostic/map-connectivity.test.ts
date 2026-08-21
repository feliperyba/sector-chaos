import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus';
import { createTestServer, cleanup } from '../helpers/test-server.ts';
import { createGameRoom } from '../helpers/game-room-helper.ts';
import type { GameStateSchema } from '../../src/infrastructure/schemas/GameStateSchema.ts';
import type { GameRoom } from '../../src/room/GameRoom.ts';
import { MatchPhase } from '@sector-battle/shared';

const TICK_RATE = 60;
const TICK_INTERVAL = 1000 / TICK_RATE;

let server: ColyseusTestServer;
beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  cleanup(server);
});

function getOrch(room: Room<{ state: GameStateSchema }>) {
  return (room as unknown as GameRoom).getOrchestrator() as any;
}

const TILE_SYMBOLS: Record<number, string> = {
  0: '.', // EMPTY
  1: '#', // INDESTRUCTIBLE_WALL
  2: 'D', // DESTRUCTIBLE_WALL
  3: 'C', // CHEST
  4: 'E', // EXIT
  5: 'd', // DOOR_CLOSED
  6: 'c', // DESTRUCTIBLE_CRATE
  7: 'B', // DESTRUCTIBLE_BARREL
  8: 'I', // INDESTRUCTIBLE_CRATE
};

describe('diagnostic: map connectivity', () => {
  it('dumps the walkability grid and checks connectivity', async () => {
    const { room } = await createGameRoom(server, {
      botFillTo: 0,
      botDifficulty: 'hard',
      seed: 42,
      mapType: 'demo',
    });
    room.autoDispose = false;

    const orch = getOrch(room);
    const match = orch.getMatch();
    const mapGrid: number[][] = match.getGrid();

    console.log('\n========== MAP CONNECTIVITY DIAGNOSTIC ==========\n');

    const h = mapGrid.length;
    const w = mapGrid[0]!.length;
    console.log(`Map grid: ${w}x${h}`);
    console.log(`Tile size: 128px (world: ${w * 128}x${h * 128})\n`);

    // Dump the tile type grid
    console.log('--- Tile Type Grid ---');
    console.log(
      'Legend: .=EMPTY #=INDESTR_WALL D=DESTR_WALL C=CHEST E=EXIT d=DOOR c=DESTR_CRATE B=BARREL I=INDESTR_CRATE\n',
    );
    console.log('    ' + Array.from({ length: w }, (_, i) => (i % 10).toString()).join(''));
    for (let y = 0; y < h; y++) {
      const rowStr = mapGrid[y]!.map((t: number) => TILE_SYMBOLS[t] ?? '?').join('');
      console.log(`${y.toString().padStart(2)} |${rowStr}|`);
    }

    // Build walkability grid (same as createPathfinder)
    const walkable: boolean[][] = mapGrid.map((row: number[]) =>
      row.map((cell: number) => cell === 0 || cell === 4),
    );

    console.log('\n--- Walkability Grid (true=walkable) ---\n');
    console.log('    ' + Array.from({ length: w }, (_, i) => (i % 10).toString()).join(''));
    for (let y = 0; y < h; y++) {
      const rowStr = walkable[y]!.map((b: boolean) => (b ? ' ' : 'X')).join('');
      console.log(`${y.toString().padStart(2)} |${rowStr}|`);
    }

    // Find ALL disconnected walkable regions
    const visited = new Set<string>();
    const regions: Array<{ tiles: Array<[number, number]>; size: number }> = [];

    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        if (!walkable[sy]![sx]) continue;
        if (visited.has(`${sx},${sy}`)) continue;

        const regionTiles: Array<[number, number]> = [];
        const queue: Array<[number, number]> = [[sx, sy]];
        visited.add(`${sx},${sy}`);

        while (queue.length > 0) {
          const [x, y] = queue.shift()!;
          regionTiles.push([x, y]);
          const neighbors: Array<[number, number]> = [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
          ];
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const key = `${nx},${ny}`;
            if (visited.has(key)) continue;
            if (!walkable[ny]![nx]) continue;
            visited.add(key);
            queue.push([nx, ny]);
          }
        }
        regions.push({ tiles: regionTiles, size: regionTiles.length });
      }
    }

    regions.sort((a, b) => b.size - a.size);
    const totalWalkable = walkable.flat().filter((b: boolean) => b).length;
    console.log(`\n--- Connectivity ---`);
    console.log(`Total walkable tiles: ${totalWalkable}`);
    console.log(`Disconnected walkable regions: ${regions.length}`);
    console.log(`Largest region: ${regions[0]!.size} tiles`);
    if (regions.length > 1) {
      console.log(`\nRegion sizes: ${regions.map((r) => r.size).join(', ')}`);
    }

    // Visualize regions: largest = 'O', others = their index number
    if (regions.length > 1) {
      console.log(`\n--- Region Map (O=largest, !=pockets) ---\n`);
      console.log('    ' + Array.from({ length: w }, (_, i) => (i % 10).toString()).join(''));
      for (let y = 0; y < h; y++) {
        let rowStr = '';
        for (let x = 0; x < w; x++) {
          if (!walkable[y]![x]) {
            rowStr += 'X';
          } else {
            const regionIdx = regions.findIndex((r) =>
              r.tiles.some(([tx, ty]) => tx === x && ty === y),
            );
            rowStr += regionIdx === 0 ? 'O' : (regionIdx + 1).toString(16).toUpperCase();
          }
        }
        console.log(`${y.toString().padStart(2)} |${rowStr}|`);
      }
    }

    // List non-largest regions (pockets)
    if (regions.length > 1) {
      console.log(`\n--- Isolated Pockets (not connected to main region) ---`);
      for (let i = 1; i < regions.length; i++) {
        const r = regions[i]!;
        console.log(`  Pocket ${i}: ${r.size} tiles`);
        for (const [tx, ty] of r.tiles) {
          const tileType = mapGrid[ty]![tx];
          console.log(
            `    (${tx},${ty}) = pixel (${tx * 128},${ty * 128}) type=${tileType}(${TILE_SYMBOLS[tileType] ?? '?'})`,
          );
        }
        // What encloses this pocket?
        const pocketSet = new Set(r.tiles.map(([x, y]) => `${x},${y}`));
        const blockers = new Set<string>();
        for (const [x, y] of r.tiles) {
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ]) {
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (pocketSet.has(`${nx},${ny}`)) continue;
            if (walkable[ny]![nx]) continue;
            blockers.add(`(${nx},${ny})=${TILE_SYMBOLS[mapGrid[ny]![nx]!]}(${mapGrid[ny]![nx]})`);
          }
        }
        console.log(`    Enclosed by: ${[...blockers].join(', ')}`);
      }
    }

    // Dump spawn points
    const spawns = match.getSpawnPoints?.() ?? orch.match?.spawnPoints ?? [];
    if (spawns && spawns.length > 0) {
      console.log(`\n--- Spawn Points ---`);
      const mainRegionSet = new Set(regions[0]!.tiles.map(([x, y]) => `${x},${y}`));
      for (const sp of spawns) {
        const pos = sp.position ?? sp;
        const tileX = Math.round(pos.x / 128);
        const tileY = Math.round(pos.y / 128);
        const isReachable = mainRegionSet.has(`${tileX},${tileY}`);
        console.log(
          `  (${tileX},${tileY}) pixel(${pos.x},${pos.y}) priority=${sp.priority ?? '?'} reachable=${isReachable}`,
        );
      }
    }

    // Check specific stuck tiles (from symptom diagnostic, corrected for 128px tiles)
    const stuckCandidates = [
      { x: 8, y: 14, label: 'bot_5 stuck area' },
      { x: 2, y: 7, label: 'bot_3 stuck area' },
      { x: 19, y: 17, label: 'bot_1 stuck area' },
      { x: 3, y: 2, label: 'top-left pocket center' },
    ];
    console.log(`\n--- Stuck Tile Analysis ---`);
    const mainRegionSet2 = new Set(regions[0]!.tiles.map(([x, y]) => `${x},${y}`));
    for (const c of stuckCandidates) {
      if (c.x >= w || c.y >= h || c.x < 0 || c.y < 0) {
        console.log(`  ${c.label}: (${c.x},${c.y}) OUT OF BOUNDS`);
        continue;
      }
      const tileType = mapGrid[c.y]![c.x];
      const isWalkable = walkable[c.y]![c.x];
      const isInMain = mainRegionSet2.has(`${c.x},${c.y}`);
      console.log(`  ${c.label}:`);
      console.log(
        `    Tile (${c.x},${c.y}): type=${tileType}(${TILE_SYMBOLS[tileType] ?? '?'}) walkable=${isWalkable} inMainRegion=${isInMain}`,
      );

      const neighbors: Array<[number, number, string]> = [
        [c.x + 1, c.y, 'E'],
        [c.x - 1, c.y, 'W'],
        [c.x, c.y + 1, 'S'],
        [c.x, c.y - 1, 'N'],
      ];
      for (const [nx, ny, dir] of neighbors) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
          console.log(`    ${dir}: OUT OF BOUNDS`);
        } else {
          console.log(
            `    ${dir}: (${nx},${ny}) type=${mapGrid[ny]![nx]}(${TILE_SYMBOLS[mapGrid[ny]![nx]] ?? '?'}) walkable=${walkable[ny]![nx]} inMain=${mainRegionSet2.has(`${nx},${ny}`)}`,
          );
        }
      }
    }

    console.log('\n=======================================\n');
    expect(mapGrid).toBeDefined();
  }, 30000);
});

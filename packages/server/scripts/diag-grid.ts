/**
 * Dump the walkable grid and TileType grid around a weapon pickup vs a bot,
 * to understand why the weapon tile is in a different region than the bot.
 */
import { TileType } from '@sector-battle/shared';
import { createTestServer, createRoom, cleanup } from '../tests/helpers/test-server.ts';

interface CtxLike {
  x: number;
  y: number;
  nearestWeapon: { distance: number; x: number; y: number; id: string } | null;
}
interface PfLike {
  worldToGrid(p: { x: number; y: number }): { x: number; y: number };
  getGrid(): boolean[][];
  getTileSize(): number;
}
interface BotSystemLike {
  bots: Map<string, CtxLike>;
  pathfinder: PfLike;
}
interface MatchLike {
  weaponPickups: Map<string, { isActive: boolean; position: { x: number; y: number } }>;
  getGrid(): number[][];
}
interface OrchLike {
  getBotSystem(): BotSystemLike | null;
  getMatch(): MatchLike | undefined;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(deltaMs: number): unknown;
}
function asGameRoom(room: unknown): { getOrchestrator(): OrchLike } {
  return room as { getOrchestrator(): OrchLike };
}

const TILE_NAMES: Record<number, string> = {
  [TileType.EMPTY]: '.',
  [TileType.EXIT]: 'E',
};
function tileChar(t: number): string {
  return TILE_NAMES[t] ?? '#';
}

async function main() {
  const server = await createTestServer();
  try {
    const room = await createRoom(server, {
      botFillTo: 4,
      botDifficulty: 'hard',
      mapType: 'demo',
      seed: 12345,
    });
    room.autoDispose = false;
    const orch = asGameRoom(room).getOrchestrator();
    orch.setLastStandingThreshold(-1);
    const start = Date.now();
    while ((orch.getMatch()?.weaponPickups.size ?? -1) < 0 && Date.now() - start < 12000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // wait for bots
    const s2 = Date.now();
    while ((orch.getBotSystem()?.bots.size ?? 0) < 4 && Date.now() - s2 < 12000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    orch.setLastStandingThreshold(1);
    orch.start();
    const TICK = 1000 / 60;
    for (let i = 0; i < 60; i++) orch.update(TICK);

    const match = orch.getMatch()!;
    const pf = orch.getBotSystem()!.pathfinder;
    const grid = pf.getGrid();
    const tileGrid = match.getGrid();
    const ts = pf.getTileSize();
    const rows = grid.length;
    const cols = rows > 0 ? grid[0]!.length : 0;
    console.log(`grid: ${rows}x${cols}, tileSize=${ts}, map px = ${cols * ts}x${rows * ts}`);

    // count walkable tiles
    let walkable = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r]![c]) walkable++;
    console.log(
      `walkable tiles: ${walkable} / ${rows * cols} (${((walkable / (rows * cols)) * 100).toFixed(1)}%)`,
    );

    // TileType distribution
    const dist: Record<string, number> = {};
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const t = tileGrid[r]![c]!;
        dist[t] = (dist[t] ?? 0) + 1;
      }
    console.log('TileType distribution:', dist);

    // Pick a weapon pickup and dump its neighborhood
    let weaponPos: { x: number; y: number } | null = null;
    for (const [, wp] of match.weaponPickups) {
      if (wp.isActive) {
        weaponPos = { x: wp.position.x, y: wp.position.y };
        break;
      }
    }
    if (weaponPos) {
      const wgrid = pf.worldToGrid(weaponPos);
      const wx = wgrid.x,
        wy = wgrid.y;
      console.log(
        `\nWeapon at world(${Math.round(weaponPos.x)},${Math.round(weaponPos.y)}) grid(${wx},${wy}) walkable=${grid[wy]?.[wx]}`,
      );
      console.log('Neighborhood (TileType | walkable):');
      const R = 4;
      for (let dy = -R; dy <= R; dy++) {
        let line = '';
        for (let dx = -R; dx <= R; dx++) {
          const gx = wx + dx,
            gy = wy + dy;
          const t = tileGrid[gy]?.[gx];
          const w = grid[gy]?.[gx];
          if (t === undefined) line += '?';
          else if (w)
            line += '.'; // walkable
          else if (t === TileType.EMPTY || t === TileType.EXIT)
            line += '!'; // should be walkable but isn't?!
          else line += tileChar(t);
        }
        console.log(`  ${line}`);
      }
    }

    // A bot neighborhood
    const bots = orch.getBotSystem()!.bots;
    for (const [, ctx] of bots) {
      const bgrid = pf.worldToGrid({ x: ctx.x, y: ctx.y });
      console.log(
        `\nBot at world(${Math.round(ctx.x)},${Math.round(ctx.y)}) grid(${bgrid.x},${bgrid.y}) walkable=${grid[bgrid.y]?.[bgrid.x]}`,
      );
      break;
    }

    // Full grid dump: '.' walkable in main region, 'o' walkable but isolated, '#' wall
    // Recompute components manually to label them
    const componentId: Int32Array = new Int32Array(rows * cols).fill(-1);
    let comp = 0;
    const compSizes: number[] = [];
    for (let sy = 0; sy < rows; sy++) {
      for (let sx = 0; sx < cols; sx++) {
        if (!grid[sy]![sx]) continue;
        const idx = sy * cols + sx;
        if (componentId[idx] !== -1) continue;
        const id = comp++;
        let size = 0;
        const queue: Array<[number, number]> = [[sx, sy]];
        componentId[idx] = id;
        while (queue.length) {
          const [x, y] = queue.shift()!;
          size++;
          for (const d of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = x + d[0]!,
              ny = y + d[1]!;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            if (!grid[ny]![nx]) continue;
            const nidx = ny * cols + nx;
            if (componentId[nidx] !== -1) continue;
            componentId[nidx] = id;
            queue.push([nx, ny]);
          }
        }
        compSizes.push(size);
      }
    }
    // find largest component
    let mainId = 0;
    for (let i = 1; i < compSizes.length; i++) if (compSizes[i]! > compSizes[mainId]!) mainId = i;
    console.log(
      `\ncomponents: ${comp} total. sizes: ${JSON.stringify(compSizes)}. main=#${mainId} (${compSizes[mainId]} tiles)`,
    );

    console.log('\nFull grid (.=main walkable, o=isolated walkable, #=wall):');
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        if (!grid[r]![c]) {
          line += '#';
        } else if (componentId[r * cols + c] === mainId) {
          line += '.';
        } else {
          line += 'o';
        }
      }
      console.log(line);
    }

    // mark weapons on grid
    console.log('\nWeapon grid positions:');
    for (const [, wp] of match.weaponPickups) {
      if (!wp.isActive) continue;
      const g = pf.worldToGrid({ x: wp.position.x, y: wp.position.y });
      const cid = componentId[g.y * cols + g.x] ?? -1;
      console.log(
        `  world(${Math.round(wp.position.x)},${Math.round(wp.position.y)}) grid(${g.x},${g.y}) component=#${cid} ${cid === mainId ? 'MAIN' : 'ISOLATED'}`,
      );
    }
  } finally {
    await cleanup(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

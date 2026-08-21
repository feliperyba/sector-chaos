// Check if ANY weapon on the demo map is reachable without demolition
// from any spawn point.
import { resolve } from 'path';
import { TmxParser } from '../../packages/server/src/infrastructure/parsers/TmxParser.ts';
import { Pathfinder } from '../../packages/server/src/ai/navigation/Pathfinder.ts';
import { TileType } from '@sector-battle/shared';

const TILED_DIR = resolve(process.cwd(), 'tiled');
const parser = new TmxParser();
const data = parser.parse(resolve(TILED_DIR, 'demo_map.tmx'));

const grid = data.grid.map((row) =>
  row.map((cell) => cell === TileType.EMPTY || cell === TileType.EXIT),
);
const tileSize = data.tileSize;
const pf = new Pathfinder(grid, tileSize);

// Find spawn points (from buildSpawnPoints logic)
const spawnPoints = data.entities.spawnPoints;
const primarySpawn =
  spawnPoints.length > 0
    ? {
        x: spawnPoints[0]!.gridX * tileSize + tileSize / 2,
        y: spawnPoints[0]!.gridY * tileSize + tileSize / 2,
      }
    : { x: 11 * tileSize + tileSize / 2, y: 11 * tileSize + tileSize / 2 };
console.log('Primary spawn:', primarySpawn);

const spawns: { x: number; y: number }[] = [primarySpawn];
for (let y = 1; y < grid.length - 1; y += 4) {
  for (let x = 1; x < grid[0]!.length - 1; x += 4) {
    if (grid[y]?.[x]) {
      const sx = x * tileSize + tileSize / 2;
      const sy = y * tileSize + tileSize / 2;
      if (Math.hypot(sx - primarySpawn.x, sy - primarySpawn.y) > tileSize * 3) {
        spawns.push({ x: sx, y: sy });
      }
    }
  }
}
console.log(`Total spawn points: ${spawns.length}`);

// Find weapon tiles (tiles with IDs > some threshold that aren't walls/barrels)
// Weapon entities from the map data
const weapons = data.entities.weapons ?? [];
console.log(`Weapons on map: ${weapons.length}`);
if (weapons.length > 0) {
  for (const w of weapons) {
    console.log(
      `  Weapon at (${w.gridX}, ${w.gridY}) = pixel (${w.gridX * tileSize + tileSize / 2}, ${w.gridY * tileSize + tileSize / 2})`,
    );
  }
}

// Also check: are there any items in the open (on EMPTY tiles)?
let openWeapons = 0;
let enclosedWeapons = 0;
for (const w of weapons) {
  const wGrid = { x: w.gridX, y: w.gridY };
  let anyReachable = false;
  for (const sp of spawns) {
    const spGrid = { x: Math.floor(sp.x / tileSize), y: Math.floor(sp.y / tileSize) };
    if (spGrid.x === wGrid.x && spGrid.y === wGrid.y) continue;
    const path = pf.findPath(spGrid, wGrid);
    if (path && path.length > 0) {
      anyReachable = true;
      break;
    }
  }
  if (anyReachable) {
    openWeapons++;
    console.log(`  Weapon at (${w.gridX}, ${w.gridY}) is REACHABLE without demolition!`);
  } else {
    enclosedWeapons++;
  }
}

console.log(`\nReachable weapons: ${openWeapons}/${weapons.length}`);
console.log(`Enclosed weapons (need demolition): ${enclosedWeapons}/${weapons.length}`);

// What about the map structure - where ARE the empty corridors?
let emptyCount = 0;
for (let y = 0; y < grid.length; y++) {
  for (let x = 0; x < grid[y]!.length; x++) {
    if (grid[y]![x]!) emptyCount++;
  }
}
console.log(`\nWalkable tiles: ${emptyCount}/${grid.length * grid[0]!.length}`);

// Print connected components of walkable tiles
const visited = new Set<string>();
const components: { tiles: { x: number; y: number }[]; size: number }[] = [];
for (let y = 0; y < grid.length; y++) {
  for (let x = 0; x < grid[y]!.length; x++) {
    if (grid[y]![x]! && !visited.has(`${x},${y}`)) {
      // BFS
      const queue = [{ x, y }];
      const tiles: { x: number; y: number }[] = [];
      visited.add(`${x},${y}`);
      while (queue.length > 0) {
        const c = queue.shift()!;
        tiles.push(c);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = c.x + dx,
            ny = c.y + dy;
          const key = `${nx},${ny}`;
          if (
            nx >= 0 &&
            ny >= 0 &&
            ny < grid.length &&
            nx < grid[0]!.length &&
            grid[ny]![nx]! &&
            !visited.has(key)
          ) {
            visited.add(key);
            queue.push({ x: nx, y: ny });
          }
        }
      }
      components.push({ tiles, size: tiles.length });
    }
  }
}
components.sort((a, b) => b.size - a.size);
console.log(`\nConnected components (walkable): ${components.length}`);
for (const c of components.slice(0, 5)) {
  const minX = Math.min(...c.tiles.map((t) => t.x));
  const maxX = Math.max(...c.tiles.map((t) => t.x));
  const minY = Math.min(...c.tiles.map((t) => t.y));
  const maxY = Math.max(...c.tiles.map((t) => t.y));
  console.log(`  Component: ${c.size} tiles, bounds (${minX},${minY})-(${maxX},${maxY})`);

  // Check if any weapon is inside this component
  for (const w of weapons) {
    if (c.tiles.some((t) => t.x === w.gridX && t.y === w.gridY)) {
      console.log(`    → Contains weapon at (${w.gridX}, ${w.gridY})`);
    }
  }
}

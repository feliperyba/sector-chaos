/* Grid connectivity diagnostic for procedural map pathfinding.
 * Usage: npx tsx tests/integration/bot-ai/grid-diag.ts
 */
import { MapGenerator } from '../../packages/server/src/domain/services/MapGenerator.ts';
import { TileType } from '@sector-battle/shared';

const gen = new MapGenerator();

// Generate the map the same way the game does
const map = gen.generate({
  seed: 12345,
  sectorGridSize: 4,
  tileSize: 128,
});

const grid = map.grid;
const rows = grid.length;
const cols = grid[0]?.length ?? 0;

// Count tile types
const counts: Record<string, number> = {};
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    const t = TileType[grid[y]![x]!] ?? 'UNKNOWN';
    counts[t] = (counts[t] ?? 0) + 1;
  }
}

// Build walkable grid (EMPTY + EXIT only, same as pathfinder)
const walkable: boolean[][] = grid.map((row) =>
  row.map((cell) => cell === TileType.EMPTY || cell === TileType.EXIT),
);

// Also build a "destructible-aware" walkable grid (EMPTY + EXIT + destructibles)
const walkableWithDestructibles: boolean[][] = grid.map((row) =>
  row.map(
    (cell) =>
      cell === TileType.EMPTY ||
      cell === TileType.EXIT ||
      cell === TileType.DESTRUCTIBLE_WALL ||
      cell === TileType.DESTRUCTIBLE_CRATE ||
      cell === TileType.DESTRUCTIBLE_BARREL,
  ),
);

// Flood fill from center
function floodFill(walkableGrid: boolean[][], startX: number, startY: number): Set<string> {
  const visited = new Set<string>();
  const queue: [number, number][] = [[startX, startY]];
  visited.add(`${startX},${startY}`);
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const nx = cx + dx;
      const ny = cy + dy;
      const key = `${nx},${ny}`;
      if (
        nx >= 0 &&
        nx < cols &&
        ny >= 0 &&
        ny < rows &&
        !visited.has(key) &&
        walkableGrid[ny]![nx]!
      ) {
        visited.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  return visited;
}

// Find a walkable tile near center
const centerY = Math.floor(rows / 2);
const centerX = Math.floor(cols / 2);
let sx = -1,
  sy = -1;
for (let r = 0; r < 10 && sx === -1; r++) {
  for (let dy = -r; dy <= r && sx === -1; dy++) {
    for (let dx = -r; dx <= r && sx === -1; dx++) {
      const nx = centerX + dx;
      const ny = centerY + dy;
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && walkable[ny]![nx]!) {
        sx = nx;
        sy = ny;
      }
    }
  }
}

// Count total walkable
let totalWalkable = 0;
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    if (walkable[y]![x]!) totalWalkable++;
  }
}

let totalWalkableDestructible = 0;
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    if (walkableWithDestructibles[y]![x]!) totalWalkableDestructible++;
  }
}

const reachable = sx >= 0 ? floodFill(walkable, sx, sy) : new Set<string>();
const reachableDestructible =
  sx >= 0 ? floodFill(walkableWithDestructibles, sx, sy) : new Set<string>();

// Check for isolated walkable regions (4 corners)
const corners = [
  { name: 'top-left', x: 1, y: 1 },
  { name: 'top-right', x: cols - 2, y: 1 },
  { name: 'bottom-left', x: 1, y: rows - 2 },
  { name: 'bottom-right', x: cols - 2, y: rows - 2 },
];

const cornerReachability: Record<string, boolean> = {};
for (const c of corners) {
  // Find nearest walkable tile to corner
  let cx = -1,
    cy = -1;
  for (let r = 0; r < 10 && cx === -1; r++) {
    for (let dy = -r; dy <= r && cx === -1; dy++) {
      for (let dx = -r; dx <= r && cx === -1; dx++) {
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && walkable[ny]![nx]!) {
          cx = nx;
          cy = ny;
        }
      }
    }
  }
  if (cx >= 0) {
    cornerReachability[c.name] = reachable.has(`${cx},${cy}`);
  } else {
    cornerReachability[c.name] = false;
  }
}

// Print a small ASCII grid of the sector walls (every 2nd tile)
let asciiMap = '';
const stepY = Math.max(1, Math.floor(rows / 40));
const stepX = Math.max(1, Math.floor(cols / 80));
for (let y = 0; y < rows; y += stepY) {
  let line = '';
  for (let x = 0; x < cols; x += stepX) {
    const t = grid[y]![x]!;
    if (t === TileType.EMPTY) line += '.';
    else if (t === TileType.INDESTRUCTIBLE_WALL) line += '#';
    else if (t === TileType.DESTRUCTIBLE_WALL) line += '+';
    else if (t === TileType.DESTRUCTIBLE_CRATE) line += 'c';
    else if (t === TileType.DESTRUCTIBLE_BARREL) line += 'b';
    else if (t === TileType.EXIT) line += 'E';
    else line += '?';
  }
  asciiMap += line + '\n';
}

console.log('=== GRID DIAGNOSTIC ===');
console.log(
  JSON.stringify(
    {
      gridSize: `${cols}x${rows}`,
      totalTiles: cols * rows,
      tileCounts: counts,
      totalWalkable,
      totalWalkableWithDestructibles: totalWalkableDestructible,
      floodFillStart: sx >= 0 ? `${sx},${sy}` : 'none',
      reachableFromCenter: reachable.size,
      reachableWithDestructibles: reachableDestructible.size,
      connectivityPct:
        totalWalkable > 0 ? ((reachable.size / totalWalkable) * 100).toFixed(1) + '%' : '0%',
      connectivityWithDestructiblesPct:
        totalWalkableDestructible > 0
          ? ((reachableDestructible.size / totalWalkableDestructible) * 100).toFixed(1) + '%'
          : '0%',
      cornerReachability,
    },
    null,
    2,
  ),
);
console.log('\n=== ASCII MAP (#=wall, +=destr-wall, .=empty, c=crate, b=barrel) ===');
console.log(asciiMap);

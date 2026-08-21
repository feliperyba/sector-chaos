/* Sector pathfinding diagnostic.
 * Tests A* pathfinding between all sector pairs on the 4x4 map.
 * Usage: npx tsx tests/integration/bot-ai/sector-path-diag.ts
 */
import { MapGenerator } from '../../packages/server/src/domain/services/MapGenerator.ts';
import { Pathfinder } from '../../packages/server/src/ai/navigation/Pathfinder.ts';
import { TileType, TILE_PIXEL_SIZE } from '@sector-battle/shared';

const gen = new MapGenerator();
const map = gen.generate({
  seed: 12345,
  sectorGridSize: 4,
  tileSize: 128,
});

// Build pathfinder grid (same as game)
const grid = map.grid.map((row) =>
  row.map((cell) => cell === TileType.EMPTY || cell === TileType.EXIT),
);

const cols = grid[0]!.length;
const rows = grid.length;
const pf = new Pathfinder(grid, TILE_PIXEL_SIZE);

// Find walkable tile in each sector quadrant
const sectorSize = cols / 4; // 80 / 4 = 20
function findWalkableInSector(sRow: number, sCol: number): { x: number; y: number } | null {
  const startCol = sCol * sectorSize;
  const startRow = sRow * sectorSize;
  for (let dy = 2; dy < sectorSize - 2; dy++) {
    for (let dx = 2; dx < sectorSize - 2; dx++) {
      const gx = startCol + dx;
      const gy = startRow + dy;
      if (grid[gy]![gx]!) {
        return {
          x: gx * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
          y: gy * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
        };
      }
    }
  }
  return null;
}

// Get sector centers
const sectors: { name: string; pos: { x: number; y: number } }[] = [];
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < 4; c++) {
    const pos = findWalkableInSector(r, c);
    if (pos) {
      sectors.push({ name: `S${r}${c}`, pos });
    }
  }
}

console.log(`Found ${sectors.length} sector positions out of 16`);
console.log(`Grid: ${cols}x${rows}, tileSize: ${TILE_PIXEL_SIZE}\n`);

// Test pathfinding between all sector pairs (adjacent + diagonal + far)
let success = 0;
let fail = 0;
const failPairs: string[] = [];
const pathLengths: number[] = [];

for (let i = 0; i < sectors.length; i++) {
  for (let j = i + 1; j < sectors.length; j++) {
    const from = sectors[i]!.pos;
    const to = sectors[j]!.pos;

    // Test raw findPath
    const path = pf.findPath(from, to);
    if (path && path.length >= 2) {
      success++;
      pathLengths.push(path.length);

      // Also test smoothing
      const smoothed = pf.smoothPath(path);
      if (smoothed.length < 2) {
        console.log(
          `  ⚠ SMOOTHING FAIL: ${sectors[i]!.name}→${sectors[j]!.name}: smoothed to ${smoothed.length} waypoints`,
        );
      }
    } else {
      fail++;
      failPairs.push(`${sectors[i]!.name}→${sectors[j]!.name}`);

      // Diagnose: check if from/to are walkable
      const fromGrid = pf.worldToGrid(from);
      const toGrid = pf.worldToGrid(to);
      const fromWalkable = pf.isWalkable(fromGrid.x, fromGrid.y);
      const toWalkable = pf.isWalkable(toGrid.x, toGrid.y);
      console.log(
        `  ✗ PATH FAIL: ${sectors[i]!.name}→${sectors[j]!.name} | fromWalkable=${fromWalkable} toWalkable=${toWalkable}`,
      );
    }
  }
}

const avgPath =
  pathLengths.length > 0
    ? (pathLengths.reduce((a, b) => a + b, 0) / pathLengths.length).toFixed(1)
    : 'N/A';
const minPath = pathLengths.length > 0 ? Math.min(...pathLengths) : 'N/A';
const maxPath = pathLengths.length > 0 ? Math.max(...pathLengths) : 'N/A';

console.log(`\n=== RESULTS ===`);
console.log(`Success: ${success}/${success + fail}`);
console.log(`Failed: ${fail}`);
if (failPairs.length > 0) {
  console.log(`Failed pairs: ${failPairs.join(', ')}`);
}
console.log(`Path lengths: avg=${avgPath}, min=${minPath}, max=${maxPath}`);

// Test a specific cross-sector path and dump it
console.log(`\n=== SAMPLE PATH: S00→S33 (diagonal corner to corner) ===`);
const s00 = sectors.find((s) => s.name === 'S00');
const s33 = sectors.find((s) => s.name === 'S33');
if (s00 && s33) {
  const path = pf.findPath(s00.pos, s33.pos);
  if (path) {
    const smoothed = pf.smoothPath(path);
    console.log(`Raw path: ${path.length} waypoints`);
    console.log(`Smoothed: ${smoothed.length} waypoints`);
    // Print first 10 and last 5 waypoints
    console.log(`First waypoints:`);
    for (let i = 0; i < Math.min(10, smoothed.length); i++) {
      const wp = smoothed[i]!;
      const grid = pf.worldToGrid(wp);
      console.log(
        `  [${i}] world=(${wp.x.toFixed(0)},${wp.y.toFixed(0)}) grid=(${grid.x},${grid.y}) walkable=${pf.isWalkable(grid.x, grid.y)}`,
      );
    }
  } else {
    console.log('FAILED!');
  }
}

// Test what happens with non-walkable targets (random wander positions)
console.log(`\n=== RANDOM TARGET TEST (simulating smartWander) ===`);
let randomSuccess = 0;
let randomFail = 0;
const testCenter = sectors[Math.floor(sectors.length / 2)]!.pos;
const EXPLORE_RADIUS = 15 * TILE_PIXEL_SIZE; // 1920px
for (let i = 0; i < 100; i++) {
  const angle = Math.random() * Math.PI * 2;
  const dist = TILE_PIXEL_SIZE + Math.random() * (EXPLORE_RADIUS - TILE_PIXEL_SIZE);
  const candidate = {
    x: testCenter.x + Math.cos(angle) * dist,
    y: testCenter.y + Math.sin(angle) * dist,
  };

  // Clamp to map bounds
  const maxX = (cols - 1) * TILE_PIXEL_SIZE;
  const maxY = (rows - 1) * TILE_PIXEL_SIZE;
  if (candidate.x < 0 || candidate.x > maxX || candidate.y < 0 || candidate.y > maxY) {
    randomFail++;
    continue;
  }

  const path = pf.findPath(testCenter, candidate);
  if (path && path.length >= 2) {
    randomSuccess++;
  } else {
    randomFail++;
    // Check if candidate is on walkable tile
    const candGrid = pf.worldToGrid(candidate);
    if (!pf.isWalkable(candGrid.x, candGrid.y)) {
      // Try snapping
      const snapped = pf.gridToWorld({ x: candGrid.x, y: candGrid.y });
    }
  }
}
console.log(`Random targets: ${randomSuccess} success, ${randomFail} fail out of 100`);

// Test pathfinding from edge positions (where bots might get stuck)
console.log(`\n=== EDGE POSITION TEST ===`);
const edgeTests = [
  { name: 'near horizontal wall', x: 40 * TILE_PIXEL_SIZE, y: 10 * TILE_PIXEL_SIZE },
  { name: 'near vertical wall', x: 20 * TILE_PIXEL_SIZE, y: 40 * TILE_PIXEL_SIZE },
  { name: 'in doorway', x: 20 * TILE_PIXEL_SIZE, y: 10 * TILE_PIXEL_SIZE },
];
for (const edge of edgeTests) {
  const fromGrid = pf.worldToGrid({ x: edge.x, y: edge.y });
  const walkable = pf.isWalkable(fromGrid.x, fromGrid.y);
  const target = sectors.find((s) => s.name === 'S33');
  if (target) {
    const path = pf.findPath({ x: edge.x, y: edge.y }, target.pos);
    console.log(
      `${edge.name} (${edge.x},${edge.y}) grid=(${fromGrid.x},${fromGrid.y}) walkable=${walkable} path=${path ? path.length + 'wps' : 'NULL'}`,
    );
  }
}

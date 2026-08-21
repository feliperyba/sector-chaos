/* Verify that snapToWalkable fixes the 58% random target failure rate.
 * Usage: npx tsx tests/integration/bot-ai/snap-verify.ts
 */
import { MapGenerator } from '../../packages/server/src/domain/services/MapGenerator.ts';
import { Pathfinder } from '../../packages/server/src/ai/navigation/Pathfinder.ts';
import { TileType, TILE_PIXEL_SIZE } from '@sector-battle/shared';

const gen = new MapGenerator();
const map = gen.generate({ seed: 12345, sectorGridSize: 4, tileSize: 128 });

const grid = map.grid.map((row: TileType[]) =>
  row.map((cell: TileType) => cell === TileType.EMPTY || cell === TileType.EXIT),
);

const cols = grid[0]!.length;
const rows = grid.length;
const pf = new Pathfinder(grid, TILE_PIXEL_SIZE);

// Replicate snapToWalkable logic
function snapToWalkable(
  pos: { x: number; y: number },
  maxRadius: number,
): { x: number; y: number } | null {
  const gx = Math.floor(pos.x / TILE_PIXEL_SIZE);
  const gy = Math.floor(pos.y / TILE_PIXEL_SIZE);
  if (grid[gy]![gx]!) return pos;
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = gx + dx;
        const ny = gy + dy;
        if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && grid[ny]![nx]!) {
          return {
            x: nx * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
            y: ny * TILE_PIXEL_SIZE + TILE_PIXEL_SIZE / 2,
          };
        }
      }
    }
  }
  return null;
}

// Find a center-ish walkable position
const centerPos = { x: 40 * TILE_PIXEL_SIZE, y: 40 * TILE_PIXEL_SIZE };
const EXPLORE_RADIUS = 15 * TILE_PIXEL_SIZE;

let rawSuccess = 0;
let rawFail = 0;
let snapSuccess = 0;
let snapFail = 0;
let snapNullCount = 0;
const snapDistances: number[] = [];

for (let i = 0; i < 500; i++) {
  const angle = Math.random() * Math.PI * 2;
  const dist = TILE_PIXEL_SIZE + Math.random() * (EXPLORE_RADIUS - TILE_PIXEL_SIZE);
  const candidate = {
    x: centerPos.x + Math.cos(angle) * dist,
    y: centerPos.y + Math.sin(angle) * dist,
  };

  // Clamp to map bounds
  const maxX = (cols - 1) * TILE_PIXEL_SIZE;
  const maxY = (rows - 1) * TILE_PIXEL_SIZE;
  if (candidate.x < 0 || candidate.x > maxX || candidate.y < 0 || candidate.y > maxY) {
    rawFail++;
    snapFail++;
    continue;
  }

  // Raw findPath (no snap)
  const rawPath = pf.findPath(centerPos, candidate);
  if (rawPath && rawPath.length >= 2) rawSuccess++;
  else rawFail++;

  // With snap
  const snapped = snapToWalkable(candidate, 8);
  if (!snapped) {
    snapNullCount++;
    snapFail++;
    continue;
  }

  // Measure snap distance
  const snapDist = Math.sqrt((snapped.x - candidate.x) ** 2 + (snapped.y - candidate.y) ** 2);
  snapDistances.push(snapDist);

  const snapPath = pf.findPath(centerPos, snapped);
  if (snapPath && snapPath.length >= 2) snapSuccess++;
  else snapFail++;
}

const avgSnapDist =
  snapDistances.length > 0
    ? (snapDistances.reduce((a, b) => a + b, 0) / snapDistances.length / TILE_PIXEL_SIZE).toFixed(2)
    : 'N/A';

console.log('=== RAW (no snapping) ===');
console.log(
  `Success: ${rawSuccess}/${rawSuccess + rawFail} (${((rawSuccess / (rawSuccess + rawFail)) * 100).toFixed(1)}%)`,
);
console.log(`Fail: ${rawFail}`);

console.log('\n=== WITH SNAP (radius=8) ===');
console.log(
  `Success: ${snapSuccess}/${snapSuccess + snapFail} (${((snapSuccess / (snapSuccess + snapFail)) * 100).toFixed(1)}%)`,
);
console.log(`Fail: ${snapFail}`);
console.log(`Snap returned null (no walkable within r=8): ${snapNullCount}`);
console.log(`Average snap distance: ${avgSnapDist} tiles`);

// Also test: how many candidates were on walkable tiles vs needed snapping?
let onWalkable = 0;
let neededSnap = 0;
for (let i = 0; i < 500; i++) {
  const angle = Math.random() * Math.PI * 2;
  const dist = TILE_PIXEL_SIZE + Math.random() * (EXPLORE_RADIUS - TILE_PIXEL_SIZE);
  const cx = Math.floor((centerPos.x + Math.cos(angle) * dist) / TILE_PIXEL_SIZE);
  const cy = Math.floor((centerPos.y + Math.sin(angle) * dist) / TILE_PIXEL_SIZE);
  if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) {
    if (grid[cy]![cx]!) onWalkable++;
    else neededSnap++;
  }
}
console.log(`\n=== TILE DISTRIBUTION ===`);
console.log(`Candidates on walkable tiles: ${onWalkable}`);
console.log(`Candidates needing snap: ${neededSnap}`);

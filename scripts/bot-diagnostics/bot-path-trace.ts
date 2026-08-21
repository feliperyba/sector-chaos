// Trace a single bot's path from spawn to weapon room wall
import { resolve } from 'path';
import { TmxParser } from '../../packages/server/src/infrastructure/parsers/TmxParser.ts';
import { Pathfinder } from '../../packages/server/src/ai/navigation/Pathfinder.ts';
import { TileType } from '@sector-battle/shared';

const parser = new TmxParser();
const data = parser.parse(resolve(process.cwd(), 'tiled/demo_map.tmx'));
const grid = data.grid.map((row) =>
  row.map((cell) => cell === TileType.EMPTY || cell === TileType.EXIT),
);
const tileSize = data.tileSize;
const pf = new Pathfinder(grid, tileSize);

// Bot spawns at primary spawn: (960, 832) → grid (7.5, 6.5)
// Weapon at (192, 192) → grid (1.5, 1.5)
const botGrid = { x: 7, y: 6 }; // Math.floor of spawn
const weaponGrid = { x: 1, y: 1 };

console.log(
  `Bot at grid (${botGrid.x},${botGrid.y}), walkable: ${pf.isWalkable(botGrid.x, botGrid.y)}`,
);
console.log(
  `Weapon at grid (${weaponGrid.x},${weaponGrid.y}), walkable: ${pf.isWalkable(weaponGrid.x, weaponGrid.y)}`,
);

// Regular path (no demolition)
console.log('\n--- Regular pathfinding ---');
const regularPath = pf.findPath(botGrid, weaponGrid);
console.log(`Path found: ${regularPath ? regularPath.length : 'null'}`);

// Path through destructibles
console.log('\n--- Pathfinding through destructibles ---');
const destrPath = pf.findPathThroughDestructibles(botGrid, weaponGrid, []);
console.log(`Path found: ${destrPath ? destrPath.length : 'null'}`);
if (destrPath) {
  for (let i = 0; i < destrPath.length; i++) {
    const p = destrPath[i]!;
    const walkable = pf.isWalkable(p.x, p.y);
    const tile = data.grid[p.y]?.[p.x];
    const tileName =
      tile === TileType.EMPTY
        ? '.'
        : tile === TileType.INDESTRUCTIBLE_WALL
          ? 'I'
          : tile === TileType.DESTRUCTIBLE_WALL
            ? 'W'
            : tile === TileType.DESTRUCTIBLE_BARREL
              ? 'B'
              : tile === TileType.DESTRUCTIBLE_CRATE
                ? 'C'
                : tile === TileType.INDESTRUCTIBLE_CRATE
                  ? 'i'
                  : `${tile}`;
    console.log(`  waypoint ${i}: (${p.x},${p.y}) = ${tileName} walkable=${walkable}`);
  }
}

// What about a closer wall? (6,5) is a destructible wall
console.log('\n--- Path to wall at (6,5) ---');
const wallGrid = { x: 6, y: 5 };
const pathToWall = pf.findPathThroughDestructibles(botGrid, wallGrid, []);
console.log(`Path to wall: ${pathToWall ? pathToWall.length : 'null'}`);
if (pathToWall) {
  for (let i = 0; i < pathToWall.length; i++) {
    const p = pathToWall[i]!;
    const tile = data.grid[p.y]?.[p.x];
    const tileName =
      tile === TileType.EMPTY
        ? '.'
        : tile === TileType.INDESTRUCTIBLE_WALL
          ? 'I'
          : tile === TileType.DESTRUCTIBLE_WALL
            ? 'W'
            : `${tile}`;
    console.log(`  waypoint ${i}: (${p.x},${p.y}) = ${tileName}`);
  }
}

// Can the bot even reach (7,5) which is next to the wall at (6,5)?
console.log('\n--- Path to (7,5) ---');
const nearWall = { x: 7, y: 5 };
const pathNear = pf.findPath(botGrid, nearWall);
console.log(`Path: ${pathNear ? pathNear.length : 'null'}`);
if (pathNear) {
  for (const p of pathNear) {
    console.log(`  (${p.x},${p.y})`);
  }
}

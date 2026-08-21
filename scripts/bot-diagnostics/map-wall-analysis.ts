// Wall analysis: what tiles surround the weapon room?
import { resolve } from 'path';
import { TmxParser } from '../../packages/server/src/infrastructure/parsers/TmxParser.ts';
import { TileType } from '@sector-battle/shared';

const parser = new TmxParser();
const data = parser.parse(resolve(process.cwd(), 'tiled/demo_map.tmx'));

const name = (t: TileType) =>
  t === TileType.EMPTY
    ? '.'
    : t === TileType.INDESTRUCTIBLE_WALL
      ? 'I'
      : t === TileType.DESTRUCTIBLE_WALL
        ? 'W'
        : t === TileType.DESTRUCTIBLE_BARREL
          ? 'B'
          : t === TileType.DESTRUCTIBLE_CRATE
            ? 'C'
            : t === TileType.INDESTRUCTIBLE_CRATE
              ? 'i'
              : t === TileType.CHEST
                ? '$'
                : t === TileType.EXIT
                  ? 'E'
                  : `${t}`;

console.log('=== Full map tile types ===');
for (let y = 0; y < data.grid.length; y++) {
  const row = data.grid[y]!.map((t) => name(t).padStart(2)).join(' ');
  console.log(`row ${String(y).padStart(2)}: ${row}`);
}

// Destructible positions
console.log('\n=== Destructible entities ===');
for (const d of data.entities.destructibles) {
  console.log(`  (${d.gridX},${d.gridY}) tileType=${name(d.tileType)} tex=${d.textureKey}`);
}

// How many destructible vs indestructible around weapon room?
let destructible = 0,
  indestructible = 0;
for (let y = 0; y <= 4; y++) {
  for (let x = 0; x <= 6; x++) {
    const t = data.grid[y]?.[x];
    if (t === TileType.INDESTRUCTIBLE_WALL || t === TileType.INDESTRUCTIBLE_CRATE) indestructible++;
    else if (
      t === TileType.DESTRUCTIBLE_WALL ||
      t === TileType.DESTRUCTIBLE_BARREL ||
      t === TileType.DESTRUCTIBLE_CRATE
    )
      destructible++;
  }
}
console.log(
  `\nWeapon room boundary (0,0)-(6,4): ${destructible} destructible, ${indestructible} indestructible`,
);

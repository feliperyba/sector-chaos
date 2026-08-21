import { resolve } from 'node:path';
import { MapGenerator, TileType } from '@sector-battle/shared';
import { SeedMapAdapter } from '../src/infrastructure/map/SeedMapAdapter.ts';

const TILED = resolve(import.meta.dirname, '../../../tiled');
const seeds = [42, 7, 100, 2024];

for (const seed of seeds) {
  const md = new MapGenerator().generate(seed);
  const enr = new SeedMapAdapter().adapt(md, seed, TILED);
  const wall = enr.visualLayers.find((l) => l.name === 'map_border_walls')!;

  const destr = new Map<string, number>();
  const indes = new Map<string, number>();
  for (let r = 0; r < enr.height; r++) {
    for (let c = 0; c < enr.width; c++) {
      const t = enr.grid[r]![c];
      const cell = wall.cells[r]?.[c];
      if (!cell || cell.spriteId < 0) continue;
      const sp = enr.atlas.sprites[cell.spriteId]!;
      const key = `${sp.imagePath}@rot${cell.rotation}`;
      if (t === TileType.DESTRUCTIBLE_WALL) destr.set(key, (destr.get(key) ?? 0) + 1);
      else if (t === TileType.INDESTRUCTIBLE_WALL) indes.set(key, (indes.get(key) ?? 0) + 1);
    }
  }
  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join('  ');
  console.log(`\n=== seed ${seed} ===`);
  console.log('  DESTRUCTIBLE_WALL:', fmt(destr) || '(none)');
  console.log('  INDESTRUCTIBLE_WALL:', fmt(indes) || '(none)');
}

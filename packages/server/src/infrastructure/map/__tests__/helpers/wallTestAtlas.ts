/**
 * Shared test fixture: the REAL env atlas + the wall buckets exactly as
 * `SeedMapAdapter.buildSpriteLookup` builds them (tileType buckets, trap
 * imagePaths filtered OUT of the indestructible bucket). Used by the
 * wall-visual test suites so they all select sprites through the same
 * production-shaped inputs.
 */

import { resolve } from 'node:path';
import { TileType, type TileSpriteAtlas, type TileSpriteDef } from '@sector-battle/shared';
import { TsxAtlasParser } from '../../../parsers/TsxAtlasParser.ts';

/** Repo root `tiled/` directory (same resolution as the map test suites). */
export const TILED_DIR = resolve(__dirname, '../../../../../../../tiled');

/** Trap frames tagged INDESTRUCTIBLE_WALL in the atlas but not real walls. */
export const TRAP_IMAGE_PATHS = new Set([
  'trap',
  'trap_door',
  'trapdoor_round',
  'trapdoor_square',
  'wall_trap',
]);

export function loadEnvAtlas(): TileSpriteAtlas {
  return new TsxAtlasParser().parse(resolve(TILED_DIR, 'env.tsx'));
}

export interface EnvWallBuckets {
  wall: TileSpriteDef[];
  destructibleWall: TileSpriteDef[];
}

export function loadEnvWallBuckets(): EnvWallBuckets {
  const atlas = loadEnvAtlas();
  return {
    wall: atlas.sprites.filter(
      (s) => s.tileType === TileType.INDESTRUCTIBLE_WALL && !TRAP_IMAGE_PATHS.has(s.imagePath),
    ),
    destructibleWall: atlas.sprites.filter((s) => s.tileType === TileType.DESTRUCTIBLE_WALL),
  };
}

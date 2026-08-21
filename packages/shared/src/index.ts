/** Shared package identifier. */
export const PACKAGE_NAME = '@sector-battle/shared';

export * from './constants/index.js';
export * from './enums/index.js';
export * from './map/index.js';
export * from './math/index.js';
export {
  ProjectileTileCollision,
  projectileTileCollisionScratch,
  type ProjectileTileCollisionResult,
} from './collision/ProjectileTileCollision.js';
export { forEachOverlappingTile } from './collision/TileCollisionQuery.js';
export type { CollisionGridProvider } from './collision/CollisionGridProvider.js';
export { resolveTileCollisionEnriched } from './collision/resolveTileCollision.js';
export {
  resolveSimpleTileCollision,
  isSimpleTileBlocked,
} from './collision/resolveSimpleTileCollision.js';
export { resolvePlayerSeparation } from './collision/resolvePlayerSeparation.js';
export * from './types/index.js';
export * from './utils/index.js';
export * from './weapons/index.js';
export * from './animation/index.js';
export * from './network/index.js';
export * from './simulation/index.js';
export * from './loot/index.js';
export * from './match/index.js';

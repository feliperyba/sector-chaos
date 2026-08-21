export {
  PIPELINE_VERSION,
  SECTOR_GRID_SIZE,
  SECTOR_TILE_SIZE,
  TILE_PIXEL_SIZE,
  CORRIDOR_WIDTH,
  MIN_SPAWN_DIST,
  BARREL_COUNT_RANGE,
  TRAP_COUNT_RANGE,
  CHEST_COUNT,
} from './constants.js';
export { EntityPlacer } from './EntityPlacer.js';
export { ExitPlacer } from './ExitPlacer.js';
export {
  assignSectorTiers,
  countTiers,
  effectiveSectorTier,
  LegendaryBudget,
  TIER_TARGETS,
  avalanche,
  type SectorTierAssignment,
  type TierLookup,
} from './lootTiers.js';
export { ZONE_SEED_XOR, deriveZoneSeed, collectZoneBiasAnchors } from './zoneSeed.js';
export {
  SPAWN_EQUITY_COMPONENTS,
  SPAWN_EQUITY_MAX_DEVIATION,
  SPAWN_EQUITY_REPAIR_CANDIDATE_LIMIT,
  SPAWN_DESTRUCTIBLE_CLEARANCE,
  auditSpawnEquity,
  repairSpawnEquity,
  type SpawnEquityComponent,
  type SpawnEquityValues,
  type SpawnEquityViolation,
  type SpawnEquityAudit,
  type SpawnEquityInput,
} from './spawnFairness.js';
export { LootSpawner } from './LootSpawner.js';
export {
  generatePoiNames,
  designationSeedTag,
  type MacroPoiNames,
  type PoiNameAssignment,
} from './poiNames.js';
export {
  assignLandmarks,
  collectLandmarkReservedTiles,
  signatureIndexFor,
  BEACON_RADIUS,
  CITADEL_BEACON_RADIUS,
  BEACON_INTENSITY_MIN,
  BEACON_INTENSITY_MAX,
  BEACON_TIER_LIGHT,
  BEACON_THEME_LIGHT,
  MINOR_LANDMARK_LIGHT,
  MINOR_HERO_MIN_CHEB,
  MINOR_MINOR_MIN_CHEB,
  type HeroLandmark,
  type MinorLandmark,
  type LandmarkAssignment,
} from './landmarks.js';
export { type FortressInfo, type CompoundInfo, type CompoundVariant } from './macro/MacroTypes.js';
export {
  SECTOR_IDENTITY,
  GLOBAL_WALL_TINT,
  BASE_WEATHER_WEIGHTS,
  TIER_WEATHER_BIAS,
  MAX_WEATHER_BIAS_POINTS,
  FLOOR_FIELD_VALUE_BAND,
  WALL_VALUE_BAND,
  WALL_TINT_MIN_LUM_SEPARATION,
  FLOOR_WALL_VALUE_GAP,
  tintLuminance,
  wallTintAt,
  biasedWeatherWeights,
  type SectorIdentitySheet,
  type FloorTintFamily,
  type GatewaySpec,
  type WeatherType,
} from './identitySheets.js';
export {
  generateVisualIdentity,
  gatewayMidpoint,
  tileJitter,
  fieldCoversTile,
  fieldTileAlpha,
  IDENTITY_SEED_XOR,
  GATEWAY_ALIGN_COS,
  type FloorTintField,
  type FloorTintFieldKind,
  type GatewayDressing,
  type VisualIdentityAssignment,
} from './visualIdentity.js';
export { CITADEL_CHANCE, CITADEL_SEAMS, CITADEL_SIZE } from './macro/MegaStructureCitadel.js';
export {
  LANDMARK_REGISTRY,
  LANDMARK_TYPE_ORDER,
  landmarkCompositionById,
  type LandmarkComposition,
  type NounHints,
} from './landmarkRegistry.js';
export { OBJECT_VISUAL_FRAMES, DECOR_BAKE_FRAMES } from './bakeFrameDiscipline.js';
export {
  isEmptyTile,
  isTraversable,
  isWallLikeTile,
  buildCompositeGrid,
  getSectorRing,
  gridBfs,
  findFirstPassable,
} from './gridUtils.js';
export type { GridBfsOptions, GridBfsResult } from './gridUtils.js';
export {
  WALL_ART_SHAPES,
  SOLID_THRESHOLD,
  shapeGrid,
  rotateShapeBy90s,
  orientedShape,
  edgeBand,
  solidEdges,
  solidQuadrants,
} from './wallArtShapes.js';
export type { WallShapeGrid } from './wallArtShapes.js';
export {
  validateWallComposition,
  collectSanctionedStubCells,
  isPureDestructibleTStemPair,
  type WallCompositionAudit,
  type WallCompositionViolation,
  type WallCompositionOptions,
  type OrphanStubCell,
} from './validatorGates.js';
export { GridArenaGenerator } from './sectors/GridArenaGenerator.js';
export type { ISectorGenerator, SectorConfig } from './sectors/ISectorGenerator.js';
export {
  GRID_ARENA_SUB_VARIANTS,
  OPEN_ARENA_SUB_VARIANTS,
  MAZE_SUB_VARIANTS,
  RESOURCE_RICH_SUB_VARIANTS,
  SUB_VARIANTS_BY_TYPE,
  resolveSubVariant,
  type SectorSubVariant,
  type GridArenaSubVariant,
  type OpenArenaSubVariant,
  type MazeSubVariant,
  type ResourceRichSubVariant,
} from './sectors/subVariants.js';
export {
  SUB_BLOCKS_BY_VARIANT,
  applyProbabilisticSubBlocks,
  type SkeletonSubBlock,
} from './sectors/probabilisticBlocks.js';
export { maybeMirrorSector, MIRROR_CHANCE } from './sectors/skeletonMirror.js';
export { MapGenerator, type GenerationAudit } from './MapGenerator.js';
export { MapValidator } from './MapValidator.js';
export { MazeGenerator } from './sectors/MazeGenerator.js';
export { OpenArenaGenerator } from './sectors/OpenArenaGenerator.js';
export { ResourceRichGenerator } from './sectors/ResourceRichGenerator.js';
export { SectorConnector } from './SectorConnector.js';
export {
  SectorType,
  SectorLootTier,
  type MapData,
  type SectorData,
  type SectorConnection,
  type SpawnPoint,
  type ExitData,
  type LootPlacement,
  type EntityPlacement,
  type TrapPlacement,
  type SectorWeather,
  type ValidationResult,
} from './types.js';
export { SeededRNG } from './rng/SeededRNG.js';
export { SpawnPointFinder } from './SpawnPointFinder.js';
export {
  type TileCollider,
  type TileColliderRect,
  type TileColliderPoly,
  type TileSpriteDef,
  type TileVisual,
  type WeaponPlacement,
  type TrapPlacementTiled,
  type TiledEntityPlacements,
  type DestructiblePlacement,
  type ChestPlacement,
  type ExitPlacement,
  type LightKind,
  type FlameKind,
  type LightAnchor,
  type LightPlacementTiled,
  LIGHT_PROP_ENTITY_ANCHORS,
  isLightPropEntityPlacement,
  LIGHT_BAKED_EXEMPT_KINDS,
  LIGHT_BAKED_EXEMPT_ANCHORS,
  isBakedExemptLightPlacement,
  type TileColliderData,
  type TileSpriteAtlas,
  type EnrichedMapData,
  type TiledMapLayer,
  emptyTileVisual,
  createSiegeWallSpriteDef,
  selectTileVisual,
} from './tiledTypes.js';

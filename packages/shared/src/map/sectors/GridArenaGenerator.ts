import { SectorType } from '../types.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import type { SectorConfig } from './ISectorGenerator.js';
import type { ISectorGenerator } from './ISectorGenerator.js';
import {
  GRID_ARENA_SUB_VARIANTS,
  resolveSubVariant,
  type GridArenaSubVariant,
  type SectorSubVariant,
} from './subVariants.js';
import { GRID_ARENA_SKELETON_BUILDERS } from './gridArenaSkeletons.js';

/**
 * GridArena (close-quarters melee brawl) generator. Dispatches on the chosen
 * sub-variant to one of four DISTINCT skeletons, each a persistent
 * INDESTRUCTIBLE_WALL pillar skeleton plus breakable cover fill (ADR 0027 /
 * GDD §5.2.1). The skeleton survives the whole match, so the arena never erodes
 * to an open box; EntityPlacer later tops up crate density and loot in the open
 * pockets each skeleton leaves clear of indestructible walls.
 */
export class GridArenaGenerator implements ISectorGenerator {
  readonly subVariants = GRID_ARENA_SUB_VARIANTS;

  /**
   * Whether this generator supports the given sub-variant id.
   *
   * @param id - the sub-variant id to test
   * @returns `true` if `id` is a GridArena sub-variant
   */
  supports(id: SectorSubVariant): boolean {
    return (this.subVariants as readonly SectorSubVariant[]).includes(id);
  }

  /**
   * Build a GridArena sector, dispatching on its sub-variant to the matching
   * skeleton builder. The builder consumes `rng`, so two GridArena instances
   * differ and the same seed reproduces them exactly.
   *
   * @param rng - the per-sector seeded RNG stream
   * @param config - the sector generation config (type, coord, sub-variant)
   * @returns the generated sector data
   */
  generate(rng: SeededRNG, config: SectorConfig): SectorData {
    const subVariant = resolveSubVariant(
      SectorType.GRID_ARENA,
      config.subVariant,
    ) as GridArenaSubVariant;

    const { tiles, lootSpots, landmarkAnchor } = GRID_ARENA_SKELETON_BUILDERS[subVariant](rng);

    return {
      type: config.type,
      subVariant,
      tiles,
      elevation: null,
      lootSpots,
      landmarkAnchor,
      mirrored: false,
      subBlockMask: 0,
      bounds: {
        x: config.sectorCoord.col * config.width * config.tileSize,
        y: config.sectorCoord.row * config.height * config.tileSize,
        width: config.width * config.tileSize,
        height: config.height * config.tileSize,
      },
      theme: config.theme,
    };
  }
}

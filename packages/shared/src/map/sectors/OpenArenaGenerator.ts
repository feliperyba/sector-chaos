import { SectorType } from '../types.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import type { SectorConfig } from './ISectorGenerator.js';
import type { ISectorGenerator } from './ISectorGenerator.js';
import {
  OPEN_ARENA_SUB_VARIANTS,
  resolveSubVariant,
  type OpenArenaSubVariant,
  type SectorSubVariant,
} from './subVariants.js';
import { OPEN_ARENA_SKELETON_BUILDERS } from './openArenaSkeletons.js';

/**
 * OpenArena (spacing, dashing & the chase) generator. Dispatches on the chosen
 * sub-variant to one of four DISTINCT skeletons, each a LOW-density, dash-friendly
 * layout of sparse structural cover around a large clear center, with good
 * sightlines and cover that never hugs the border (GDD §5.2.2, ADR 0027). The
 * skeletons lay only sparse structural cover; EntityPlacer later tops up crate
 * density (~10%) and loot in the wide-open pockets each skeleton leaves clear.
 */
export class OpenArenaGenerator implements ISectorGenerator {
  readonly subVariants = OPEN_ARENA_SUB_VARIANTS;

  /**
   * Whether this generator supports the given sub-variant id.
   *
   * @param id - the sub-variant id to test
   * @returns `true` if `id` is an OpenArena sub-variant
   */
  supports(id: SectorSubVariant): boolean {
    return (this.subVariants as readonly SectorSubVariant[]).includes(id);
  }

  /**
   * Build an OpenArena sector, dispatching on its sub-variant to the matching
   * skeleton builder. The builder consumes `rng`, so two OpenArena instances
   * differ and the same seed reproduces them exactly.
   *
   * @param rng - the per-sector seeded RNG stream
   * @param config - the sector generation config (type, coord, sub-variant)
   * @returns the generated sector data
   */
  generate(rng: SeededRNG, config: SectorConfig): SectorData {
    const subVariant = resolveSubVariant(
      SectorType.OPEN_ARENA,
      config.subVariant,
    ) as OpenArenaSubVariant;

    const { tiles, lootSpots, landmarkAnchor } = OPEN_ARENA_SKELETON_BUILDERS[subVariant](rng);

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

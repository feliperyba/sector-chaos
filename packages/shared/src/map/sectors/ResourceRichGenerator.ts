import { SectorType } from '../types.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import type { SectorConfig } from './ISectorGenerator.js';
import type { ISectorGenerator } from './ISectorGenerator.js';
import {
  RESOURCE_RICH_SUB_VARIANTS,
  resolveSubVariant,
  type ResourceRichSubVariant,
  type SectorSubVariant,
} from './subVariants.js';
import { RESOURCE_RICH_SKELETON_BUILDERS } from './resourceRichSkeletons.js';

/**
 * ResourceRich (loot-rush hot zone) generator. Dispatches on the chosen
 * sub-variant to one of four DISTINCT skeletons (T7), each high-reward, exposed
 * and contested, with COVER THAT FRAMES LOOT (ADR 0027 / GDD §5.2.4). This
 * replaces the old artifact of 5–8 lone INDESTRUCTIBLE "stub" walls in an open
 * box: cover is now BREAKABLE (DESTRUCTIBLE_WALL / DESTRUCTIBLE_CRATE) so the
 * cache cells it frames stay loot-eligible and reachable.
 *
 * Each skeleton also reports its intended cache cells, which the generator copies
 * into {@link SectorData.lootSpots} (tile coords `{ x: col, y: row }`).
 * EntityPlacer prefers those cells for chests + the guaranteed ground-weapon
 * spawns, so loot lands INSIDE the cover structure rather than scattered; it
 * falls back to its existing random placement when a cache cell is taken or no
 * longer eligible. EntityPlacer still tops up crate density (15%) and barrels.
 */
export class ResourceRichGenerator implements ISectorGenerator {
  readonly subVariants = RESOURCE_RICH_SUB_VARIANTS;

  /**
   * Whether this generator supports the given sub-variant id.
   *
   * @param id - the sub-variant id to test
   * @returns `true` if `id` is a ResourceRich sub-variant
   */
  supports(id: SectorSubVariant): boolean {
    return (this.subVariants as readonly SectorSubVariant[]).includes(id);
  }

  /**
   * Build a ResourceRich sector, dispatching on its sub-variant to the matching
   * skeleton builder. The builder consumes `rng`, so two ResourceRich instances
   * differ and the same seed reproduces them exactly; it also returns the cache
   * cells recorded into `lootSpots` for the loot-framing hook.
   *
   * @param rng - the per-sector seeded RNG stream
   * @param config - the sector generation config (type, coord, sub-variant)
   * @returns the generated sector data
   */
  generate(rng: SeededRNG, config: SectorConfig): SectorData {
    const subVariant = resolveSubVariant(
      SectorType.RESOURCE_RICH,
      config.subVariant,
    ) as ResourceRichSubVariant;

    const { tiles, lootSpots, landmarkAnchor } = RESOURCE_RICH_SKELETON_BUILDERS[subVariant](rng);

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

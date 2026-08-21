import type { SectorData, SectorType } from '../types.js';
import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorSubVariant } from './subVariants.js';

/** Sector generator configuration. */
export interface SectorConfig {
  width: number;
  height: number;
  tileSize: number;
  type: SectorType;
  theme: 'default' | 'cave' | 'factory';
  sectorCoord: { row: number; col: number };
  /**
   * The chosen sub-variant (Skeleton) id for this sector instance. Selected
   * centrally in `MapGenerator` (with adjacency-dedup) and passed to the
   * generator, which dispatches on it. Optional so direct generator callers and
   * tests can omit it (the generator then builds its default skeleton).
   */
  subVariant?: SectorSubVariant;
}

/** Interface for sector tile generators. */
export interface ISectorGenerator {
  /** The sub-variant ids this generator can build. */
  readonly subVariants: readonly SectorSubVariant[];
  /**
   * Whether this generator supports the given sub-variant id.
   *
   * @param id - the sub-variant id to test
   * @returns `true` if this generator can build the sub-variant
   */
  supports(id: SectorSubVariant): boolean;
  /**
   * Build a sector's tile skeleton from the seeded RNG and config.
   *
   * @param rng - the per-sector seeded RNG stream
   * @param config - the sector generation config (type, coord, sub-variant)
   * @returns the generated sector data
   */
  generate(rng: SeededRNG, config: SectorConfig): SectorData;
}

import { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorType } from '../types.js';
import { SUB_VARIANTS_BY_TYPE, type SectorSubVariant } from './subVariants.js';
import { avalanche } from '../lootTiers.js';

/**
 * Selection lives on an RNG stream seeded purely from the map seed, XORed with
 * this constant so it is fully isolated from the main pipeline RNG. Drawing from
 * this stream NEVER perturbs the per-sector `subSeed` draws in `MapGenerator`, so
 * the generated tiles stay byte-identical to before sub-variants existed.
 *
 * Map-redesign ticket 08: the stream is AVALANCHE-MIXED
 * (`avalanche(seed ^ salt)`, the same fix lootTiers/MacroFeaturePass applied
 * for the xorshift128 step-seed collapse). Measured pathology with the plain
 * salted seed: SeededRNG(seed) and SeededRNG(seed ^ salt) differ ONLY in
 * stateX, so the sub-variant floats at the positions where the (main-stream
 * driven) SectorDistributor places a given type were correlated with the type
 * placement itself — over a 500-seed sweep, the draw floats at MAZE positions
 * landed in [0.2, 0.8) 100% of the time (buckets 0 and 4 never fired), which
 * made the 5th maze id ('Sewer Grid') unreachable and 'Loose Labyrinth'
 * near-unreachable. Avalanche restores the full bucket coverage (all 20 ids
 * appear across the sweep).
 */
const SUB_VARIANT_STREAM_SALT = 0x9e3779b9;

/**
 * Deterministically choose a sub-variant id for every sector, enforcing
 * adjacency-dedup: no orthogonally-adjacent pair shares an id. Selection reads
 * from an isolated seed-derived RNG stream (see {@link SUB_VARIANT_STREAM_SALT})
 * so it does not disturb the main map RNG.
 *
 * Row-major assignment only needs to exclude the already-assigned left and up
 * neighbours: when the right/down sector is later assigned, it sees the current
 * one as its own left/up neighbour, so every orthogonal edge is covered. If a
 * type's id set is fully blocked by same-type neighbours (cannot happen for the
 * 5-ids-per-type sets, where at most 2 neighbours conflict), it falls back
 * best-effort to the full set rather than crashing.
 *
 * @param seed - the map seed (the same value passed to `MapGenerator.generate`)
 * @param typeGrid - the per-sector type grid
 * @returns a grid of chosen sub-variant ids, parallel to `typeGrid`
 */
export function selectSubVariants(seed: number, typeGrid: SectorType[][]): SectorSubVariant[][] {
  const rng = new SeededRNG(avalanche((seed ^ SUB_VARIANT_STREAM_SALT) >>> 0));
  const chosen: SectorSubVariant[][] = [];

  for (let row = 0; row < typeGrid.length; row++) {
    chosen[row] = [];
    const typeRow = typeGrid[row]!;
    for (let col = 0; col < typeRow.length; col++) {
      const type = typeRow[col]!;
      const supported = SUB_VARIANTS_BY_TYPE[type];

      const blocked = new Set<SectorSubVariant>();
      if (col > 0) blocked.add(chosen[row]![col - 1]!);
      if (row > 0) blocked.add(chosen[row - 1]![col]!);

      const candidates = supported.filter((id) => !blocked.has(id));
      const pool = candidates.length > 0 ? candidates : supported;
      chosen[row]![col] = pool[rng.nextInt(0, pool.length - 1)]!;
    }
  }

  return chosen;
}

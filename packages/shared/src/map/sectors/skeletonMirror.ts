import type { SeededRNG } from '../rng/SeededRNG.js';
import type { SectorData } from '../types.js';
import { SECTOR_TILE_SIZE } from '../constants.js';
import { measureSectorGates } from './sectorGates.js';

/**
 * Seeded horizontal mirroring for asymmetric skeletons (map-redesign ticket
 * 08 / DEC-007.2 — 2× the effective library for one boolean).
 *
 * RNG CONTRACT (Wei's dissent, same as the sub-block pass): the mirror die is
 * the LAST draw on the sector's forked stream — one `nextFloat()` AFTER the
 * base skeleton draw and AFTER the probabilistic sub-block dice (appended,
 * never interleaved). The mirror therefore flips the fully-built grid — base
 * skeleton AND present sub-blocks together — in the authored frame.
 *
 * EVERY skeleton in the library participates: all twenty are authored
 * asymmetric (plaza jitter, ring gap phases, shuffled bastion/anchor picks,
 * DFS maze starts, entrance-gap sides), so a horizontal mirror always yields
 * a genuinely different layout read.
 *
 * POST-TRANSFORM RE-VALIDATION (the ticket criterion — verified, not
 * assumed): a horizontal flip is an automorphism of the tile grid, so
 * connectivity, spawn feasibility and sightlines are provably invariant; the
 * transform nevertheless re-measures every gate (see `sectorGates.ts`) and
 * deterministically reverts to the unmirrored grid if ANY measure differs
 * (components / spawn pool / lone walls / sightline signature). Mirrored
 * placements stay deterministic: `lootSpots` and the `landmarkAnchor` are
 * re-mapped through the same `x → SIZE-1-x` flip as the tiles, so downstream
 * passes (landmarks, entity placement, exits, spawns) consume a consistent
 * sector.
 */

/** The 20×20 sector side length. */
const SIZE = SECTOR_TILE_SIZE;

/** Mirror die: a coin flip on the forked stream (mirrored AND unmirrored instances appear across seeds). */
export const MIRROR_CHANCE = 0.5;

/**
 * Roll the mirror die and, when it fires, horizontally mirror the sector in
 * place: tiles, lootSpots and landmarkAnchor all flip through
 * `x → SIZE-1-x`. The border ring maps onto itself (col 0 ↔ col 19), so
 * corridor carving by `SectorConnector` (rows/cols 9–11 through the seam)
 * is unaffected — it runs after this pass and overwrites the seam tiles
 * exactly as on unmirrored sectors.
 *
 * @param sector - the generated sector (mutated in place; `mirrored` set)
 * @param rng - the sector's forked RNG stream, positioned AFTER the
 *   sub-block dice
 */
export function maybeMirrorSector(sector: SectorData, rng: SeededRNG): void {
  sector.mirrored = false;
  if (rng.nextFloat() >= MIRROR_CHANCE) return;

  const preTiles = sector.tiles;
  const preSpots = sector.lootSpots;
  const preAnchor = sector.landmarkAnchor;
  const pre = measureSectorGates(sector);

  const flipped: Uint8Array[] = preTiles.map((row) => {
    const out = new Uint8Array(row.length);
    for (let c = 0; c < row.length; c++) out[c] = row[row.length - 1 - c]!;
    return out;
  });
  sector.tiles = flipped;
  sector.lootSpots = preSpots.map((spot) => ({ x: SIZE - 1 - spot.x, y: spot.y }));
  sector.landmarkAnchor = { x: SIZE - 1 - preAnchor.x, y: preAnchor.y };

  const post = measureSectorGates(sector);
  if (
    post.emptyComponents !== pre.emptyComponents ||
    post.spawnEligible !== pre.spawnEligible ||
    post.loneWalls !== pre.loneWalls ||
    post.sightlineProfile !== pre.sightlineProfile
  ) {
    // Provably unreachable (a horizontal flip is a grid automorphism) — the
    // deterministic safety net the ticket's "re-verified post-transform"
    // criterion asks for. Revert to the exact unmirrored state.
    sector.tiles = preTiles;
    sector.lootSpots = preSpots;
    sector.landmarkAnchor = preAnchor;
    return;
  }
  sector.mirrored = true;
}
